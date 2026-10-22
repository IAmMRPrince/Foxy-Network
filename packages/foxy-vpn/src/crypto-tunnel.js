// ==============================================================================
// Foxy Network - dVPN Cryptographic Tunnel Protocol (AES-256-GCM)
// Zero-Knowledge Encapsulation between VPN Client and Donor Exit Node
// ==============================================================================

import crypto from 'node:crypto';

export class CryptoTunnel {
  /**
   * Derives a deterministic 256-bit symmetric session key for a VPN session
   */
  static deriveKey(sharedSecret, sessionId) {
    return crypto.createHmac('sha256', sharedSecret)
      .update(`foxy-dvpn-session-key-${sessionId}`)
      .digest();
  }

  /**
   * Encrypts a raw buffer into an AES-256-GCM authenticated payload
   */
  static encrypt(buffer, key) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: encrypted.toString('base64')
    };
  }

  /**
   * Decrypts an authenticated AES-256-GCM payload back to raw buffer
   */
  static decrypt(payload, key) {
    const iv = Buffer.from(payload.iv, 'base64');
    const tag = Buffer.from(payload.tag, 'base64');
    const data = Buffer.from(payload.data, 'base64');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(data), decipher.final()]);
  }
}
