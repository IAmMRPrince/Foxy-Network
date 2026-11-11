import test from 'node:test';
import assert from 'node:assert/strict';
import {
  issueSubdomainToken, verifySubdomainToken, issueNodeToken, verifyNodeToken,
  signRequestHeaders, verifyRequestSignature, safeEqual, createNodeKeypair, signData, verifyData
} from '../packages/foxy-security/src/index.js';

const SECRET = 'test-secret-a';
const lower = (h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

test('subdomain tokens verify only with the right secret, subdomain and scope', () => {
  const token = issueSubdomainToken({ nodeId: 'node-1', subdomain: 'Shop', secret: SECRET });
  assert.equal(verifySubdomainToken(token, 'shop', SECRET).valid, true);
  assert.equal(verifySubdomainToken(token, 'other', SECRET).valid, false);
  assert.equal(verifySubdomainToken(token, 'shop', 'another-secret').valid, false);
  assert.equal(verifySubdomainToken('a.b.c', 'shop', SECRET).valid, false);
  assert.equal(verifySubdomainToken(null, 'shop', SECRET).valid, false);
  // A subdomain token is not a node identity, and vice versa
  assert.equal(verifyNodeToken(token, null, SECRET).valid, false);
  assert.equal(verifySubdomainToken(issueNodeToken({ nodeId: 'shop', secret: SECRET }), 'shop', SECRET).valid, false);
});

test('a tampered token payload is rejected', () => {
  const token = issueNodeToken({ nodeId: 'node-1', secret: SECRET });
  const [h, , s] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'node-2', scope: 'foxy:node', exp: 9999999999 })).toString('base64url');
  assert.equal(verifyNodeToken(`${h}.${forged}.${s}`, null, SECRET).valid, false);
});

test('node tokens are bound to their node and expire', () => {
  const token = issueNodeToken({ nodeId: 'node-1', secret: SECRET });
  assert.equal(verifyNodeToken(token, 'node-1', SECRET).valid, true);
  assert.equal(verifyNodeToken(token, 'node-2', SECRET).valid, false);
  const expired = issueNodeToken({ nodeId: 'node-1', secret: SECRET, expiresInSeconds: -10 });
  assert.equal(verifyNodeToken(expired, 'node-1', SECRET).valid, false);
});

test('request signatures cover method, path, body and time', () => {
  const base = { secret: SECRET, expectedKeyId: 'foxy-finance', method: 'POST', path: '/api/partner/v1/jobs', body: '{"a":1}' };
  const headers = lower(signRequestHeaders({ keyId: 'foxy-finance', ...base }));

  assert.equal(verifyRequestSignature({ ...base, headers }).valid, true);
  assert.equal(verifyRequestSignature({ ...base, headers, body: '{"a":2}' }).valid, false);
  assert.equal(verifyRequestSignature({ ...base, headers, path: '/api/partner/v1/links/redeem' }).valid, false);
  assert.equal(verifyRequestSignature({ ...base, headers, method: 'GET' }).valid, false);
  assert.equal(verifyRequestSignature({ ...base, headers, secret: 'wrong' }).valid, false);
  assert.equal(verifyRequestSignature({ ...base, headers, expectedKeyId: 'someone-else' }).valid, false);
  assert.equal(verifyRequestSignature({ ...base, headers: {} }).valid, false);
  // A captured request cannot be replayed after the time window
  const later = Math.floor(Date.now() / 1000) + 3600;
  assert.equal(verifyRequestSignature({ ...base, headers, now: later }).valid, false);
});

test('safeEqual and Ed25519 helpers', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  const { publicKey, privateKey } = createNodeKeypair();
  const sig = signData(privateKey, { hello: 'world' });
  assert.equal(verifyData(publicKey, { hello: 'world' }, sig), true);
  assert.equal(verifyData(publicKey, { hello: 'mars' }, sig), false);
});
