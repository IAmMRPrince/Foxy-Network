import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
   * Spawns a workload based on its type
   */
  async spawnWorkload(config) {
    const { id, name, type, image, scriptPath, staticDir, quota = {} } = config;
    const port = this.allocatePort();

    const workload = {
      id,
      name: name || id,
      type: type || 'static',
      subdomain: config.subdomain || id,
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
      port: w.port,
      status: w.status,
      startedAt: w.startedAt,
      containerId: w.containerId,
      recentLogs: w.logs.slice(-5)
    }));
  }
}
