// ==============================================================================
// Foxy Network partner client (JavaScript)
// What Foxy Finance uses to talk to a Foxy Network controller. Every request is
// signed with HMAC-SHA256; the shared secret never travels over the wire.
// A Python version with the same interface lives in integrations/python/.
// ==============================================================================

import crypto from 'node:crypto';

export class FoxyNetworkError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'FoxyNetworkError';
    this.status = status;
    this.body = body;
  }
}

export class FoxyNetworkClient {
  /**
   * @param {object} options
   * @param {string} options.baseUrl  controller URL, e.g. https://controller.example.com
   * @param {string} options.secret   shared partner secret (FOXY_FINANCE_API_SECRET)
   * @param {string} [options.keyId]  partner key id (default "foxy-finance")
   */
  constructor({ baseUrl, secret, keyId = 'foxy-finance', timeoutMs = 15000 }) {
    if (!baseUrl || !secret) throw new Error('baseUrl y secret son obligatorios');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.secret = secret;
    this.keyId = keyId;
    this.timeoutMs = timeoutMs;
  }

  sign(method, path, body, timestamp = Math.floor(Date.now() / 1000)) {
    const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
    const canonical = `${timestamp}.${method.toUpperCase()}.${path}.${bodyHash}`;
    return {
      'X-Foxy-Key-Id': this.keyId,
      'X-Foxy-Timestamp': String(timestamp),
      'X-Foxy-Signature': crypto.createHmac('sha256', this.secret).update(canonical).digest('hex')
    };
  }

  async request(method, path, payload = null) {
    const body = payload === null ? '' : JSON.stringify(payload);
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { ...this.sign(method, path, body), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body || undefined,
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty or non-JSON body */ }
    if (!res.ok) {
      throw new FoxyNetworkError(data?.error || `HTTP ${res.status}`, res.status, data);
    }
    return data;
  }

  /** Online capacity, available job types and the benefit matrix. */
  getNetwork() {
    return this.request('GET', '/api/partner/v1/network');
  }

  /** Binds the node behind a donor's one-time code to one of your users. */
  redeemLinkCode(code, userId) {
    return this.request('POST', '/api/partner/v1/links/redeem', { code, userId });
  }

  revokeLink(nodeId, userId) {
    return this.request('POST', '/api/partner/v1/links/revoke', { nodeId, userId });
  }

  /** Discount and plan a user has earned with the hardware they contribute. */
  getUserBenefits(userId) {
    return this.request('GET', `/api/partner/v1/users/${encodeURIComponent(userId)}/benefits`);
  }

  /** Plans this user paid by burning $FOXY from a linked node. */
  getUserPayments(userId) {
    return this.request('GET', `/api/partner/v1/users/${encodeURIComponent(userId)}/payments`);
  }

  /**
   * Submits a compute job from the network's catalogue.
   * @param {string} type  sha256_benchmark | matrix_benchmark | monte_carlo_gbm | latency_probe
   * @param {object} params
   * @param {object} [options] replicas (1-3), externalRef, idempotencyKey, billingUsd
   */
  async submitJob(type, params = {}, options = {}) {
    const data = await this.request('POST', '/api/partner/v1/jobs', { type, params, ...options });
    return data.job;
  }

  async getJob(jobId) {
    const data = await this.request('GET', `/api/partner/v1/jobs/${encodeURIComponent(jobId)}`);
    return data.job;
  }

  /** Polls until the job finishes. Resolves with the job; throws on timeout. */
  async waitForJob(jobId, { timeoutMs = 120000, intervalMs = 1500 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await this.getJob(jobId);
      if (job.status === 'COMPLETED' || job.status === 'FAILED') return job;
      if (Date.now() > deadline) throw new FoxyNetworkError(`El trabajo ${jobId} no terminó a tiempo`, 408, job);
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }

  /** Convenience: submit and wait. */
  async runJob(type, params = {}, options = {}) {
    const job = await this.submitJob(type, params, options);
    return this.waitForJob(job.id, options);
  }
}
