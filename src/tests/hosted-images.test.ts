import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { isForbiddenAddress } from '../shared/ssrf';
import { runWithCredentials } from '../shared/request-context';
import { resolveImageSource } from '../shared/attachments';
import { downloadImages } from '../shared/image-processing';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mP8z8DAwMgAA4xkYCADAKQlBAX9tXpZAAAAAElFTkSuQmCC';
const PNG = Buffer.from(PNG_BASE64, 'base64');

const creds = { token: 't', teamId: 'team1', userKey: 'k' };
const hosted = <T>(fn: () => T) => runWithCredentials(creds, fn);

let mockAgent: MockAgent | undefined;
afterEach(async () => {
  await mockAgent?.close();
  mockAgent = undefined;
});

function mock() {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  return mockAgent;
}

test('isForbiddenAddress blocks loopback, private, link-local, unique-local, unspecified and mapped forms', () => {
  const forbidden = [
    '127.0.0.1', '127.1.2.3', '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255',
    '172.16.0.1', '172.31.255.255', '192.168.0.1', '192.168.255.255', '169.254.169.254', '100.64.0.1',
    '192.0.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', '0:0:0:0:0:0:0:1', 'fe80::1', 'febf::1', 'fc00::1', 'fd12:3456:789a::1', 'fdff::1',
    'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a00:1',
    '::ffff:169.254.169.254', '::127.0.0.1', '64:ff9b::7f00:1', '[::1]', 'fe80::1%eth0', 'not-an-ip', '',
  ];
  for (const address of forbidden) assert.equal(isForbiddenAddress(address), true, address);
});

test('isForbiddenAddress allows public addresses', () => {
  const allowed = [
    '8.8.8.8', '93.184.216.34', '1.1.1.1', '172.15.255.255', '172.32.0.1', '192.169.0.1', '100.63.255.255',
    '100.128.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '::ffff:808:808', '2a00:1450::1',
  ];
  for (const address of allowed) assert.equal(isForbiddenAddress(address), false, address);
});

test('hosted mode refuses local paths and file: URLs, stdio mode still reads them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hosted-images-'));
  try {
    const file = join(dir, 'shot.png');
    await writeFile(file, PNG);

    const local = await resolveImageSource(file);
    assert.equal(local.kind, 'bytes');

    for (const src of [file, 'shot.png', '../etc/passwd', `file://${file}`]) {
      await assert.rejects(
        hosted(() => resolveImageSource(src, dir)),
        /local file paths are not available on the hosted server; use a URL or data URI/,
        src
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('hosted mode still accepts data URIs', async () => {
  const resolved = await hosted(() => resolveImageSource(`data:image/png;base64,${PNG_BASE64}`));
  assert.equal(resolved.kind, 'bytes');
});

test('hosted mode refuses URLs that point at internal addresses', async () => {
  mock(); // net connect disabled: a request that slipped through would fail with a different error
  for (const src of [
    'http://127.0.0.1:8080/a.png',
    'http://localhost/a.png',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.1.2.3/a.png',
    'http://[::1]/a.png',
    'http://[::ffff:127.0.0.1]/a.png',
    'http://0.0.0.0/a.png',
  ]) {
    await assert.rejects(hosted(() => resolveImageSource(src)), /private or internal address/, src);
  }
});

test('hosted mode downloads from a public address', async () => {
  const agent = mock();
  agent.get('http://93.184.216.34').intercept({ path: '/pics/cat.png', method: 'GET' }).reply(200, PNG, {
    headers: { 'content-type': 'image/png' },
  });
  const resolved = await hosted(() => resolveImageSource('http://93.184.216.34/pics/cat.png'));
  assert.equal(resolved.kind, 'bytes');
  assert.equal((resolved as any).suggestedName, 'cat.png');
});

test('hosted mode re-validates redirects and follows public ones', async () => {
  const agent = mock();
  const pool = agent.get('http://93.184.216.34');
  pool.intercept({ path: '/evil', method: 'GET' }).reply(302, '', { headers: { location: 'http://127.0.0.1:9/secret.png' } });
  await assert.rejects(hosted(() => resolveImageSource('http://93.184.216.34/evil')), /private or internal address/);

  pool.intercept({ path: '/hop1', method: 'GET' }).reply(302, '', { headers: { location: '/final.png' } });
  pool.intercept({ path: '/final.png', method: 'GET' }).reply(200, PNG);
  const ok = await hosted(() => resolveImageSource('http://93.184.216.34/hop1'));
  assert.equal(ok.kind, 'bytes');
});

test('hosted mode gives up after too many redirects', async () => {
  const agent = mock();
  agent
    .get('http://93.184.216.34')
    .intercept({ path: '/loop', method: 'GET' })
    .reply(302, '', { headers: { location: '/loop' } })
    .persist();
  await assert.rejects(hosted(() => resolveImageSource('http://93.184.216.34/loop')), /too many redirects/);
});

test('hosted mode enforces the size limit while downloading', async () => {
  const agent = mock();
  const limitMb = Number(process.env.MAX_UPLOAD_SIZE_MB ?? 10);
  const big = Buffer.alloc(limitMb * 1024 * 1024 + 1024, 1);
  agent.get('http://93.184.216.34').intercept({ path: '/big.png', method: 'GET' }).reply(200, big);
  await assert.rejects(hosted(() => resolveImageSource('http://93.184.216.34/big.png')), /larger than|exceeds/);
});

test('hosted downloadImages skips a loopback image without any request but still downloads a public one', async () => {
  const agent = mock();
  agent.get('http://93.184.216.34').intercept({ path: '/ok.png', method: 'GET' }).reply(200, PNG);
  const block = (alt: string, url: string): any => ({ type: 'image_metadata', alt, urls: [url] });
  const content = [
    { type: 'text', text: 'task text' },
    block('internal', 'http://127.0.0.1:8080/secret.png'),
    block('metadata', 'http://169.254.169.254/latest/meta-data/'),
    block('public', 'http://93.184.216.34/ok.png'),
  ] as any[];

  const result = await hosted(() => downloadImages(content, 10, 5));

  assert.equal(result[0].type, 'text');
  assert.equal(result[0].text, 'task text'); // the text still renders
  assert.equal(result[1].type, 'text'); // refused: omitted, placeholder only
  assert.equal(result[2].type, 'text');
  assert.equal(result[3].type, 'image');
  assert.equal(result[3].mimeType, 'image/png');
  assert.equal(result[3].data, PNG_BASE64);
  // net connect is disabled and only the public URL was stubbed: nothing else was requested
  agent.assertNoPendingInterceptors();
});
