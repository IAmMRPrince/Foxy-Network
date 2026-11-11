// Runs one deterministic catalogue job off the main thread, so a long
// computation never delays heartbeats or tunnel traffic.
import { parentPort, workerData } from 'node:worker_threads';
import { runDeterministicJob } from '../../foxy-jobs/src/index.js';

try {
  parentPort.postMessage({ result: runDeterministicJob(workerData.type, workerData.params) });
} catch (err) {
  parentPort.postMessage({ error: err.message });
}
