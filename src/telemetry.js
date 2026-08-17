// ═══════════════════════════════════════════════════════════════════════════
// src/telemetry.js — 계측 피드 표현 계층
//
// 현장 데이터가 들어오는 것처럼 보이게 하는 계층이다. 값의 출처는 어디까지나
// runSim 의 결과이며, 여기서 만드는 것은 '수신 시각 · 태그 · 링크 상태 ·
// 계측 노이즈' 뿐이다.
//
// ★ 이 모듈의 값은 절대 config 나 엔진으로 흘러들어가지 않는다.
//   runSim 은 순수 함수로 남아야 하고(검증 게이트 P), 계측 노이즈가 엔진에
//   들어가면 같은 config 가 매번 다른 결과를 내놓는다. 여기서 만든 값은
//   오직 화면에만 쓴다.
// ═══════════════════════════════════════════════════════════════════════════

import { TELEMETRY, liveDisruptions } from './data.js';
import { secondsSinceStart } from './clock.js';

/**
 * 결정론적 의사난수 — 같은 (키, 틱) 조합이면 항상 같은 값이 나온다.
 * Math.random() 을 쓰면 렌더할 때마다 숫자가 튀어 클릭만 해도 값이 바뀐다.
 * 계측값은 '갱신 주기마다' 변해야지 '렌더마다' 변하면 안 된다.
 */
function hashNoise(key, tick) {
  let h = 2166136261;
  const s = `${key}:${tick}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000; // 0..1
}

/**
 * 노드의 현재 계측 상태.
 *   value      표시용 값 (실제 결과값 + 계측 노이즈)
 *   exact      노이즈 없는 원래 값 — 비교·계산에는 이쪽을 쓴다
 *   ageSeconds 마지막 수신 후 경과 (STALE 판정용)
 */
export function reading(nodeId, exact, opts = {}) {
  const meta = TELEMETRY[nodeId] || { src: 'MES', tag: `${nodeId}.OEE`, intervalSec: 60 };
  const jitterPct = opts.jitterPct ?? 0.004; // ±0.4% — 계측기 흔들림 수준
  const elapsed = secondsSinceStart();

  // 갱신 주기 단위로만 값이 바뀐다
  const tick = Math.floor(elapsed / meta.intervalSec);
  const noise = (hashNoise(`${nodeId}:${opts.field || 'v'}`, tick) - 0.5) * 2 * jitterPct;

  const stale = meta.staleMinutes != null;
  const ageSeconds = stale
    ? meta.staleMinutes * 60 + elapsed
    : elapsed % meta.intervalSec;

  return {
    value: stale ? exact : exact * (1 + noise), // 끊긴 노드는 마지막 값을 그대로 붙든다
    exact,
    src: meta.src,
    tag: meta.tag,
    intervalSec: meta.intervalSec,
    stale,
    ageSeconds,
  };
}

/** 링크 상태 — 헤더 배지와 노드별 표시에 함께 쓴다. */
export function linkHealth() {
  const ids = Object.keys(TELEMETRY);
  const staleIds = ids.filter((id) => TELEMETRY[id].staleMinutes != null);
  return {
    total: ids.length,
    online: ids.length - staleIds.length,
    staleIds,
    ok: staleIds.length === 0,
  };
}

/**
 * 이 config 가 관측된 현장 상태 그대로인가, 아니면 사용자가 손댄 가정인가.
 * LIVE 실측과 다르면 그 화면은 시뮬레이션이므로 그렇게 표시해야 한다.
 */
export function isPristineLive(config) {
  const base = liveDisruptions();
  const cur = config.disruptions || [];
  if (cur.length !== base.length) return false;
  if ((config.actions || []).length > 0) return false;
  return base.every((o, i) => {
    const c = cur[i];
    return c && c.type === o.type && c.target === o.target && c.startDay === o.startDay
      && c.pct === o.pct && c.deltaPct === o.deltaPct && c.multiplier === o.multiplier;
  });
}
