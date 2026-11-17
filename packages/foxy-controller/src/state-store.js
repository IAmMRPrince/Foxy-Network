// ==============================================================================
// Foxy Network - Controller state persistence
// A small JSON snapshot written atomically, so balances, links and subdomain
// ownership survive a controller restart.
// ==============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { getStateDir } from '../../foxy-security/src/index.js';

export class StateStore {
  constructor(fileName = 'controller-state.json', { enabled = true } = {}) {
    this.enabled = enabled;
    this.file = enabled ? path.join(getStateDir(), fileName) : null;
    this.dirty = false;
    this.sections = new Map(); // name -> () => serializable
  }

  load() {
    if (!this.enabled) return {};
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf-8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Keep the unreadable file for inspection instead of overwriting it.
        const backup = `${this.file}.corrupt-${Date.now()}`;
        try { fs.renameSync(this.file, backup); } catch { /* best effort */ }
        console.error(`[Controller] Estado ilegible (${err.message}). Copia guardada en ${backup}`);
      }
      return {};
    }
  }

  /** Registers a function that returns the data to persist under `name`. */
  register(name, serialize) {
    this.sections.set(name, serialize);
  }

  markDirty() {
    this.dirty = true;
  }

  flush() {
    if (!this.enabled || !this.dirty) return;
    const snapshot = {};
    for (const [name, serialize] of this.sections) snapshot[name] = serialize();
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }

  startAutoFlush(intervalMs = 5000) {
    if (!this.enabled) return;
    const timer = setInterval(() => {
      try { this.flush(); } catch (err) { console.error(`[Controller] No se pudo guardar el estado: ${err.message}`); }
    }, intervalMs);
    timer.unref();
  }
}
