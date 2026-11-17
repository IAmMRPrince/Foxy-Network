// ==============================================================================
// Foxy Finance demo workload
// Shows how Foxy Finance consumes Foxy Network: it submits real catalogue jobs
// through the signed partner API and prints what the donor nodes return.
//
// It is a DEMO driver for local development. In production these calls are made
// from the Foxy Finance backend (see docs/FOXY_FINANCE_INTEGRATION.md).
// ==============================================================================

import { pathToFileURL } from 'node:url';
import { FoxyNetworkClient } from './network-client.js';
import { loadOrCreateSecret } from '../../foxy-security/src/index.js';

export { FoxyNetworkClient, FoxyNetworkError } from './network-client.js';

const CONTROLLER_URL = process.env.FOXY_CONTROLLER_URL || 'http://127.0.0.1:4000';
const INTERVAL_MS = parseInt(process.env.FOXY_FINANCE_DEMO_INTERVAL_MS || '25000', 10);

const DEMO_JOBS = [
  () => ['monte_carlo_gbm', { paths: 50000, steps: 30, s0: 100, mu: 0.08, sigma: 0.45, seed: Date.now() % 0xFFFFFFFF }],
  () => ['matrix_benchmark', { size: 128, seed: Date.now() % 0xFFFFFFFF }],
  () => ['sha256_benchmark', { iterations: 200000, seed: Date.now() % 0xFFFFFFFF }]
];

async function runDemoJob(client) {
  const [type, params] = DEMO_JOBS[Math.floor(Math.random() * DEMO_JOBS.length)]();
  try {
    const job = await client.runJob(type, params, { timeoutMs: 60000 });
    if (job.status === 'COMPLETED') {
      console.log(`[Foxy Finance 📈] ${type} completado (${job.computeUnits} unidades):`, JSON.stringify(job.result));
    } else {
      console.log(`[Foxy Finance 📈] ${type} falló: ${job.error}`);
    }
  } catch (err) {
    // No nodes online yet, or the controller is still starting
    console.log(`[Foxy Finance 📈] ${type} pendiente: ${err.message}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const client = new FoxyNetworkClient({
    baseUrl: CONTROLLER_URL,
    keyId: process.env.FOXY_FINANCE_KEY_ID || 'foxy-finance',
    // Local development: the controller on this machine created this secret.
    secret: loadOrCreateSecret('finance-api-secret', { envVar: 'FOXY_FINANCE_API_SECRET' })
  });

  console.log(`[Foxy Finance 📈] Demo de cómputo conectada a ${CONTROLLER_URL} (un trabajo cada ${INTERVAL_MS / 1000}s)`);
  setTimeout(() => runDemoJob(client), 8000);
  setInterval(() => runDemoJob(client), INTERVAL_MS);
}
