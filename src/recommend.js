// ═══════════════════════════════════════════════════════════════════════════
// src/recommend.js — 진단 → Action 추천 (Ontology 기반, 승인·실행까지)
//
// 이 모듈의 원칙: 예상 효과를 추정하지 않는다. 실제로 돌려 본다.
//
//   후보 Action 마다 그 Action 이 들어간 config 를 만들어 runSim 을 한 번 더
//   돌리고, 현재 결과와의 차이를 그대로 '예상 효과'로 쓴다. 계수를 곱해
//   어림하는 방식은 계획 지연(infoLag/frozen)이 걸린 이 모델에서 거의 항상
//   틀린다 — 같은 조정이라도 언제 발효되느냐에 따라 효과가 완전히 달라지기
//   때문이다. 어차피 1회 5ms 짜리 순수 함수를 갖고 있으니 추정할 이유가 없다.
//
// 비용: 후보 N개 → 시뮬 N회 (≈5ms×N). store 가 TTS 와 같은 방식으로 별도
// debounce 를 걸어 호출한다.
// ═══════════════════════════════════════════════════════════════════════════

import {
  NODES, CELL_IDS, PACK_IDS, LINK_IDS, LANES, CUSTOMERS, RESPONSIBLE, UNITS,
} from './data.js';
import { runSim, earliestApplicableDay, effectiveDailyOutput } from './sim.js';

const EPS = 1e-9;

// ───────────────────────────────────────────────────────────────────────────
// 1. 진단 — 지금 무엇이 문제인가
// ───────────────────────────────────────────────────────────────────────────

/**
 * 제약 공정(bottleneck)을 찾는다. 정의는 '가동률이 가장 높게 붙어 있으면서
 * 상류가 밀리거나 하류가 굶고 있는 단계' 다. 단순 최고 가동률만 보면 평상시
 * 정상 가동 노드가 잡히므로, 단계 간 격차를 함께 본다.
 */
export function findConstraint(result) {
  const stages = [
    { stage: 'CELL', ids: CELL_IDS },
    { stage: 'PACK', ids: PACK_IDS },
    { stage: 'LINK', ids: LINK_IDS },
  ];
  const util = (id) => result.perNode[id].utilizationPct;
  const scored = stages.map((s) => ({
    ...s,
    maxUtil: Math.max(...s.ids.map(util)),
    minUtil: Math.min(...s.ids.map(util)),
  }));
  const top = scored.reduce((a, b) => (b.maxUtil > a.maxUtil ? b : a));
  // 제약 노드 = 그 단계에서 가장 높이 붙어 있는 노드
  const nodeId = top.ids.reduce((a, b) => (util(b) > util(a) ? b : a));
  return { stage: top.stage, nodeId, utilizationPct: util(nodeId), stages: scored };
}

/** 설계값 대비 실측 편차(계획이 아직 모르는 것). Inspector 의 편차 카드와 같은 소스. */
export function activeDrifts(config, day) {
  const out = [];
  for (const d of config.disruptions || []) {
    const dur = d.durationDays ?? 9999;
    if (!(day >= d.startDay && day < d.startDay + dur)) continue;
    if (d.type === 'capacityDrop') {
      out.push({ nodeId: d.target, kind: 'capacity', pct: d.pct, label: `가동률 −${(d.pct * 100).toFixed(0)}%` });
    } else if (d.type === 'yieldDrop') {
      out.push({ nodeId: d.target, kind: 'yield', deltaPct: d.deltaPct, label: `수율 ${(d.deltaPct * 100).toFixed(1)}%p` });
    }
  }
  return out;
}

/** 앞으로 수요가 오르는가 — 오르면 제약이 더 조인다. */
export function demandOutlook(result, nowDay) {
  const s = result.system;
  const H = s.horizonDays;
  const now = s.demandRateSeries[Math.min(nowDay, H - 1)] || 0;
  const end = s.demandRateSeries[H - 1] || 0;
  const risePct = now > EPS ? (end / now - 1) * 100 : 0;
  // 최초로 수요가 오르는 날
  let riseDay = null;
  for (let d = nowDay; d < H; d++) {
    if (s.demandRateSeries[d] > now * 1.02) { riseDay = d; break; }
  }
  return { now, end, risePct, riseDay, rising: risePct > 2 };
}

/** 아직 못 채운 PO 중 납기가 임박하거나 이미 넘긴 것. */
export function atRiskOrders(result, config, nowDay, limit = 5) {
  return result.orders
    .filter((o) => o.deliveredMWh < o.qtyMWh - EPS)
    .map((o) => {
      const grace = config.customers[o.customerId].graceDays;
      return { ...o, slackDays: o.dueDay + grace - nowDay, shortMWh: o.qtyMWh - o.deliveredMWh };
    })
    .filter((o) => o.slackDays <= 45)
    .sort((a, b) => a.slackDays - b.slackDays)
    .slice(0, limit);
}

// ───────────────────────────────────────────────────────────────────────────
// 2. 후보 Action 생성
// ───────────────────────────────────────────────────────────────────────────

function laneToCustomerOf(customerId) {
  return LANES.find((l) => l.to === customerId && l.laneType === 'linkToCustomer')?.id || null;
}

/**
 * 진단 결과를 바탕으로 '해볼 만한' Action 후보를 만든다.
 * 여기서는 아직 효과를 모른다 — 다음 단계에서 실제로 돌려 본다.
 */
function buildCandidates(state) {
  const { config, result, nowDay } = state;
  const day = nowDay;
  const cons = findConstraint(result);
  const drifts = activeDrifts(config, day);
  const risky = atRiskOrders(result, config, day);
  const outlook = demandOutlook(result, day);
  const out = [];

  // ① 제약 공정의 실측 편차 복구 — 정비/보전으로 설계값에 되돌린다
  for (const dr of drifts.filter((d) => d.kind === 'capacity')) {
    const lev = config.nodes[dr.nodeId];
    if (!lev) continue;
    out.push({
      id: `restore-${dr.nodeId}`,
      kind: 'MAINTENANCE',
      title: `${dr.nodeId} 가동률 설계값 복구`,
      targetNode: dr.nodeId,
      responsible: RESPONSIBLE[dr.nodeId] || RESPONSIBLE.PLANNING,
      // capacityDrop 을 걷어내는 것이 아니라, 계획 레버를 올려 실측 손실을
      // 상쇄한다. 현장 정비로 편차를 없애는 시나리오에 해당한다.
      action: {
        type: 'rescheduleProduction', nodeId: dr.nodeId, day,
        newLevers: { availability: Math.min(0.98, lev.availability / (1 - dr.pct)) },
      },
      why: [
        `실측 가동률이 설계 대비 ${(dr.pct * 100).toFixed(0)}% 낮습니다.`,
        `계획 레이어는 여전히 설계값(${(lev.availability * 100).toFixed(1)}%)을 전제로 생산율을 산출하고 있어, 이 격차가 상류 BLOCKING 의 직접 원인입니다.`,
      ],
    });
  }

  // ② 제약 공정 조업시간 연장 — 설비를 못 고치면 시간을 늘린다
  const consLev = config.nodes[cons.nodeId];
  if (consLev && consLev.operatingHoursPerDay < 24) {
    out.push({
      id: `shift-${cons.nodeId}`,
      kind: 'CAPACITY',
      title: `${cons.nodeId} 조업시간 ${consLev.operatingHoursPerDay}h → 24h`,
      targetNode: cons.nodeId,
      responsible: RESPONSIBLE[cons.nodeId] || RESPONSIBLE.PLANNING,
      action: { type: 'adjustShift', nodeId: cons.nodeId, hours: 24, day },
      why: [
        `${cons.nodeId} 가동률이 ${cons.utilizationPct.toFixed(1)}% 로 제약 공정입니다.`,
        `설비 복구 없이 즉시 산출을 늘릴 수 있는 유일한 레버입니다.`,
      ],
    });
  }

  // ③ 제약 단계 내 재고 이관 — 한쪽이 막히고 다른 쪽에 여유가 있을 때
  const peers = (cons.stage === 'CELL' ? CELL_IDS : cons.stage === 'PACK' ? PACK_IDS : [])
    .filter((x) => x !== cons.nodeId);
  for (const to of peers) {
    const toUtil = result.perNode[to].utilizationPct;
    if (toUtil > cons.utilizationPct - 5) continue; // 받는 쪽도 꽉 차 있으면 의미 없다
    out.push({
      id: `realloc-${cons.nodeId}-${to}`,
      kind: 'INVENTORY',
      title: `${cons.nodeId} → ${to} 재고 이관 10 MWh`,
      targetNode: cons.nodeId,
      responsible: RESPONSIBLE.LOGISTICS,
      action: { type: 'reallocateInventory', from: cons.nodeId, to, qtyMWh: 10, day },
      why: [
        `${cons.nodeId} 가동률 ${cons.utilizationPct.toFixed(1)}% 대비 ${to} 는 ${toUtil.toFixed(1)}% 로 여유가 있습니다.`,
        `설비 투자 없이 단계 내 부하를 재배분합니다.`,
      ],
    });
  }

  // ④ 납기 임박 PO 특송
  for (const o of risky.slice(0, 2)) {
    const laneId = laneToCustomerOf(o.customerId);
    if (!laneId) continue;
    out.push({
      id: `expedite-${o.id}`,
      kind: 'LOGISTICS',
      title: `${o.customerId} 향 14일 특송`,
      targetNode: 'AZL',
      targetOrder: o.id,
      responsible: RESPONSIBLE.LOGISTICS,
      action: { type: 'expediteLane', laneId, startDay: day, durationDays: 14 },
      why: [
        `${o.id} 잔량 ${o.shortMWh.toFixed(1)} MWh, 납기까지 ${o.slackDays}일 남았습니다.`,
        `리드타임 ×0.5 로 단축되지만 운임이 배로 듭니다 — LD 페널티와 비교해 판단하십시오.`,
      ],
    });
  }

  // ⑤ 계획 지연 단축 — 이 도구의 핵심 명제를 그대로 Action 으로
  const pl = config.planning;
  if (pl.infoLagDays > 0 || pl.frozenWindowDays > 0) {
    out.push({
      id: 'planning-lag',
      kind: 'PLANNING',
      title: `계획 지연 단축 (정보지연 ${pl.infoLagDays}→0일 · frozen ${pl.frozenWindowDays}→7일)`,
      targetNode: null,
      responsible: RESPONSIBLE.PLANNING,
      // 이것만 config 직접 변경이다 — 계획 파라미터는 Action 큐 대상이 아니다.
      configPatch: { planning: { infoLagDays: 0, frozenWindowDays: Math.min(7, pl.frozenWindowDays) } },
      why: [
        `현재 조정 지시가 실제 발효되기까지 ${earliestApplicableDay(pl, day).totalLagDays}일이 걸립니다.`,
        `설비를 건드리지 않고 '언제 알고 언제 반영하느냐'만 바꾸는 조치입니다.`,
      ],
    });
  }

  // ⑥ 수요 서지 대비 선제 증산
  if (outlook.rising && outlook.riseDay != null) {
    const target = cons.nodeId;
    const lev = config.nodes[target];
    if (lev) {
      out.push({
        id: `preempt-${target}`,
        kind: 'CAPACITY',
        title: `${target} 선제 증산 (수요 +${outlook.risePct.toFixed(0)}% 대비)`,
        targetNode: target,
        responsible: RESPONSIBLE[target] || RESPONSIBLE.PLANNING,
        action: {
          type: 'rescheduleProduction', nodeId: target, day,
          newLevers: {
            availability: Math.min(0.98, lev.availability + 0.06),
            yield: Math.min(0.999, lev.yield + 0.01),
          },
        },
        why: [
          `수요가 ${outlook.risePct.toFixed(0)}% 증가할 예정이며, 제약 공정은 이미 ${cons.utilizationPct.toFixed(1)}% 입니다.`,
          `계획 지연을 감안하면 지금 착수해야 증산분이 서지 시점에 맞습니다.`,
        ],
      });
    }
  }

  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// 3. 효과 평가 — 실제로 돌려 본다
// ───────────────────────────────────────────────────────────────────────────

function withCandidate(config, cand) {
  if (cand.configPatch) {
    return {
      ...config,
      planning: { ...config.planning, ...(cand.configPatch.planning || {}) },
    };
  }
  // Action 은 계획 레이어를 거쳐 발효된다 — 실제 실행 경로와 같아야 효과도 같다.
  const lag = earliestApplicableDay(config.planning, cand.action.day ?? cand.action.startDay ?? 0);
  const a = { ...cand.action };
  if (a.type === 'expediteLane') a.startDay = lag.effectiveDay;
  else a.day = lag.effectiveDay;
  return { ...config, actions: [...(config.actions || []), a] };
}

function impactOf(base, next) {
  const b = base.system;
  const n = next.system;
  return {
    otdPct: n.otdPct - b.otdPct,
    penaltyUSD: n.costBreakdown.ldPenalty - b.costBreakdown.ldPenalty,
    totalCostUSD: n.totalCostUSD - b.totalCostUSD,
    lostMWh: n.totalLostOutputMWh - b.totalLostOutputMWh,
    throughput: n.throughputAvg - b.throughputAvg,
  };
}

/**
 * 추천 목록. 총원가를 낮추는 것만 남기고, 절감액 큰 순으로 정렬한다.
 * 효과가 없거나 되레 나빠지는 후보는 버린다 — 추천이 아니라 소음이므로.
 */
export function recommend(state) {
  const { config, result } = state;
  if (!result) return [];
  const day = state.nowDay;
  const lag = earliestApplicableDay(config.planning, day);

  const evaluated = [];
  for (const cand of buildCandidates(state)) {
    let sim;
    try {
      sim = runSim(withCandidate(config, cand));
    } catch {
      continue; // 후보 하나가 터져도 나머지 추천은 살린다
    }
    const impact = impactOf(result, sim);
    if (impact.totalCostUSD >= -1) continue; // 절감 없음
    evaluated.push({
      ...cand,
      impact,
      effectiveDay: cand.configPatch ? day : lag.effectiveDay,
      lag,
      evidence: buildEvidence(state, cand),
    });
  }
  evaluated.sort((a, b) => a.impact.totalCostUSD - b.impact.totalCostUSD);
  return evaluated.slice(0, 5);
}

/** 근거 데이터 — 추천 카드에 그대로 표로 뿌린다. */
function buildEvidence(state, cand) {
  const { result, config } = state;
  const day = state.nowDay;
  const rows = [];
  const n = cand.targetNode;

  if (n && result.perNode[n]) {
    const p = result.perNode[n];
    const lev = config.nodes[n];
    rows.push(['가동률(실적)', `${p.utilizationPct.toFixed(1)}%`]);
    if (lev) rows.push(['유효 일산출', `${effectiveDailyOutput(lev).toFixed(2)} MWh/day`]);

    // 제약 노드는 자기 자신이 BLOCKED/STARVED 로 잡히지 않는다 — 꽉 차서
    // 돌기 때문이다. 병목의 증거는 그 노드가 아니라 '위아래'에 남으므로
    // 상류 적체 · 하류 결품을 함께 싣는다. 자기 지표만 보여 주면 0 만 나온다.
    const stageOf = (id) => NODES.find((x) => x.id === id)?.type;
    const stage = stageOf(n);
    const upIds = stage === 'PACK' ? CELL_IDS : stage === 'LINK' ? PACK_IDS : [];
    const downIds = stage === 'CELL' ? PACK_IDS : stage === 'PACK' ? LINK_IDS : [];
    const sum = (ids, key) => ids.reduce((s, id) => s + result.perNode[id][key], 0);

    if (p.blockedDays || p.starvedDays) {
      rows.push(['본 노드 BLOCKED/STARVED', `${p.blockedDays}일 / ${p.starvedDays}일`]);
    }
    if (upIds.length) rows.push(['상류 적체(BLOCKED)', `${sum(upIds, 'blockedDays')}일`]);
    if (downIds.length) rows.push(['하류 결품(STARVED)', `${sum(downIds, 'starvedDays')}일`]);
    const lost = sum([...upIds, n, ...downIds], 'lostOutputMWh');
    if (lost > 0.05) rows.push(['연쇄 일실 산출', `${lost.toFixed(1)} MWh`]);
  }
  if (cand.targetOrder) {
    const o = result.orders.find((x) => x.id === cand.targetOrder);
    if (o) {
      rows.push(['PO 수량', `${(o.qtyMWh / UNITS.linkMWh).toFixed(1)} Link`]);
      rows.push(['인도 완료', `${((o.deliveredMWh / o.qtyMWh) * 100).toFixed(0)}%`]);
      rows.push(['누적 LD', `$${Math.round(o.penaltyUSD).toLocaleString('en-US')}`]);
    }
  }
  if (cand.kind === 'PLANNING') {
    const l = earliestApplicableDay(config.planning, day);
    rows.push(['정보 지연', `${l.infoLagDays}일`]);
    rows.push(['replan 대기', `${l.replanWaitDays}일`]);
    rows.push(['frozen window', `${l.frozenWindowDays}일`]);
    rows.push(['총 대응 지연', `${l.totalLagDays}일`]);
  }
  return rows;
}

/** 이 추천의 Action 이 이미 큐에 들어가 있는가 (승인 완료 표시용). */
export function isApplied(config, cand) {
  if (cand.configPatch) {
    const p = cand.configPatch.planning || {};
    return Object.entries(p).every(([k, v]) => config.planning[k] === v);
  }
  const a = cand.action;
  return (config.actions || []).some((x) =>
    x.type === a.type
    && (x.nodeId ?? null) === (a.nodeId ?? null)
    && (x.laneId ?? null) === (a.laneId ?? null)
    && (x.from ?? null) === (a.from ?? null)
    && (x.to ?? null) === (a.to ?? null));
}
