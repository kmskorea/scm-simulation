// ═══════════════════════════════════════════════════════════════════════════
// src/ui.js — 셸 · 라우팅 · 키보드 · 재생
//
// 실행 모델 (§1.5.1) 재확인:
//   재생 / 일시정지 / 스크럽 / 속도 변경은 전부 렌더링 계층 동작이다.
//   여기서는 절대 runSim 을 부르지 않는다. store.commit() 만이 엔진을 깨운다.
// ═══════════════════════════════════════════════════════════════════════════

import {
  NODES, HUB, CUSTOMERS, LANES, ASSUMPTIONS, META, BOM, UNITS, SIM,
  DISPLAY_UNITS, COST_DEFAULTS, UPSTREAM_MODEL,
} from './data.js';
import { el, clear, icon, badge, section, kv, slider, numberField, button } from './components.js';
import { usd, fmtNum, day as fmtDay, setDisplayUnit } from './units.js';
import {
  appState, onData, onFrame, recomputeNow, readHash, writeHash,
  setPlayhead, setView, setMode, setUnit, setPanel, setSelection, resetAll,
  toggleCounterfactual, setCost, setIdleCost, emitFrame,
} from './store.js';
import { effectiveDailyOutput } from './sim.js';

import * as networkView from './views/network.js';
import * as flowView from './views/flow.js';
import * as costView from './views/cost.js';
import * as ganttView from './views/gantt.js';

import * as inspectorPanel from './panels/inspector.js';
import * as scenarioPanel from './panels/scenario.js';
import * as planningPanel from './panels/planning.js';
import * as customersPanel from './panels/customers.js';
import * as ontologyPanel from './panels/ontology.js';
import * as rightPanel from './panels/right.js';

const PANELS = {
  INSPECTOR: { mod: inspectorPanel, icon: 'inspector', title: 'Node · Lane · Customer Inspector' },
  SCENARIO: { mod: scenarioPanel, icon: 'scenario', title: 'Scenario' },
  PLANNING: { mod: planningPanel, icon: 'planning', title: 'Planning' },
  CUSTOMERS: { mod: customersPanel, icon: 'customers', title: 'Customers' },
  ONTOLOGY: { mod: ontologyPanel, icon: 'ontology', title: 'Ontology' },
};

const VIEWS = {
  NETWORK: { mod: networkView, node: () => document.getElementById('view-network') },
  FLOW: { mod: flowView, node: () => document.getElementById('view-flow') },
  COST: { mod: costView, node: () => document.getElementById('view-cost') },
};

let prevDayKpi = null;

// ═══════════════════════════════════════════════════════════════════════
function init() {
  readHash();
  setDisplayUnit(appState.displayUnit);

  buildRail();
  buildUnitSelect();
  wireTopbar();
  wireTransport();
  wireKeyboard();
  wireModals();
  wirePanelHold();

  networkView.mount(document.getElementById('view-network'));
  flowView.mount(document.getElementById('view-flow'));
  costView.mount(document.getElementById('view-cost'));
  ganttView.mount(document.getElementById('gantt'));
  rightPanel.mount(document.getElementById('right'));

  onData(renderAll);
  onFrame(renderFrame);
  window.addEventListener('panel-refresh', () => renderPanel(appState));

  recomputeNow();

  // TODAY 앵커 — 로드 시 현재 시뮬 일자로 진입 (§4.8)
  if (!location.hash) setPlayhead(0);
}

// ═══════════════════════════════════════════════════════════════════════
// 렌더
// ═══════════════════════════════════════════════════════════════════════
let lastPanelKey = null;
function renderAll(state) {
  if (!state.result) return;
  syncTabs(state);
  // 선택 대상이나 패널이 바뀌었으면 붙잡고 있어도 반드시 다시 그린다
  const key = `${state.panel}|${state.selection?.type}|${state.selection?.id}|${state.mode}`;
  renderPanel(state, key !== lastPanelKey);
  lastPanelKey = key;
  rightPanel.render(state);
  ganttView.render(state);
  renderDeltaStrip(state);

  for (const [id, v] of Object.entries(VIEWS)) {
    const node = v.node();
    node.hidden = id !== state.view;
  }
  VIEWS[state.view].mod.render(state);
  renderFrame(state);
}

function renderFrame(state) {
  const H = state.config.horizonDays;
  document.getElementById('playhead-label').textContent =
    `${fmtDay(state.playhead)} / ${H}`;
  const scrub = document.getElementById('scrub');
  scrub.max = String(H - 1);
  if (Number(scrub.value) !== state.playhead) scrub.value = String(state.playhead);

  VIEWS[state.view].mod.frame?.(state);
  ganttView.frame(state);
  renderDeltaStrip(state);
}

// 레버를 붙잡고 있는 동안에는 패널을 다시 그리지 않는다.
// 재계산은 그대로 돌아가고 지도 · 간트 · KPI 는 실시간으로 갱신되지만, 패널
// DOM 을 갈아끼우면 드래그 중인 슬라이더가 교체되어 제스처가 끊긴다.
// (§7 "재생 중에 레버를 조정해도 동작한다" / §8 "레버에 잠금을 걸지 말 것")
let panelHeld = false;

function panelBusy() {
  const panel = document.getElementById('panel');
  return panelHeld || (panel && !panel.hidden && panel.contains(document.activeElement));
}

function renderPanel(state, force = false) {
  const panel = document.getElementById('panel');
  const body = document.getElementById('panel-body');
  if (!state.panel) { panel.hidden = true; return; }
  panel.hidden = false;
  document.getElementById('panel-title').textContent = PANELS[state.panel].title;
  for (const b of document.querySelectorAll('.rail-btn')) {
    b.setAttribute('aria-pressed', String(b.dataset.panel === state.panel));
  }
  if (!force && panelBusy() && body.firstChild) return;

  const scroll = body.scrollTop;
  clear(body);
  body.appendChild(PANELS[state.panel].mod.render(state));
  body.scrollTop = scroll; // 재계산마다 스크롤이 튀지 않게 유지
}

function wirePanelHold() {
  const panel = document.getElementById('panel');
  panel.addEventListener('pointerdown', () => { panelHeld = true; });
  const release = () => {
    if (!panelHeld) return;
    panelHeld = false;
    // 손을 뗀 뒤 최신 상태로 한 번 다시 그린다
    setTimeout(() => renderPanel(appState, true), 160);
  };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  panel.addEventListener('focusout', (e) => {
    if (!panel.contains(e.relatedTarget)) setTimeout(() => renderPanel(appState, true), 0);
  });
}

function syncTabs(state) {
  for (const t of document.querySelectorAll('.tab')) {
    t.setAttribute('aria-selected', String(t.dataset.view === state.view));
  }
  for (const b of document.querySelectorAll('#mode-toggle button')) {
    b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
  }
  document.getElementById('btn-cf').classList.toggle('primary', state.showCounterfactual);
  document.getElementById('unit-select').value = state.displayUnit;
}

// ── 어제 대비 델타 스트립 (§4.8) ────────────────────────────────────────
function renderDeltaStrip(state) {
  const strip = document.getElementById('delta-strip');
  const r = state.result;
  if (!r) return;
  const d = state.playhead;
  const prev = Math.max(0, d - 1);

  const wip = r.system.wipSeries[d] - r.system.wipSeries[prev];
  const pen = r.system.cumPenaltySeries[d] - r.system.cumPenaltySeries[prev];
  const thru = r.system.throughputMWhPerDay[d] - r.system.throughputMWhPerDay[prev];
  const it = r.system.inTransitSeries[d] - r.system.inTransitSeries[prev];

  const nonRunning = NODES.filter((n) => r.perNode[n.id].stateTimeline[d] !== 'RUNNING');

  clear(strip);
  const item = (label, value, dir) => {
    strip.appendChild(el('span', {},
      el('b', { text: label + ' ' }),
      el('span', { class: dir, text: value })));
  };
  strip.appendChild(el('span', { class: 'muted', text: '어제 대비' }));
  item('THRUPUT', `${thru >= 0 ? '+' : ''}${fmtNum(thru, 2)} MWh`, thru < -0.01 ? 'up' : thru > 0.01 ? 'down' : 'flat');
  item('PENALTY', `${pen > 0 ? '+' : ''}${usd(pen)}`, pen > 0 ? 'up' : 'flat');
  item('WIP', `${wip >= 0 ? '+' : ''}${fmtNum(wip, 1)} MWh`, wip > 0.5 ? 'up' : wip < -0.5 ? 'down' : 'flat');
  item('IN-TRANSIT', `${it >= 0 ? '+' : ''}${fmtNum(it, 1)} MWh`, 'flat');
  strip.appendChild(el('span', { class: nonRunning.length ? 'up' : 'down' },
    el('b', { text: 'EXCEPTIONS ' }),
    el('span', { text: nonRunning.length ? nonRunning.map((n) => `${n.id}:${r.perNode[n.id].stateTimeline[d][0]}`).join(' ') : 'NONE' })));
  if (state.lastComputeMs != null) {
    strip.appendChild(el('span', { class: 'muted', style: { marginLeft: 'auto' },
      text: `recompute ${state.lastComputeMs.toFixed(0)} ms` }));
  }
  void prevDayKpi;
}

// ═══════════════════════════════════════════════════════════════════════
// 셸 배선
// ═══════════════════════════════════════════════════════════════════════
function buildRail() {
  const rail = document.getElementById('rail');
  clear(rail);
  for (const [id, p] of Object.entries(PANELS)) {
    const b = el('button', {
      class: 'rail-btn', title: p.title, dataset: { panel: id },
      onclick: () => setPanel(id),
    }, icon(p.icon));
    rail.appendChild(b);
  }
  rail.appendChild(el('div', { style: { flex: '1' } }));
  const watch = el('button', {
    class: 'rail-btn', title: '워치리스트',
    onclick: () => {
      if (appState.watchlist.length) {
        const [type, wid] = appState.watchlist[0].split(':');
        setSelection({ type, id: wid });
      }
    },
  }, icon('watchlist'));
  rail.appendChild(watch);
  onData((s) => {
    const old = watch.querySelector('.rail-badge');
    if (old) old.remove();
    if (s.watchlist.length) {
      watch.appendChild(el('span', { class: 'rail-badge', text: String(s.watchlist.length) }));
    }
  });
}

function buildUnitSelect() {
  const sel = document.getElementById('unit-select');
  clear(sel);
  for (const u of DISPLAY_UNITS) {
    sel.appendChild(el('option', { value: u.id, text: u.label, selected: u.id === appState.displayUnit }));
  }
  sel.addEventListener('change', (e) => setUnit(e.target.value));
}

function wireTopbar() {
  document.getElementById('tabstrip').addEventListener('click', (e) => {
    const t = e.target.closest('.tab');
    if (t) setView(t.dataset.view);
  });
  document.getElementById('mode-toggle').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) setMode(b.dataset.mode);
  });
  document.getElementById('search-open').addEventListener('click', openSearch);
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('btn-share').addEventListener('click', async () => {
    writeHash();
    try {
      await navigator.clipboard.writeText(location.href);
      flash('시나리오 링크를 클립보드에 복사했습니다');
    } catch {
      flash('복사 실패 — 주소창의 URL 을 직접 복사하세요');
    }
  });
}

// ── 재생 (§1.5.1 — 엔진을 부르지 않는 순수 렌더 루프) ───────────────────
let playing = false;
let speed = 1;
let rafId = null;
let lastT = 0;
let acc = 0;

function wireTransport() {
  document.getElementById('btn-play').addEventListener('click', togglePlay);
  document.getElementById('btn-back').addEventListener('click', () => setPlayhead(appState.playhead - 7));
  document.getElementById('btn-fwd').addEventListener('click', () => setPlayhead(appState.playhead + 7));
  document.getElementById('scrub').addEventListener('input', (e) => setPlayhead(Number(e.target.value)));
  document.getElementById('btn-reset').addEventListener('click', () => { stop(); resetAll(); setPlayhead(0); });
  document.getElementById('btn-cf').addEventListener('click', toggleCounterfactual);
  document.getElementById('speed-toggle').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    speed = Number(b.dataset.speed);
    for (const x of e.currentTarget.children) x.setAttribute('aria-pressed', String(x === b));
  });
}

function togglePlay() {
  playing ? stop() : start();
}

function start() {
  playing = true;
  document.getElementById('btn-play').textContent = '❚❚';
  lastT = performance.now();
  acc = 0;
  const tick = (t) => {
    if (!playing) return;
    const dt = t - lastT;
    lastT = t;
    acc += (dt / 1000) * speed * 8; // 8 일/초 @1x
    if (acc >= 1) {
      const step = Math.floor(acc);
      acc -= step;
      const next = appState.playhead + step;
      if (next >= appState.config.horizonDays - 1) { setPlayhead(appState.config.horizonDays - 1); stop(); return; }
      setPlayhead(next);
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

function stop() {
  playing = false;
  document.getElementById('btn-play').textContent = '▶';
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
}

// ── 키보드 (§4.8) ───────────────────────────────────────────────────────
function wireKeyboard() {
  window.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault(); openSearch(); return;
    }
    if (e.key === 'Escape') {
      if (!closeModals()) setSelection(null);
      return;
    }
    if (typing) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); setPlayhead(appState.playhead - (e.shiftKey ? 7 : 1)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setPlayhead(appState.playhead + (e.shiftKey ? 7 : 1)); }
    else if (e.key === '1') setView('NETWORK');
    else if (e.key === '2') setView('FLOW');
    else if (e.key === '3') setView('COST');
  });
}

// ═══════════════════════════════════════════════════════════════════════
// ⌘K 검색
// ═══════════════════════════════════════════════════════════════════════
let searchIndex = null;
let searchCursor = 0;

function buildSearchIndex() {
  const idx = [];
  for (const n of NODES) idx.push({ kind: 'NODE', id: n.id, name: `${n.name} · ${n.place}`, sel: { type: 'node', id: n.id } });
  idx.push({ kind: 'HUB', id: HUB.id, name: `${HUB.name} · ${HUB.place}`, sel: { type: 'hub', id: HUB.id } });
  for (const l of LANES) idx.push({ kind: 'LANE', id: l.id, name: l.laneType, sel: { type: 'lane', id: l.id } });
  for (const c of CUSTOMERS) idx.push({ kind: 'CUST', id: c.id, name: `${c.name} · ${c.state}`, sel: { type: 'customer', id: c.id } });
  for (const o of appState.result.orders) {
    idx.push({ kind: 'PO', id: o.id, name: `${o.customerId} · DUE D+${o.dueDay}`, meta: o.status, sel: { type: 'order', id: o.id }, day: o.dueDay });
  }
  return idx;
}

function openSearch() {
  searchIndex = buildSearchIndex();
  const modal = document.getElementById('search-modal');
  const input = document.getElementById('search-input');
  modal.hidden = false;
  input.value = '';
  searchCursor = 0;
  paintSearch('');
  input.focus();
}

function paintSearch(q) {
  const box = document.getElementById('search-results');
  clear(box);
  const needle = q.trim().toLowerCase();
  const hits = searchIndex
    .filter((x) => !needle || x.id.toLowerCase().includes(needle) || x.name.toLowerCase().includes(needle))
    .slice(0, 40);
  searchCursor = Math.min(searchCursor, Math.max(0, hits.length - 1));
  hits.forEach((h, i) => {
    box.appendChild(el('div', {
      class: 'sr-item', 'aria-selected': String(i === searchCursor),
      onclick: () => pickSearch(h),
    },
      el('span', { class: 'k', text: h.kind }),
      el('span', { class: 'n', text: `${h.id}` }),
      el('span', { class: 'm', text: h.meta ? `${h.name} · ${h.meta}` : h.name })));
  });
  if (!hits.length) box.appendChild(el('div', { class: 'empty-state', text: '결과 없음' }));
  box._hits = hits;
}

function pickSearch(h) {
  closeModals();
  if (h.day != null) setPlayhead(h.day);
  setSelection(h.sel);
}

// ═══════════════════════════════════════════════════════════════════════
// 설정 / 가정 / 내보내기
// ═══════════════════════════════════════════════════════════════════════
function openSettings() {
  const modal = document.getElementById('settings-modal');
  const body = document.getElementById('settings-body');
  clear(body);
  const state = appState;

  // 명시적 가정 (§9)
  const asm = el('div');
  for (const a of ASSUMPTIONS) {
    asm.appendChild(el('div', { class: 'assump' },
      el('span', { class: 'tag', text: a.tag }),
      el('span', { class: 'txt', text: a.text })));
  }
  body.appendChild(section('명시적 가정 (§9)', asm));

  // BOM 왕복 검증
  body.appendChild(section('BOM · 단위', kv([
    ['cellWh', `${BOM.cellWh} Wh`],
    ['cellsPerPack', `${BOM.cellsPerPack}`],
    ['packsPerLink', `${BOM.packsPerLink}`],
    ['1 Pack', `${UNITS.packMWh.toFixed(6)} MWh`],
    ['1 Link', `${UNITS.linkMWh.toFixed(6)} MWh`],
    ['cells / Link', `${UNITS.cellsPerLink.toLocaleString('en-US')}`],
    ['upstream model', UPSTREAM_MODEL],
  ])));

  // 원가율
  const cost = el('div');
  cost.appendChild(numberField({
    label: '트럭 운임', unit: 'USD/mile', value: state.config.cost.freightPerMileTruck, min: 0, step: 0.05,
    sub: (v) => `기준 물류비 ≈ ${usd((state.result.system.costBreakdown.baseFreight / state.config.cost.freightPerMileTruck) * v)}`,
    onInput: (v) => setCost('freightPerMileTruck', v),
  }));
  cost.appendChild(numberField({
    label: '환적 취급비', unit: 'USD/트럭', value: state.config.cost.hubHandlingPerTruck, min: 0, step: 10,
    sub: () => '', onInput: (v) => setCost('hubHandlingPerTruck', v),
  }));
  cost.appendChild(numberField({
    label: '보관비', unit: 'USD/MWh·day', value: state.config.cost.storagePerMWhDay, min: 0, step: 1,
    sub: () => '', onInput: (v) => setCost('storagePerMWhDay', v),
  }));
  for (const stage of ['CELL', 'PACK', 'LINK']) {
    cost.appendChild(numberField({
      label: `유휴 비용 — ${stage}`, unit: 'USD/h', value: state.config.cost.idleCostPerHour[stage], min: 0, step: 100,
      sub: () => '', onInput: (v) => setIdleCost(stage, v),
    }));
  }
  body.appendChild(section('원가율 (전부 placeholder)', cost));

  // 파라미터 사전 요약
  const dict = el('div', { class: 'tiny muted' });
  dict.appendChild(el('div', { text: `초기 재고: 입고 ${SIM.initialInputFillPct * 100}% · 출고 CELL/PACK ${SIM.initialOutputFillPct.CELL * 100}% / LINK ${SIM.initialOutputFillPct.LINK * 100}%` }));
  dict.appendChild(el('div', { text: `보충 목표: 입고창고 × ${SIM.targetInputFillPct} + 리드타임 소요분` }));
  dict.appendChild(el('div', { text: `재고 보정: ${SIM.inventoryCorrectionDays}일 · 불감대 ${SIM.inventoryDeadBandPct * 100}%` }));
  dict.appendChild(el('div', { text: `고객 출하 선행일: ${SIM.preShipDays}d · TTS 프로브 시작 D+${SIM.ttsProbeStartDay}` }));
  dict.appendChild(el('div', { text: `도로 우회계수 ${SIM.roadFactor} · 무료 보관 ${SIM.freeStorageDays}일` }));
  dict.appendChild(el('div', { style: { marginTop: '6px' }, text: 'README.md 에 전 상수의 의미 · 단위 · 출처 · 검증여부가 정리되어 있습니다.' }));
  body.appendChild(section('엔진 파라미터', dict));

  // CSV export
  const exp = el('div', { class: 'btn-row' },
    button('노드 일별 상태 CSV', () => exportCsv('node-daily-state', csvNodeDaily())),
    button('PO 납기 실적 CSV', () => exportCsv('po-performance', csvOrders())),
    button('원가 분해 CSV', () => exportCsv('cost-breakdown', csvCost())));
  body.appendChild(section('CSV EXPORT', exp));

  body.appendChild(section('데이터 출처', el('div', { class: 'tiny muted' },
    el('div', { text: META.distanceSource }),
    el('div', { text: META.caption }))));

  modal.hidden = false;
}

function csvNodeDaily() {
  const r = appState.result;
  const rows = [['day', 'nodeId', 'stage', 'status', 'producedMWh', 'planMWh', 'capacityMWh', 'inputBufferMWh', 'outputBufferMWh', 'fgiDaysOfSupply']];
  for (let d = 0; d < appState.config.horizonDays; d++) {
    for (const n of NODES) {
      const p = r.perNode[n.id];
      rows.push([d, n.id, n.type, p.stateTimeline[d],
        p.producedSeries[d].toFixed(4), p.planSeries[d].toFixed(4), p.capacitySeries[d].toFixed(4),
        p.inputBufferSeries[d].toFixed(4), p.outputBufferSeries[d].toFixed(4), p.fgiDaysOfSupply[d].toFixed(4)]);
    }
  }
  return rows;
}

function csvOrders() {
  const r = appState.result;
  const rows = [['poId', 'customerId', 'qtyLinks', 'qtyMWh', 'dueDay', 'firstShipDay', 'deliveredDay', 'lateDays', 'status', 'penaltyUSD']];
  for (const o of r.orders) {
    rows.push([o.id, o.customerId, o.qtyLinks.toFixed(2), o.qtyMWh.toFixed(4), o.dueDay,
      o.firstShipDay ?? '', o.deliveredDay ?? '', o.lateDays, o.status, o.penaltyUSD.toFixed(2)]);
  }
  return rows;
}

function csvCost() {
  const r = appState.result;
  const rows = [['bucket', 'usd']];
  for (const [k, v] of Object.entries(r.system.costBreakdown)) rows.push([k, v.toFixed(2)]);
  rows.push(['TOTAL', r.system.totalCostUSD.toFixed(2)]);
  rows.push([]);
  rows.push(['nodeId', 'blockingIdleUSD', 'starvingIdleUSD', 'storageUSD', 'blockedDays', 'starvedDays', 'lostOutputMWh']);
  for (const n of NODES) {
    const p = r.perNode[n.id];
    rows.push([n.id, p.blockingIdleUSD.toFixed(2), p.starvingIdleUSD.toFixed(2), p.storageUSD.toFixed(2),
      p.blockedDays, p.starvedDays, p.lostOutputMWh.toFixed(3)]);
  }
  rows.push([]);
  rows.push(['laneId', 'trucks', 'shippedMWh', 'freightUSD', 'expediteUSD', 'hubHandlingUSD', 'avgTransitDays']);
  for (const l of LANES) {
    const p = r.perLane[l.id];
    rows.push([l.id, p.trucks, p.shippedMWh.toFixed(3), p.freightUSD.toFixed(2),
      p.expediteUSD.toFixed(2), p.hubHandlingUSD.toFixed(2), p.avgTransitDays.toFixed(2)]);
  }
  return rows;
}

function exportCsv(name, rows) {
  const csv = rows.map((r) => r.map((c) => {
    const s = String(c ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ess-scm-${name}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

// ── 모달 배선 ───────────────────────────────────────────────────────────
function wireModals() {
  const search = document.getElementById('search-modal');
  const input = document.getElementById('search-input');
  input.addEventListener('input', (e) => { searchCursor = 0; paintSearch(e.target.value); });
  input.addEventListener('keydown', (e) => {
    const box = document.getElementById('search-results');
    const hits = box._hits || [];
    if (e.key === 'ArrowDown') { e.preventDefault(); searchCursor = Math.min(hits.length - 1, searchCursor + 1); paintSearch(input.value); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); searchCursor = Math.max(0, searchCursor - 1); paintSearch(input.value); }
    else if (e.key === 'Enter' && hits[searchCursor]) pickSearch(hits[searchCursor]);
  });
  for (const m of [search, document.getElementById('settings-modal')]) {
    m.addEventListener('click', (e) => { if (e.target === m) m.hidden = true; });
  }
  for (const b of document.querySelectorAll('[data-close-modal]')) {
    b.addEventListener('click', closeModals);
  }
  document.getElementById('panel-close').addEventListener('click', () => setPanel(appState.panel));
}

function closeModals() {
  let any = false;
  for (const id of ['search-modal', 'settings-modal']) {
    const m = document.getElementById(id);
    if (!m.hidden) { m.hidden = true; any = true; }
  }
  return any;
}

function flash(msg) {
  const n = el('div', {
    class: 'callout ok',
    style: {
      position: 'fixed', bottom: '18px', left: '50%', transform: 'translateX(-50%)',
      zIndex: '300', background: 'var(--bg-elevated)',
    },
    text: msg,
  });
  document.body.appendChild(n);
  setTimeout(() => n.remove(), 2400);
}

// ═══════════════════════════════════════════════════════════════════════
init();
