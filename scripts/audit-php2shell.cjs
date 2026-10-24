#!/usr/bin/env node
// ==============================================================================
// Scorpion Apex Group - Cybersecurity Intelligence Unit
// Tool: PHP2Shell Vulnerability Auditor (CVE-2026-109618 & CVE-2026-109619)
// ==============================================================================

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log(`
🛡️ ================================================================
     SCORPION APEX GROUP — CYBER INTELLIGENCE AUDITOR
     Vulnerabilities: PHP2Shell (CVE-2026-109618 / CVE-2026-109619)
     Severity: CVSS 9.2 (CRITICAL - Unauthenticated RCE)
================================================================
`);

function auditTarget(targetPath) {
  console.log(`🔍 Escaneando objetivo: ${targetPath}\n`);

  const report = {
    target: targetPath,
    phpDetected: false,
    version: null,
    isVulnerableVersion: false,
    patchedVersion: null,
    sapi: null,
    configs: {
      memoryLimit: null,
      uploadProgress: null,
      fatalErrorBacktraces: null
    },
    riskScore: 0,
    findings: [],
    mitigations: []
  };

  // 1. Revisar si hay binario local php
  try {
    const phpVer = execSync('php -v 2>&1', { encoding: 'utf8' });
    const match = phpVer.match(/PHP\s+([0-9]+\.[0-9]+\.[0-9]+)/i);
    if (match) {
      report.phpDetected = true;
      report.version = match[1];
      console.log(`[+] Binario PHP del sistema detectado: v${report.version}`);
      evaluateVersion(report.version, report);
    }
  } catch (e) {
    console.log('[-] Binario PHP local no encontrado o no ejecutable en PATH.');
  }

  // 2. Inspeccionar archivos en el directorio del objetivo
  if (fs.existsSync(targetPath)) {
    inspectDirectory(targetPath, report);
  }

  // 3. Evaluar e Imprimir Diagnóstico
  printReport(report);
}

function evaluateVersion(verStr, report) {
  const parts = verStr.split('.').map(Number);
  const major = parts[0];
  const minor = parts[1];
  const patch = parts[2] || 0;

  if (major === 8) {
    if (minor === 5) {
      report.patchedVersion = '8.5.12';
      if (patch < 12) report.isVulnerableVersion = true;
    } else if (minor === 4) {
      report.patchedVersion = '8.4.27';
      if (patch < 27) report.isVulnerableVersion = true;
    } else if (minor === 3) {
      report.patchedVersion = '8.3.36';
      if (patch < 36) report.isVulnerableVersion = true;
    } else if (minor === 2) {
      report.patchedVersion = '8.2.35';
      if (patch < 35) report.isVulnerableVersion = true;
    } else {
      report.isVulnerableVersion = true;
      report.findings.push(`Rama EOL PHP 8.${minor} (Sin parches oficiales upstream)`);
    }
  } else if (major <= 7) {
    report.isVulnerableVersion = true;
    report.findings.push(`PHP v${verStr} es End-Of-Life (EOL). Sin parches upstream disponibles.`);
  }

  if (report.isVulnerableVersion) {
    report.riskScore += 50;
    report.findings.push(`Versión ${verStr} < ${report.patchedVersion || 'Soportada'} susceptible a ejecución remota de código`);
  }
}

function inspectDirectory(dir, report) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', '.git', 'venv', '.venv'].includes(entry.name)) {
        inspectDirectory(fullPath, report);
      }
    } else {
      const lower = entry.name.toLowerCase();
      if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) {
        inspectDockerfile(fullPath, report);
      } else if (lower.includes('docker-compose') && (lower.endsWith('.yml') || lower.endsWith('.yaml'))) {
        inspectDockerCompose(fullPath, report);
      } else if (lower.endsWith('.ini')) {
        inspectIni(fullPath, report);
      } else if (lower.endsWith('.php')) {
        report.phpDetected = true;
      }
    }
  }
}

function inspectDockerfile(filePath, report) {
  const content = fs.readFileSync(filePath, 'utf8');
  const match = content.match(/FROM\s+.*php:([0-9]+\.[0-9]+[a-zA-Z0-9.-]*)/i);
  if (match) {
    report.phpDetected = true;
    const tag = match[1];
    console.log(`[+] Dockerfile (${path.basename(filePath)}): Detectada imagen base php:${tag}`);
    evaluateVersion(tag, report);
  }
}

function inspectDockerCompose(filePath, report) {
  const content = fs.readFileSync(filePath, 'utf8');
  const match = content.match(/image:\s+.*php:([0-9]+\.[0-9]+[a-zA-Z0-9.-]*)/i);
  if (match) {
    report.phpDetected = true;
    const tag = match[1];
    console.log(`[+] docker-compose (${path.basename(filePath)}): Detectada imagen php:${tag}`);
    evaluateVersion(tag, report);
  }
}

function inspectIni(filePath, report) {
  const content = fs.readFileSync(filePath, 'utf8');
  if (/memory_limit/i.test(content) || /upload_progress/i.test(content)) {
    console.log(`[+] Archivo de configuración analizado: ${path.basename(filePath)}`);
    const memMatch = content.match(/^\s*memory_limit\s*=\s*([0-9]+[A-Za-z]?)/m);
    if (memMatch && memMatch[1] !== '-1') {
      report.configs.memoryLimit = memMatch[1];
      report.riskScore += 25;
      report.findings.push(`memory_limit = ${memMatch[1]} (no es -1): Explotable para CVE-2026-109618`);
    }
    const upMatch = content.match(/^\s*session\.upload_progress\.enabled\s*=\s*([01])/m);
    if (upMatch && upMatch[1] === '1') {
      report.configs.uploadProgress = '1';
      report.riskScore += 25;
      report.findings.push(`session.upload_progress.enabled = 1: Explotable para CVE-2026-109619`);
    }
  }
}

function printReport(r) {
  console.log('\n' + '='.repeat(64));
  console.log('                 INFORME DE AUDITORÍA');
  console.log('='.repeat(64));

  if (!r.phpDetected && r.findings.length === 0) {
    console.log('✅ ESTADO: INMUNE / NO AFECTADO');
    console.log('   No se detectaron servicios ni entornos PHP en este proyecto.');
    console.log('   (La arquitectura Foxy se apoya en Python, Node.js y Rust).');
  } else {
    console.log(`⚠️  ESTADO: ${r.riskScore >= 50 ? '🔴 CRÍTICO / VULNERABLE' : '🟡 RIESGO POTENCIAL'}`);
    console.log(`   Nivel de Riesgo: ${r.riskScore} / 100`);
    console.log('\n📋 Hallazgos Técnicos:');
    r.findings.forEach(f => console.log(`   - ${f}`));

    console.log('\n🛡️ Medidas de Remediación Obligatorias:');
    if (r.patchedVersion) {
      console.log(`   1. Actualizar inmediatamente a PHP ${r.patchedVersion}`);
    }
    console.log('   2. Reconstruir contenedores con: docker compose build --no-cache');
    console.log('   3. Mitigación temporal en php.ini:');
    console.log('      memory_limit = -1');
    console.log('      session.upload_progress.enabled = 0');
    console.log('      fatal_error_backtraces = 0');
  }
  console.log('='.repeat(64) + '\n');
}

const target = process.argv[2] || process.cwd();
auditTarget(target);
