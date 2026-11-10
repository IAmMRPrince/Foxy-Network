import { spawn, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Deterministic PRNG (Mulberry32) for redundant cross-node verification (epsilon < 1e-6)
 */
export function createSeededPrng(seed = 1337) {
  let state = (Number(seed) || 1337) >>> 0;
  return function nextRandom() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Executes a Sovereign Black-Box Quantitative Task (Monte Carlo VaR/CVaR, DEX Arbitrage, Candle Audit)
 * Pure mathematical calculation over parameterized vectors — no proprietary strategy source code exposed.
 */
export function executeSovereignQuantTask(task = {}) {
  const startTime = Date.now();
  const type = String(task.type || task.workloadType || 'MONTE_CARLO_VAR').toUpperCase();
  const seed = Number(task.seed ?? 42069);
  const rand = createSeededPrng(seed);

  if (type === 'ARBITRAGE' || type === 'DEX_ARBITRAGE_SWEEP') {
    const pools = task.parameters?.pools || ['ETH/USDC', 'FOXY/ETH', 'WBTC/USDT', 'SOL/USDC', 'ARB/USDC'];
    const results = [];
    for (const pool of pools) {
      const basePrice = 100 + rand() * 2500;
      const dexSpread = (rand() - 0.48) * 0.015;
      const netSpreadPercent = parseFloat((dexSpread * 100).toFixed(4));
      results.push({
        pool,
        basePrice: parseFloat(basePrice.toFixed(2)),
        netSpreadPercent,
        hasOpportunity: Math.abs(netSpreadPercent) > 0.4
      });
    }
    const opportunitiesFound = results.filter(r => r.hasOpportunity).length;
    const vectorString = results.map(r => `${r.pool}:${r.basePrice}:${r.netSpreadPercent}`).join('|');
    const resultHash = crypto.createHash('sha256').update(`ARB:${seed}:${vectorString}`).digest('hex');

    return {
      taskId: task.taskId || `task-arb-${seed}`,
      type: 'DEX_ARBITRAGE_SWEEP',
      seed,
      poolsEvaluated: pools.length,
      opportunitiesFound,
      computeUnitsRequired: 2,
      data: results,
      vector: results.map(r => r.netSpreadPercent),
      resultHash,
      durationMs: Date.now() - startTime
    };
  }

  // Default: Monte Carlo VaR / CVaR 95% & 99% simulation
  const params = task.parameters || {};
  const initialPrice = Number(params.initialPrice || 67500.25);
  const annualDrift = Number(params.annualDrift || 0.08);
  const annualVol = Number(params.annualVol || 0.45);
  const days = Number(params.days || 30);
  const paths = Math.min(100000, Math.max(500, Number(params.paths || task.iterations || 10000)));

  const dt = days / 365.0;
  const driftTerm = (annualDrift - 0.5 * annualVol * annualVol) * dt;
  const volTerm = annualVol * Math.sqrt(dt);

  const pnlReturns = new Float64Array(paths);
  let accumulatedVolatility = 0;

  for (let i = 0; i < paths; i++) {
    const u1 = Math.max(1e-12, rand());
    const u2 = rand();
    const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    accumulatedVolatility += Math.abs(z0);
    const terminalPrice = initialPrice * Math.exp(driftTerm + volTerm * z0);
    pnlReturns[i] = (terminalPrice - initialPrice) / initialPrice;
  }

  pnlReturns.sort();

  const idx95 = Math.max(0, Math.floor(0.05 * paths));
  const idx99 = Math.max(0, Math.floor(0.01 * paths));

  const var95 = parseFloat((-pnlReturns[idx95] * initialPrice).toFixed(4));
  const var99 = parseFloat((-pnlReturns[idx99] * initialPrice).toFixed(4));

  let tailSum = 0;
  const tailCount = Math.max(1, idx99);
  for (let i = 0; i < tailCount; i++) {
    tailSum += -pnlReturns[i] * initialPrice;
  }
  const cvar99 = parseFloat((tailSum / tailCount).toFixed(4));
  const averageVolatilityFactor = parseFloat((accumulatedVolatility / paths).toFixed(4));
  const computeUnitsRequired = Math.max(1, Math.round(paths / 5000));

  const vector = [var95, var99, cvar99, averageVolatilityFactor];
  const resultHash = crypto
    .createHash('sha256')
    .update(`MC:${seed}:${vector.map(v => v.toFixed(4)).join(':')}`)
    .digest('hex');

  return {
    taskId: task.taskId || `task-mc-${seed}`,
    type: 'DEFI_RISK_MONTE_CARLO',
    seed,
    iterations: paths,
    paths,
    initialPrice,
    var95,
    var99,
    cvar99,
    averageVolatilityFactor,
    computeUnitsRequired,
    vector,
    resultHash,
    durationMs: Date.now() - startTime
  };
}

export class WorkloadEngine {
  constructor(options = {}) {
    this.basePort = options.basePort || 5100;
    this.currentPortOffset = 0;
    this.workloads = new Map(); // id -> { id, name, type, status, port, process, containerId, logs: [] }
    this.runtime = this.detectRuntime();
  }

  detectRuntime() {
    try {
      execSync('docker --version', { stdio: 'ignore' });
      return { type: 'DOCKER', name: 'Docker Engine', isOciReady: true };
    } catch {
      try {
        execSync('podman --version', { stdio: 'ignore' });
        return { type: 'PODMAN', name: 'Podman OCI Runtime', isOciReady: true };
      } catch {
        return {
          type: 'NATIVE_SANDBOX',
          name: 'Sandbox Nativo de Procesos (Python / Node.js / Static)',
          isOciReady: false
        };
      }
    }
  }

  allocatePort() {
    this.currentPortOffset++;
    return this.basePort + this.currentPortOffset;
  }

  appendLog(workload, line, isError = false) {
    const entry = {
      timestamp: new Date().toLocaleTimeString(),
      text: line.trim(),
      isError
    };
    workload.logs.push(entry);
    if (workload.logs.length > 100) workload.logs.shift();
  }

  /**
   * Executes a Sovereign Black-Box Quantitative Task on this node
   */
  executeQuantWorkload(task = {}) {
    return executeSovereignQuantTask(task);
  }

  /**
   * Spawns a workload based on its type
   */
  async spawnWorkload(config) {
    const { id, name, type, image, scriptPath, staticDir, targetPort, quota = {} } = config;
    const port = targetPort || this.allocatePort();
    const cleanSubdomain = String(config.subdomain || id)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '');

    const workload = {
      id,
      name: name || id,
      type: type || 'static',
      subdomain: cleanSubdomain,
      port,
      foxDomain: config.foxDomain || null,
      status: 'STARTING',
      startedAt: new Date().toISOString(),
      logs: [],
      process: null,
      containerId: null,
      quota
    };

    this.workloads.set(id, workload);

    try {
      if (type === 'docker') {
        if (!this.runtime.isOciReady) {
          throw new Error('El motor Docker/Podman no está activo en este equipo. Usa el modo nativo (Python, Node o Static).');
        }
        await this._startDockerWorkload(workload, image);
      } else if (type === 'foxy-finance') {
        await this._startFoxyFinanceWorkload(workload, config.appDir);
      } else if (type === 'python') {
        await this._startPythonWorkload(workload, scriptPath, staticDir);
      } else if (type === 'node') {
        await this._startNodeWorkload(workload, scriptPath);
      } else {
        // Default: Static server
        await this._startStaticWorkload(workload, staticDir);
      }

      workload.status = 'RUNNING';
      this.appendLog(workload, `Servicio iniciado exitosamente en puerto local :${port}`);
      return workload;
    } catch (err) {
      workload.status = 'FAILED';
      this.appendLog(workload, `Fallo al iniciar servicio: ${err.message}`, true);
      throw err;
    }
  }

  _resolveFoxyFinanceDir(customAppDir) {
    if (customAppDir && fs.existsSync(customAppDir)) return customAppDir;
    const foxyRoot = path.resolve(__dirname, '..', '..', '..', '..');
    const candidates = [
      path.join(foxyRoot, 'FOXY FINANCE'),
      path.join(foxyRoot, 'FOXY FINAINCE'),
      path.join(foxyRoot, 'foxy-finance')
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return candidates[0];
  }

  _startFoxyFinanceWorkload(workload, customAppDir) {
    return new Promise((resolve) => {
      const financeDir = this._resolveFoxyFinanceDir(customAppDir);
      const port = workload.port || 8000;

      // Check if port 8000 is already listening (e.g. FOXY FINANCE already started externally)
      const checkReq = http.get({ hostname: '127.0.0.1', port, path: '/api/health', timeout: 1200 }, (res) => {
        res.resume();
        this.appendLog(workload, `FOXY FINANCE detectado activo en 127.0.0.1:${port} (HTTP ${res.statusCode}). Vinculando túnel https://www.foxyfianance.fox...`);
        resolve();
      });

      checkReq.on('error', () => {
        // Not running yet; spawn FOXY FINANCE FastAPI server if directory exists
        if (fs.existsSync(financeDir) && fs.existsSync(path.join(financeDir, 'main.py'))) {
          const venvPyWin = path.join(financeDir, 'venv', 'Scripts', 'python.exe');
          const venvPyUnix = path.join(financeDir, 'venv', 'bin', 'python');
          const pythonExec = fs.existsSync(venvPyWin)
            ? venvPyWin
            : (fs.existsSync(venvPyUnix) ? venvPyUnix : 'python');

          this.appendLog(workload, `Iniciando servidor FOXY FINANCE SaaS en 127.0.0.1:${port} para https://www.foxyfianance.fox...`);

          const child = spawn(pythonExec, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', `${port}`], {
            cwd: financeDir,
            env: { ...process.env, FASTAPI_PORT: `${port}`, PORT: `${port}` }
          });

          workload.process = child;
          child.stdout.on('data', d => this.appendLog(workload, d.toString()));
          child.stderr.on('data', d => this.appendLog(workload, d.toString()));
          child.on('exit', code => {
            this.appendLog(workload, `Proceso FOXY FINANCE terminado (código ${code})`);
          });
          setTimeout(resolve, 1500);
        } else {
          this.appendLog(workload, `Proxy reverso preparado hacia 127.0.0.1:${port} para https://www.foxyfianance.fox`);
          resolve();
        }
      });
    });
  }

  _startDockerWorkload(workload, image) {
    const cli = this.runtime.type === 'PODMAN' ? 'podman' : 'docker';
    const cpuLimit = workload.quota.maxCpuCores ? `--cpus=${workload.quota.maxCpuCores}` : '--cpus=1';
    const memLimit = workload.quota.maxRamMb ? `-m=${workload.quota.maxRamMb}m` : '-m=512m';
    const containerName = `foxy-${workload.id}`;

    // docker run -d --rm --name foxy-xyz --cpus=1 -m=512m -p 5101:80 nginx:alpine
    const args = [
      'run', '-d', '--rm',
      '--name', containerName,
      cpuLimit, memLimit,
      '-p', `${workload.port}:80`,
      image || 'nginx:alpine'
    ];

    return new Promise((resolve, reject) => {
      this.appendLog(workload, `Ejecutando: ${cli} ${args.join(' ')}`);
      const child = spawn(cli, args, { shell: true });

      let out = '';
      let err = '';
      child.stdout.on('data', d => out += d.toString());
      child.stderr.on('data', d => err += d.toString());

      child.on('close', code => {
        if (code === 0) {
          workload.containerId = out.trim().slice(0, 12);
          this.appendLog(workload, `Contenedor OCI iniciado con ID: ${workload.containerId}`);
          resolve();
        } else {
          reject(new Error(err || `Docker exit code ${code}`));
        }
      });
    });
  }

  _startPythonWorkload(workload, scriptPath, staticDir) {
    return new Promise((resolve) => {
      let args = [];
      let cwd = process.cwd();

      if (scriptPath && fs.existsSync(scriptPath)) {
        args = [scriptPath, '--port', `${workload.port}`];
        cwd = path.dirname(scriptPath);
      } else {
        // Launch Python's built-in HTTP server serving staticDir or a sample dir
        const targetDir = staticDir && fs.existsSync(staticDir) ? staticDir : __dirname;
        args = ['-m', 'http.server', `${workload.port}`, '--directory', targetDir];
        cwd = targetDir;
      }

      this.appendLog(workload, `Lanzando microservicio Python: python ${args.join(' ')}`);

      const child = spawn('python', args, {
        cwd,
        env: { ...process.env, PORT: `${workload.port}` }
      });

      workload.process = child;

      child.stdout.on('data', d => this.appendLog(workload, d.toString()));
      child.stderr.on('data', d => this.appendLog(workload, d.toString(), true));

      child.on('error', err => {
        this.appendLog(workload, `Error en proceso Python: ${err.message}`, true);
        workload.status = 'ERROR';
      });

      child.on('exit', code => {
        this.appendLog(workload, `Proceso Python terminado con código ${code}`);
        workload.status = 'STOPPED';
      });

      setTimeout(resolve, 800);
    });
  }

  _startNodeWorkload(workload, scriptPath) {
    return new Promise((resolve) => {
      let args = [];
      let cwd = process.cwd();

      if (scriptPath && fs.existsSync(scriptPath)) {
        args = [scriptPath];
        cwd = path.dirname(scriptPath);
      } else {
        // Fallback simple inline Node HTTP server
        args = ['-e', `
          import http from 'node:http';
          const server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              app: '${workload.name}',
              nodeRuntime: process.version,
              port: ${workload.port},
              timestamp: new Date().toISOString()
            }, null, 2));
          });
          server.listen(${workload.port}, '127.0.0.1');
        `];
      }

      this.appendLog(workload, `Lanzando servidor Node.js en puerto ${workload.port}`);

      const child = spawn('node', args, {
        cwd,
        env: { ...process.env, PORT: `${workload.port}` }
      });

      workload.process = child;

      child.stdout.on('data', d => this.appendLog(workload, d.toString()));
      child.stderr.on('data', d => this.appendLog(workload, d.toString(), true));

      child.on('exit', code => {
        this.appendLog(workload, `Servidor Node.js terminado con código ${code}`);
        workload.status = 'STOPPED';
      });

      setTimeout(resolve, 800);
    });
  }

  _startStaticWorkload(workload, staticDir) {
    return new Promise((resolve) => {
      // Create a built-in HTTP server for this static workload
      const server = http.createServer((req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Foxy-Workload': workload.id
        });
        res.end(`
          <!DOCTYPE html>
          <html lang="es">
          <head>
            <meta charset="UTF-8">
            <title>${workload.name} — Foxy Cloud</title>
            <style>
              body { font-family: system-ui, sans-serif; background: #0b0f19; color: #f0f4fc; padding: 3rem; text-align: center; }
              .box { background: #151d30; border: 1px solid #232f4e; border-radius: 12px; padding: 2rem; max-width: 500px; margin: auto; }
              h1 { color: #ff6b35; margin-bottom: 0.5rem; }
              code { background: #080c14; padding: 2px 6px; border-radius: 4px; color: #00f2fe; }
            </style>
          </head>
          <body>
            <div class="box">
              <h1>🚀 ${workload.name}</h1>
              <p>Aplicación web servida desde un nodo donante descentralizado.</p>
              <div style="margin-top:1.5rem; font-size:0.9rem; text-align:left; color:#8ba0c8">
                <div><strong>ID de Carga:</strong> <code>${workload.id}</code></div>
                <div><strong>Puerto Local:</strong> <code>:${workload.port}</code></div>
                <div><strong>Subdominio Virtual:</strong> <code>${workload.subdomain}</code></div>
                <div><strong>Hora de Servido:</strong> ${new Date().toLocaleTimeString()}</div>
              </div>
            </div>
          </body>
          </html>
        `);
      });

      server.listen(workload.port, '127.0.0.1', () => {
        workload.serverInstance = server;
        this.appendLog(workload, `Servidor estático activo en 127.0.0.1:${workload.port}`);
        resolve();
      });
    });
  }

  stopWorkload(id) {
    const workload = this.workloads.get(id);
    if (!workload) return false;

    this.appendLog(workload, 'Deteniendo carga de trabajo...');

    if (workload.containerId) {
      const cli = this.runtime.type === 'PODMAN' ? 'podman' : 'docker';
      try {
        execSync(`${cli} stop foxy-${workload.id}`, { stdio: 'ignore' });
        this.appendLog(workload, 'Contenedor OCI detenido.');
      } catch (e) {
        // Ignore error
      }
    }

    if (workload.process) {
      workload.process.kill();
      workload.process = null;
    }

    if (workload.serverInstance) {
      workload.serverInstance.close();
      workload.serverInstance = null;
    }

    workload.status = 'STOPPED';
    return true;
  }

  listWorkloads() {
    return Array.from(this.workloads.values()).map(w => ({
      id: w.id,
      name: w.name,
      type: w.type,
      subdomain: w.subdomain,
      foxDomain: w.foxDomain || null,
      port: w.port,
      status: w.status,
      startedAt: w.startedAt,
      containerId: w.containerId,
      recentLogs: w.logs.slice(-5)
    }));
  }
}
