// ==============================================================================
// Foxy Network - Donor job runner
// Executes compute jobs from the fixed catalogue in foxy-jobs. The controller
// sends a job type and parameters only: no code from the network is ever run.
// ==============================================================================

import net from 'node:net';
import { Worker } from 'node:worker_threads';
import { normalizeJob } from '../../foxy-jobs/src/index.js';
import { VpnRelay } from '../../foxy-vpn/src/relay.js';

const JOB_TIMEOUT_MS = 60000;
const PROBE_TIMEOUT_MS = 4000;

// Reuses the exit relay's destination firewall: probes may only reach public IPs.
const resolver = new VpnRelay();

function runInWorker(type, params) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./job-worker.js', import.meta.url), {
      workerData: { type, params },
      resourceLimits: { maxOldGenerationSizeMb: 256 }
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('El trabajo superó el tiempo máximo'));
    }, JOB_TIMEOUT_MS);

    worker.once('message', (msg) => {
      clearTimeout(timer);
      worker.terminate();
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.result);
    });
    worker.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function tcpConnectMs(address, port) {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const socket = net.createConnection({ host: address, port });
    const done = (ms) => {
      socket.destroy();
      resolve(ms);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(null));
    socket.once('connect', () => done(Number(process.hrtime.bigint() - start) / 1e6));
    socket.once('error', () => done(null));
  });
}

async function runLatencyProbe({ targets, samples }) {
  const results = [];
  for (const target of targets) {
    let address;
    try {
      address = await resolver.resolvePublicTarget(target.host);
    } catch (err) {
      results.push({ ...target, reachable: false, error: err.message });
      continue;
    }
    const timings = [];
    for (let i = 0; i < samples; i++) {
      const ms = await tcpConnectMs(address, target.port);
      if (ms !== null) timings.push(ms);
    }
    timings.sort((a, b) => a - b);
    results.push({
      ...target,
      reachable: timings.length > 0,
      samples: timings.length,
      minMs: timings.length ? Number(timings[0].toFixed(2)) : null,
      medianMs: timings.length ? Number(timings[Math.floor(timings.length / 2)].toFixed(2)) : null,
      maxMs: timings.length ? Number(timings[timings.length - 1].toFixed(2)) : null
    });
  }
  return { measuredAt: new Date().toISOString(), targets: results };
}

/**
 * Validates and runs a job. Parameters are re-validated here: the daemon never
 * trusts that the controller already checked them.
 */
export async function runJob(jobType, params) {
  const spec = normalizeJob(jobType, params);
  const started = Date.now();
  const result = spec.type === 'latency_probe'
    ? await runLatencyProbe(spec.params)
    : await runInWorker(spec.type, spec.params);
  return { result, durationMs: Date.now() - started };
}
