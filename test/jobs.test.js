import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeJob, runDeterministicJob, resultFingerprint, JOB_TYPES } from '../packages/foxy-jobs/src/index.js';

test('deterministic jobs give the same result for the same seed', () => {
  for (const [type, params] of [
    ['sha256_benchmark', { iterations: 5000, seed: 7 }],
    ['matrix_benchmark', { size: 24, seed: 7 }],
    ['monte_carlo_gbm', { paths: 2000, steps: 10, seed: 7 }]
  ]) {
    const a = runDeterministicJob(type, params);
    const b = runDeterministicJob(type, params);
    assert.equal(resultFingerprint(a), resultFingerprint(b), type);
    const c = runDeterministicJob(type, { ...params, seed: 8 });
    assert.notEqual(resultFingerprint(a), resultFingerprint(c), type);
  }
});

test('monte carlo output is statistically sane', () => {
  const r = runDeterministicJob('monte_carlo_gbm', { paths: 40000, steps: 20, s0: 100, mu: 0, sigma: 0.2, horizonYears: 1, seed: 3 });
  assert.ok(Math.abs(r.mean - 100) < 1.5, `mean ${r.mean}`);
  assert.ok(r.p1 < r.p5 && r.p5 < r.median && r.median < r.p95 && r.p95 < r.p99);
  assert.ok(r.valueAtRisk99 > r.valueAtRisk95 && r.valueAtRisk95 > 0);
  // Expected shortfall is always at least as bad as the VaR at the same level
  assert.ok(r.cvar95 >= r.valueAtRisk95 && r.cvar99 >= r.valueAtRisk99);
});

test('job parameters are validated and bounded', () => {
  assert.throws(() => normalizeJob('rm -rf', {}));
  assert.throws(() => normalizeJob('constructor', {}));
  assert.throws(() => normalizeJob('__proto__', {}));
  assert.throws(() => normalizeJob('sha256_benchmark', { iterations: 1e12 }));
  assert.throws(() => normalizeJob('sha256_benchmark', { iterations: '5000; evil' }));
  assert.throws(() => normalizeJob('matrix_benchmark', { size: 100000 }));
  assert.throws(() => normalizeJob('monte_carlo_gbm', { paths: 500000, steps: 365 }));
  assert.throws(() => normalizeJob('latency_probe', { targets: [] }));
  assert.throws(() => normalizeJob('latency_probe', { targets: [{ host: '127.0.0.1; rm', port: 443 }] }));
  assert.throws(() => normalizeJob('latency_probe', { targets: [{ host: 'api.example.com', port: 22 }] }));
  assert.throws(() => normalizeJob('latency_probe', { targets: Array(11).fill({ host: 'a.example.com' }) }));

  // Unknown fields never reach the node
  const spec = normalizeJob('sha256_benchmark', { iterations: 5000, seed: 1, extra: 'ignored', code: 'x' });
  assert.deepEqual(Object.keys(spec.params).sort(), ['iterations', 'seed']);
  assert.ok(spec.computeUnits >= 1);
  assert.equal(JOB_TYPES.latency_probe.deterministic, false);
});
