// ═══════════════════════════════════════════════════════════════════════════
// src/panels/scenario.js — ② SCENARIO §4.4-②
// 프리셋 6종 · 커스텀 장애 주입 · 확률 모드 / Monte Carlo (§3.6)
// ═══════════════════════════════════════════════════════════════════════════

import { PRESETS, DISRUPTION_TYPES, NODES, LANES, CUSTOMERS } from '../data.js';
import {
  el, section, slider, selectField, checkbox, badge, button, clear, callout,
} from '../components.js';
import { fmtNum, usd, pct } from '../units.js';
import {
  appState, applyPreset, addDisruption, removeDisruption, setGlobal,
  setGlobal as setCfg, setMonteCarlo, setMcProgress, removeSimAction,
} from '../store.js';

export const title = 'Scenario';

let draft = { type: 'nodeDown', target: 'PW1', startDay: 20, durationDays: 5, pct: 0.4, deltaPct: -0.05, extraDays: 4, multiplier: 1.5 };
let worker = null;

export function render(state) {
  const box = el('div');

  // ── 프리셋 ────────────────────────────────────────────────────────────
  const presets = el('div', { class: 'stack' });
  for (const p of PRESETS) {
    const active = state.presetId === p.id;
    presets.appendChild(el('button', {
      class: `btn wide${active ? ' primary' : ''}`,
      style: { textAlign: 'left', height: 'auto', padding: '5px 8px', display: 'block' },
      onclick: () => applyPreset(p.id),
    },
      el('div', { class: 'mono', style: { fontSize: '10px' }, text: p.label }),
      el('div', { class: 'tiny muted', style: { textTransform: 'none', letterSpacing: 0, marginTop: '1px' }, text: p.desc })));
  }
  box.appendChild(section('PRESETS', presets,
    state.presetId === 'CUSTOM' ? badge('CUSTOM', 'warn') : null));

  // ── 적용된 장애 목록 ──────────────────────────────────────────────────
  const list = el('div');
  if (!state.config.disruptions.length) {
    list.appendChild(el('div', { class: 'tiny muted', text: '장애 없음 — 기준선' }));
  }
  state.config.disruptions.forEach((d, i) => {
    const row = el('div', { class: 'spread', style: { padding: '3px 0', borderBottom: '1px solid var(--border)' } });
    row.appendChild(el('div', {},
      el('div', { class: 'mono tiny', style: { color: 'var(--text-primary)' }, text: `${d.type} · ${d.target}` }),
      el('div', { class: 'mono tiny muted', text: describe(d) })));
    row.appendChild(el('button', { class: 'btn danger', text: '✕', onclick: () => removeDisruption(i) }));
    list.appendChild(row);
  });
  box.appendChild(section('ACTIVE DISRUPTIONS', list));

  // ── 커스텀 주입 폼 ────────────────────────────────────────────────────
  const form = el('div');
  const rebuild = () => { clear(form); buildForm(form, state); };
  buildForm(form, state);
  box.appendChild(section('INJECT DISRUPTION', form));
  void rebuild;

  // ── Action 큐 ─────────────────────────────────────────────────────────
  if (state.config.actions.length) {
    const acts = el('div');
    state.config.actions.forEach((a, i) => {
      const row = el('div', { class: 'spread', style: { padding: '3px 0', borderBottom: '1px solid var(--border)' } });
      row.appendChild(el('div', {},
        el('div', { class: 'mono tiny', style: { color: 'var(--accent)' }, text: a.type }),
        el('div', { class: 'mono tiny muted', text: actionDesc(a) })));
      row.appendChild(el('button', { class: 'btn danger', text: '✕', onclick: () => removeSimAction(i) }));
      acts.appendChild(row);
    });
    box.appendChild(section('ACTION QUEUE', acts, badge(`${state.config.actions.length}`, 'info')));
  }

  // ── 확률 모드 ─────────────────────────────────────────────────────────
  const sto = el('div');
  sto.appendChild(checkbox({
    label: '확률 모드 (일산출 · 수송시간 · 비계획 정지)',
    value: state.config.stochastic,
    onChange: (v) => setGlobal('stochastic', v),
  }));
  sto.appendChild(slider({
    label: 'Monte Carlo 실행 횟수', value: state.config.monteCarloRuns,
    min: 20, max: 500, step: 20, digits: 0, unit: 'runs',
    onInput: (v) => { state.config.monteCarloRuns = v; },
  }));
  sto.appendChild(slider({
    label: '시드', value: state.config.seed, min: 1, max: 99999999, step: 1, digits: 0,
    sub: () => '시드 고정 시 재실행 결과 완전 동일',
    onInput: (v) => setGlobal('seed', v),
  }));

  const runBtn = button('▶ MONTE CARLO 실행', () => runMonteCarlo(state), 'primary');
  runBtn.classList.add('wide');
  sto.appendChild(el('div', { style: { marginTop: '6px' } }, runBtn));

  const prog = el('div', { class: 'progress', style: { marginTop: '6px' } }, el('i', { style: { width: `${state.mcProgress * 100}%` } }));
  if (state.mcProgress > 0 && state.mcProgress < 1) sto.appendChild(prog);

  if (state.mc) {
    const k = state.mc.kpi;
    sto.appendChild(el('div', { class: 'hr' }));
    sto.appendChild(el('div', { class: 'ctrl-sub', text: `${state.mc.runs} runs · P10 / P50 / P90` }));
    sto.appendChild(band('OTD', k.otdPct, (v) => pct(v, 1)));
    sto.appendChild(band('LD PENALTY', k.totalPenaltyUSD, usd));
    sto.appendChild(band('TOTAL COST', k.totalCostUSD, usd));
    sto.appendChild(band('LOST OUTPUT', k.totalLostOutputMWh, (v) => `${fmtNum(v, 0)} MWh`));
    sto.appendChild(callout('간트 각 행 하단 스트립 = 그 노드가 BLOCKED 일 확률 (§1.5.4)', 'ok'));
  }
  box.appendChild(section('STOCHASTIC', sto));
  return box;
}

function band(label, v, fmt) {
  return el('div', { class: 'spread', style: { padding: '2px 0' } },
    el('span', { class: 'tiny muted', text: label }),
    el('span', { class: 'mono tiny', text: `${fmt(v.p10)} / ${fmt(v.p50)} / ${fmt(v.p90)}` }));
}

function describe(d) {
  const parts = [`D+${d.startDay}`];
  if (d.durationDays) parts.push(`${d.durationDays}일간`);
  if (d.pct != null) parts.push(`−${Math.round(d.pct * 100)}%`);
  if (d.deltaPct != null) parts.push(`수율 ${Math.round(d.deltaPct * 100)}%p`);
  if (d.extraDays != null) parts.push(`+${d.extraDays}d`);
  if (d.multiplier != null) parts.push(`×${d.multiplier}`);
  return parts.join(' · ');
}

function actionDesc(a) {
  if (a.type === 'expediteLane') return `${a.laneId} · D+${a.startDay} ${a.durationDays}일`;
  if (a.type === 'reallocateInventory') return `${a.from}→${a.to} ${fmtNum(a.qtyMWh, 1)} MWh · D+${a.day}`;
  if (a.type === 'adjustShift') return `${a.nodeId} · D+${a.day} · 조업 ${a.hours}h`;
  return `${a.nodeId} · D+${a.day} ${JSON.stringify(a.newLevers || {})}`;
}

function targetOptions(kind) {
  if (kind === 'node') return NODES.map((n) => ({ value: n.id, label: `${n.id} (${n.type})` }));
  if (kind === 'lane') return LANES.map((l) => ({ value: l.id, label: l.id }));
  return CUSTOMERS.map((c) => ({ value: c.id, label: `${c.id} (${c.state})` }));
}

function buildForm(form, state) {
  const spec = DISRUPTION_TYPES.find((t) => t.id === draft.type);
  form.appendChild(selectField({
    label: '유형', value: draft.type,
    options: DISRUPTION_TYPES.map((t) => ({ value: t.id, label: t.label })),
    onChange: (v) => {
      draft.type = v;
      const s = DISRUPTION_TYPES.find((t) => t.id === v);
      draft.target = targetOptions(s.targets)[0].value;
      clear(form); buildForm(form, state);
    },
  }));
  form.appendChild(selectField({
    label: '대상', value: draft.target, options: targetOptions(spec.targets),
    onChange: (v) => { draft.target = v; },
  }));
  form.appendChild(slider({
    label: '시작일', value: draft.startDay, min: 0, max: state.config.horizonDays - 1, step: 1, digits: 0, unit: 'D+',
    onInput: (v) => { draft.startDay = v; },
  }));
  if (spec.fields.includes('durationDays')) {
    form.appendChild(slider({
      label: '기간', value: draft.durationDays, min: 1, max: 60, step: 1, digits: 0, unit: 'day',
      onInput: (v) => { draft.durationDays = v; },
    }));
  }
  if (spec.fields.includes('pct')) {
    form.appendChild(slider({
      label: 'CAPA 저하', value: draft.pct, min: 0.05, max: 0.95, step: 0.05, pct: true, digits: 0,
      onInput: (v) => { draft.pct = v; },
    }));
  }
  if (spec.fields.includes('deltaPct')) {
    form.appendChild(slider({
      label: '수율 변화', value: draft.deltaPct, min: -0.2, max: 0, step: 0.005, pct: true, digits: 1,
      onInput: (v) => { draft.deltaPct = v; },
    }));
  }
  if (spec.fields.includes('extraDays')) {
    form.appendChild(slider({
      label: '추가 지연', value: draft.extraDays, min: 1, max: 20, step: 1, digits: 0, unit: 'day',
      onInput: (v) => { draft.extraDays = v; },
    }));
  }
  if (spec.fields.includes('multiplier')) {
    form.appendChild(slider({
      label: '수요 배수', value: draft.multiplier, min: 0.5, max: 3, step: 0.1, digits: 1, unit: '×',
      onInput: (v) => { draft.multiplier = v; },
    }));
  }
  const add = button('+ 장애 추가', () => {
    const d = { type: draft.type, target: draft.target, startDay: draft.startDay };
    for (const f of spec.fields) if (f !== 'startDay') d[f] = draft[f];
    addDisruption(d);
  }, 'primary');
  add.classList.add('wide');
  form.appendChild(el('div', { style: { marginTop: '6px' } }, add));
}

// ── Monte Carlo (Web Worker) ────────────────────────────────────────────
function runMonteCarlo(state) {
  if (worker) worker.terminate();
  setMcProgress(0.01);
  try {
    worker = new Worker(new URL('../mc-worker.js', import.meta.url), { type: 'module' });
  } catch (e) {
    console.error('Worker 생성 실패', e);
    setMcProgress(0);
    return;
  }
  worker.onmessage = (e) => {
    if (e.data.type === 'progress') setMcProgress(e.data.value);
    else if (e.data.type === 'done') { setMonteCarlo(e.data.result); worker.terminate(); worker = null; }
    else if (e.data.type === 'error') { console.error('MC 실패:', e.data.message); setMcProgress(0); }
  };
  worker.onerror = (err) => { console.error('Worker 오류', err); setMcProgress(0); };
  worker.postMessage({
    config: JSON.parse(JSON.stringify(state.config)),
    runs: state.config.monteCarloRuns,
  });
}
