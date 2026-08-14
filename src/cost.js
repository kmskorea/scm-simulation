// ═══════════════════════════════════════════════════════════════════════════
// src/cost.js — 원가 / 페널티 모델
//
// 총비용 = 기준물류비 + Blocking 유휴 + Starving 유휴 + 초과보관비 + 특송비 + LD 페널티
// DOM 의존 없음. sim.js 에서만 호출된다.
// ═══════════════════════════════════════════════════════════════════════════

import { SIM } from './data.js';

export const COST_BUCKETS = [
  { id: 'baseFreight', label: '기준 물류비', en: 'BASE FREIGHT', sign: 'base' },
  { id: 'blockingIdle', label: 'Blocking 유휴', en: 'BLOCKING IDLE', sign: 'add' },
  { id: 'starvingIdle', label: 'Starving 유휴', en: 'STARVING IDLE', sign: 'add' },
  { id: 'excessStorage', label: '초과보관', en: 'EXCESS STORAGE', sign: 'add' },
  { id: 'expedite', label: '특송', en: 'EXPEDITE', sign: 'add' },
  { id: 'ldPenalty', label: 'LD 페널티', en: 'LD PENALTY', sign: 'add' },
];

/** 운임 — 트럭 대수 × 거리 × 요율. 특송이면 배수 적용. */
export function freightForShipment(shipment, cost) {
  const base = shipment.trucks * shipment.miles * cost.freightPerMileTruck;
  if (!shipment.expedited) return { base, expediteExtra: 0 };
  return { base, expediteExtra: base * (shipment.expediteCostMultiplier - 1) };
}

/** 환적 취급비 — CHI 를 경유한 트럭 대수 기준. */
export function hubHandling(trucks, cost) {
  return trucks * cost.hubHandlingPerTruck;
}

/**
 * 유휴 비용 — 그 날 잃어버린 산출량 비율만큼 라인이 놀았다고 본다.
 * idleFraction = lostOutput / byCapacity  (0..1)
 * 비용 = idleFraction × 조업시간 × 시간당 유휴비
 */
export function idleCost(stage, idleFraction, operatingHoursPerDay, cost) {
  const rate = cost.idleCostPerHour[stage] ?? 0;
  return Math.max(0, idleFraction) * operatingHoursPerDay * rate;
}

/**
 * 초과 보관비 — 무료 허용량(freeStorageDays 분)을 넘는 완제품 재고에만 부과.
 * 실측 요율 부재 → placeholder.
 */
export function excessStorageCost(fgiMWh, freeAllowanceMWh, cost) {
  return Math.max(0, fgiMWh - freeAllowanceMWh) * cost.storagePerMWhDay;
}

export function freeStorageAllowance(effectiveDailyOutput) {
  return effectiveDailyOutput * SIM.freeStorageDays;
}

/**
 * LD 페널티 (§2.6)
 *   lateDays = max(0, deliveredDay - dueDay - graceDays)
 *   penalty  = min(qty × 계약가 × 일률 × lateDays, qty × 계약가 × 상한)
 */
export function ldPenalty(qtyMWh, lateDays, terms) {
  if (lateDays <= 0 || qtyMWh <= 0) return 0;
  const exposure = qtyMWh * terms.contractValuePerMWh;
  return Math.min(exposure * terms.ldRatePerDay * lateDays, exposure * terms.ldCapPct);
}

/** 노출 상한 — 미인도 잔량 페널티가 수렴하는 값. */
export function ldCapAmount(qtyMWh, terms) {
  return qtyMWh * terms.contractValuePerMWh * terms.ldCapPct;
}

export function inventoryValue(totalMWh, cost) {
  return totalMWh * cost.inventoryValuePerMWh;
}

/** 워터폴용 누적 좌표를 만든다. base 에서 시작해 add 를 쌓는다. */
export function waterfallSteps(breakdown) {
  const steps = [];
  let cursor = 0;
  for (const b of COST_BUCKETS) {
    const value = breakdown[b.id] ?? 0;
    steps.push({ ...b, value, start: cursor, end: cursor + value });
    cursor += value;
  }
  steps.push({ id: 'total', label: '총액', en: 'TOTAL', sign: 'total', value: cursor, start: 0, end: cursor });
  return steps;
}

export function totalCost(breakdown) {
  return COST_BUCKETS.reduce((s, b) => s + (breakdown[b.id] ?? 0), 0);
}
