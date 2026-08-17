// ═══════════════════════════════════════════════════════════════════════════
// src/sim.js — 이산 시뮬레이션 엔진
//
// 계약:
//   runSim(config) -> result      순수 함수. DOM 의존 0. 외부 상태 변경 0.
//   같은 config 를 두 번 넣으면 두 번 다 완전히 같은 result 가 나온다.
//
// 실행 모델(§1.5): 재생하면서 계산하지 않는다. 여기서 120일 전체를 한 번에
// 계산하고, 렌더링 계층은 result 의 k일 슬라이스만 읽는다.
//
// ── §3.2 에 대한 명시적 확장 ────────────────────────────────────────────────
// 사양서 §3.2 의 생산 가능량은 byCapacity/bySupply/bySpace 3항이지만, 그것만
// 쓰면 각 단계가 항상 최대로 밀어내므로 §3.9-①(무장애 시 blocked/starved = 0)
// 를 만족할 수 없다(Cell 여유 +14%, Link 여유 +11% 가 곧바로 재고 누적/기아로
// 나타난다). 따라서 계획 레이어(§3.4)가 산출하는 byPlan 을 네 번째 제약으로
// 추가한다. 이것이 이 도구의 명제 자체이기도 하다 —
//   정상 시: 계획 = 실제 흐름  → 누적 없음
//   장애 시: 계획이 infoLag/frozen 때문에 못 따라옴 → 상류가 벽에 밀어넣음
//            → BLOCKING. 하류는 시차를 두고 STARVING.
// ═══════════════════════════════════════════════════════════════════════════

import {
  NODES, HUB, CUSTOMERS, LANES, LANE_TYPES, UNITS, SIM,
  CELL_IDS, PACK_IDS, LINK_IDS, milesBetween, PO_BASE_YEAR_MONTH,
} from './data.js';
import * as COST from './cost.js';
import { COST_BUCKETS } from './cost.js';

const EPS = SIM.epsilon;

// ───────────────────────────────────────────────────────────────────────────
// RNG — mulberry32. 시드 고정 시 항상 동일.
// ───────────────────────────────────────────────────────────────────────────
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function triangular(rng, min, mode, max) {
  if (max <= min) return min;
  const u = rng();
  const c = (mode - min) / (max - min);
  if (u < c) return min + Math.sqrt(u * (max - min) * (mode - min));
  return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
}

// ───────────────────────────────────────────────────────────────────────────
// 레버 → 유효 산출
// ───────────────────────────────────────────────────────────────────────────
/** §2.4 유효 일산출. 장애 미반영(= 물리 설비 능력). */
export function effectiveDailyOutput(lev) {
  return (
    lev.theoreticalCapaPerHour *
    lev.operatingHoursPerDay *
    (lev.operatingDaysPerWeek / 7) *
    lev.availability *
    lev.yield
  );
}

/** 입고 기준 일소요량 (수율 역산). */
export function effectiveDailyInput(lev) {
  return effectiveDailyOutput(lev) / lev.yield;
}

export function outputBufferCapacity(lev) {
  return effectiveDailyOutput(lev) * lev.outputBufferDays;
}

export function inputBufferCapacity(lev) {
  return effectiveDailyInput(lev) * lev.inputBufferDays;
}

// ───────────────────────────────────────────────────────────────────────────
// 주문서 생성 — 12 고객 × 4개월 = 48 PO. 결정론적.
// ───────────────────────────────────────────────────────────────────────────
export function buildOrders(config) {
  const orders = [];
  // 지평선 너머 1개월치를 더 만든다. 주문서가 D+115 에서 뚝 끊기면 AZL 이
  // 출하할 곳을 잃고 막히면서 상류 전체가 인위적으로 BLOCKED 가 된다.
  // 이 꼬리 주문은 출하 대상일 뿐 KPI 집계에서는 제외한다(beyondHorizon).
  const months = Math.ceil(config.horizonDays / SIM.daysPerMonth) + 1;
  const spikes = (config.disruptions || []).filter((d) => d.type === 'demandSpike');
  for (const cust of CUSTOMERS) {
    const cc = config.customers[cust.id];
    for (let m = 0; m < months; m++) {
      const dueDay = m * SIM.daysPerMonth + cc.deliveryDayOfMonth;
      if (dueDay >= config.horizonDays + SIM.daysPerMonth) continue;
      let links = cc.monthlyLinks;
      for (const s of spikes) {
        if (s.target === cust.id && dueDay >= s.startDay) links *= s.multiplier;
      }
      const ym = PO_BASE_YEAR_MONTH.year * 100 + PO_BASE_YEAR_MONTH.month + m;
      orders.push({
        id: `PO-${cust.poCode}-${String(ym).padStart(4, '0')}`,
        customerId: cust.id,
        month: m,
        dueDay,
        qtyLinks: links,
        qtyMWh: links * UNITS.linkMWh,
        deliveredMWh: 0,
        inTransitMWh: 0,
        deliveredDay: null,
        firstShipDay: null,
        lateDays: 0,
        penaltyUSD: 0,
        status: 'PENDING', // PENDING | IN_TRANSIT | PARTIAL | DELIVERED | LATE | UNDELIVERED
        beyondHorizon: dueDay >= config.horizonDays,
        deliveries: [],
      });
    }
  }
  orders.sort((a, b) => a.dueDay - b.dueDay || a.id.localeCompare(b.id));
  return orders;
}

/** 명목 수요율(MWh/day) — 계획 레이어 입력. demandSpike 반영. */
function demandRateAt(config, day) {
  let links = 0;
  for (const cust of CUSTOMERS) {
    let m = config.customers[cust.id].monthlyLinks;
    for (const s of config.disruptions || []) {
      if (s.type === 'demandSpike' && s.target === cust.id && day >= s.startDay) m *= s.multiplier;
    }
    links += m;
  }
  return (links * UNITS.linkMWh) / SIM.daysPerMonth;
}

// ───────────────────────────────────────────────────────────────────────────
// Action → 레버 오버라이드 해석
// ───────────────────────────────────────────────────────────────────────────
function buildLeverResolver(config) {
  const overrides = {}; // nodeId -> [{day, patch}]
  for (const a of config.actions || []) {
    if (a.type === 'rescheduleProduction' || a.type === 'adjustShift') {
      const patch =
        a.type === 'adjustShift' ? { operatingHoursPerDay: a.hours } : a.newLevers || {};
      (overrides[a.nodeId] ||= []).push({ day: a.day, patch });
    }
  }
  for (const k of Object.keys(overrides)) overrides[k].sort((x, y) => x.day - y.day);

  const cache = new Map();
  return function leversAt(nodeId, day) {
    const list = overrides[nodeId];
    if (!list || !list.length) return config.nodes[nodeId];
    let n = 0;
    while (n < list.length && list[n].day <= day) n++;
    const key = `${nodeId}:${n}`;
    if (cache.has(key)) return cache.get(key);
    let lev = { ...config.nodes[nodeId] };
    for (let i = 0; i < n; i++) lev = { ...lev, ...list[i].patch };
    cache.set(key, lev);
    return lev;
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 장애 조회
// ───────────────────────────────────────────────────────────────────────────
function disruptionState(config, nodeId, day) {
  let down = false;
  let capacityFactor = 1;
  let yieldDelta = 0;
  for (const d of config.disruptions || []) {
    if (d.target !== nodeId) continue;
    const dur = d.durationDays ?? config.horizonDays;
    if (day < d.startDay || day >= d.startDay + dur) continue;
    if (d.type === 'nodeDown') down = true;
    else if (d.type === 'capacityDrop') capacityFactor *= 1 - (d.pct ?? 0);
    else if (d.type === 'yieldDrop') yieldDelta += d.deltaPct ?? 0;
  }
  return { down, capacityFactor, yieldDelta };
}

function laneExtraDays(config, laneId, day) {
  let extra = 0;
  for (const d of config.disruptions || []) {
    if (d.type !== 'laneDelay' || d.target !== laneId) continue;
    const dur = d.durationDays ?? config.horizonDays;
    if (day >= d.startDay && day < d.startDay + dur) extra += d.extraDays ?? 0;
  }
  return extra;
}

function plannedDown(lev, day) {
  for (const p of lev.plannedDowntime || []) {
    if (day >= p.startDay && day < p.startDay + p.durationDays) return true;
  }
  return false;
}

// ───────────────────────────────────────────────────────────────────────────
// Lane 기하 / 리드타임
// ───────────────────────────────────────────────────────────────────────────
function laneMiles(config, lane) {
  return milesBetween(lane.from, lane.to, config.roadFactor);
}

function baseTransitDays(config, lane, miles) {
  const lc = config.lanes[lane.id];
  return Math.ceil(miles / lc.milesPerDay) + lc.loadUnloadDays;
}

function truckMWhFor(config, lane) {
  const t = LANE_TYPES[lane.laneType];
  return config.lanes[lane.id].truckLoad * t.unitMWh;
}

function isShipDay(lc, day) {
  if (lc.frequency === 'daily') return true;
  return lc.shipDaysOfWeek.includes(day % 7);
}

// ───────────────────────────────────────────────────────────────────────────
// 계획 레이어 (§3.4)
// ───────────────────────────────────────────────────────────────────────────
/**
 * 인지된 설비 능력으로부터 단계별 목표 산출률을 계산한다.
 * 병목 1회 통과 후 각 단계 목표를 수율 역산으로 배분.
 */
function computePlan(perceivedCapacity, yieldsByStage, demandRate, inventoryAdj) {
  const sum = (ids) => ids.reduce((s, id) => s + (perceivedCapacity[id] ?? 0), 0);
  const cellCap = sum(CELL_IDS);
  const packCap = sum(PACK_IDS);
  const linkCap = sum(LINK_IDS);
  const yPack = yieldsByStage.PACK;
  const yLink = yieldsByStage.LINK;

  // 각 단계 능력을 '고객 인도량' 단위로 환산해 최소값을 취한다.
  const systemRate = Math.min(
    demandRate,
    linkCap,
    packCap * yLink,
    cellCap * yPack * yLink
  );

  const linkTotal = systemRate;
  const packTotal = linkTotal / yLink;
  const cellTotal = packTotal / yPack;

  const rates = {};
  const share = (ids, total) => {
    const cap = sum(ids);
    for (const id of ids) {
      rates[id] = cap > EPS ? (total * (perceivedCapacity[id] ?? 0)) / cap : 0;
      // 개별 노드는 자기 능력을 넘어설 수 없다
      rates[id] = Math.min(rates[id], perceivedCapacity[id] ?? 0);
    }
  };
  share(CELL_IDS, cellTotal);
  share(PACK_IDS, packTotal);
  share(LINK_IDS, linkTotal);

  // 재고 상계 — 인지된 출고재고가 목표보다 많으면 낮추고, 적으면 올린다.
  // 이 보정은 replan 시점에만 일어나고 frozen window 뒤에야 발효된다. 그래서
  // 상류는 '창고가 이미 꽉 찼는데도' 한동안 계획대로 계속 밀어넣게 된다.
  if (inventoryAdj) {
    for (const id of Object.keys(rates)) {
      rates[id] = Math.max(0, Math.min(rates[id] + (inventoryAdj[id] ?? 0), perceivedCapacity[id] ?? 0));
    }
  }
  return { rates, systemRate };
}

/**
 * PLAN 모드용 — day 시점 변경이 실제로 적용되는 최단 일자.
 * 실질 대응 지연 = 정보지연 + (다음 replan 경계까지) + frozen window
 */
export function earliestApplicableDay(planning, day) {
  const perceived = day + planning.infoLagDays;
  const cycle = Math.max(1, planning.replanCycleDays);
  const nextReplan = Math.ceil(perceived / cycle) * cycle;
  return {
    perceivedDay: perceived,
    replanDay: nextReplan,
    effectiveDay: nextReplan + planning.frozenWindowDays,
    infoLagDays: planning.infoLagDays,
    replanWaitDays: nextReplan - perceived,
    frozenWindowDays: planning.frozenWindowDays,
    totalLagDays: nextReplan + planning.frozenWindowDays - day,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 배분 규칙 (§3.4)
// ───────────────────────────────────────────────────────────────────────────
function sortOrdersByRule(orders, rule, config, day) {
  const arr = [...orders];
  const terms = (o) => config.customers[o.customerId];
  switch (rule) {
    case 'penaltyValue':
      arr.sort((a, b) => {
        const ea = (a.qtyMWh - a.deliveredMWh) * terms(a).contractValuePerMWh * terms(a).ldRatePerDay;
        const eb = (b.qtyMWh - b.deliveredMWh) * terms(b).contractValuePerMWh * terms(b).ldRatePerDay;
        return eb - ea || a.dueDay - b.dueDay;
      });
      break;
    case 'priorityTier':
      arr.sort((a, b) => terms(a).priorityTier - terms(b).priorityTier || a.dueDay - b.dueDay);
      break;
    case 'fcfs':
      arr.sort((a, b) => a.month - b.month || a.id.localeCompare(b.id));
      break;
    case 'proRata':
      arr.sort((a, b) => a.dueDay - b.dueDay || a.id.localeCompare(b.id));
      break;
    case 'dueDate':
    default:
      arr.sort((a, b) => a.dueDay - b.dueDay || a.id.localeCompare(b.id));
  }
  return arr;
}

// ═══════════════════════════════════════════════════════════════════════════
// 메인 엔진
// ═══════════════════════════════════════════════════════════════════════════
export function runSim(config) {
  const H = config.horizonDays;
  const rng = mulberry32(config.seed);
  const stochastic = !!config.stochastic;
  const leversAt = buildLeverResolver(config);
  const cost = config.cost;

  // ── 노드 상태 초기화 ────────────────────────────────────────────────────
  const nodeState = {};
  const nodeMeta = {};
  for (const n of NODES) {
    const lev = config.nodes[n.id];
    const inCap = inputBufferCapacity(lev);
    const outCap = outputBufferCapacity(lev);
    nodeState[n.id] = {
      inputBuffer: n.type === 'CELL' ? 0 : inCap * SIM.initialInputFillPct,
      outputBuffer: outCap * SIM.initialOutputFillPct[n.type],
      unplannedDownUntil: -1,
      lastStatus: null,
    };
    nodeMeta[n.id] = { type: n.type, node: n };
  }

  const perNode = {};
  for (const n of NODES) {
    perNode[n.id] = {
      id: n.id, type: n.type,
      blockedDays: 0, starvedDays: 0, downDays: 0, runningDays: 0,
      lostOutputMWh: 0, producedMWh: 0, consumedMWh: 0, yieldLossMWh: 0,
      utilizationPct: 0,
      stateTimeline: new Array(H),
      inputBufferSeries: new Array(H),
      outputBufferSeries: new Array(H),
      producedSeries: new Array(H),
      planSeries: new Array(H),
      capacitySeries: new Array(H),
      fgiDaysOfSupply: new Array(H),
      inboundLeadDays: 0, // 아래에서 채운다
      leadTimeDemandMWh: 0,
      inputCapacity: inputBufferCapacity(config.nodes[n.id]),
      outputCapacity: outputBufferCapacity(config.nodes[n.id]),
      nominalDailyOutput: effectiveDailyOutput(config.nodes[n.id]),
      idleCostUSD: 0, blockingIdleUSD: 0, starvingIdleUSD: 0, storageUSD: 0,
    };
  }

  const perLane = {};
  const laneRuntime = {};
  for (const l of LANES) {
    const miles = laneMiles(config, l);
    perLane[l.id] = {
      id: l.id, from: l.from, to: l.to, laneType: l.laneType, role: l.role,
      miles,
      baseTransitDays: baseTransitDays(config, l, miles),
      shipmentsCount: 0, trucks: 0, shippedMWh: 0,
      transitDaysSum: 0, avgTransitDays: 0,
      freightUSD: 0, expediteUSD: 0, hubHandlingUSD: 0,
      inTransitMWhSeries: new Array(H).fill(0),
      shippedSeries: new Array(H).fill(0),
    };
    laneRuntime[l.id] = { waitDays: 0, seq: 0 };
  }

  // 노드별 인바운드 리드타임 — 공급원 능력 가중 평균
  for (const n of NODES) {
    if (n.type === 'CELL') continue;
    const feeders = LANES.filter(
      (l) => l.to === n.id && l.role !== 'toHub' && l.role !== 'fromHub'
    );
    let w = 0, acc = 0;
    for (const l of feeders) {
      const cap = effectiveDailyOutput(config.nodes[l.from]);
      w += cap;
      acc += cap * (baseTransitDays(config, l, perLane[l.id].miles) +
                    (n.id === 'AZL' && config.routeViaHub ? config.hubDwellDays : 0));
    }
    const p = perNode[n.id];
    p.inboundLeadDays = w > EPS ? acc / w : 0;
    p.leadTimeDemandMWh = p.inboundLeadDays * effectiveDailyInput(config.nodes[n.id]);
  }

  // Cell → Pack 은 최단거리 우선, 초과분 차순위 이월
  const packOrderByCell = {};
  for (const c of CELL_IDS) {
    packOrderByCell[c] = [...PACK_IDS].sort(
      (a, b) => milesBetween(c, a, config.roadFactor) - milesBetween(c, b, config.roadFactor)
    );
  }
  // 핫 루프에서 LANES.find 를 돌지 않도록 인덱스를 만들어 둔다
  const laneBetween = {};
  for (const l of LANES) laneBetween[`${l.from}>${l.to}`] = l;
  const laneOf = (from, to) => laneBetween[`${from}>${to}`];

  const orders = buildOrders(config);
  const ordersById = Object.fromEntries(orders.map((o) => [o.id, o]));

  const inTransit = []; // { arriveDay, ... }
  const shipments = [];
  const events = [];
  const addEvent = (day, severity, nodeId, message, extra) =>
    events.push({ day, severity, nodeId, message, ...extra });

  // 물질수지 추적
  let rawInputMWh = 0;
  let yieldLossMWh = 0;
  let deliveredMWhTotal = 0;
  let shippedMWhTotal = 0;
  let transitDaysWeighted = 0;
  // warm start 화물도 in-transit 재고에 잡히므로 Little's Law 통계에 포함한다.
  const countInFlow = (qty, days) => { shippedMWhTotal += qty; transitDaysWeighted += qty * days; };

  // 계획 상태
  const capacityHistory = new Array(H);
  const bufferHistory = new Array(H); // 일 마감 출고재고 — 계획이 '인지'하는 값
  const pendingPlans = []; // { effectiveDay, plan }
  const planLog = [];

  const stageYieldsFrom = (levById, capById) => {
    const avg = (ids) => {
      let w = 0, s = 0;
      for (const id of ids) {
        const c = capById[id] ?? 0;
        w += c; s += c * levById[id].yield;
      }
      return w > EPS ? s / w : 0.94;
    };
    return { CELL: avg(CELL_IDS), PACK: avg(PACK_IDS), LINK: avg(LINK_IDS) };
  };

  // D+0 초기 계획 — 장애 없는 명목 능력 기준
  const nominalCap = {};
  for (const n of NODES) nominalCap[n.id] = effectiveDailyOutput(config.nodes[n.id]);
  let currentPlan = computePlan(
    nominalCap,
    stageYieldsFrom(config.nodes, nominalCap),
    demandRateAt(config, 0)
  );
  planLog.push({ day: 0, effectiveDay: 0, systemRate: currentPlan.systemRate, reason: 'INITIAL' });

  // ── Warm start ─────────────────────────────────────────────────────────
  // D+0 이전에도 네트워크가 돌고 있었다고 가정한다. 파이프라인이 비어 있으면
  // 첫 달 전체가 기동 과도현상으로 지연되어 기준선이 무의미해진다.
  // 가정: 정상 흐름률이 리드타임만큼 이미 이동 중.  // TODO: 실제 기초 in-transit
  {
    const capOf = (id) => nominalCap[id] ?? 0;
    for (const n of NODES) {
      if (n.type === 'CELL') continue;
      const need = (currentPlan.rates[n.id] ?? 0) / config.nodes[n.id].yield;
      const feeders = LANES.filter((l) => l.to === n.id && l.role !== 'toHub' && l.role !== 'fromHub');
      const totalSrc = feeders.reduce((s, l) => s + capOf(l.from), 0);
      if (totalSrc <= EPS) continue;
      for (const l of feeders) {
        const rate = (need * capOf(l.from)) / totalSrc;
        const T = baseTransitDays(config, l, perLane[l.id].miles);
        // T일치가 이동 중 — 오늘(D+0) 도착분부터 채워야 기동일에 굶지 않는다.
        for (let d = 0; d < T; d++) {
          if (rate <= EPS) continue;
          inTransit.push({
            id: `WARM-${l.id}-${d}`, laneId: l.id, from: l.from, to: l.to,
            qtyMWh: rate, trucks: Math.max(1, Math.round(rate / truckMWhFor(config, l))),
            departDay: d - T - 1, arriveDay: d, transitDays: T,
            expedited: false, viaHub: false, miles: perLane[l.id].miles,
            orderId: null, warmStart: true,
          });
          countInFlow(rate, T);
        }
      }
    }
    // 첫 달 주문은 D+0 이전에 이미 일부 출하되어 있었다고 본다.
    for (const o of orders) {
      if (o.month !== 0) continue;
      const lane = LANES.find((l) => l.from === 'AZL' && l.to === o.customerId);
      const T = perLane[lane.id].baseTransitDays;
      const windowStart = o.dueDay - T - SIM.preShipDays;
      if (windowStart >= 0) continue;
      const frac = Math.min(1, -windowStart / (o.dueDay - windowStart));
      const qty = o.qtyMWh * frac;
      if (qty <= EPS) continue;
      inTransit.push({
        id: `WARM-${lane.id}-${o.id}`, laneId: lane.id, from: 'AZL', to: o.customerId,
        qtyMWh: qty, trucks: Math.max(1, Math.round(qty / truckMWhFor(config, lane))),
        departDay: -T, arriveDay: Math.max(1, o.dueDay - 1), transitDays: T,
        expedited: false, viaHub: false, miles: perLane[lane.id].miles,
        orderId: o.id, warmStart: true,
      });
      countInFlow(qty, T);
      o.inTransitMWh += qty;
      o.firstShipDay = 0;
      o.status = 'IN_TRANSIT';
    }
  }

  // 기초 재고 — warm start 파이프라인까지 포함해 물질수지 기준점을 잡는다.
  const initialInventoryMWh =
    NODES.reduce((s, n) => s + nodeState[n.id].inputBuffer + nodeState[n.id].outputBuffer, 0) +
    inTransit.reduce((s, x) => s + x.qtyMWh, 0);

  // 시스템 시계열
  // costSeries 는 버킷별 '누적' 원가다(그날까지 발생한 총액). 특정일에 발생한
  // 금액만 필요하면 호출부에서 costSeries[d] - costSeries[d-1] 로 차분한다 —
  // 어제 대비 델타 스트립(ui.js)이 이미 이 패턴을 쓴다. 배열을 따로 하나 더
  // 두지 않는 이유는 저장하는 정보가 결국 같기 때문이다: 매일을 순회하며
  // 누적을 다시 미분하느니, 누적 하나만 진실의 원천으로 두고 필요할 때
  // 차분하는 쪽이 이중 부기를 피한다.
  const sys = {
    throughputMWhPerDay: new Array(H).fill(0),
    deliveredMWhSeries: new Array(H).fill(0),
    wipSeries: new Array(H).fill(0),
    inTransitSeries: new Array(H).fill(0),
    costSeries: Object.fromEntries(COST_BUCKETS.map((b) => [b.id, new Array(H).fill(0)])),
    totalCostSeries: new Array(H).fill(0),
    planRateSeries: new Array(H).fill(0),
    demandRateSeries: new Array(H).fill(0),
  };

  const breakdown = {
    baseFreight: 0, blockingIdle: 0, starvingIdle: 0,
    excessStorage: 0, expedite: 0, ldPenalty: 0,
  };
  let hubHandlingUSD = 0;


  // ── Action 인덱스 ───────────────────────────────────────────────────────
  const expediteShipmentIds = new Set(
    (config.actions || []).filter((a) => a.type === 'expediteShipment').map((a) => a.shipmentId)
  );
  const expediteLaneWindows = (config.actions || []).filter((a) => a.type === 'expediteLane');
  const reallocations = (config.actions || []).filter((a) => a.type === 'reallocateInventory');

  function isExpedited(lane, shipmentId, day) {
    const lc = config.lanes[lane.id];
    if (!lc.expediteEnabled) return false;
    if (expediteShipmentIds.has(shipmentId)) return true;
    for (const w of expediteLaneWindows) {
      if (w.laneId !== lane.id) continue;
      const dur = w.durationDays ?? 9999;
      if (day >= w.startDay && day < w.startDay + dur) return true;
    }
    return false;
  }

  // ── Lane 로 화물 발송 ───────────────────────────────────────────────────
  function dispatch(lane, day, qtyMWh, trucks, opts = {}) {
    if (qtyMWh <= EPS) return null;
    const lc = config.lanes[lane.id];
    const rt = laneRuntime[lane.id];
    const id = `SHP-${lane.id}-${day}-${rt.seq++}`;
    const expedited = isExpedited(lane, id, day);

    let miles = perLane[lane.id].miles;
    let transit = baseTransitDays(config, lane, miles) + laneExtraDays(config, lane.id, day);
    let viaHub = false;
    let hubTrucks = 0;

    // Pack → Link 환적 경로: 물리적으로 PW→CHI→AZL 두 구간을 합산한다.
    if (opts.viaHub) {
      viaHub = true;
      const toHub = LANES.find((x) => x.from === lane.from && x.to === HUB.id);
      const fromHub = LANES.find((x) => x.from === HUB.id && x.to === 'AZL');
      const m1 = perLane[toHub.id].miles;
      const m2 = perLane[fromHub.id].miles;
      miles = m1 + m2;
      transit =
        baseTransitDays(config, toHub, m1) +
        baseTransitDays(config, fromHub, m2) +
        config.hubDwellDays +
        laneExtraDays(config, toHub.id, day) +
        laneExtraDays(config, fromHub.id, day);
      hubTrucks = trucks;
    }

    if (expedited) transit = Math.max(1, Math.round(transit * lc.expediteSpeedup));
    if (stochastic) transit = Math.max(1, Math.round(triangular(rng, transit, transit * 1.15, transit * 1.6)));

    const arriveDay = day + transit;
    const shp = {
      id, laneId: lane.id, from: lane.from, to: lane.to,
      qtyMWh, trucks, departDay: day, arriveDay, transitDays: transit,
      expedited, viaHub, miles, orderId: opts.orderId || null,
    };
    inTransit.push(shp);
    shipments.push(shp);

    const f = COST.freightForShipment(
      { trucks, miles, expedited, expediteCostMultiplier: lc.expediteCostMultiplier },
      cost
    );
    breakdown.baseFreight += f.base;
    breakdown.expedite += f.expediteExtra;
    perLane[lane.id].freightUSD += f.base;
    perLane[lane.id].expediteUSD += f.expediteExtra;
    if (viaHub) {
      const hh = COST.hubHandling(hubTrucks, cost);
      hubHandlingUSD += hh;
      breakdown.baseFreight += hh;
      perLane[lane.id].hubHandlingUSD += hh;
    }

    const pl = perLane[lane.id];
    pl.shipmentsCount += 1;
    pl.trucks += trucks;
    pl.shippedMWh += qtyMWh;
    pl.transitDaysSum += transit;
    pl.shippedSeries[day] += qtyMWh;
    rt.waitDays = 0;
    countInFlow(qtyMWh, transit);
    return shp;
  }

  /**
   * 적재 정책 (§2.5): 만차는 항상 출하. 잔여는 minLoadPct 이상이거나
   * forceShipAfterDays 를 넘겨 대기했을 때만 출하.
   * roomMWh 로 목적지 여유(입고버퍼 − 재고 − in-transit)를 넘지 않게 제한한다.
   */
  function planLoad(lane, availMWh, roomMWh, day, forceRemainder = false) {
    const lc = config.lanes[lane.id];
    if (!isShipDay(lc, day)) return { qty: 0, trucks: 0 };
    const truckMWh = truckMWhFor(config, lane);
    if (truckMWh <= EPS) return { qty: 0, trucks: 0 };
    const cap = Math.max(0, Math.min(availMWh, roomMWh));
    if (cap <= EPS) return { qty: 0, trucks: 0 };

    let trucks = Math.floor((cap + EPS) / truckMWh);
    let qty = trucks * truckMWh;
    const remainder = cap - qty;
    const fill = remainder / truckMWh;
    const rt = laneRuntime[lane.id];
    // 만차 미달분은 대기시킨다 — 이 규칙이 bullwhip 의 발원지(§2.5).
    // 단 대기 상한을 넘겼거나 이미 출하 기한이 지난 건은 그냥 보낸다.
    const forced = forceRemainder || rt.waitDays >= lc.forceShipAfterDays;
    if (remainder > EPS && (fill >= lc.minLoadPct - EPS || forced)) {
      trucks += 1;
      qty += remainder;
    }
    return { qty, trucks };
  }

  /**
   * 목적지 입고 여유 = 보충 목표 재고 포지션 − 현 재고 − 이동 중 물량.
   * 목표 포지션 = 입고창고 × targetInputFillPct + 리드타임 소요분.
   * 수송 중에도 목적지는 계속 소비하므로 리드타임 소요분을 목표에 더해야
   * 현물 재고가 목표 수준(창고의 절반)에 머문다.
   */
  function roomAt(nodeId) {
    const p = perNode[nodeId];
    const st = nodeState[nodeId];
    let committed = 0;
    for (const s of inTransit) if (s.to === nodeId) committed += s.qtyMWh;
    const target = p.inputCapacity * SIM.targetInputFillPct + p.leadTimeDemandMWh;
    return Math.max(0, target - st.inputBuffer - committed);
  }

  /**
   * 한 단계(Cell→Pack, Pack→Link)의 출하를 처리한다.
   *
   * 정상 흐름에서 목적지 여유가 하루에 열리는 양은 소비율과 같고, 그것은 상류
   * 총산출과 같다(= 여유 0). 이때 배차를 탐욕적으로 하면 한 공장이 그날 여유를
   * 독식하고 나머지는 적체 → BLOCKED 가 된다. 실제로는 배차가 소요량에 비례해
   * 나뉘므로 여기서도 1차 비례배분 후 2차로 잔여분을 적체순으로 처리한다.
   */
  function shipStage(sourceIds, destOrderFor, day, dispatchOpts) {
    const room = {};
    let totalRoom = 0;
    const dests = new Set();
    for (const s of sourceIds) for (const d of destOrderFor(s)) dests.add(d);
    for (const d of dests) {
      room[d] = roomAt(d);
      totalRoom += room[d];
    }
    if (totalRoom <= EPS) return;

    let totalPending = 0;
    const pending = {};
    for (const s of sourceIds) {
      pending[s] = nodeState[s].outputBuffer;
      totalPending += pending[s];
    }
    if (totalPending <= EPS) return;

    const send = (sid, budget) => {
      const st = nodeState[sid];
      for (const did of destOrderFor(sid)) {
        if (st.outputBuffer <= EPS || budget <= EPS) break;
        if (room[did] <= EPS) continue;
        const lane = laneOf(sid, did);
        const { qty, trucks } = planLoad(
          lane, Math.min(st.outputBuffer, budget), room[did], day
        );
        if (qty > EPS) {
          st.outputBuffer -= qty;
          room[did] -= qty;
          budget -= qty;
          dispatch(lane, day, qty, trucks, dispatchOpts);
        }
      }
    };

    for (const sid of sourceIds) send(sid, (totalRoom * pending[sid]) / totalPending);
    const byPressure = [...sourceIds].sort(
      (a, b) =>
        nodeState[b].outputBuffer / perNode[b].nominalDailyOutput -
        nodeState[a].outputBuffer / perNode[a].nominalDailyOutput
    );
    for (const sid of byPressure) send(sid, Infinity);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 일 단위 루프
  // ═══════════════════════════════════════════════════════════════════════
  for (let day = 0; day < H; day++) {
    // ── 1. 도착 처리 ──────────────────────────────────────────────────────
    for (let i = inTransit.length - 1; i >= 0; i--) {
      const s = inTransit[i];
      if (s.arriveDay > day) continue;
      inTransit.splice(i, 1);
      if (s.orderId) {
        const o = ordersById[s.orderId];
        const lateDays = Math.max(0, day - o.dueDay - config.customers[o.customerId].graceDays);
        const pen = COST.ldPenalty(s.qtyMWh, lateDays, config.customers[o.customerId]);
        o.deliveredMWh += s.qtyMWh;
        o.inTransitMWh = Math.max(0, o.inTransitMWh - s.qtyMWh);
        o.deliveries.push({ day, qtyMWh: s.qtyMWh, lateDays, penaltyUSD: pen, shipmentId: s.id });
        o.penaltyUSD += pen;
        o.lateDays = Math.max(o.lateDays, lateDays);
        breakdown.ldPenalty += pen;
        deliveredMWhTotal += s.qtyMWh;
        sys.deliveredMWhSeries[day] += s.qtyMWh;
        if (o.deliveredMWh >= o.qtyMWh - EPS) {
          o.deliveredDay = day;
          o.status = lateDays > 0 ? 'LATE' : 'DELIVERED';
          if (lateDays > 0) {
            addEvent(day, 'CRIT', o.customerId,
              `${o.id} LATE ${lateDays}D · LD $${Math.round(o.penaltyUSD).toLocaleString('en-US')}`,
              { orderId: o.id });
          }
          // 정시 인도는 예외가 아니므로 피드에 남기지 않는다 (§4.8 예외 우선).
        } else {
          o.status = 'PARTIAL';
        }
      } else {
        nodeState[s.to].inputBuffer += s.qtyMWh;
      }
    }

    // ── 2. 가용성 / 능력 판정 ─────────────────────────────────────────────
    const todayCapacity = {};
    const todayLevers = {};
    const todayDown = {};
    for (const n of NODES) {
      const lev0 = leversAt(n.id, day);
      const dis = disruptionState(config, n.id, day);
      const lev = { ...lev0, yield: Math.max(0.5, Math.min(0.999, lev0.yield + dis.yieldDelta)) };
      todayLevers[n.id] = lev;

      let down = dis.down || plannedDown(lev, day);
      if (stochastic && !down) {
        const st = nodeState[n.id];
        if (day <= st.unplannedDownUntil) down = true;
        else if (rng() < 1 / Math.max(1, lev.mtbfDays)) {
          st.unplannedDownUntil = day + Math.max(1, Math.round(lev.mttrDays));
          down = true;
          addEvent(day, 'CRIT', n.id, `UNPLANNED DOWNTIME ${Math.round(lev.mttrDays)}D`);
        }
      }
      todayDown[n.id] = down;

      let capa = down ? 0 : effectiveDailyOutput(lev) * dis.capacityFactor;
      if (stochastic && capa > 0) capa *= triangular(rng, 0.85, 1.0, 1.05);
      todayCapacity[n.id] = capa;
    }
    capacityHistory[day] = todayCapacity;

    // ── 3. 계획 레이어 (§3.4) ─────────────────────────────────────────────
    const demandRate = demandRateAt(config, day);
    sys.demandRateSeries[day] = demandRate;

    const cycle = Math.max(1, config.planning.replanCycleDays);
    if (day > 0 && day % cycle === 0) {
      // 인지 지연: 오늘이 아니라 infoLagDays 전의 상태만 보고 계획한다.
      const pDay = Math.max(0, day - config.planning.infoLagDays);
      const perceived = capacityHistory[pDay] || todayCapacity;
      const seenBuffers = bufferHistory[pDay];
      const invAdj = {};
      if (seenBuffers) {
        for (const n of NODES) {
          const cap = perNode[n.id].outputCapacity;
          const dev = cap * SIM.targetOutputFillPct[n.type] - seenBuffers[n.id];
          invAdj[n.id] =
            Math.abs(dev) > cap * SIM.inventoryDeadBandPct
              ? dev / SIM.inventoryCorrectionDays
              : 0;
        }
      }
      const plan = computePlan(
        perceived, stageYieldsFrom(todayLevers, perceived), demandRateAt(config, pDay), invAdj
      );
      const effDay = day + config.planning.frozenWindowDays;
      pendingPlans.push({ effectiveDay: effDay, plan });
      planLog.push({
        day, effectiveDay: effDay, perceivedDay: pDay,
        systemRate: plan.systemRate, reason: 'REPLAN',
      });
    }
    for (let i = pendingPlans.length - 1; i >= 0; i--) {
      if (pendingPlans[i].effectiveDay <= day) {
        currentPlan = pendingPlans[i].plan;
        addEvent(day, 'INFO', null,
          `PLAN EFFECTIVE · SYSTEM RATE ${currentPlan.systemRate.toFixed(2)} MWh/d`);
        pendingPlans.splice(i, 1);
      }
    }
    sys.planRateSeries[day] = currentPlan.systemRate;

    // ── 3b. Action: 재고 이관 ─────────────────────────────────────────────
    for (const r of reallocations) {
      if (r.day !== day) continue;
      const src = nodeState[r.from];
      const dst = nodeState[r.to];
      if (!src || !dst) continue;
      const qty = Math.min(r.qtyMWh, src.outputBuffer);
      if (qty <= EPS) continue;
      src.outputBuffer -= qty;
      if (nodeMeta[r.from].type === nodeMeta[r.to].type) dst.outputBuffer += qty;
      else dst.inputBuffer += qty;
      addEvent(day, 'INFO', r.to, `REALLOCATED ${qty.toFixed(1)} MWh FROM ${r.from}`);
    }

    // ── 4. 생산 (Cell → Pack → Link 위상 순서) ────────────────────────────
    for (const n of NODES) {
      const st = nodeState[n.id];
      const p = perNode[n.id];
      const lev = todayLevers[n.id];
      const y = lev.yield;
      const byCapacity = todayCapacity[n.id];
      const planRate = currentPlan.rates[n.id] ?? 0;
      const desired = Math.min(byCapacity, planRate);

      const bySupply = n.type === 'CELL' ? Infinity : st.inputBuffer * y;
      const bySpace = Math.max(0, p.outputCapacity - st.outputBuffer);
      const actual = Math.max(0, Math.min(desired, bySupply, bySpace));

      let status;
      if (todayDown[n.id]) status = 'DOWN';
      else if (bySupply < desired - EPS && bySupply <= bySpace + EPS) status = 'STARVED';
      else if (bySpace < desired - EPS) status = 'BLOCKED';
      else status = 'RUNNING';

      const consumed = actual / y;
      if (n.type === 'CELL') rawInputMWh += consumed;
      else st.inputBuffer = Math.max(0, st.inputBuffer - consumed);
      st.outputBuffer += actual;
      yieldLossMWh += consumed - actual;
      p.yieldLossMWh += consumed - actual;
      p.producedMWh += actual;
      p.consumedMWh += consumed;

      const lost = Math.max(0, desired - actual);
      p.lostOutputMWh += lost;

      // 상태 집계 + 유휴 비용
      p.stateTimeline[day] = status;
      if (status === 'DOWN') p.downDays++;
      else if (status === 'STARVED') p.starvedDays++;
      else if (status === 'BLOCKED') p.blockedDays++;
      else p.runningDays++;

      const idleFrac = byCapacity > EPS ? lost / byCapacity : todayDown[n.id] ? 1 : 0;
      const ic = COST.idleCost(n.type, idleFrac, lev.operatingHoursPerDay, cost);
      if (status === 'BLOCKED') { breakdown.blockingIdle += ic; p.blockingIdleUSD += ic; }
      else if (status === 'STARVED') { breakdown.starvingIdle += ic; p.starvingIdleUSD += ic; }
      p.idleCostUSD += ic;

      // 완제품 초과 보관비 — Link 단계에만 부과 (§2.7)
      if (n.type === 'LINK') {
        const free = COST.freeStorageAllowance(p.nominalDailyOutput);
        const sc = COST.excessStorageCost(st.outputBuffer, free, cost);
        breakdown.excessStorage += sc;
        p.storageUSD += sc;
      }

      p.producedSeries[day] = actual;
      p.planSeries[day] = planRate;
      p.capacitySeries[day] = byCapacity;
      // 버퍼 시계열은 출하까지 끝난 '일 마감' 값으로 §6 에서 기록한다.

      // 이벤트
      if (st.lastStatus !== status) {
        if (status === 'BLOCKED')
          addEvent(day, 'WARN', n.id, `OUTPUT BUFFER ${((st.outputBuffer / p.outputCapacity) * 100).toFixed(0)}% · BLOCKED`);
        else if (status === 'STARVED')
          addEvent(day, 'CRIT', n.id, `INPUT BUFFER ${st.inputBuffer.toFixed(1)} MWh · STARVED`);
        else if (status === 'DOWN') addEvent(day, 'CRIT', n.id, `LINE DOWN`);
        else if (st.lastStatus) addEvent(day, 'INFO', n.id, `RECOVERED · RUNNING`);
        st.lastStatus = status;
      } else if (status === 'RUNNING' && p.outputCapacity > EPS) {
        // 출고 FGI 가 임계에 접근하는 속도로 BLOCKING 도달 시점을 추정한다.
        const fgi = st.outputBuffer / p.outputCapacity;
        const prev = p.outputBufferSeries[day - 1];
        const netFillRate = prev == null ? 0 : st.outputBuffer - prev;
        if (fgi > 0.9 && netFillRate > EPS && day - (st.lastImminentDay ?? -99) >= 5) {
          const eta = Math.max(1, Math.ceil((p.outputCapacity - st.outputBuffer) / netFillRate));
          addEvent(day, 'WARN', n.id, `FGI ${(fgi * 100).toFixed(0)}% · BLOCKING IMMINENT (ETA ${eta}D)`);
          st.lastImminentDay = day;
        }
      }

      sys.throughputMWhPerDay[day] += n.type === 'LINK' ? actual : 0;
    }

    // ── 5. 출하 ───────────────────────────────────────────────────────────
    // 5a. Cell → Pack — 각 Cell 안에서는 §2.2 대로 최단거리 Pack 부터.
    shipStage(CELL_IDS, (cid) => packOrderByCell[cid], day, undefined);

    // 5b. Pack → Link (직송 또는 CHI 환적)
    //     환적이어도 화물의 출발/도착은 PW→AZL 이다. routeViaHub 는 리드타임에
    //     PW→CHI + dwell + CHI→AZL 을 합산하고 환적 취급비를 더할 뿐이다.
    shipStage(PACK_IDS, () => ['AZL'], day, { viaHub: config.routeViaHub });

    // 5c. Link → 고객
    {
      const st = nodeState['AZL'];
      // 미충족량은 '아직 이동 중인 물량'을 뺀 값이다. 이걸 빼지 않으면
      // 도착 전까지 같은 PO 로 매일 재출하되어 과잉 인도가 발생한다.
      const remaining = (o) => o.qtyMWh - o.deliveredMWh - o.inTransitMWh;
      const eligible = orders.filter((o) => {
        if (remaining(o) <= EPS) return false;
        const lane = laneOf('AZL', o.customerId);
        return day >= o.dueDay - perLane[lane.id].baseTransitDays - SIM.preShipDays;
      });
      const ordered = sortOrdersByRule(eligible, config.planning.allocationRule, config, day);
      const proRata = config.planning.allocationRule === 'proRata';
      const totalNeed = ordered.reduce((s, o) => s + remaining(o), 0);
      const available = st.outputBuffer;

      for (const o of ordered) {
        if (st.outputBuffer <= EPS) break;
        const lane = laneOf('AZL', o.customerId);
        let need = remaining(o);
        if (proRata && totalNeed > EPS) need = Math.min(need, (available * need) / totalNeed);
        const shipBy = o.dueDay - perLane[lane.id].baseTransitDays;
        const { qty, trucks } = planLoad(
          lane, Math.min(st.outputBuffer, need), need, day, day >= shipBy
        );
        if (qty > EPS) {
          st.outputBuffer -= qty;
          o.inTransitMWh += qty;
          dispatch(lane, day, qty, trucks, { orderId: o.id });
          if (o.firstShipDay === null) o.firstShipDay = day;
          if (o.status === 'PENDING') o.status = 'IN_TRANSIT';
        }
      }
    }

    // 대기 일수 갱신 (출하 없이 재고가 남은 lane)
    for (const l of LANES) {
      const src = nodeState[l.from];
      const shippedToday = perLane[l.id].shippedSeries[day] > EPS;
      if (!shippedToday && src && src.outputBuffer > EPS) laneRuntime[l.id].waitDays++;
    }

    // ── 6. 시계열 기록 (일 마감 시점) ─────────────────────────────────────
    let wip = 0;
    for (const n of NODES) {
      const st = nodeState[n.id];
      const p = perNode[n.id];
      p.inputBufferSeries[day] = st.inputBuffer;
      p.outputBufferSeries[day] = st.outputBuffer;
      p.fgiDaysOfSupply[day] =
        p.nominalDailyOutput > EPS ? st.outputBuffer / p.nominalDailyOutput : 0;
      wip += st.inputBuffer + st.outputBuffer;
    }
    bufferHistory[day] = Object.fromEntries(NODES.map((n) => [n.id, nodeState[n.id].outputBuffer]));
    let it = 0;
    for (const s of inTransit) {
      it += s.qtyMWh;
      perLane[s.laneId].inTransitMWhSeries[day] += s.qtyMWh;
    }
    sys.wipSeries[day] = wip;
    sys.inTransitSeries[day] = it;

    // ── 7. 미인도 잔량 페널티 누적 ────────────────────────────────────────
    for (const o of orders) {
      if (o.deliveredMWh >= o.qtyMWh - EPS) continue;
      const terms = config.customers[o.customerId];
      const late = day - o.dueDay - terms.graceDays;
      if (late <= 0) continue;
      const remain = o.qtyMWh - o.deliveredMWh;
      const capAmt = COST.ldCapAmount(remain, terms);
      const target = Math.min(remain * terms.contractValuePerMWh * terms.ldRatePerDay * late, capAmt);
      const already = o.accruedOpenPenalty || 0;
      const delta = Math.max(0, target - already);
      o.accruedOpenPenalty = target;
      o.penaltyUSD += delta;
      o.lateDays = Math.max(o.lateDays, late);
      breakdown.ldPenalty += delta;
      if (late === 1) {
        addEvent(day, 'CRIT', o.customerId, `${o.id} OVERDUE · ${(remain / UNITS.linkMWh).toFixed(1)} LINK SHORT`, { orderId: o.id });
      }
    }
    // 그날까지의 누적 원가 스냅샷. dispatch()(운임·특송) · 유휴비 · 초과보관비 ·
    // LD 페널티(인도 완료분 + 미인도 잔량 가산분) 전부 이 지점 이전에 그날치가
    // breakdown 에 이미 더해져 있으므로, 여기서 한 번에 찍으면 6개 버킷이
    // 모두 같은 시점(그날 마감) 기준으로 스냅샷된다.
    let dayTotal = 0;
    for (const b of COST_BUCKETS) {
      sys.costSeries[b.id][day] = breakdown[b.id];
      dayTotal += breakdown[b.id];
    }
    sys.totalCostSeries[day] = dayTotal;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 마감 집계
  // ═══════════════════════════════════════════════════════════════════════
  const reportOrders = orders.filter((o) => !o.beyondHorizon);
  for (const o of reportOrders) {
    if (o.deliveredMWh < o.qtyMWh - EPS) o.status = 'UNDELIVERED';
  }

  for (const n of NODES) {
    const p = perNode[n.id];
    const capSum = p.capacitySeries.reduce((s, v) => s + v, 0);
    p.utilizationPct = capSum > EPS ? (p.producedMWh / capSum) * 100 : 0;
  }
  for (const l of LANES) {
    const pl = perLane[l.id];
    pl.avgTransitDays = pl.shipmentsCount ? pl.transitDaysSum / pl.shipmentsCount : pl.baseTransitDays;
  }

  const perCustomer = {};
  for (const c of CUSTOMERS) {
    const os = reportOrders.filter((o) => o.customerId === c.id);
    perCustomer[c.id] = {
      id: c.id,
      orders: os,
      orderedMWh: os.reduce((s, o) => s + o.qtyMWh, 0),
      deliveredMWh: os.reduce((s, o) => s + o.deliveredMWh, 0),
      penaltyUSD: os.reduce((s, o) => s + o.penaltyUSD, 0),
      lateOrders: os.filter((o) => o.status === 'LATE' || o.status === 'UNDELIVERED').length,
    };
  }

  const onTime = reportOrders.filter((o) => o.status === 'DELIVERED').length;
  const endInventory =
    NODES.reduce((s, n) => s + nodeState[n.id].inputBuffer + nodeState[n.id].outputBuffer, 0) +
    inTransit.reduce((s, x) => s + x.qtyMWh, 0);

  const totalBlockedDays = NODES.reduce((s, n) => s + perNode[n.id].blockedDays, 0);
  const totalStarvedDays = NODES.reduce((s, n) => s + perNode[n.id].starvedDays, 0);
  const avgWip = sys.wipSeries.reduce((s, v) => s + v, 0) / H;
  const avgInTransit = sys.inTransitSeries.reduce((s, v) => s + v, 0) / H;

  const system = {
    horizonDays: H,
    throughputMWhPerDay: sys.throughputMWhPerDay,
    deliveredMWhSeries: sys.deliveredMWhSeries,
    wipSeries: sys.wipSeries,
    inTransitSeries: sys.inTransitSeries,
    costSeries: sys.costSeries, // 버킷별(baseFreight 등) 누적 원가 — src/cost.js COST_BUCKETS 참고
    totalCostSeries: sys.totalCostSeries, // 전 버킷 합산 누적 원가
    planRateSeries: sys.planRateSeries,
    demandRateSeries: sys.demandRateSeries,
    otdPct: reportOrders.length ? (onTime / reportOrders.length) * 100 : 100,
    ordersTotal: reportOrders.length,
    ordersOnTime: onTime,
    ordersLate: reportOrders.filter((o) => o.status === 'LATE').length,
    ordersUndelivered: reportOrders.filter((o) => o.status === 'UNDELIVERED').length,
    totalPenaltyUSD: breakdown.ldPenalty,
    avgWipMWh: avgWip,
    avgInTransitMWh: avgInTransit,
    inventoryValueUSD: COST.inventoryValue(avgWip + avgInTransit, cost),
    totalBlockedDays,
    totalStarvedDays,
    totalDownDays: NODES.reduce((s, n) => s + perNode[n.id].downDays, 0),
    totalLostOutputMWh: NODES.reduce((s, n) => s + perNode[n.id].lostOutputMWh, 0),
    deliveredMWh: deliveredMWhTotal,
    orderedMWh: reportOrders.reduce((s, o) => s + o.qtyMWh, 0),
    throughputAvg: sys.throughputMWhPerDay.reduce((s, v) => s + v, 0) / H,
    demandAvg: sys.demandRateSeries.reduce((s, v) => s + v, 0) / H,
    costBreakdown: breakdown,
    hubHandlingUSD,
    totalCostUSD: COST.totalCost(breakdown),
    // 검증 게이트용
    balance: {
      rawInputMWh,
      initialInventoryMWh,
      deliveredMWh: deliveredMWhTotal,
      endInventoryMWh: endInventory,
      yieldLossMWh,
    },
    little: {
      avgInTransitMWh: avgInTransit,
      avgDailyShippedMWh: shippedMWhTotal / H,
      avgTransitDays: shippedMWhTotal > EPS ? transitDaysWeighted / shippedMWhTotal : 0,
    },
  };

  events.sort((a, b) => a.day - b.day || a.severity.localeCompare(b.severity));

  return {
    config,
    perNode,
    perLane,
    perCustomer,
    orders: reportOrders,
    shipments,
    system,
    events,
    planLog,
    tts: null, // computeTTS(config) 로 별도 산출 (§3.8)
    stochasticBands: null, // Monte Carlo 결과가 있으면 UI 가 채운다
  };
}

// ───────────────────────────────────────────────────────────────────────────
// §3.8 TTS — Time To Survive
// 각 생산 노드를 무기한 정지시켰을 때 '기준선에는 없던 첫 납기 위반'까지의 일수
// ───────────────────────────────────────────────────────────────────────────
export function computeTTS(config) {
  const probeStart = SIM.ttsProbeStartDay;
  const base = runSim({ ...config, stochastic: false });
  const baseLate = new Set(
    base.orders.filter((o) => o.status === 'LATE' || o.status === 'UNDELIVERED').map((o) => o.id)
  );
  const out = {};
  for (const n of NODES) {
    const probe = runSim({
      ...config,
      stochastic: false,
      disruptions: [
        ...(config.disruptions || []),
        { type: 'nodeDown', target: n.id, startDay: probeStart, durationDays: 999 },
      ],
    });
    let first = null;
    for (const o of probe.orders) {
      if (baseLate.has(o.id)) continue;
      if (o.status === 'LATE' || o.status === 'UNDELIVERED') {
        const violationDay =
          o.status === 'LATE'
            ? o.deliveredDay
            : o.dueDay + (config.customers[o.customerId].graceDays || 0) + 1;
        if (first === null || violationDay < first) first = violationDay;
      }
    }
    out[n.id] = first === null ? null : Math.max(0, first - probeStart);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// 반사실 (§4.7) — 정보 지연만 제거
// ───────────────────────────────────────────────────────────────────────────
export function counterfactualConfig(config) {
  return {
    ...config,
    planning: { ...config.planning, infoLagDays: 0, frozenWindowDays: 0, replanCycleDays: 1 },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// §3.6 Monte Carlo — Web Worker 에서 호출한다
// ───────────────────────────────────────────────────────────────────────────
export function monteCarlo(config, runs, onProgress) {
  const H = config.horizonDays;
  const samples = { otdPct: [], totalPenaltyUSD: [], totalCostUSD: [], totalLostOutputMWh: [], throughputAvg: [] };
  const blockedProb = {};
  const starvedProb = {};
  for (const n of NODES) {
    blockedProb[n.id] = new Array(H).fill(0);
    starvedProb[n.id] = new Array(H).fill(0);
  }
  const throughputByDay = Array.from({ length: H }, () => []);

  for (let i = 0; i < runs; i++) {
    const r = runSim({ ...config, stochastic: true, seed: (config.seed + i * 7919) >>> 0 });
    samples.otdPct.push(r.system.otdPct);
    samples.totalPenaltyUSD.push(r.system.totalPenaltyUSD);
    samples.totalCostUSD.push(r.system.totalCostUSD);
    samples.totalLostOutputMWh.push(r.system.totalLostOutputMWh);
    samples.throughputAvg.push(r.system.throughputAvg);
    for (const n of NODES) {
      const tl = r.perNode[n.id].stateTimeline;
      for (let d = 0; d < H; d++) {
        if (tl[d] === 'BLOCKED') blockedProb[n.id][d]++;
        if (tl[d] === 'STARVED') starvedProb[n.id][d]++;
      }
    }
    for (let d = 0; d < H; d++) throughputByDay[d].push(r.system.throughputMWhPerDay[d]);
    if (onProgress && (i % 10 === 0 || i === runs - 1)) onProgress((i + 1) / runs);
  }

  const pct = (arr, q) => {
    const s = [...arr].sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
    return s[idx];
  };
  const kpi = {};
  for (const k of Object.keys(samples)) {
    kpi[k] = { p10: pct(samples[k], 0.1), p50: pct(samples[k], 0.5), p90: pct(samples[k], 0.9) };
  }
  for (const n of NODES) {
    blockedProb[n.id] = blockedProb[n.id].map((v) => v / runs);
    starvedProb[n.id] = starvedProb[n.id].map((v) => v / runs);
  }
  const band = { p10: new Array(H), p50: new Array(H), p90: new Array(H) };
  for (let d = 0; d < H; d++) {
    band.p10[d] = pct(throughputByDay[d], 0.1);
    band.p50[d] = pct(throughputByDay[d], 0.5);
    band.p90[d] = pct(throughputByDay[d], 0.9);
  }
  return { runs, kpi, blockedProb, starvedProb, throughputBand: band };
}
