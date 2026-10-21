import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET_FILE = path.resolve(__dirname, '..', '..', '..', '.foxy-network-secret');

// -------------------------------------------------------------
// 1. Shared Network Authority Secret
// -------------------------------------------------------------
export function getNetworkSecret() {
  if (process.env.FOXY_NETWORK_SECRET) {
    return process.env.FOXY_NETWORK_SECRET;
  }

  try {
    if (fs.existsSync(SECRET_FILE)) {
      return fs.readFileSync(SECRET_FILE, 'utf-8').trim();
    }
  } catch {
    // Ignore error
  }

  // Generate deterministic secret for local network cluster if none exists
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(SECRET_FILE, generated, 'utf-8');
  } catch {
    // Ignore write failure if read-only
  }
  return generated;
}

// -------------------------------------------------------------
// 2. High-Performance Base64Url Helpers
// -------------------------------------------------------------
function base64urlEncode(data) {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  return buf.toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64urlDecode(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('utf-8');
}

// -------------------------------------------------------------
// 3. Cryptographic Capability Tokens (JWT HS256)
// -------------------------------------------------------------
/**
 * Issues a signed capability token granting a node the right to bind a subdomain.
 */
export function issueSubdomainToken({ nodeId, subdomain, expiresInSeconds = 86400, secret }) {
  const signingKey = secret || getNetworkSecret();
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);

  const payload = {
    sub: subdomain.toLowerCase(),
    nodeId,
    iat: now,
    exp: now + expiresInSeconds,
    scope: 'foxy:tunnel:bind'
  };

  const encodedHeader = base64urlEncode(JSON.stringify(header));
  const encodedPayload = base64urlEncode(JSON.stringify(payload));
  const dataToSign = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto.createHmac('sha256', signingKey)
    .update(dataToSign)
    .digest();

  const encodedSignature = base64urlEncode(signature);
  return `${dataToSign}.${encodedSignature}`;
}

/**
 * Validates a capability token presented by a node when requesting a tunnel.
 */
export function verifySubdomainToken(token, expectedSubdomain = null, secret = null) {
  if (!token || typeof token !== 'string') {
    return { valid: false, error: 'Token missing or malformed' };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return { valid: false, error: 'Invalid JWT format' };
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const signingKey = secret || getNetworkSecret();

  // Verify HMAC signature
  const expectedSig = base64urlEncode(
    crypto.createHmac('sha256', signingKey)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest()
  );

  if (encodedSignature !== expectedSig) {
    return { valid: false, error: 'Invalid cryptographic signature - Token forgery detected' };
  }

  try {
    const payload = JSON.parse(base64urlDecode(encodedPayload));
    const now = Math.floor(Date.now() / 1000);

    if (payload.exp && payload.exp < now) {
      return { valid: false, error: 'Token has expired' };
    }

    if (expectedSubdomain && payload.sub !== expectedSubdomain.toLowerCase()) {
      return {
        valid: false,
        error: `Token is for subdomain '${payload.sub}', but node requested '${expectedSubdomain}'`
      };
    }

    return { valid: true, payload };
  } catch (err) {
    return { valid: false, error: 'Failed to parse token payload: ' + err.message };
  }
}

// -------------------------------------------------------------
// 4. Ed25519 Asymmetric Node Identity
// -------------------------------------------------------------
export function createNodeKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  return { publicKey, privateKey };
}

export function signData(privateKeyPem, data) {
  const signer = crypto.createSign(null);
  signer.update(typeof data === 'string' ? data : JSON.stringify(data));
  return signer.sign(privateKeyPem).toString('base64');
}

export function verifyData(publicKeyPem, data, signatureBase64) {
  try {
    const verifier = crypto.createVerify(null);
    verifier.update(typeof data === 'string' ? data : JSON.stringify(data));
    return verifier.verify(publicKeyPem, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}
