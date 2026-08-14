// ═══════════════════════════════════════════════════════════════════════════
// src/panels/customers.js — ④ CUSTOMERS §4.4-④
// 전역 LD 레버 (상단) + 고객별 오버라이드 (행) 2단 구조 · PO 테이블 48건
// ═══════════════════════════════════════════════════════════════════════════

import { CUSTOMERS } from '../data.js';
import { el, section, slider, numberField, badge, kv } from '../components.js';
import { usd, fmtNum } from '../units.js';
import { setAllCustomers, setCustomerLever, setSelection } from '../store.js';

export const title = 'Customers';

let sortKey = 'dueDay';
let showOnlyProblem = false;

export function render(state) {
  const box = el('div');
  const r = state.result;

  // ── 전역 계약 조건 ────────────────────────────────────────────────────
  const first = state.config.customers[CUSTOMERS[0].id];
  const g = el('div');
  g.appendChild(numberField({
    label: '계약가 (전역)', unit: 'USD/MWh', value: first.contractValuePerMWh, min: 0, step: 10000,
    sub: (v) => `총 노출액 ≈ ${usd(v * r.system.orderedMWh)}`,
    onInput: (v) => setAllCustomers('contractValuePerMWh', v),
  }));
  g.appendChild(slider({
    label: 'LD 일률 (전역)', value: first.ldRatePerDay, min: 0, max: 0.01, step: 0.0005, pct: true, digits: 2,
    onInput: (v) => setAllCustomers('ldRatePerDay', v),
  }));
  g.appendChild(slider({
    label: 'LD 상한 (전역)', value: first.ldCapPct, min: 0, max: 0.3, step: 0.01, pct: true, digits: 0,
    onInput: (v) => setAllCustomers('ldCapPct', v),
  }));
  g.appendChild(slider({
    label: '유예일 (전역)', value: first.graceDays, min: 0, max: 14, step: 1, unit: 'day', digits: 0,
    onInput: (v) => setAllCustomers('graceDays', v),
  }));
  g.appendChild(el('div', { class: 'ctrl-note', text: '전역 값은 전 고객에 일괄 적용됩니다. 개별 조정은 아래 표에서.' }));
  box.appendChild(section('CONTRACT TERMS — GLOBAL', g, badge('PLACEHOLDER', 'warn')));

  // ── 요약 ──────────────────────────────────────────────────────────────
  box.appendChild(section('SUMMARY', kv([
    ['PO 총건수', `${r.system.ordersTotal}`],
    ['정시 인도', `${r.system.ordersOnTime}`],
    ['지연', `${r.system.ordersLate}`],
    ['미인도', `${r.system.ordersUndelivered}`],
    ['OTD', `${fmtNum(r.system.otdPct, 1)}%`],
    ['LD 누계', usd(r.system.totalPenaltyUSD)],
  ])));

  // ── 고객별 오버라이드 ─────────────────────────────────────────────────
  const ct = el('table', { class: 'grid' });
  ct.appendChild(el('thead', {}, el('tr', {},
    el('th', { text: '고객' }), el('th', { text: 'Link/월' }), el('th', { text: '인도일' }),
    el('th', { text: 'LD %/d' }), el('th', { text: 'Tier' }))));
  const ctb = el('tbody');
  for (const c of CUSTOMERS) {
    const cc = state.config.customers[c.id];
    const tr = el('tr', {
      'aria-selected': String(state.selection?.type === 'customer' && state.selection.id === c.id),
      onclick: () => setSelection({ type: 'customer', id: c.id }),
    },
      el('td', { class: 'tiny', text: `${c.id.replace(/_/g, ' ')}` }),
      el('td', { class: 'n tiny' }, inlineNum(cc.monthlyLinks, 1, 40, 1, (v) => setCustomerLever(c.id, 'monthlyLinks', v))),
      el('td', { class: 'n tiny' }, inlineNum(cc.deliveryDayOfMonth, 1, 28, 1, (v) => setCustomerLever(c.id, 'deliveryDayOfMonth', v))),
      el('td', { class: 'n tiny' }, inlineNum(+(cc.ldRatePerDay * 100).toFixed(2), 0, 1, 0.05, (v) => setCustomerLever(c.id, 'ldRatePerDay', v / 100))),
      el('td', { class: 'n tiny' }, inlineNum(cc.priorityTier, 1, 3, 1, (v) => setCustomerLever(c.id, 'priorityTier', v))));
    ctb.appendChild(tr);
  }
  ct.appendChild(ctb);
  box.appendChild(section('PER-CUSTOMER OVERRIDE', ct));

  // ── PO 테이블 ─────────────────────────────────────────────────────────
  const controls = el('div', { style: { display: 'flex', gap: '4px' } },
    el('button', {
      class: `btn${showOnlyProblem ? ' primary' : ''}`, text: '지연만',
      onclick: () => { showOnlyProblem = !showOnlyProblem; rerender(); },
    }),
    el('button', {
      class: 'btn', text: sortKey === 'dueDay' ? '납기순' : 'LD순',
      onclick: () => { sortKey = sortKey === 'dueDay' ? 'penaltyUSD' : 'dueDay'; rerender(); },
    }));

  let orders = [...r.orders];
  if (showOnlyProblem) orders = orders.filter((o) => o.status === 'LATE' || o.status === 'UNDELIVERED');
  orders.sort((a, b) => (sortKey === 'dueDay' ? a.dueDay - b.dueDay : b.penaltyUSD - a.penaltyUSD));

  const t = el('table', { class: 'grid' });
  t.appendChild(el('thead', {}, el('tr', {},
    el('th', { text: 'PO' }), el('th', { text: 'Link' }), el('th', { text: '납기' }),
    el('th', { text: '인도' }), el('th', { text: '지연' }), el('th', { text: 'LD' }))));
  const tb = el('tbody');
  for (const o of orders) {
    const bad = o.status === 'LATE' || o.status === 'UNDELIVERED';
    tb.appendChild(el('tr', {
      class: bad ? 'late' : '',
      'aria-selected': String(state.selection?.type === 'order' && state.selection.id === o.id),
      title: `${o.customerId} · ${o.status}`,
      onclick: () => setSelection({ type: 'order', id: o.id }),
    },
      el('td', { class: 'mono tiny', text: o.id }),
      el('td', { class: 'n tiny', text: fmtNum(o.qtyLinks, 1) }),
      el('td', { class: 'n tiny', text: `D+${o.dueDay}` }),
      el('td', { class: 'n tiny', text: o.deliveredDay != null ? `D+${o.deliveredDay}` : '—' }),
      el('td', { class: 'n tiny', text: o.lateDays ? `${o.lateDays}d` : '—' }),
      el('td', { class: 'n tiny', text: o.penaltyUSD > 0 ? usd(o.penaltyUSD) : '—' })));
  }
  if (!orders.length) tb.appendChild(el('tr', {}, el('td', { colSpan: 6, class: 'muted tiny', text: '해당 PO 없음' })));
  t.appendChild(tb);
  box.appendChild(section(`PURCHASE ORDERS (${orders.length})`, t, controls));

  box.appendChild(el('div', { class: 'ctrl-note', style: { padding: '6px 10px' },
    text: '행을 클릭하면 해당 PO 의 고객이 선택되고 NETWORK VIEW 에서 공급 경로가 강조됩니다.' }));
  return box;
}

function inlineNum(value, min, max, step, onChange) {
  return el('input', {
    type: 'number', value, min, max, step,
    style: { width: '52px', height: '18px', padding: '0 3px', textAlign: 'right' },
    onclick: (e) => e.stopPropagation(),
    onchange: (e) => onChange(Number(e.target.value)),
  });
}

function rerender() {
  // store 를 건드리지 않는 순수 표시 상태 변경 — 패널만 다시 그린다
  const evt = new CustomEvent('panel-refresh');
  window.dispatchEvent(evt);
}
