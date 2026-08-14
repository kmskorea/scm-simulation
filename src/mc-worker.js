// ═══════════════════════════════════════════════════════════════════════════
// src/mc-worker.js — Monte Carlo 워커 (§3.6)
// sim.js 는 DOM 을 모르므로 워커에서 그대로 import 된다.
// ═══════════════════════════════════════════════════════════════════════════

import { monteCarlo } from './sim.js';

self.onmessage = (e) => {
  const { config, runs } = e.data;
  try {
    const result = monteCarlo(config, runs, (p) => {
      self.postMessage({ type: 'progress', value: p });
    });
    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message ? err.message : err) });
  }
};
