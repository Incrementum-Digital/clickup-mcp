import { test, afterEach } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { isForbiddenAddress, fetchPublicBytes, nodeTransport } from '../shared/ssrf';
import { installFakeWeb, restoreFakeWeb } from './fake-web';
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
  restoreFakeWeb();
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
  const { calls } = installFakeWeb({}); // any request that slipped through would reach the transport
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
  assert.equal(calls.length, 0);
});

test('hosted mode downloads from a public address', async () => {
  const { calls } = installFakeWeb({
    'http://93.184.216.34/pics/cat.png': { body: PNG, headers: { 'content-type': 'image/png' } },
  });
  const resolved = await hosted(() => resolveImageSource('http://93.184.216.34/pics/cat.png'));
  assert.equal(resolved.kind, 'bytes');
  assert.equal((resolved as any).suggestedName, 'cat.png');
  assert.equal(calls.length, 1);
});

test('hosted mode re-validates redirects and follows public ones', async () => {
  const { calls } = installFakeWeb({
    'http://93.184.216.34/evil': { status: 302, headers: { location: 'http://127.0.0.1:9/secret.png' } },
    'http://93.184.216.34/hop1': { status: 302, headers: { location: '/final.png' } },
    'http://93.184.216.34/final.png': { body: PNG },
  });
  await assert.rejects(hosted(() => resolveImageSource('http://93.184.216.34/evil')), /private or internal address/);
  assert.equal(calls.length, 1, 'the loopback redirect target is never connected to');

  const ok = await hosted(() => resolveImageSource('http://93.184.216.34/hop1'));
  assert.equal(ok.kind, 'bytes');
});

test('hosted mode gives up after too many redirects', async () => {
  const { calls } = installFakeWeb({
    'http://93.184.216.34/loop': { status: 302, headers: { location: '/loop' } },
  });
  await assert.rejects(hosted(() => resolveImageSource('http://93.184.216.34/loop')), /too many redirects/);
  assert.equal(calls.length, 4, 'the first request plus three redirects');
});

test('hosted mode enforces the size limit while downloading', async () => {
  const limitMb = Number(process.env.MAX_UPLOAD_SIZE_MB ?? 10);
  const big = Buffer.alloc(limitMb * 1024 * 1024 + 1024, 1);
  installFakeWeb({ 'http://93.184.216.34/big.png': { body: big } });
  await assert.rejects(hosted(() => resolveImageSource('http://93.184.216.34/big.png')), /larger than|exceeds/);
});

test('hosted downloadImages skips a loopback image without any request but still downloads a public one', async () => {
  const { calls } = installFakeWeb({ 'http://93.184.216.34/ok.png': { body: PNG } });
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
  // only the public URL reached the transport
  assert.deepEqual(calls.map((c) => c.url.href), ['http://93.184.216.34/ok.png']);
});

// --- DNS rebinding: the connection must go to the address that was validated -------------------

test('DNS rebinding: the connection is pinned to the validated address, hostname only in Host/SNI', async () => {
  // First answer is public, any later lookup would answer with the metadata address (rebinding).
  let lookups = 0;
  const lookup = async () => {
    lookups++;
    return lookups === 1
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '169.254.169.254', family: 4 }];
  };
  const { calls } = installFakeWeb(
    {
      'http://rebind.example.com:8080/x.png': { body: PNG },
      'https://rebind.example.com/y.png': { body: PNG },
    },
    { lookup }
  );

  await fetchPublicBytes('http://rebind.example.com:8080/x.png', { maxBytes: 1024 });
  assert.equal(calls[0].address, '93.184.216.34', 'connects to the validated IP, not to the hostname');
  assert.equal(calls[0].family, 4);
  assert.equal(calls[0].hostHeader, 'rebind.example.com:8080', 'Host keeps the hostname and the non-default port');
  assert.equal(calls[0].servername, 'rebind.example.com');
  assert.equal(lookups, 1, 'the hostname is resolved exactly once per hop');

  lookups = 0;
  await fetchPublicBytes('https://rebind.example.com/y.png', { maxBytes: 1024 });
  assert.equal(calls[1].address, '93.184.216.34');
  assert.equal(calls[1].hostHeader, 'rebind.example.com', 'default port is omitted from Host');
  assert.equal(calls[1].servername, 'rebind.example.com', 'TLS SNI and certificate check use the hostname');
});

test('DNS rebinding: a lookup that returns a private address for the hop is refused before connecting', async () => {
  const { calls } = installFakeWeb({ 'http://rebind.example.com/x.png': { body: PNG } }, {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }],
  });
  await assert.rejects(
    fetchPublicBytes('http://rebind.example.com/x.png', { maxBytes: 1024 }),
    /private or internal address/
  );
  assert.equal(calls.length, 0);
});

test('a redirect to a hostname that resolves to a private address is refused and never connected to', async () => {
  const addresses: Record<string, string> = { 'public.example.com': '93.184.216.34', 'internal.example.com': '10.0.0.5' };
  const { calls } = installFakeWeb(
    {
      'http://public.example.com/start': { status: 302, headers: { location: 'http://internal.example.com/secret' } },
      'http://internal.example.com/secret': { body: 'secret' },
    },
    { lookup: async (host) => [{ address: addresses[host], family: 4 }] }
  );
  await assert.rejects(
    fetchPublicBytes('http://public.example.com/start', { maxBytes: 1024 }),
    /internal\.example\.com resolves to a private or internal address/
  );
  assert.deepEqual(calls.map((c) => c.address), ['93.184.216.34']);
});

test('every redirect hop is re-resolved and re-pinned to its own validated address', async () => {
  const addresses: Record<string, string> = { 'a.example.com': '93.184.216.34', 'b.example.com': '8.8.8.8' };
  const { calls } = installFakeWeb(
    {
      'http://a.example.com/start': { status: 301, headers: { location: 'http://b.example.com/end.png' } },
      'http://b.example.com/end.png': { body: PNG, headers: { 'content-type': 'image/png', 'content-disposition': 'attachment; filename="end.png"' } },
    },
    { lookup: async (host) => [{ address: addresses[host], family: 4 }] }
  );
  const result = await fetchPublicBytes('http://a.example.com/start', { maxBytes: 1024 });
  assert.deepEqual(calls.map((c) => [c.address, c.hostHeader]), [['93.184.216.34', 'a.example.com'], ['8.8.8.8', 'b.example.com']]);
  assert.equal(result.contentType, 'image/png');
  assert.equal(result.contentDisposition, 'attachment; filename="end.png"');
  assert.equal(result.url.href, 'http://b.example.com/end.png');
});

test('IP-literal URLs are pinned to themselves and send no TLS servername', async () => {
  const { calls } = installFakeWeb({ 'https://93.184.216.34/a.png': { body: PNG }, 'http://[2606:4700:4700::1111]/a.png': { body: PNG } });
  await fetchPublicBytes('https://93.184.216.34/a.png', { maxBytes: 1024 });
  await fetchPublicBytes('http://[2606:4700:4700::1111]/a.png', { maxBytes: 1024 });
  assert.equal(calls[0].address, '93.184.216.34');
  assert.equal(calls[0].servername, undefined);
  assert.equal(calls[1].address, '2606:4700:4700::1111');
  assert.equal(calls[1].family, 6);
  assert.equal(calls[1].servername, undefined);
});

// --- the real node:http transport, against a loopback server -----------------------------------

test('nodeTransport connects to the pinned IP while sending the original hostname in Host', async () => {
  let seenHost: string | undefined;
  const server = http.createServer((req, res) => {
    seenHost = req.headers.host;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('pinned');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  try {
    const controller = new AbortController();
    const response = await nodeTransport({
      url: new URL(`http://not-resolvable.invalid:${port}/path?q=1`),
      address: '127.0.0.1',
      family: 4,
      hostHeader: `not-resolvable.invalid:${port}`,
      headers: {},
      timeoutMs: 5000,
      signal: controller.signal,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'text/plain');
    assert.equal(Buffer.concat(chunks).toString(), 'pinned');
    assert.equal(seenHost, `not-resolvable.invalid:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('nodeTransport times out a server that never answers', async () => {
  const server = http.createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  try {
    await assert.rejects(
      nodeTransport({
        url: new URL(`http://slow.invalid:${port}/`),
        address: '127.0.0.1',
        family: 4,
        hostHeader: `slow.invalid:${port}`,
        headers: {},
        timeoutMs: 100,
        signal: new AbortController().signal,
      }),
      { code: 'ETIMEDOUT' }
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
