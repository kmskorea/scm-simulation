// ═══════════════════════════════════════════════════════════════════════════
// src/panels/planning.js — ③ PLANNING §4.4-③
//
// 이 패널의 대형 숫자 '실질 대응 지연'이 이 도구의 핵심 숫자다.
//   실질 대응 지연 = 정보지연 + (다음 replan 경계까지) + frozen window
// 파라미터를 0 으로 내리면 PLAN 모드의 적용 지연 경고가 사라진다 —
// 사용자가 스스로 "정보 지연을 없애면 이렇게 된다"를 발견하게 만든다.
// ═══════════════════════════════════════════════════════════════════════════

import { ALLOCATION_RULES } from '../data.js';
import { el, section, slider, selectField, kv, callout, badge } from '../components.js';
import { usd, fmtNum } from '../units.js';
import { setPlanning, toggleCounterfactual } from '../store.js';
import { earliestApplicableDay } from '../sim.js';

export const title = 'Planning';

export function render(state) {
  const box = el('div');
  const pl = state.config.planning;
  const day = state.playhead;
  const lag = earliestApplicableDay(pl, day);

  // ── 대형 숫자 ─────────────────────────────────────────────────────────
  const hero = el('div', { style: { padding: '10px', background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border)' } });
  hero.appendChild(el('div', { class: 'section-label', style: { padding: 0 } },
    el('span', { text: '실질 대응 지연' })));
  hero.appendChild(el('div', {
    class: 'bignum',
    style: { color: lag.totalLagDays === 0 ? 'var(--status-ok)' : lag.totalLagDays > 14 ? 'var(--status-crit)' : 'var(--status-warn)' },
    text: `${lag.totalLagDays} DAYS`,
  }));
  hero.appendChild(el('div', { class: 'ctrl-sub', style: { marginTop: '4px' },
    text: `정보지연 ${pl.infoLagDays} + replan 대기 ${lag.replanWaitDays} + frozen ${pl.frozenWindowDays}` +
          ` = ${lag.totalLagDays} → 실행 가능 최단 D+${String(lag.effectiveDay).padStart(3, '0')}` }));
  box.appendChild(hero);

  // ── 파라미터 ──────────────────────────────────────────────────────────
  const levers = el('div');
  levers.appendChild(slider({
    label: '계획 주기 (replan)', value: pl.replanCycleDays, min: 1, max: 30, step: 1, unit: 'day', digits: 0,
    onInput: (v) => setPlanning('replanCycleDays', v),
  }));
  levers.appendChild(slider({
    label: 'Frozen window', value: pl.frozenWindowDays, min: 0, max: 30, step: 1, unit: 'day', digits: 0,
    sub: (v) => (v === 0 ? '계획 변경이 즉시 반영됩니다' : `${v}일 내 계획은 변경 불가`),
    onInput: (v) => setPlanning('frozenWindowDays', v),
  }));
  levers.appendChild(slider({
    label: '정보 지연 (infoLag)', value: pl.infoLagDays, min: 0, max: 21, step: 1, unit: 'day', digits: 0,
    sub: (v) => (v === 0 ? '장애를 즉시 인지합니다' : `장애 발생 ${v}일 뒤에야 계획이 인지`),
    onInput: (v) => setPlanning('infoLagDays', v),
  }));
  // 배분 규칙은 ADVANCED 패널로 이동했다 (총 생산량이 아니라 순서만 바꾸는 값이라
  // 진단 화면의 주 레버와 성격이 다르다).
  levers.appendChild(slider({
    label: 'Horizon', value: state.config.horizonDays, min: 30, max: 240, step: 30, unit: 'day', digits: 0,
    onInput: (v) => { state.config.horizonDays = v; setPlanning('replanCycleDays', pl.replanCycleDays); },
  }));
  box.appendChild(section('PARAMETERS', levers));

  // ── 물리 vs 정보 ──────────────────────────────────────────────────────
  const r = state.result;
  const cf = state.counterfactual;
  const saving = r.system.totalCostUSD - cf.system.totalCostUSD;
  const cmp = el('div');
  cmp.appendChild(el('div', { class: 'cf-grid' },
    el('div', { class: 'cf-cell' }, el('div', { class: 'k', text: '현재' }), el('div', { class: 'v', text: usd(r.system.totalCostUSD) })),
    el('div', { class: 'cf-cell' }, el('div', { class: 'k', text: '즉시대응' }), el('div', { class: 'v', text: usd(cf.system.totalCostUSD) })),
    el('div', { class: 'cf-cell saving' }, el('div', { class: 'k', text: '절감' }), el('div', { class: 'v', text: usd(saving) }))));
  cmp.appendChild(el('div', { style: { marginTop: '6px' } },
    el('button', {
      class: `btn wide${state.showCounterfactual ? ' primary' : ''}`,
      text: '◫ 즉시 대응 시 절감효과',
      onclick: toggleCounterfactual,
    })));
  cmp.appendChild(callout(
    `물리 리드타임은 못 줄인다 — PW→AZL 1,745 mi 는 그대로다.\n` +
    `줄일 수 있는 것은 정보 지연이고, 그 차액이 위 금액이다.`, 'ok'));
  box.appendChild(section('물리 리드타임 vs 정보 지연', cmp));

  // ── 계획 이력 ─────────────────────────────────────────────────────────
  const log = el('div', { style: { maxHeight: '160px', overflowY: 'auto' } });
  for (const p of r.planLog.slice(-14).reverse()) {
    log.appendChild(el('div', {
      class: 'mono tiny',
      style: { display: 'flex', justifyContent: 'space-between', padding: '2px 0', borderBottom: '1px solid var(--border)' },
    },
      el('span', { class: 'muted', text: `D+${String(p.day).padStart(3, '0')} → D+${String(p.effectiveDay).padStart(3, '0')}` }),
      el('span', { text: `${fmtNum(p.systemRate, 2)} MWh/d` })));
  }
  box.appendChild(section('REPLAN LOG', log, badge(`${r.planLog.length}`, 'muted')));

  box.appendChild(section('배분 규칙 효과', kv([
    ['OTD', `${fmtNum(r.system.otdPct, 1)}%`],
    ['지연 PO', `${r.system.ordersLate}`],
    ['미인도 PO', `${r.system.ordersUndelivered}`],
    ['LD 누계', usd(r.system.totalPenaltyUSD)],
  ])));
  return box;
}
