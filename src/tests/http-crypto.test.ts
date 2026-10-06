import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openToken, sealToken, TokenError } from '../http/crypto';

const SECRET = 'a-test-secret-that-is-at-least-32-characters-long';

test('sealToken/openToken roundtrip returns the payload and an exp', () => {
  const token = sealToken('access', { hello: 'world', n: 1 }, 60, SECRET);
  assert.match(token, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
  const payload = openToken('access', token, SECRET);
  assert.equal(payload.hello, 'world');
  assert.equal(payload.n, 1);
  assert.ok(payload.exp > Date.now() / 1000);
});

test('tokens are randomised: sealing twice gives different blobs', () => {
  assert.notEqual(sealToken('access', { a: 1 }, 60, SECRET), sealToken('access', { a: 1 }, 60, SECRET));
});

test('the payload is not readable from the token', () => {
  const token = sealToken('access', { secretValue: 'clickup-token-123' }, 60, SECRET);
  assert.ok(!Buffer.from(token.split('.')[2], 'base64url').toString('utf8').includes('clickup-token-123'));
});

test('a tampered token is rejected', () => {
  const token = sealToken('access', { a: 1 }, 60, SECRET);
  const parts = token.split('.');
  for (const index of [1, 2, 3]) {
    const bytes = Buffer.from(parts[index], 'base64url');
    bytes[0] ^= 0xff;
    const tampered = [...parts];
    tampered[index] = bytes.toString('base64url');
    assert.throws(() => openToken('access', tampered.join('.'), SECRET), TokenError, `part ${index}`);
  }
});

test('garbage and truncated tokens are rejected', () => {
  const token = sealToken('access', { a: 1 }, 60, SECRET);
  for (const bad of ['', 'nope', 'v1.a.b', 'v2.a.b.c', token.slice(0, -4), token + 'x', `${token}.extra`]) {
    assert.throws(() => openToken('access', bad, SECRET), TokenError, bad);
  }
});

test('a token only opens for the purpose it was sealed for', () => {
  const token = sealToken('refresh', { a: 1 }, 60, SECRET);
  assert.throws(() => openToken('access', token, SECRET), TokenError);
  assert.throws(() => openToken('client', token, SECRET), TokenError);
  assert.equal(openToken('refresh', token, SECRET).a, 1);
});

test('a token does not open with another secret', () => {
  const token = sealToken('access', { a: 1 }, 60, SECRET);
  assert.throws(() => openToken('access', token, SECRET + 'x'), TokenError);
});

test('an expired token is rejected', () => {
  const token = sealToken('access', { a: 1 }, -1, SECRET);
  assert.throws(() => openToken('access', token, SECRET), /expired/);
});

test('a token expires once its ttl has passed', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const token = sealToken('access', { a: 1 }, 10, SECRET);
  t.mock.timers.setTime(1_700_000_005_000);
  assert.equal(openToken('access', token, SECRET).a, 1);
  t.mock.timers.setTime(1_700_000_011_000);
  assert.throws(() => openToken('access', token, SECRET), /expired/);
});

test('the secret falls back to MCP_TOKEN_SECRET and must be long enough', () => {
  const previous = process.env.MCP_TOKEN_SECRET;
  try {
    process.env.MCP_TOKEN_SECRET = SECRET;
    assert.equal(openToken('access', sealToken('access', { a: 1 }, 60)).a, 1);
    process.env.MCP_TOKEN_SECRET = 'short';
    assert.throws(() => sealToken('access', { a: 1 }, 60), /MCP_TOKEN_SECRET/);
    delete process.env.MCP_TOKEN_SECRET;
    assert.throws(() => sealToken('access', { a: 1 }, 60), /MCP_TOKEN_SECRET/);
  } finally {
    if (previous === undefined) delete process.env.MCP_TOKEN_SECRET;
    else process.env.MCP_TOKEN_SECRET = previous;
  }
});
