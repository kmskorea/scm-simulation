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

import { buildDefaultConfig, buildLiveConfig, PRESETS, LIVE } from './data.js';
import { runSim, computeTTS, counterfactualConfig, earliestApplicableDay } from './sim.js';
import { recommend } from './recommend.js';
import { setDisplayUnit } from './units.js';

export const appState = {
  // 시작 상태는 '현장에서 관측된 지금' 이다 — 설계 기준선이 아니라.
  config: buildLiveConfig(),
  mode: 'LIVE', // 'LIVE' (관측) | 'PLAN' (대응 수립)
  nowDay: LIVE.nowDay, // 실측/예측 경계. 화면에는 실제 일시로 표기된다.
  projectionRevealed: false, // LIVE 에서 '이대로 두면?' 을 실행했는가
  recommendations: [], // 파생 — 진단 기반 Action 추천 (src/recommend.js)
  result: null, // 파생 — 저장하지 않는다
  counterfactual: null,
  baseline: null, // 파생 — 장애/Action 을 제거한 무장애 기준선 (원가 귀속의 기준점)
  costMode: 'DELTA', // 'DELTA' | 'ABS' — COST 뷰 표시 기준
  playhead: LIVE.nowDay, // 시작 지점은 '지금' — 해시가 있으면 readHash 가 덮어쓴다
  selection: null, // { type: 'node'|'lane'|'hub'|'customer'|'order', id }
  view: 'NETWORK', // 'NETWORK' | 'FLOW' | 'COST'
  displayUnit: 'MWh',
  watchlist: [],
  panel: null, // 'INSPECTOR'|'SCENARIO'|'PLANNING'|'ONTOLOGY'
  showCounterfactual: false,
  playing: false,
  speed: 1,
  mc: null, // Monte Carlo 결과 (§3.6)
  mcProgress: 0,
  lastApplyNotice: null, // PLAN 모드 최단 적용 가능일 안내
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

/**
 * 무장애 기준선 config — 장애와 대응 Action 을 모두 제거한다.
 * 원가를 "장애에 귀속되는 몫"으로 분해하려면 비교 기준이 필요하다. 특송 같은
 * 대응 Action 도 장애가 없었으면 발생하지 않았을 비용이므로 함께 제거한다.
 */
function baselineConfig(config) {
  return { ...config, disruptions: [], actions: [] };
}

/** 장애도 Action 도 없으면 기준선이 곧 현재 시나리오다 — run 을 아낀다. */
function isUndisrupted(config) {
  return config.disruptions.length === 0 && config.actions.length === 0;
}

export function recomputeNow() {
  const t0 = performance.now();
  appState.result = runSim(appState.config);
  appState.counterfactual = runSim(counterfactualConfig(appState.config));
  appState.baseline = isUndisrupted(appState.config)
    ? appState.result
    : runSim(baselineConfig(appState.config));
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
    // 추천은 TTS 가 채워진 뒤에 계산한다 — 위험도 근거로 TTS 를 쓰기 때문이다.
    scheduleRecommend();
  }, 400);
}

let recTimer = null;
function scheduleRecommend() {
  // 후보마다 runSim 을 한 번씩 더 돌리므로(≈5ms×N) TTS 와 같이 뒤로 미룬다.
  clearTimeout(recTimer);
  recTimer = setTimeout(() => {
    try {
      appState.recommendations = recommend(appState);
    } catch (e) {
      console.warn('추천 계산 실패', e);
      appState.recommendations = [];
    }
    emitData();
  }, 120);
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
 * 생산 노드 레버 변경 — 항상 계획 레이어를 경유한다.
 *
 * D+0 부터 소급 적용하던 DESIGN 모드는 없앴다. 관측된 현재(LIVE)를 기준으로
 * 삼는 이상 이미 계측된 과거를 다시 쓰는 것은 성립하지 않는다. 모든 조정은
 * '최단 적용 가능일'에 발효되는 Action 으로 큐에 들어간다.
 *
 * 컨트롤은 어떤 모드에서도 잠그지 않는다 (§8). LIVE 에서 레버를 건드리면
 * 그 화면은 더 이상 관측이 아니므로 PLAN 으로 넘어간다 — 슬라이더를 당겼는데
 * 아무 일도 일어나지 않는 막다른 상태를 만들지 않기 위해서다.
 */
export function setNodeLever(nodeId, key, value) {
  if (appState.mode === 'LIVE') appState.mode = 'PLAN';
  const lag = earliestApplicableDay(appState.config.planning, appState.playhead);
  upsertAction('rescheduleProduction', nodeId, lag.effectiveDay, { [key]: value });
  appState.lastApplyNotice = { nodeId, key, value, ...lag };
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

/**
 * 추천 승인 → 실행. 추천 카드의 '승인' 버튼이 부르는 유일한 경로다.
 *
 * 계획 파라미터 조정(configPatch)과 설비/물류 Action 은 반영 경로가 다르다 —
 * 전자는 계획 레이어 자체를 바꾸는 것이라 즉시 적용되고, 후자는 그 계획
 * 레이어를 통과해 '최단 적용 가능일'에 발효된다. 추천 카드가 보여준
 * effectiveDay 와 실제 발효일이 어긋나면 안 되므로 여기서도 같은 계산을 쓴다.
 */
export function approveRecommendation(rec) {
  if (rec.configPatch) {
    for (const [k, v] of Object.entries(rec.configPatch.planning || {})) {
      appState.config.planning[k] = v;
    }
  } else {
    const lag = earliestApplicableDay(appState.config.planning, appState.nowDay);
    const a = { ...rec.action };
    if (a.type === 'expediteLane') a.startDay = lag.effectiveDay;
    else a.day = lag.effectiveDay;
    appState.config.actions.push(a);
  }
  // 승인하면 그 화면은 더 이상 관측이 아니다 — 대응 검토 모드로 넘어간다.
  if (appState.mode === 'LIVE') appState.mode = 'PLAN';
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

/** 조정한 레버·주입한 장애를 걷어내고 '현재 관측된 현장 상태'로 되돌린다. */
export function resetAll() {
  appState.config = buildLiveConfig();
  appState.mc = null;
  appState.presetId = 'LIVE';
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
  if (sel) appState.panel = 'INSPECTOR';
  emitData();
}

export function setPanel(p) {
  appState.panel = appState.panel === p ? null : p;
  emitData();
}

/** 토글이 아니라 '무조건 연다' — 자동 연출에서 이미 열려 있는 패널을 닫으면 안 된다. */
export function openPanel(p) {
  if (appState.panel === p) return;
  appState.panel = p;
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
  // LIVE 는 '지금'을 보는 모드다. 플레이헤드를 관측 시점에 고정하고
  // 재생을 멈춘다 — 과거를 훑는 것은 진단이 아니라 분석이다.
  if (m === 'LIVE') {
    appState.playing = false;
    appState.playhead = appState.nowDay;
    // SCENARIO 는 PLAN 전용이다. 열어 둔 채 LIVE 로 돌아오면 레일에서는
    // 사라지는데 패널만 남아 닫을 방법이 없어지므로 여기서 함께 닫는다.
    if (appState.panel === 'SCENARIO') appState.panel = null;
  }
  emitData();
}

/**
 * LIVE 모드의 '이대로 두면?' — 예측 구간을 연다. 엔진은 다시 돌지 않는다.
 *
 * 여는 데서 끝내지 않고 관측 시점부터 지평선 끝까지 자동 재생을 요청한다.
 * 숫자만 바뀌면 '무슨 일이 벌어지는지'가 안 보이고, 재생이 끝나야 담당자가
 * 결과를 다 본 시점이므로 그때 AI 진단·추천을 연다 (ui.js 가 신호를 받는다).
 */
export function revealProjection() {
  appState.projectionRevealed = true;
  appState.playhead = appState.nowDay;
  emitData();
  window.dispatchEvent(new CustomEvent('projection-play'));
}

/** 관측 시점으로 복귀. */
export function goToNow() {
  appState.playhead = appState.nowDay;
  emitFrame();
  writeHash();
}

/** 설계 기준선(nameplate)으로 되돌린다 — 현장 실측 편차를 걷어낸 상태. */
export function resetToDesign() {
  appState.config = buildDefaultConfig();
  appState.mc = null;
  appState.presetId = 'BASELINE';
  appState.lastApplyNotice = null;
  recomputeNow();
}

/** 재생 속도 — ADVANCED 패널과 재생 루프가 같은 값을 봐야 하므로 store 가 보유한다. */
export function setSpeed(s) {
  appState.speed = s;
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

export function setCostMode(m) {
  appState.costMode = m;
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
    appState.mode = p.m === 'PLAN' ? 'PLAN' : 'LIVE'; // 구 DESIGN/OPERATE 해시는 LIVE 로 흡수
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

