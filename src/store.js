// ═══════════════════════════════════════════════════════════════════════════
// src/store.js — 애플리케이션 상태 (§1.5.5)
//
//   config 만이 진실의 원천이다.
//   result 는 항상 config 에서 재계산되는 파생값이며 절대 직접 수정하지 않는다.
//
// 실행 모델 (§1.5.1)
//   레버 변경 → debounce 120ms → runSim(config) 로 120일 전체 재계산
//   → 렌더. 재생/스크럽은 이 result 의 k일 슬라이스만 읽으며 엔진을 부르지 않는다.
// ═══════════════════════════════════════════════════════════════════════════

import { buildDefaultConfig, PRESETS } from './data.js';
import { runSim, computeTTS, counterfactualConfig, earliestApplicableDay } from './sim.js';
import { setDisplayUnit } from './units.js';

export const appState = {
  config: buildDefaultConfig(),
  mode: 'DESIGN', // 'DESIGN' | 'OPERATE'
  result: null, // 파생 — 저장하지 않는다
  counterfactual: null,
  playhead: 0,
  selection: null, // { type: 'node'|'lane'|'hub'|'customer'|'order', id }
  view: 'NETWORK', // 'NETWORK' | 'FLOW' | 'COST'
  displayUnit: 'MWh',
  watchlist: [],
  panel: null, // 'INSPECTOR'|'SCENARIO'|'PLANNING'|'CUSTOMERS'|'ONTOLOGY'
  showCounterfactual: false,
  playing: false,
  speed: 1,
  mc: null, // Monte Carlo 결과 (§3.6)
  mcProgress: 0,
  lastApplyNotice: null, // OPERATE 모드 최단 적용 가능일 안내
  presetId: 'BASELINE',
};

// ── 구독 ────────────────────────────────────────────────────────────────
const subs = { data: new Set(), frame: new Set() };

/** 데이터가 바뀌어 전면 재렌더가 필요할 때 */
export function onData(fn) { subs.data.add(fn); return () => subs.data.delete(fn); }
/** 플레이헤드만 움직였을 때 (엔진 재호출 없음) */
export function onFrame(fn) { subs.frame.add(fn); return () => subs.frame.delete(fn); }

function emitData() { for (const f of subs.data) f(appState); }
export function emitFrame() { for (const f of subs.frame) f(appState); }

// ── 재계산 ──────────────────────────────────────────────────────────────
let dataTimer = null;
let ttsTimer = null;

export function recomputeNow() {
  const t0 = performance.now();
  appState.result = runSim(appState.config);
  appState.counterfactual = runSim(counterfactualConfig(appState.config));
  if (appState.result.tts == null && lastTts) appState.result.tts = lastTts;
  appState.playhead = Math.min(appState.playhead, appState.config.horizonDays - 1);
  appState.lastComputeMs = performance.now() - t0;
  emitData();
  scheduleTts();
  writeHash();
}

let lastTts = null;
function scheduleTts() {
  // TTS 는 노드 수만큼 전체 run 을 돌리므로(≈100ms) 별도 debounce 를 둔다.
  clearTimeout(ttsTimer);
  ttsTimer = setTimeout(() => {
    lastTts = computeTTS(appState.config);
    if (appState.result) appState.result.tts = lastTts;
    emitData();
  }, 400);
}

/** 레버/장애/Action 변경 진입점. 120ms 디바운스 후 전체 재계산. */
export function commit() {
  clearTimeout(dataTimer);
  dataTimer = setTimeout(recomputeNow, 120);
}

// ═══════════════════════════════════════════════════════════════════════
// 액션
// ═══════════════════════════════════════════════════════════════════════

/**
 * 생산 노드 레버 변경.
 * DESIGN 모드 → config 를 직접 바꾼다 (D+0 부터 적용).
 * OPERATE 모드 → 계획 레이어가 계산한 '최단 적용 가능일'에 발효되는 Action 으로
 *                큐에 넣는다. 컨트롤을 잠그지 않고 경고만 표시한다 (§8).
 */
export function setNodeLever(nodeId, key, value) {
  if (appState.mode === 'DESIGN') {
    appState.config.nodes[nodeId][key] = value;
    appState.lastApplyNotice = null;
  } else {
    const lag = earliestApplicableDay(appState.config.planning, appState.playhead);
    upsertAction('rescheduleProduction', nodeId, lag.effectiveDay, { [key]: value });
    appState.lastApplyNotice = { nodeId, key, value, ...lag };
  }
  commit();
}

function upsertAction(type, nodeId, day, patch) {
  const list = appState.config.actions;
  const found = list.find((a) => a.type === type && a.nodeId === nodeId && a.day === day);
  if (found) Object.assign(found.newLevers, patch);
  else list.push({ type, nodeId, day, newLevers: { ...patch } });
}

export function setLaneLever(laneId, key, value) {
  appState.config.lanes[laneId][key] = value;
  commit();
}

export function setCustomerLever(customerId, key, value) {
  appState.config.customers[customerId][key] = value;
  commit();
}

/** 전역 계약 조건 — 전 고객에 일괄 적용 (§4.4-④ 2단 구조의 상단) */
export function setAllCustomers(key, value) {
  for (const c of Object.values(appState.config.customers)) c[key] = value;
  commit();
}

export function setPlanning(key, value) {
  appState.config.planning[key] = value;
  commit();
}

export function setGlobal(key, value) {
  appState.config[key] = value;
  commit();
}

export function setCost(key, value) {
  appState.config.cost[key] = value;
  commit();
}

export function setIdleCost(stage, value) {
  appState.config.cost.idleCostPerHour[stage] = value;
  commit();
}

export function addDisruption(d) {
  appState.config.disruptions.push(d);
  appState.presetId = 'CUSTOM';
  commit();
}

export function removeDisruption(index) {
  appState.config.disruptions.splice(index, 1);
  appState.presetId = 'CUSTOM';
  commit();
}

export function applyPreset(id) {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) return;
  appState.config.disruptions = JSON.parse(JSON.stringify(p.disruptions));
  appState.presetId = id;
  appState.mc = null;
  commit();
}

/** Ontology Action — 실제로 시뮬레이션 상태를 바꾼다 (§3.5 / §4.4-⑤) */
export function pushSimAction(action) {
  appState.config.actions.push(action);
  commit();
}

export function removeSimAction(index) {
  appState.config.actions.splice(index, 1);
  commit();
}

export function resetNode(nodeId) {
  const d = buildDefaultConfig();
  appState.config.nodes[nodeId] = d.nodes[nodeId];
  appState.config.actions = appState.config.actions.filter((a) => a.nodeId !== nodeId);
  commit();
}

export function resetAll() {
  appState.config = buildDefaultConfig();
  appState.mc = null;
  appState.presetId = 'BASELINE';
  appState.lastApplyNotice = null;
  recomputeNow();
}

// ── 순수 뷰 상태 (재계산 불필요) ────────────────────────────────────────
export function setPlayhead(d) {
  const H = appState.config.horizonDays;
  appState.playhead = Math.max(0, Math.min(H - 1, Math.round(d)));
  emitFrame();
  writeHash();
}

export function setSelection(sel) {
  appState.selection = sel;
  if (sel) appState.panel = sel.type === 'order' ? 'CUSTOMERS' : 'INSPECTOR';
  emitData();
}

export function setPanel(p) {
  appState.panel = appState.panel === p ? null : p;
  emitData();
}

export function setView(v) {
  appState.view = v;
  emitData();
  writeHash();
}

export function setMode(m) {
  appState.mode = m;
  appState.lastApplyNotice = null;
  emitData();
}

export function setUnit(u) {
  appState.displayUnit = u;
  setDisplayUnit(u);
  emitData();
}

export function toggleWatch(type, id) {
  const key = `${type}:${id}`;
  const i = appState.watchlist.indexOf(key);
  if (i >= 0) appState.watchlist.splice(i, 1);
  else appState.watchlist.push(key);
  emitData();
}

export function isWatched(type, id) {
  return appState.watchlist.includes(`${type}:${id}`);
}

export function toggleCounterfactual() {
  appState.showCounterfactual = !appState.showCounterfactual;
  emitData();
}

export function setMonteCarlo(mc) {
  appState.mc = mc;
  appState.mcProgress = 0;
  emitData();
}

export function setMcProgress(p) {
  appState.mcProgress = p;
  emitData();
}

// ═══════════════════════════════════════════════════════════════════════
// URL 해시 — config + playhead + view 만 인코딩 (§1.5.5 / §4.8)
// 기본값 대비 차분만 담아 링크를 짧게 유지한다.
// ═══════════════════════════════════════════════════════════════════════
function diff(base, cur) {
  if (Array.isArray(cur)) return JSON.stringify(cur) === JSON.stringify(base) ? undefined : cur;
  if (cur && typeof cur === 'object') {
    const out = {};
    for (const k of Object.keys(cur)) {
      const d = diff(base?.[k], cur[k]);
      if (d !== undefined) out[k] = d;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return cur === base ? undefined : cur;
}

function mergeDeep(base, patch) {
  if (patch === undefined) return base;
  if (Array.isArray(patch) || typeof patch !== 'object' || patch === null) return patch;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(patch)) out[k] = mergeDeep(base?.[k], patch[k]);
  return out;
}

let suppressHash = false;

export function writeHash() {
  if (suppressHash) return;
  try {
    const patch = diff(buildDefaultConfig(), appState.config) || {};
    const payload = { c: patch, d: appState.playhead, v: appState.view, m: appState.mode, u: appState.displayUnit };
    const json = JSON.stringify(payload);
    const b64 = btoa(unescape(encodeURIComponent(json))).replace(/=+$/, '');
    history.replaceState(null, '', `#s=${b64}`);
  } catch (e) {
    console.warn('hash 인코딩 실패', e);
  }
}

export function readHash() {
  const m = location.hash.match(/#s=(.+)$/);
  if (!m) return false;
  try {
    const json = decodeURIComponent(escape(atob(m[1])));
    const p = JSON.parse(json);
    suppressHash = true;
    appState.config = mergeDeep(buildDefaultConfig(), p.c || {});
    appState.playhead = p.d ?? 0;
    appState.view = p.v || 'NETWORK';
    appState.mode = p.m || 'DESIGN';
    appState.displayUnit = p.u || 'MWh';
    setDisplayUnit(appState.displayUnit);
    appState.presetId = 'CUSTOM';
    suppressHash = false;
    return true;
  } catch (e) {
    console.warn('hash 해석 실패 — 기본 설정으로 시작', e);
    suppressHash = false;
    return false;
  }
}

