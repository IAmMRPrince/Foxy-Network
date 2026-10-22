// ==============================================================================
// Foxy Network - dVPN Donor Exit Relay
// Secure, Encrypted, Firewall-Protected Egress Gateway running on Donor Nodes
// ==============================================================================

import net from 'node:net';
import { CryptoTunnel } from './crypto-tunnel.js';

// Safe outbound ports allowed on donor nodes (protects donor IP from spam & abusive scans)
const ALLOWED_PORTS = new Set([
  80,   // HTTP
  443,  // HTTPS
  8080, // HTTP Alternate
  8443, // HTTPS Alternate
  53,   // DNS
  3000, 5000, 8000, 8888, 9000 // Common Web APIs & Microservices
]);

const BLOCKED_PORTS = new Set([
  25, 465, 587, // SMTP Mail Spam Prevention
  22,           // SSH Brute-force Prevention
  445, 139,     // Windows SMB / NetBIOS
  23            // Telnet
]);

export class VpnRelay {
  constructor(sharedSecret = 'foxy-depin-cluster-shared-secret-v1') {
    this.sharedSecret = sharedSecret;
    this.activeSessions = new Map(); // sessionId -> { socket, sessionKey, targetHost, targetPort, bytesIn, bytesOut }
    this.totalBytesRouted = 0;
  }

  /**
   * Evaluates if target host/port is safe for the donor node to route
   */
  isTargetAllowed(host, port) {
    const numPort = parseInt(port, 10);
    if (BLOCKED_PORTS.has(numPort)) return false;
    if (ALLOWED_PORTS.has(numPort)) return true;
    // Allow general high web ports > 1024 except blocked ones
    return numPort > 1024 && !BLOCKED_PORTS.has(numPort);
  }

  /**
   * Handles initiating an encrypted TCP stream to a remote host
   */
  handleConnect(sessionId, targetHost, targetPort, sendCallback) {
    if (!this.isTargetAllowed(targetHost, targetPort)) {
      sendCallback({
        type: 'VPN_ERROR',
        sessionId,
        error: `Puerto de destino :${targetPort} bloqueado por la política de seguridad del donante`
      });
      return;
    }

    const sessionKey = CryptoTunnel.deriveKey(this.sharedSecret, sessionId);

    try {
      const socket = net.createConnection({ host: targetHost, port: targetPort }, () => {
        sendCallback({
          type: 'VPN_CONNECTED',
          sessionId,
          targetHost,
          targetPort
        });
      });

      socket.on('data', (chunk) => {
        this.totalBytesRouted += chunk.length;
        const session = this.activeSessions.get(sessionId);
        if (session) session.bytesIn += chunk.length;

        // Encrypt the incoming response before sending back over WebSocket tunnel
        const encrypted = CryptoTunnel.encrypt(chunk, sessionKey);
        sendCallback({
          type: 'VPN_DATA_STREAM',
          sessionId,
          payload: encrypted
        });
      });

      socket.on('end', () => {
        sendCallback({ type: 'VPN_CLOSED', sessionId });
        this.activeSessions.delete(sessionId);
      });

      socket.on('error', (err) => {
        sendCallback({ type: 'VPN_ERROR', sessionId, error: err.message });
        this.activeSessions.delete(sessionId);
      });

      socket.setTimeout(30000, () => {
        socket.destroy();
        this.activeSessions.delete(sessionId);
      });

      this.activeSessions.set(sessionId, {
        socket,
        sessionKey,
        targetHost,
        targetPort,
        bytesIn: 0,
        bytesOut: 0,
        createdAt: Date.now()
      });
    } catch (err) {
      sendCallback({ type: 'VPN_ERROR', sessionId, error: err.message });
    }
  }

  /**
   * Handles incoming encrypted stream from client destined for target host
   */
  handleData(sessionId, encryptedPayload) {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.socket || session.socket.destroyed) {
      return false;
    }

    try {
      const decrypted = CryptoTunnel.decrypt(encryptedPayload, session.sessionKey);
      this.totalBytesRouted += decrypted.length;
      session.bytesOut += decrypted.length;
      session.socket.write(decrypted);
      return true;
    } catch (err) {
      console.error(`[VPN Relay] Failed to decrypt client frame: ${err.message}`);
      return false;
    }
  }

  /**
   * Closes a specific session
   */
  closeSession(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (session && session.socket) {
      session.socket.destroy();
      this.activeSessions.delete(sessionId);
    }
  }

  /**
   * Closes all active sessions
   */
  destroy() {
    for (const [id, session] of this.activeSessions.entries()) {
      if (session.socket) session.socket.destroy();
    }
    this.activeSessions.clear();
  }
}
