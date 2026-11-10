// ==============================================================================
// Foxy Network - Partner bridge (Foxy Finance <-> Foxy Network)
//
//   * Account linking: a donor proves control of a node with a one-time code,
//     and the partner binds it to one of its own user ids.
//   * Benefits: the partner asks which discount a user has earned with the
//     hardware they contribute.
//   * Compute jobs: the partner submits jobs from the fixed catalogue in
//     foxy-jobs; nodes run them and are paid per verified compute unit.
// ==============================================================================

import crypto from 'node:crypto';
import { normalizeJob, resultFingerprint } from '../../foxy-jobs/src/index.js';
import { PREMIUM_PLANS } from './premium-tiers.js';

export const DEVICE_CLASSES = ['IOT', 'MOBILE', 'SBC', 'PC', 'SERVER'];

// Benefit matrix agreed with Foxy Finance (discount on its subscription).
export const BENEFIT_MATRIX = {
  IOT:    { discountPercent: 15,  plan: null,        label: 'Microcontrolador / IoT' },
  MOBILE: { discountPercent: 25,  plan: null,        label: 'Celular Android (Termux)' },
  SBC:    { discountPercent: 50,  plan: null,        label: 'Raspberry Pi / SBC' },
  PC:     { discountPercent: 70,  plan: null,        label: 'Computador personal / laptop' },
  SERVER: { discountPercent: 100, plan: 'PRO_QUANT', label: 'Servidor VPS / bare metal' }
};

export const ELIGIBILITY = {
  MIN_UPTIME_RATIO_24H: 0.5,          // online at least half of the last 24 h
  MAX_SECONDS_SINCE_HEARTBEAT: 15 * 60,
  SERVER_MIN_CORES: 4,
  SERVER_MIN_RAM_MB: 7600             // "8 GB" machines report slightly less
};

const LINK_CODE_TTL_MS = 10 * 60 * 1000;
const LINK_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const MAX_LINK_ATTEMPTS = 5;
const JOB_ATTEMPT_TIMEOUT_MS = 90 * 1000;
const JOB_MAX_AGE_MS = 10 * 60 * 1000;
const JOB_RETENTION_MS = 60 * 60 * 1000;
const MAX_STORED_JOBS = 2000;
const USER_ID_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;

/** Class a node is credited with, after sanity-checking what it declared. */
export function effectiveDeviceClass(declared, specs = {}) {
  const cls = DEVICE_CLASSES.includes(declared) ? declared : 'PC';
  if (cls === 'SERVER') {
    const cores = Number(specs.cores) || 0;
    const ram = Number(specs.totalRamMb) || 0;
    if (cores < ELIGIBILITY.SERVER_MIN_CORES || ram < ELIGIBILITY.SERVER_MIN_RAM_MB) return 'PC';
  }
  return cls;
}

export class FinanceBridge {
  /**
   * @param {object} deps
   * @param {Map} deps.nodes live node registry (nodeId -> node record)
   * @param {import('./ledger.js').FoxyLedger} deps.ledger
   * @param {(job: object) => void} [deps.onJobSettled] called once per finished job
   * @param {() => void} [deps.onChange]
   * @param {object} [deps.snapshot]
   */
  constructor({ nodes, ledger, onJobSettled = () => {}, onChange = () => {}, snapshot = null }) {
    this.nodes = nodes;
    this.ledger = ledger;
    this.onJobSettled = onJobSettled;
    this.onChange = onChange;

    this.linkCodes = new Map();  // code -> { nodeId, expiresAt, attempts }
    this.linksByNode = new Map(); // nodeId -> { userId, linkedAt }
    this.jobs = new Map();        // jobId -> job
    this.idempotency = new Map(); // idempotencyKey -> jobId
    this.redeemFailures = new Map(); // userId -> { count, resetAt }
    this.payments = Array.isArray(snapshot?.payments) ? snapshot.payments : []; // $FOXY payments, newest last

    for (const link of snapshot?.links || []) {
      if (link?.nodeId && link?.userId) {
        this.linksByNode.set(link.nodeId, { userId: link.userId, linkedAt: link.linkedAt });
      }
    }
  }

  serialize() {
    return {
      links: Array.from(this.linksByNode, ([nodeId, l]) => ({ nodeId, userId: l.userId, linkedAt: l.linkedAt })),
      payments: this.payments
    };
  }

  // ---------------------------------------------------------------- linking

  /** Called by an authenticated node: returns a short one-time code. */
  createLinkCode(nodeId) {
    const now = Date.now();
    for (const [code, entry] of this.linkCodes) {
      if (entry.expiresAt < now || entry.nodeId === nodeId) this.linkCodes.delete(code);
    }
    let code = '';
    for (const byte of crypto.randomBytes(10)) code += LINK_CODE_ALPHABET[byte % LINK_CODE_ALPHABET.length];
    code = `${code.slice(0, 5)}-${code.slice(5)}`;
    const expiresAt = now + LINK_CODE_TTL_MS;
    this.linkCodes.set(code, { nodeId, expiresAt });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Called by the partner: binds the node behind `code` to `userId`. */
  redeemLinkCode(code, userId) {
    if (!USER_ID_RE.test(String(userId || ''))) {
      return { ok: false, status: 400, error: 'userId inválido' };
    }
    const now = Date.now();
    const failures = this.redeemFailures.get(userId);
    if (failures && failures.resetAt > now && failures.count >= MAX_LINK_ATTEMPTS) {
      return { ok: false, status: 429, error: 'Demasiados intentos fallidos. Espera unos minutos.' };
    }

    const normalized = String(code || '').trim().toUpperCase();
    const entry = this.linkCodes.get(normalized);
    if (!entry || entry.expiresAt < now) {
      if (entry) this.linkCodes.delete(normalized);
      const next = failures && failures.resetAt > now ? failures : { count: 0, resetAt: now + LINK_CODE_TTL_MS };
      next.count++;
      this.redeemFailures.set(userId, next);
      return { ok: false, status: 404, error: 'Código de vinculación inválido o expirado' };
    }

    this.linkCodes.delete(normalized); // one use only
    this.redeemFailures.delete(userId);

    const previous = this.linksByNode.get(entry.nodeId);
    this.linksByNode.set(entry.nodeId, { userId, linkedAt: new Date().toISOString() });
    this.onChange();
    return {
      ok: true,
      nodeId: entry.nodeId,
      userId,
      replacedUserId: previous && previous.userId !== userId ? previous.userId : null
    };
  }

  /** Removes a link. The partner may only unlink nodes of the user it names. */
  unlink(nodeId, userId = null) {
    const link = this.linksByNode.get(nodeId);
    if (!link || (userId !== null && link.userId !== userId)) return false;
    this.linksByNode.delete(nodeId);
    this.onChange();
    return true;
  }

  getLink(nodeId) {
    return this.linksByNode.get(nodeId) || null;
  }

  // --------------------------------------------------------------- benefits

  describeNode(nodeId) {
    const node = this.nodes.get(nodeId);
    const now = Date.now();
    const secondsSinceHeartbeat = node ? Math.round((now - node.lastHeartbeat) / 1000) : null;
    const online = !!node && node.status === 'ONLINE';
    const deviceClass = node ? effectiveDeviceClass(node.deviceClass, node.specs) : null;
    const uptimeRatio24h = Number(this.ledger.getUptimeRatio(nodeId, 24).toFixed(4));

    let eligible = true;
    let reason = null;
    if (!node) {
      eligible = false;
      reason = 'NODE_NOT_SEEN';
    } else if (secondsSinceHeartbeat > ELIGIBILITY.MAX_SECONDS_SINCE_HEARTBEAT) {
      eligible = false;
      reason = 'NODE_OFFLINE';
    } else if (uptimeRatio24h < ELIGIBILITY.MIN_UPTIME_RATIO_24H) {
      eligible = false;
      reason = 'UPTIME_BELOW_MINIMUM';
    }

    const account = this.ledger.accounts.get(nodeId);
    return {
      nodeId,
      name: node?.name || null,
      online,
      secondsSinceHeartbeat,
      deviceClass,
      declaredDeviceClass: node?.deviceClass || null,
      specs: node ? { cores: node.specs?.cores ?? null, totalRamMb: node.specs?.totalRamMb ?? null, platform: node.specs?.platform ?? null } : null,
      uptimeRatio24h,
      uptimeRatio7d: Number(this.ledger.getUptimeRatio(nodeId, 168).toFixed(4)),
      lifetimeComputeUnits: account?.lifetimeComputeUnits || 0,
      eligible,
      ineligibleReason: reason,
      benefit: eligible ? BENEFIT_MATRIX[deviceClass] : null
    };
  }

  /** Benefits a partner user has earned across all the nodes linked to them. */
  getUserBenefits(userId) {
    const nodes = [];
    for (const [nodeId, link] of this.linksByNode) {
      if (link.userId === userId) nodes.push({ ...this.describeNode(nodeId), linkedAt: link.linkedAt });
    }

    let best = null;
    for (const n of nodes) {
      if (n.eligible && (!best || n.benefit.discountPercent > best.benefit.discountPercent)) best = n;
    }

    return {
      userId,
      linkedNodes: nodes.length,
      eligibleNodes: nodes.filter(n => n.eligible).length,
      discountPercent: best ? best.benefit.discountPercent : 0,
      grantedPlan: best ? best.benefit.plan : null,
      grantingNodeId: best ? best.nodeId : null,
      // Benefits depend on the node staying online: re-check before each billing cycle.
      evaluatedAt: new Date().toISOString(),
      nodes
    };
  }

  // --------------------------------------------------------------- payments

  /**
   * A linked node pays a Foxy Finance plan with its unclaimed $FOXY balance.
   * The tokens are burned in the ledger and the partner sees the payment
   * under the user the node is linked to.
   */
  payPlanWithFoxy(nodeId, planId) {
    const link = this.linksByNode.get(nodeId);
    if (!link) return { ok: false, status: 409, error: 'Vincula primero este nodo con tu cuenta de Foxy Finance' };
    const plan = Object.hasOwn(PREMIUM_PLANS, planId) ? PREMIUM_PLANS[planId] : null;
    if (!plan || !(plan.priceFoxy > 0)) return { ok: false, status: 400, error: `Plan no disponible para pago en $FOXY: ${planId}` };

    const burn = this.ledger.burnForService(nodeId, plan.priceFoxy, `PLAN:${plan.id}`);
    if (!burn.success) return { ok: false, status: 402, error: burn.error };

    const payment = {
      id: `pay-${crypto.randomUUID()}`,
      userId: link.userId,
      nodeId,
      planId: plan.id,
      amountFoxy: plan.priceFoxy,
      listPriceUsd: plan.priceUsd,
      settlement: 'OFFCHAIN_LEDGER_BURN',
      paidAt: new Date().toISOString()
    };
    this.payments.push(payment);
    if (this.payments.length > 5000) this.payments.shift();
    this.onChange();
    return { ok: true, payment, balance: burn.balance };
  }

  getUserPayments(userId) {
    return this.payments.filter(p => p.userId === userId);
  }

  // ------------------------------------------------------------------- jobs

  /** Nodes that may take partner jobs right now. */
  onlineNodeIds() {
    return Array.from(this.nodes.values())
      .filter(n => n.status === 'ONLINE' && n.acceptsJobs !== false)
      .map(n => n.id);
  }

  submitJob({ type, params, replicas = 1, externalRef = null, idempotencyKey = null, billingUsd = null }) {
    if (idempotencyKey) {
      const existing = this.jobs.get(this.idempotency.get(idempotencyKey));
      if (existing) return { job: existing, created: false };
    }

    const spec = normalizeJob(type, params);
    const wanted = Number(replicas);
    if (!Number.isInteger(wanted) || wanted < 1 || wanted > 3) {
      throw new Error("'replicas' debe ser 1, 2 o 3");
    }
    if (wanted > 1 && !spec.deterministic) {
      throw new Error(`'${type}' mide la red de cada nodo: no admite réplicas comparables`);
    }
    if (this.jobs.size >= MAX_STORED_JOBS) {
      this.pruneJobs();
      if (this.jobs.size >= MAX_STORED_JOBS) throw new Error('Cola de trabajos llena. Reintenta más tarde.');
    }

    const job = {
      id: `job-${crypto.randomUUID()}`,
      type: spec.type,
      params: spec.params,
      deterministic: spec.deterministic,
      computeUnits: spec.computeUnits,
      replicas: wanted,
      externalRef: externalRef ? String(externalRef).slice(0, 128) : null,
      billingUsd: Number.isFinite(Number(billingUsd)) && Number(billingUsd) >= 0 ? Number(billingUsd) : null,
      status: 'QUEUED', // QUEUED | RUNNING | COMPLETED | FAILED
      createdAt: Date.now(),
      finishedAt: null,
      attempts: [],     // { nodeId, status: DISPATCHED|DONE|ERROR|TIMEOUT, dispatchedAt, finishedAt, result, error, durationMs }
      result: null,
      verification: null,
      error: null
    };
    this.jobs.set(job.id, job);
    if (idempotencyKey) this.idempotency.set(String(idempotencyKey).slice(0, 128), job.id);
    return { job, created: true };
  }

  /**
   * Called on each node heartbeat: returns the jobs this node should start.
   * A node never receives the same job twice.
   */
  takeJobsForNode(nodeId, maxJobs = 2) {
    this.expireAttempts();
    const out = [];
    const busy = Array.from(this.jobs.values())
      .filter(j => j.attempts.some(a => a.nodeId === nodeId && a.status === 'DISPATCHED')).length;

    for (const job of this.jobs.values()) {
      if (out.length + busy >= maxJobs) break;
      if (job.status !== 'QUEUED' && job.status !== 'RUNNING') continue;
      if (job.attempts.some(a => a.nodeId === nodeId)) continue;
      const live = job.attempts.filter(a => a.status === 'DISPATCHED' || a.status === 'DONE').length;
      if (live >= job.replicas) continue;

      job.attempts.push({ nodeId, status: 'DISPATCHED', dispatchedAt: Date.now(), finishedAt: null, result: null, error: null, durationMs: null });
      job.status = 'RUNNING';
      out.push({ type: 'RUN_JOB', jobId: job.id, jobType: job.type, params: job.params });
    }
    return out;
  }

  /** Called by an authenticated node with the outcome of a job. */
  submitResult(nodeId, jobId, { result = null, error = null, durationMs = null } = {}) {
    const job = this.jobs.get(jobId);
    const attempt = job?.attempts.find(a => a.nodeId === nodeId && a.status === 'DISPATCHED');
    if (!job || !attempt) return { ok: false, status: 404, error: 'Trabajo no asignado a este nodo' };

    attempt.finishedAt = Date.now();
    attempt.durationMs = Number.isFinite(Number(durationMs)) ? Math.max(0, Math.round(Number(durationMs))) : null;
    if (error || result === null || typeof result !== 'object') {
      attempt.status = 'ERROR';
      attempt.error = String(error || 'Resultado vacío').slice(0, 500);
    } else {
      attempt.status = 'DONE';
      attempt.result = result;
    }
    this.evaluate(job);
    return { ok: true, jobStatus: job.status };
  }

  expireAttempts() {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (job.status !== 'RUNNING' && job.status !== 'QUEUED') continue;
      let changed = false;
      for (const a of job.attempts) {
        if (a.status === 'DISPATCHED' && now - a.dispatchedAt > JOB_ATTEMPT_TIMEOUT_MS) {
          a.status = 'TIMEOUT';
          a.finishedAt = now;
          changed = true;
        }
      }
      if (changed) this.evaluate(job);
      if (!job.finishedAt && now - job.createdAt > JOB_MAX_AGE_MS) {
        this.finish(job, 'FAILED', { error: 'Ningún nodo completó el trabajo a tiempo', paid: [] });
      }
    }
    this.pruneJobs();
  }

  /** Decides whether a job is finished, and pays the nodes whose work stood. */
  evaluate(job) {
    if (job.status === 'COMPLETED' || job.status === 'FAILED') return;

    const done = job.attempts.filter(a => a.status === 'DONE');
    const pending = job.attempts.filter(a => a.status === 'DISPATCHED');
    const failed = job.attempts.filter(a => a.status === 'ERROR' || a.status === 'TIMEOUT');

    if (done.length >= job.replicas) {
      // Group identical results; with replicas the majority wins.
      const groups = new Map();
      for (const a of done) {
        const key = job.deterministic ? resultFingerprint(a.result) : a.nodeId;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(a);
      }
      const ranked = Array.from(groups.values()).sort((x, y) => y.length - x.length);
      const winners = ranked[0];
      const quorum = Math.floor(job.replicas / 2) + 1;

      if (job.replicas > 1 && winners.length < quorum) {
        return this.finish(job, 'FAILED', { error: 'Las réplicas no coincidieron: resultado descartado', paid: [] });
      }

      job.result = winners[0].result;
      job.verification = {
        mode: job.replicas > 1 ? 'REPLICATED' : 'SINGLE_NODE',
        agreeing: winners.length,
        replicas: job.replicas,
        dissentingNodes: done.filter(a => !winners.includes(a)).map(a => a.nodeId)
      };
      return this.finish(job, 'COMPLETED', { paid: winners });
    }

    // Not enough results yet. Give up once too many nodes have failed it.
    if (pending.length === 0 && failed.length >= job.replicas + 2) {
      return this.finish(job, 'FAILED', { error: failed[failed.length - 1].error || 'Los nodos no completaron el trabajo', paid: [] });
    }
    if (pending.length === 0) job.status = 'QUEUED';
  }

  finish(job, status, { error = null, paid = [] }) {
    job.status = status;
    job.error = error;
    job.finishedAt = Date.now();
    for (const attempt of paid) {
      this.ledger.recordCompute(attempt.nodeId, job.computeUnits);
      attempt.paidComputeUnits = job.computeUnits;
    }
    this.onJobSettled(job);
  }

  pruneJobs() {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      const stale = job.finishedAt && now - job.finishedAt > JOB_RETENTION_MS;
      const abandoned = !job.finishedAt && now - job.createdAt > JOB_RETENTION_MS;
      if (stale || abandoned) this.jobs.delete(id);
    }
    for (const [key, jobId] of this.idempotency) {
      if (!this.jobs.has(jobId)) this.idempotency.delete(key);
    }
  }

  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  /** Public view of a job for the partner. */
  describeJob(job) {
    return {
      id: job.id,
      type: job.type,
      params: job.params,
      status: job.status,
      computeUnits: job.computeUnits,
      replicas: job.replicas,
      externalRef: job.externalRef,
      createdAt: new Date(job.createdAt).toISOString(),
      finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
      result: job.result,
      verification: job.verification,
      error: job.error,
      attempts: job.attempts.map(a => ({
        nodeId: a.nodeId,
        status: a.status,
        durationMs: a.durationMs,
        paidComputeUnits: a.paidComputeUnits || 0,
        // For measurements each node's own reading is the result.
        result: job.deterministic ? undefined : a.result,
        error: a.error
      }))
    };
  }

  getStats() {
    const jobs = Array.from(this.jobs.values());
    const byClass = {};
    for (const node of this.nodes.values()) {
      if (node.status !== 'ONLINE') continue;
      const cls = effectiveDeviceClass(node.deviceClass, node.specs);
      byClass[cls] = (byClass[cls] || 0) + 1;
    }
    return {
      onlineNodes: this.onlineNodeIds().length,
      onlineNodesByClass: byClass,
      linkedNodes: this.linksByNode.size,
      jobs: {
        queued: jobs.filter(j => j.status === 'QUEUED').length,
        running: jobs.filter(j => j.status === 'RUNNING').length,
        completed: jobs.filter(j => j.status === 'COMPLETED').length,
        failed: jobs.filter(j => j.status === 'FAILED').length
      }
    };
  }
}
