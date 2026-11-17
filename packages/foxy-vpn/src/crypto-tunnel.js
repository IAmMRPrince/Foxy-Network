// ==============================================================================
// Foxy Network - dVPN Cryptographic Tunnel Protocol
//
// Key agreement: ephemeral X25519 (one keypair per session on each side).
// Key derivation: HKDF-SHA256 bound to the sessionId.
// Transport:      AES-256-GCM with a random 96-bit nonce per frame.
//
// The gateway only relays the two public keys and the ciphertext, so it cannot
// read the traffic by observing it. NOTE: the exchange is not authenticated
// yet (the relay's public key is not signed by a known node identity), so a
// malicious gateway could still run an active man-in-the-middle. Destination
// traffic that is itself TLS (HTTPS) remains protected end to end regardless.
// ==============================================================================

import crypto from 'node:crypto';

const HKDF_INFO_PREFIX = 'foxy-dvpn-v2-session:';

export class CryptoTunnel {
  /** Creates an ephemeral X25519 keypair. `publicKey` is base64 (raw 32 bytes). */
  static createEphemeralKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    const rawPublic = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    return { privateKey, publicKey: rawPublic.toString('base64') };
  }

  /** Derives the 256-bit session key from our private key and the peer's public key. */
  static deriveSessionKey(privateKey, peerPublicKeyBase64, sessionId) {
    const raw = Buffer.from(String(peerPublicKeyBase64 || ''), 'base64');
    if (raw.length !== 32) {
      throw new Error('Clave pública X25519 inválida');
    }
    // SPKI DER prefix for an X25519 public key
    const spkiPrefix = Buffer.from('302a300506032b656e032100', 'hex');
    const peerKey = crypto.createPublicKey({
      key: Buffer.concat([spkiPrefix, raw]),
      format: 'der',
      type: 'spki'
    });
    const shared = crypto.diffieHellman({ privateKey, publicKey: peerKey });
    return Buffer.from(
      crypto.hkdfSync('sha256', shared, Buffer.alloc(0), `${HKDF_INFO_PREFIX}${sessionId}`, 32)
    );
  }

  /** Encrypts a raw buffer into an AES-256-GCM authenticated payload */
  static encrypt(buffer, key) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
    return {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64')
    };
  }

  /** Decrypts an authenticated AES-256-GCM payload back to raw buffer */
  static decrypt(payload, key) {
    const iv = Buffer.from(payload.iv, 'base64');
    const tag = Buffer.from(payload.tag, 'base64');
    const data = Buffer.from(payload.data, 'base64');
    if (iv.length !== 12 || tag.length !== 16) {
      throw new Error('Trama cifrada malformada');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  }
}
