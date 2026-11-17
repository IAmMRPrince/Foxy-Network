// ==============================================================================
// Foxy Network - Built-in compute job catalogue
//
// Partners (e.g. Foxy Finance) never ship code to donor nodes. They pick a job
// type from this fixed catalogue and send parameters only, so a donor machine
// runs nothing but the functions in this file, and no partner source code or
// market data ever leaves the partner's own servers.
//
// Every job except `latency_probe` is deterministic for a given `seed`, which
// lets the controller run the same job on several nodes and compare results.
// ==============================================================================

import crypto from 'node:crypto';

/** Small, fast, seedable PRNG (mulberry32). Deterministic across platforms. */
export function createRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function intParam(value, { name, min, max, fallback }) {
  const n = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`'${name}' debe ser un entero entre ${min} y ${max}`);
  }
  return n;
}

function numParam(value, { name, min, max, fallback }) {
  const n = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`'${name}' debe ser un número entre ${min} y ${max}`);
  }
  return n;
}

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export const JOB_TYPES = {
  // Chained SHA-256: CPU benchmark and proof of work done.
  sha256_benchmark: {
    deterministic: true,
    normalize(params = {}) {
      return {
        iterations: intParam(params.iterations, { name: 'iterations', min: 1000, max: 2_000_000, fallback: 200_000 }),
        seed: intParam(params.seed, { name: 'seed', min: 0, max: 0xFFFFFFFF, fallback: 1 })
      };
    },
    computeUnits: (p) => Math.max(1, Math.ceil(p.iterations / 200_000)),
    run({ iterations, seed }) {
      let digest = crypto.createHash('sha256').update(`foxy-sha256-benchmark:${seed}`).digest();
      for (let i = 0; i < iterations; i++) {
        digest = crypto.createHash('sha256').update(digest).digest();
      }
      return { digest: digest.toString('hex'), iterations };
    }
  },

  // Dense matrix multiplication on pseudo-random data: synthetic linear algebra.
  matrix_benchmark: {
    deterministic: true,
    normalize(params = {}) {
      return {
        size: intParam(params.size, { name: 'size', min: 8, max: 256, fallback: 96 }),
        seed: intParam(params.seed, { name: 'seed', min: 0, max: 0xFFFFFFFF, fallback: 1 })
      };
    },
    computeUnits: (p) => Math.max(1, Math.ceil((p.size ** 3) / 2_000_000)),
    run({ size, seed }) {
      const rng = createRng(seed);
      // Small integers keep every product exact, so results match on any CPU.
      const a = new Float64Array(size * size);
      const b = new Float64Array(size * size);
      for (let i = 0; i < a.length; i++) a[i] = Math.floor(rng() * 201) - 100;
      for (let i = 0; i < b.length; i++) b[i] = Math.floor(rng() * 201) - 100;

      let trace = 0;
      let checksum = 0;
      for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) {
          let sum = 0;
          for (let k = 0; k < size; k++) sum += a[i * size + k] * b[k * size + j];
          if (i === j) trace += sum;
          checksum = (checksum + (((sum % 1_000_003) + 1_000_003) % 1_000_003) * (i + j + 1)) % 1_000_000_007;
        }
      }
      return { size, trace, checksum };
    }
  },

  // Monte Carlo simulation of geometric Brownian motion: generic risk math.
  // The partner sends only scalar parameters, never positions or strategies.
  monte_carlo_gbm: {
    deterministic: true,
    normalize(params = {}) {
      const normalized = {
        paths: intParam(params.paths, { name: 'paths', min: 100, max: 500_000, fallback: 20_000 }),
        steps: intParam(params.steps, { name: 'steps', min: 1, max: 365, fallback: 30 }),
        s0: numParam(params.s0, { name: 's0', min: 1e-9, max: 1e12, fallback: 100 }),
        mu: numParam(params.mu, { name: 'mu', min: -5, max: 5, fallback: 0.05 }),
        sigma: numParam(params.sigma, { name: 'sigma', min: 0, max: 10, fallback: 0.2 }),
        horizonYears: numParam(params.horizonYears, { name: 'horizonYears', min: 1 / 365, max: 30, fallback: 30 / 365 }),
        seed: intParam(params.seed, { name: 'seed', min: 0, max: 0xFFFFFFFF, fallback: 1 })
      };
      if (normalized.paths * normalized.steps > 20_000_000) {
        throw new Error("'paths' x 'steps' no puede superar 20.000.000 por trabajo; divide la simulación en varios trabajos");
      }
      return normalized;
    },
    computeUnits: (p) => Math.max(1, Math.ceil((p.paths * p.steps) / 500_000)),
    run({ paths, steps, s0, mu, sigma, horizonYears, seed }) {
      const rng = createRng(seed);
      const dt = horizonYears / steps;
      const drift = (mu - 0.5 * sigma * sigma) * dt;
      const vol = sigma * Math.sqrt(dt);
      const finals = new Float64Array(paths);

      for (let p = 0; p < paths; p++) {
        let logPrice = 0;
        for (let s = 0; s < steps; s++) {
          // Box-Muller; 1 - rng() keeps the argument of log() above zero.
          const z = Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
          logPrice += drift + vol * z;
        }
        finals[p] = s0 * Math.exp(logPrice);
      }

      finals.sort();
      let sum = 0;
      for (let i = 0; i < paths; i++) sum += finals[i];
      const at = (q) => finals[Math.min(paths - 1, Math.floor(q * paths))];
      const round = (x) => Number(x.toPrecision(10));
      const p5 = at(0.05);
      // Expected shortfall: average loss over the worst q of the paths.
      const cvar = (q) => {
        const n = Math.max(1, Math.floor(q * paths));
        let tail = 0;
        for (let i = 0; i < n; i++) tail += finals[i];
        return s0 - tail / n;
      };
      return {
        paths,
        steps,
        mean: round(sum / paths),
        median: round(at(0.5)),
        p1: round(at(0.01)),
        p5: round(p5),
        p95: round(at(0.95)),
        p99: round(at(0.99)),
        valueAtRisk95: round(s0 - p5),
        valueAtRisk99: round(s0 - at(0.01)),
        cvar95: round(cvar(0.05)),
        cvar99: round(cvar(0.01))
      };
    }
  },

  // TCP connect latency from the donor's network to public endpoints
  // (exchange APIs, RPC nodes...). Not deterministic: measured, not computed.
  latency_probe: {
    deterministic: false,
    normalize(params = {}) {
      const targets = Array.isArray(params.targets) ? params.targets : [];
      if (targets.length === 0 || targets.length > 10) {
        throw new Error("'targets' debe tener entre 1 y 10 destinos");
      }
      return {
        samples: intParam(params.samples, { name: 'samples', min: 1, max: 5, fallback: 3 }),
        targets: targets.map((t) => {
          const host = String(t?.host || '').toLowerCase();
          if (!HOSTNAME_RE.test(host)) throw new Error(`Host de destino inválido: '${host}'`);
          const port = intParam(t.port, { name: 'port', min: 1, max: 65535, fallback: 443 });
          if (port !== 443 && port !== 80) throw new Error('latency_probe solo admite los puertos 80 y 443');
          return { host, port };
        })
      };
    },
    computeUnits: (p) => Math.max(1, Math.ceil((p.targets.length * p.samples) / 10))
    // Executed by the daemon (needs the network): see foxy-daemon/src/job-runner.js
  }
};

/** Validates and normalizes job parameters. Throws on anything unexpected. */
export function normalizeJob(type, params) {
  const def = Object.hasOwn(JOB_TYPES, type) ? JOB_TYPES[type] : null;
  if (!def) {
    throw new Error(`Tipo de trabajo no soportado: '${type}'. Disponibles: ${Object.keys(JOB_TYPES).join(', ')}`);
  }
  const normalized = def.normalize(params && typeof params === 'object' ? params : {});
  return { type, params: normalized, computeUnits: def.computeUnits(normalized), deterministic: def.deterministic };
}

/** Runs a deterministic job in-process. */
export function runDeterministicJob(type, params) {
  const { params: normalized, deterministic } = normalizeJob(type, params);
  if (!deterministic) throw new Error(`'${type}' no es un trabajo determinista`);
  return JOB_TYPES[type].run(normalized);
}

/** Canonical fingerprint of a result, used to compare replicas. */
export function resultFingerprint(result) {
  const canonical = (v) => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
    }
    return v;
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical(result))).digest('hex');
}
