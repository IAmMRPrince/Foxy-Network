// ==============================================================================
// Foxy Network - Security primitives
//   1. Secret storage (never committed, never hardcoded)
//   2. Signed capability tokens (JWT HS256) for subdomains and node identity
//   3. HMAC request signing for service-to-service calls (Foxy Finance <-> Network)
//   4. Ed25519 node identities
// ==============================================================================

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** Directory for local runtime state and secrets. Ignored by git. */
export function getStateDir() {
  const dir = process.env.FOXY_STATE_DIR || path.join(REPO_ROOT, '.foxy');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Loads a secret from the environment, or from a 0600 file in the state dir.
 * If neither exists a random one is generated and persisted.
 */
export function loadOrCreateSecret(name, { envVar = null, bytes = 32 } = {}) {
  if (envVar && process.env[envVar]) return process.env[envVar].trim();

  const file = path.join(getStateDir(), name);
  try {
    const existing = fs.readFileSync(file, 'utf-8').trim();
    if (existing) return existing;
  } catch {
    // Not created yet
  }

  const generated = crypto.randomBytes(bytes).toString('hex');
  try {
    // 'wx' fails if another process created it first; then we read theirs.
    fs.writeFileSync(file, generated, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    return generated;
  } catch (err) {
    if (err.code === 'EEXIST') return fs.readFileSync(file, 'utf-8').trim();
    throw new Error(`No se pudo guardar el secreto '${name}' en ${file}: ${err.message}`);
  }
}

// -------------------------------------------------------------
// 1. Network authority secret (controller + gateway only)
// -------------------------------------------------------------
// Donor daemons and VPN clients must NOT hold this secret: they receive
// tokens signed by the controller instead.
export function getNetworkSecret() {
  return loadOrCreateSecret('network-secret', { envVar: 'FOXY_NETWORK_SECRET' });
}

// -------------------------------------------------------------
// 2. Base64Url helpers
// -------------------------------------------------------------
function base64urlEncode(data) {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  return buf.toString('base64url');
}

function base64urlDecode(str) {
  return Buffer.from(str, 'base64url').toString('utf-8');
}

/** Constant-time string comparison. */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// -------------------------------------------------------------
// 3. Signed tokens (JWT HS256)
// -------------------------------------------------------------
export const SCOPE_TUNNEL = 'foxy:tunnel:bind';
export const SCOPE_NODE = 'foxy:node';

function signToken(payload, secret) {
  const signingKey = secret || getNetworkSecret();
  const encodedHeader = base64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const encodedPayload = base64urlEncode(JSON.stringify(payload));
  const dataToSign = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.createHmac('sha256', signingKey).update(dataToSign).digest();
  return `${dataToSign}.${base64urlEncode(signature)}`;
}

function verifyToken(token, expectedScope, secret) {
  if (!token || typeof token !== 'string') {
    return { valid: false, error: 'Token missing or malformed' };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return { valid: false, error: 'Invalid JWT format' };
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const signingKey = secret || getNetworkSecret();
  const expectedSig = base64urlEncode(
    crypto.createHmac('sha256', signingKey).update(`${encodedHeader}.${encodedPayload}`).digest()
  );

  if (!safeEqual(encodedSignature, expectedSig)) {
    return { valid: false, error: 'Invalid cryptographic signature' };
  }

  let payload;
  try {
    payload = JSON.parse(base64urlDecode(encodedPayload));
  } catch (err) {
    return { valid: false, error: 'Failed to parse token payload: ' + err.message };
  }

  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    return { valid: false, error: 'Token has expired' };
  }
  if (payload.scope !== expectedScope) {
    return { valid: false, error: `Token scope '${payload.scope}' is not '${expectedScope}'` };
  }
  return { valid: true, payload };
}

/** Capability token granting a node the right to bind a subdomain on the gateway. */
export function issueSubdomainToken({ nodeId, subdomain, expiresInSeconds = 86400, secret }) {
  const now = Math.floor(Date.now() / 1000);
  return signToken({
    sub: subdomain.toLowerCase(),
    nodeId,
    iat: now,
    exp: now + expiresInSeconds,
    scope: SCOPE_TUNNEL
  }, secret);
}

export function verifySubdomainToken(token, expectedSubdomain = null, secret = null) {
  const result = verifyToken(token, SCOPE_TUNNEL, secret);
  if (!result.valid) return result;

  if (expectedSubdomain && result.payload.sub !== expectedSubdomain.toLowerCase()) {
    return {
      valid: false,
      error: `Token is for subdomain '${result.payload.sub}', but node requested '${expectedSubdomain}'`
    };
  }
  return result;
}

/** Identity token proving that the bearer is the donor node `nodeId`. */
export function issueNodeToken({ nodeId, expiresInSeconds = 365 * 86400, secret }) {
  const now = Math.floor(Date.now() / 1000);
  return signToken({ sub: nodeId, iat: now, exp: now + expiresInSeconds, scope: SCOPE_NODE }, secret);
}

export function verifyNodeToken(token, expectedNodeId = null, secret = null) {
  const result = verifyToken(token, SCOPE_NODE, secret);
  if (!result.valid) return result;
  if (expectedNodeId && result.payload.sub !== expectedNodeId) {
    return { valid: false, error: 'Token belongs to a different node' };
  }
  return result;
}

// -------------------------------------------------------------
// 4. HMAC request signing (partner / service-to-service API)
// -------------------------------------------------------------
// Signature = HMAC-SHA256(secret, `${timestamp}.${METHOD}.${path}.${sha256(body)}`)
// Sent as headers:
//   X-Foxy-Key-Id, X-Foxy-Timestamp (unix seconds), X-Foxy-Signature (hex)
export const SIGNATURE_MAX_SKEW_SECONDS = 300;

export function computeRequestSignature({ secret, timestamp, method, path: reqPath, body = '' }) {
  const bodyHash = crypto.createHash('sha256').update(body || '').digest('hex');
  const canonical = `${timestamp}.${String(method).toUpperCase()}.${reqPath}.${bodyHash}`;
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

export function signRequestHeaders({ keyId, secret, method, path: reqPath, body = '', timestamp = null }) {
  const ts = String(timestamp ?? Math.floor(Date.now() / 1000));
  return {
    'X-Foxy-Key-Id': keyId,
    'X-Foxy-Timestamp': ts,
    'X-Foxy-Signature': computeRequestSignature({ secret, timestamp: ts, method, path: reqPath, body })
  };
}

export function verifyRequestSignature({ headers, secret, expectedKeyId, method, path: reqPath, body = '', now = null }) {
  const keyId = headers['x-foxy-key-id'];
  const timestamp = headers['x-foxy-timestamp'];
  const signature = headers['x-foxy-signature'];

  if (!keyId || !timestamp || !signature) {
    return { valid: false, error: 'Missing X-Foxy-Key-Id, X-Foxy-Timestamp or X-Foxy-Signature header' };
  }
  if (!safeEqual(keyId, expectedKeyId)) {
    return { valid: false, error: 'Unknown key id' };
  }

  const ts = Number(timestamp);
  const current = now ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(current - ts) > SIGNATURE_MAX_SKEW_SECONDS) {
    return { valid: false, error: 'Timestamp outside the allowed window' };
  }

  const expected = computeRequestSignature({ secret, timestamp, method, path: reqPath, body });
  if (!safeEqual(signature, expected)) {
    return { valid: false, error: 'Invalid signature' };
  }
  return { valid: true };
}

// -------------------------------------------------------------
// 5. Ed25519 node identity
// -------------------------------------------------------------
export function createNodeKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  return { publicKey, privateKey };
}

export function signData(privateKeyPem, data) {
  const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  return crypto.sign(null, payload, privateKeyPem).toString('base64');
}

export function verifyData(publicKeyPem, data, signatureBase64) {
  try {
    const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
    return crypto.verify(null, payload, publicKeyPem, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}
