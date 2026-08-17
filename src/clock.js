// ═══════════════════════════════════════════════════════════════════════════
// src/clock.js — 시뮬레이션 일자(D+n) ↔ 실제 일시 매핑
//
// 엔진은 정수 일자(0..119)로만 돈다. 화면은 그걸 실제 날짜로 보여준다 —
// 담당자가 보는 것은 'D+030' 이 아니라 지금 이 순간이어야 하기 때문이다.
//
// 기준점: LIVE.nowDay 가 앱을 연 시각에 대응한다.
//   D+0        = 지금 − 30일   (실측 구간의 시작)
//   D+nowDay   = 지금          (관측 시점)
//   D+119      = 지금 + 89일   (예측 구간의 끝)
//
// EPOCH 는 모듈 로드 시 한 번만 고정한다. 렌더마다 new Date() 를 부르면
// 같은 일자가 렌더 시점에 따라 다른 날짜로 찍혀 타임라인이 흔들린다.
// ═══════════════════════════════════════════════════════════════════════════

import { LIVE } from './data.js';

const MS_PER_DAY = 86400000;

/** 앱을 연 시각 = 관측 시점(D+LIVE.nowDay). 세션 동안 고정된다. */
export const SESSION_START = new Date();

/** 실제 경과 시간 — 'LAST SYNC 12초 전' 류의 카운터가 쓴다. */
export function secondsSinceStart() {
  return Math.floor((Date.now() - SESSION_START.getTime()) / 1000);
}

/** 시뮬레이션 일자 → Date. 시각은 관측 시점의 시:분:초를 그대로 유지한다. */
export function dateForDay(d) {
  return new Date(SESSION_START.getTime() + (d - LIVE.nowDay) * MS_PER_DAY);
}

const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];
const p2 = (n) => String(n).padStart(2, '0');

/** 2026-08-16 (금) */
export function fmtDate(d) {
  const t = dateForDay(d);
  return `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())} (${WEEKDAY[t.getDay()]})`;
}

/** 08-16 — 타임라인 눈금처럼 좁은 자리용 */
export function fmtDateShort(d) {
  const t = dateForDay(d);
  return `${p2(t.getMonth() + 1)}-${p2(t.getDate())}`;
}

/** 2026-08-16 14:32:07 — 계측 수신 시각 표기용 */
export function fmtDateTime(d, opts = {}) {
  const t = dateForDay(d);
  const base = `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())} ` +
    `${p2(t.getHours())}:${p2(t.getMinutes())}`;
  return opts.seconds ? `${base}:${p2(t.getSeconds())}` : base;
}

/** 14:32:07 */
export function fmtClock(date = new Date()) {
  return `${p2(date.getHours())}:${p2(date.getMinutes())}:${p2(date.getSeconds())}`;
}

/**
 * 경과 시간을 사람이 읽는 형태로 — '12초 전' / '4시간 12분 전'.
 * 계측 수신 지연을 그대로 노출해야 피드가 살아 있는 것처럼 읽힌다.
 */
export function fmtAgo(seconds) {
  if (seconds < 60) return `${seconds}초 전`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  return `${h}시간 ${m % 60}분 전`;
}

/** 관측 시점 기준 상대 표기 — 예측 구간에서 'D+12일 뒤' 같은 맥락이 필요할 때. */
export function relativeToNow(d) {
  const diff = d - LIVE.nowDay;
  if (diff === 0) return '현재';
  return diff > 0 ? `+${diff}일` : `${diff}일`;
}
