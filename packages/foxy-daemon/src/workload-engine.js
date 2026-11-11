import { spawn, execSync, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';


const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKLOAD_TYPES = new Set(['static', 'docker', 'python', 'node']);
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
// registry/repo:tag or @sha256 digest. Never starts with '-', so it can't be read as a flag.
const IMAGE_RE = /^[a-z0-9][a-z0-9._/-]{0,127}(:[A-Za-z0-9._-]{1,127})?(@sha256:[a-f0-9]{64})?$/;
const MAX_WORKLOADS = 12;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Environment for child processes: nothing from the daemon's own secrets. */
function childEnv(port) {
  const env = { PORT: `${port}` };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'LANG']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

export class WorkloadEngine {
  constructor(options = {}) {
    this.basePort = options.basePort || 5100;
    this.dataDir = options.dataDir || path.resolve(process.cwd(), '.foxy');
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
   * Publishes the operator's own Foxy Finance server through the tunnel.
   * Only the daemon's startup code calls this (never the dashboard or the
   * controller): it points at a local port and may launch a local program.
   *
   * If nothing answers on `port`, and `appDir` (or a sibling "FOXY FINANCE"
   * folder) holds a FastAPI app, it is started with uvicorn.
   */
  async attachFoxyFinance({ port = 8000, appDir = null, subdomain = 'foxy-finance', foxDomain = null, quota = {} } = {}) {
    const workload = {
      id: 'foxy-finance-saas',
      name: 'FOXY FINANCE SaaS',
      type: 'foxy-finance',
      subdomain,
      foxDomain,
      port,
      status: 'STARTING',
      startedAt: new Date().toISOString(),
      logs: [],
      process: null,
      containerId: null,
      quota
    };
    this.workloads.set(workload.id, workload);

    const alreadyUp = await new Promise((resolve) => {
      const req = http.get({ hostname: '127.0.0.1', port, path: '/', timeout: 1200 }, (res) => { res.resume(); resolve(true); });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    });

    if (alreadyUp) {
      this.appendLog(workload, `FOXY FINANCE detectado en 127.0.0.1:${port}.`);
    } else {
      const financeDir = this._resolveFoxyFinanceDir(appDir);
      if (financeDir) {
        const venvWin = path.join(financeDir, 'venv', 'Scripts', 'python.exe');
        const venvUnix = path.join(financeDir, 'venv', 'bin', 'python');
        const python = fs.existsSync(venvWin) ? venvWin
          : fs.existsSync(venvUnix) ? venvUnix
          : (process.platform === 'win32' ? 'python' : 'python3');

        // Foxy Finance is the operator's own app and needs its own settings,
        // but never the keys that sign for the whole network.
        const env = { ...process.env, FASTAPI_PORT: `${port}`, PORT: `${port}` };
        for (const key of ['FOXY_NETWORK_SECRET', 'FOXY_ADMIN_KEY', 'FOXY_ORACLE_PRIVATE_KEY', 'DEPLOYER_PRIVATE_KEY']) delete env[key];

        this.appendLog(workload, `Iniciando FOXY FINANCE desde ${financeDir} en 127.0.0.1:${port}...`);
        const child = spawn(python, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', `${port}`], { cwd: financeDir, env });
        workload.process = child;
        child.stdout.on('data', d => this.appendLog(workload, d.toString()));
        child.stderr.on('data', d => this.appendLog(workload, d.toString()));
        child.on('error', err => { this.appendLog(workload, `No se pudo iniciar FOXY FINANCE: ${err.message}`, true); workload.status = 'ERROR'; });
        child.on('exit', code => { this.appendLog(workload, `Proceso FOXY FINANCE terminado (código ${code})`); workload.status = 'STOPPED'; });
        await new Promise(r => setTimeout(r, 1500));
      } else {
        this.appendLog(workload, `Túnel preparado hacia 127.0.0.1:${port}; inicia FOXY FINANCE en ese puerto.`);
      }
    }

    if (workload.status === 'STARTING') workload.status = 'RUNNING';
    return workload;
  }

  _resolveFoxyFinanceDir(customAppDir) {
    // The Foxy Finance project is expected next to this repository
    const foxyRoot = path.resolve(MODULE_DIR, '..', '..', '..', '..');
    const candidates = [
      customAppDir,
      path.join(foxyRoot, 'FOXY FINANCE'),
      path.join(foxyRoot, 'FOXY FINAINCE'),
      path.join(foxyRoot, 'foxy-finance')
    ].filter(Boolean);
    return candidates.find(dir => fs.existsSync(path.join(dir, 'main.py'))) || null;
  }

  /**
   * Spawns a workload based on its type
   */
  async spawnWorkload(config) {
    // Everything here may come from the network, so it is validated strictly.
    // Workloads never run a script path or directory chosen by the caller.
    const id = String(config.id || '').toLowerCase();
    if (!ID_RE.test(id)) throw new Error('Identificador de carga inválido');
    const type = config.type || 'static';
    if (!WORKLOAD_TYPES.has(type)) throw new Error(`Tipo de carga no soportado: ${type}`);
    const image = config.image || 'nginx:alpine';
    if (type === 'docker' && !IMAGE_RE.test(image)) throw new Error('Nombre de imagen de contenedor inválido');
    const name = String(config.name || id).replace(/[\u0000-\u001f<>]/g, '').slice(0, 80);
    const subdomain = String(config.subdomain || id).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 63) || id;
    const quota = config.quota || {};

    const existing = this.workloads.get(id);
    if (existing && (existing.status === 'RUNNING' || existing.status === 'STARTING')) return existing;
    const active = Array.from(this.workloads.values()).filter(w => w.status === 'RUNNING' || w.status === 'STARTING');
    if (active.length >= MAX_WORKLOADS) throw new Error('Límite de cargas de trabajo alcanzado en este nodo');

    const port = this.allocatePort();

    const workload = {
      id,
      name,
      type,
      subdomain,
      port,
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
      } else if (type === 'python') {
        await this._startPythonWorkload(workload);
      } else if (type === 'node') {
        await this._startNodeWorkload(workload);
      } else {
        // Default: Static server
        await this._startStaticWorkload(workload);
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

  _startDockerWorkload(workload, image) {
    const cli = this.runtime.type === 'PODMAN' ? 'podman' : 'docker';
    const cpus = Number(workload.quota.maxCpuCores) > 0 ? Number(workload.quota.maxCpuCores) : 1;
    const ramMb = Number(workload.quota.maxRamMb) > 0 ? Math.floor(Number(workload.quota.maxRamMb)) : 512;
    const cpuLimit = `--cpus=${cpus}`;
    const memLimit = `-m=${ramMb}m`;
    const containerName = `foxy-${workload.id}`;

    // docker run -d --rm --name foxy-xyz --cpus=1 -m=512m -p 5101:80 nginx:alpine
    const args = [
      'run', '-d', '--rm',
      '--name', containerName,
      cpuLimit, memLimit,
      '--pids-limit', '256',
      '--security-opt', 'no-new-privileges',
      // Published on loopback only: traffic reaches it through the tunnel.
      '-p', `127.0.0.1:${workload.port}:80`,
      image
    ];

    return new Promise((resolve, reject) => {
      this.appendLog(workload, `Ejecutando: ${cli} ${args.join(' ')}`);
      const child = spawn(cli, args, { shell: false });
      child.on('error', reject);

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

  /** Private directory holding the placeholder page served by a workload. */
  _prepareWebRoot(workload) {
    const dir = path.join(this.dataDir, 'www', workload.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), this._renderPage(workload), 'utf-8');
    return dir;
  }

  _startPythonWorkload(workload) {
    return new Promise((resolve) => {
      const targetDir = this._prepareWebRoot(workload);
      const args = ['-m', 'http.server', `${workload.port}`, '--bind', '127.0.0.1', '--directory', targetDir];
      const bin = process.platform === 'win32' ? 'python' : 'python3';

      this.appendLog(workload, `Lanzando microservicio Python: ${bin} ${args.join(' ')}`);

      const child = spawn(bin, args, { cwd: targetDir, env: childEnv(workload.port) });

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

  _startNodeWorkload(workload) {
    return new Promise((resolve) => {
      const cwd = this._prepareWebRoot(workload);
      // The app name travels as an argument, never interpolated into code.
      const args = ['--input-type=module', '-e', `
        import http from 'node:http';
        const [name, port] = process.argv.slice(1);
        http.createServer((req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ app: name, nodeRuntime: process.version, port: Number(port), timestamp: new Date().toISOString() }, null, 2));
        }).listen(Number(port), '127.0.0.1');
      `, workload.name, `${workload.port}`];

      this.appendLog(workload, `Lanzando servidor Node.js en puerto ${workload.port}`);

      const child = spawn(process.execPath, args, { cwd, env: childEnv(workload.port) });
      child.on('error', err => {
        this.appendLog(workload, `Error en proceso Node.js: ${err.message}`, true);
        workload.status = 'ERROR';
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

  _renderPage(workload) {
    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(workload.name)} — Foxy Cloud</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0b0f19; color: #f0f4fc; padding: 3rem; text-align: center; }
    .box { background: #151d30; border: 1px solid #232f4e; border-radius: 12px; padding: 2rem; max-width: 500px; margin: auto; }
    h1 { color: #ff6b35; margin-bottom: 0.5rem; }
    code { background: #080c14; padding: 2px 6px; border-radius: 4px; color: #00f2fe; }
  </style>
</head>
<body>
  <div class="box">
    <h1>🚀 ${escapeHtml(workload.name)}</h1>
    <p>Aplicación web servida desde un nodo donante descentralizado.</p>
    <div style="margin-top:1.5rem; font-size:0.9rem; text-align:left; color:#8ba0c8">
      <div><strong>ID de Carga:</strong> <code>${escapeHtml(workload.id)}</code></div>
      <div><strong>Subdominio Virtual:</strong> <code>${escapeHtml(workload.subdomain)}</code></div>
    </div>
  </div>
</body>
</html>`;
  }

  _startStaticWorkload(workload) {
    return new Promise((resolve, reject) => {
      const page = this._renderPage(workload);
      const server = http.createServer((req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'X-Foxy-Workload': workload.id
        });
        res.end(page);
      });
      server.once('error', reject);

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
        execFileSync(cli, ['stop', `foxy-${workload.id}`], { stdio: 'ignore' });
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
