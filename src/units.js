// ═══════════════════════════════════════════════════════════════════════════
// src/units.js — 표시 단위 변환 + 포맷 (§4.9)
// 원가는 항상 USD 고정. 물량만 MWh / Link / Pack / Cell 로 환산한다.
// ═══════════════════════════════════════════════════════════════════════════

import { DISPLAY_UNITS, UNITS } from './data.js';

let current = DISPLAY_UNITS[0];

export function setDisplayUnit(id) {
  current = DISPLAY_UNITS.find((u) => u.id === id) || DISPLAY_UNITS[0];
}
export function getDisplayUnit() {
  return current;
}

/** MWh 값을 현재 표시 단위 숫자로 변환한다 (단위 문자열 없음). */
export function conv(mwh) {
  return mwh * current.perMWh;
}

/** MWh 값을 현재 표시 단위 문자열로. 예: "18.4 MWh" / "3.58 Link" */
export function qty(mwh, digits) {
  const d = digits ?? current.digits;
  const v = conv(mwh);
  return `${fmtNum(v, d)} ${unitLabel()}`;
}

export function unitLabel() {
  return current.id === 'MWh' ? 'MWh' : current.id.charAt(0) + current.id.slice(1).toLowerCase();
}

export function fmtNum(v, digits = 1) {
  if (!isFinite(v)) return '—';
  const abs = Math.abs(v);
  const d = abs >= 1000 ? Math.min(digits, 0) : digits;
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function usd(v, opts = {}) {
  if (!isFinite(v)) return '—';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : opts.signed && v > 0 ? '+' : '';
  if (opts.compact !== false) {
    if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  }
  return `${sign}$${Math.round(abs).toLocaleString('en-US')}`;
}

export function pct(v, digits = 1) {
  return `${fmtNum(v, digits)}%`;
}

export function day(d) {
  return `D+${String(Math.max(0, Math.round(d))).padStart(3, '0')}`;
}

export function miles(m) {
  return `${Math.round(m).toLocaleString('en-US')} mi`;
}

/** 창고 슬라이더 하단 환산 병기용 — "= 33.7 MWh / 6.6 Link" (§4.4-①) */
export function dualQty(mwh) {
  return `= ${fmtNum(mwh, 1)} MWh / ${fmtNum(mwh / UNITS.linkMWh, 2)} Link`;
}

/** Lane 적재 단위 환산 — "39 Pack = 2.38 MWh" */
export function loadQty(units, unitMWh, unitName) {
  return `${fmtNum(units, 0)} ${unitName} = ${fmtNum(units * unitMWh, 2)} MWh`;
}

export const STATUS_COLOR = {
  RUNNING: 'var(--status-ok)',
  BLOCKED: 'var(--status-warn)',
  STARVED: 'var(--status-danger)',
  DOWN: 'var(--status-idle)',
};

export const STATUS_CLASS = {
  RUNNING: 'ok',
  BLOCKED: 'warn',
  STARVED: 'danger',
  DOWN: 'idle',
};

export const SEVERITY_GLYPH = { INFO: '●', WARN: '▲', CRIT: '■' };

// ── 노드 건강 상태 (§4.1 / §4.2 범례) ──────────────────────────────────────
//
// 엔진의 상태(RUNNING/BLOCKED/STARVED/DOWN)는 '지금 무슨 일이 벌어지고 있나'만
// 말한다. 담당자가 실제로 알고 싶은 것은 거기에 '얼마나 급한가'가 더해진
// 것이므로, 실제 상태와 TTS(잔여 생존일)를 합쳐 5단계로 요약한다.
//
// 판정 순서가 중요하다 — 지금 멈춰 있는 것이 앞으로 위험한 것보다 급하다.
//   DOWN            → CRITICAL   (라인이 서 있다)
//   BLOCKED         → BLOCKED    (밀어낼 곳이 없다)
//   STARVED         → STARVED    (받을 것이 없다)
//   RUNNING + TTS↓  → AT_RISK    (아직 돌지만 곧 무너진다)
//   그 외           → NORMAL
export const HEALTH = {
  CRITICAL: { id: 'CRITICAL', glyph: '●', label: 'Critical', ko: '정지', color: 'var(--status-crit)' },
  AT_RISK: { id: 'AT_RISK', glyph: '▲', label: 'At risk', ko: '위험', color: 'var(--status-warn)' },
  BLOCKED: { id: 'BLOCKED', glyph: '❙❙', label: 'Blocked', ko: '적체', color: 'var(--status-warn)' },
  STARVED: { id: 'STARVED', glyph: '▼', label: 'Starved', ko: '결품', color: 'var(--status-danger)' },
  NORMAL: { id: 'NORMAL', glyph: '✓', label: 'Normal', ko: '정상', color: 'var(--status-ok)' },
};

/** 범례 표시 순서 — 심각한 것부터. */
export const HEALTH_ORDER = ['CRITICAL', 'AT_RISK', 'NORMAL', 'BLOCKED', 'STARVED'];

const AT_RISK_TTS_DAYS = 30;

/**
 * @param {string} state  엔진 상태 (RUNNING/BLOCKED/STARVED/DOWN)
 * @param {number|null} tts  잔여 생존일. null 이면 지평선 내 위험 없음.
 */
export function nodeHealth(state, tts) {
  if (state === 'DOWN') return HEALTH.CRITICAL;
  if (state === 'BLOCKED') return HEALTH.BLOCKED;
  if (state === 'STARVED') return HEALTH.STARVED;
  if (tts != null && tts <= AT_RISK_TTS_DAYS) return HEALTH.AT_RISK;
  return HEALTH.NORMAL;
}
