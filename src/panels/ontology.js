// ═══════════════════════════════════════════════════════════════════════════
// src/panels/ontology.js — ⑤ ONTOLOGY §4.4-⑤
//
// 선택된 객체가 Foundry Ontology 에서 어떻게 모델링되는지 보여주고,
// Action 버튼은 말이 아니라 동작으로 폐루프를 증명한다 —
// 누르면 config.actions 에 들어가고 즉시 재계산되어 KPI·원가가 실제로 움직인다.
// ═══════════════════════════════════════════════════════════════════════════

import { ONTOLOGY, NODES, LANES, CUSTOMERS, HUB, LANE_INDEX, PACK_IDS, CELL_IDS } from '../data.js';
import { el, section, badge, button, kv, callout, slider } from '../components.js';
import { usd, fmtNum, qty } from '../units.js';
import { appState, pushSimAction, setSelection, removeSimAction } from '../store.js';

export const title = 'Ontology';

let reallocQty = 5;

export function render(state) {
  const box = el('div');
  const sel = state.selection;

  box.appendChild(el('div', { style: { padding: '8px 10px', borderBottom: '1px solid var(--border)' } },
    el('div', { class: 'tiny muted', text: 'Foundry Ontology 매핑 — 선택된 객체의 타입 · 링크 · 실행 가능 Action' })));

  if (!sel) {
    box.appendChild(section('OBJECT TYPES', typeList()));
    box.appendChild(section('LINK TYPES', linkList()));
    box.appendChild(section('ACTION TYPES', actionTypeList()));
    box.appendChild(el('div', { class: 'empty-state', text: '노드 · Lane · 고객을 선택하면 그 객체의 인스턴스 카드와 실행 가능한 Action 이 나타납니다.' }));
    return box;
  }

  box.appendChild(objectCard(state, sel));
  box.appendChild(linkedObjects(state, sel));
  box.appendChild(actions(state, sel));
  if (state.config.actions.length) box.appendChild(actionQueue(state));
  return box;
}

function typeList() {
  const g = el('div');
  for (const t of ONTOLOGY.objectTypes) {
    g.appendChild(el('div', { style: { padding: '3px 0', borderBottom: '1px solid var(--border)' } },
      el('div', { class: 'mono tiny', style: { color: 'var(--accent)' }, text: t.id }),
      el('div', { class: 'mono tiny muted', text: t.props.join(' · ') })));
  }
  return g;
}

function linkList() {
  const g = el('div');
  for (const l of ONTOLOGY.linkTypes) {
    g.appendChild(el('div', { class: 'mono tiny', style: { padding: '2px 0' } },
      el('span', { style: { color: 'var(--text-secondary)' }, text: l.from }),
      el('span', { class: 'muted', text: ` ──${l.name}──▶ ` }),
      el('span', { style: { color: 'var(--text-secondary)' }, text: l.to })));
  }
  return g;
}

function actionTypeList() {
  const g = el('div');
  for (const a of ONTOLOGY.actionTypes) {
    g.appendChild(el('div', { style: { padding: '3px 0', borderBottom: '1px solid var(--border)' } },
      el('div', { class: 'mono tiny', style: { color: 'var(--cyan)' }, text: a.id }),
      el('div', { class: 'tiny muted', text: a.desc })));
  }
  return g;
}

function objectCard(state, sel) {
  const day = state.playhead;
  if (sel.type === 'node') {
    const n = NODES.find((x) => x.id === sel.id);
    const p = state.result.perNode[sel.id];
    const lev = state.config.nodes[sel.id];
    return section('Facility · ProductionLine', el('div', {},
      el('div', { class: 'spread', style: { marginBottom: '4px' } },
        badge('Facility', 'info'), badge('ProductionLine', 'info')),
      kv([
        ['facilityId', n.id],
        ['name', n.name],
        ['geo', `${n.lat.toFixed(2)}, ${n.lng.toFixed(2)}`],
        ['owner', n.owner],
        ['stage', n.type],
        ['theoreticalCapaPerHour', `${lev.theoreticalCapaPerHour} MWh/h`],
        ['availability', `${(lev.availability * 100).toFixed(1)}%`],
        ['yield', `${(lev.yield * 100).toFixed(1)}%`],
        ['— InventoryPosition —', ''],
        ['input.qtyMWh', fmtNum(p.inputBufferSeries[day], 2)],
        ['output.qtyMWh', fmtNum(p.outputBufferSeries[day], 2)],
        ['output.daysOfSupply', fmtNum(p.fgiDaysOfSupply[day], 2)],
      ])));
  }
  if (sel.type === 'lane') {
    const lane = LANE_INDEX[sel.id];
    const pl = state.result.perLane[sel.id];
    const inflight = state.result.shipments.filter(
      (s) => s.laneId === sel.id && s.departDay <= day && s.arriveDay > day);
    return section('Shipment (집합)', el('div', {},
      el('div', { style: { marginBottom: '4px' } }, badge('Shipment', 'info')),
      kv([
        ['laneId', lane.id],
        ['originatesFrom', lane.from],
        ['deliversTo', lane.to],
        ['miles', fmtNum(pl.miles, 0)],
        ['activeShipments', `${inflight.length}`],
        ['qtyMWh (in-transit)', fmtNum(inflight.reduce((a, b) => a + b.qtyMWh, 0), 2)],
        ['expedited', `${inflight.filter((s) => s.expedited).length}`],
      ])));
  }
  if (sel.type === 'customer' || sel.type === 'order') {
    const cid = sel.type === 'order'
      ? state.result.orders.find((o) => o.id === sel.id)?.customerId : sel.id;
    const c = CUSTOMERS.find((x) => x.id === cid);
    const pc = state.result.perCustomer[cid];
    const cc = state.config.customers[cid];
    return section('CustomerSite · PurchaseOrder', el('div', {},
      el('div', { class: 'spread', style: { marginBottom: '4px' } },
        badge('CustomerSite', 'info'), badge('PurchaseOrder', 'info')),
      kv([
        ['siteId', c.id],
        ['name', c.name],
        ['state', c.state],
        ['priorityTier', `${cc.priorityTier}`],
        ['openOrders', `${pc.orders.filter((o) => o.status !== 'DELIVERED').length}`],
        ['penaltyUSD', usd(pc.penaltyUSD)],
      ])));
  }
  if (sel.type === 'hub') {
    return section('Facility (cross-dock)', kv([
      ['facilityId', HUB.id], ['mode', HUB.mode], ['stage', 'TRANSSHIPMENT'],
      ['dwellDays', `${state.config.hubDwellDays}`],
    ]));
  }
  return el('div');
}

function linkedObjects(state, sel) {
  const g = el('div');
  const add = (label, id, target) => {
    g.appendChild(el('div', {
      class: 'mono tiny', style: { padding: '3px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer' },
      onclick: () => target && setSelection(target),
    },
      el('span', { class: 'muted', text: `${label}  ` }),
      el('span', { style: { color: 'var(--accent)' }, text: id })));
  };

  if (sel.type === 'node') {
    for (const l of LANES.filter((x) => x.to === sel.id)) add('inbound ', l.id, { type: 'lane', id: l.id });
    for (const l of LANES.filter((x) => x.from === sel.id)) add('outbound', l.id, { type: 'lane', id: l.id });
  } else if (sel.type === 'lane') {
    const lane = LANE_INDEX[sel.id];
    add('origin  ', lane.from, { type: NODES.some((n) => n.id === lane.from) ? 'node' : 'hub', id: lane.from });
    add('dest    ', lane.to, CUSTOMERS.some((c) => c.id === lane.to)
      ? { type: 'customer', id: lane.to }
      : { type: NODES.some((n) => n.id === lane.to) ? 'node' : 'hub', id: lane.to });
  } else if (sel.type === 'customer' || sel.type === 'order') {
    const cid = sel.type === 'order'
      ? state.result.orders.find((o) => o.id === sel.id)?.customerId : sel.id;
    for (const o of state.result.perCustomer[cid].orders) add('order   ', o.id, { type: 'order', id: o.id });
    add('lane    ', `AZL->${cid}`, { type: 'lane', id: `AZL->${cid}` });
  }
  for (const d of state.config.disruptions) {
    if (d.target === sel.id) add('impacts ', `DisruptionEvent(${d.type})`, null);
  }
  return section('LINKED OBJECTS', g);
}

// ── 실행 가능 Action — 실제로 시뮬을 바꾼다 (§3.5) ──────────────────────
function actions(state, sel) {
  const g = el('div', { class: 'stack' });
  const day = state.playhead;

  if (sel.type === 'node') {
    const n = NODES.find((x) => x.id === sel.id);
    const lev = state.config.nodes[sel.id];

    g.appendChild(actionRow('AdjustShift', `조업시간 ${lev.operatingHoursPerDay}h → 24h`, () =>
      pushSimAction({ type: 'adjustShift', nodeId: sel.id, hours: 24, day })));

    g.appendChild(actionRow('RescheduleProduction', '가동률 +5%p · 수율 +1%p', () =>
      pushSimAction({
        type: 'rescheduleProduction', nodeId: sel.id, day,
        newLevers: {
          availability: Math.min(1, lev.availability + 0.05),
          yield: Math.min(0.999, lev.yield + 0.01),
        },
      })));

    // 재고 이관은 같은 단계의 다른 노드로
    const peers = (n.type === 'CELL' ? CELL_IDS : n.type === 'PACK' ? PACK_IDS : []).filter((x) => x !== sel.id);
    if (peers.length) {
      g.appendChild(slider({
        label: '이관 물량', value: reallocQty, min: 1, max: 40, step: 1, unit: 'MWh', digits: 0,
        onInput: (v) => { reallocQty = v; },
      }));
      for (const to of peers) {
        g.appendChild(actionRow('ReallocateInventory', `${sel.id} → ${to}`, () =>
          pushSimAction({ type: 'reallocateInventory', from: sel.id, to, qtyMWh: reallocQty, day })));
      }
    }
  } else if (sel.type === 'lane') {
    g.appendChild(actionRow('ExpediteShipment', '이 구간 14일 특송 (리드타임 ×0.5 · 운임 ×3.2)', () =>
      pushSimAction({ type: 'expediteLane', laneId: sel.id, startDay: day, durationDays: 14 })));
  } else if (sel.type === 'customer' || sel.type === 'order') {
    g.appendChild(actionRow('ExpediteShipment', 'AZL → 고객 구간 14일 특송', () => {
      const cid = sel.type === 'order'
        ? state.result.orders.find((o) => o.id === sel.id)?.customerId : sel.id;
      pushSimAction({ type: 'expediteLane', laneId: `AZL->${cid}`, startDay: day, durationDays: 14 });
    }));
  }

  g.appendChild(callout(
    `Action 은 D+${String(day).padStart(3, '0')} 기준으로 실제 시뮬레이션 상태를 바꿉니다.\n` +
    `누르면 즉시 재계산되어 KPI · 원가 · 간트가 움직입니다.`, 'ok'));
  return section('EXECUTABLE ACTIONS', g);
}

function actionRow(type, label, onclick) {
  const b = button(`▶ ${label}`, onclick, 'primary');
  b.classList.add('wide');
  b.style.textAlign = 'left';
  return el('div', {},
    el('div', { class: 'mono tiny', style: { color: 'var(--cyan)', marginBottom: '2px' }, text: type }),
    b);
}

function actionQueue(state) {
  const g = el('div');
  state.config.actions.forEach((a, i) => {
    g.appendChild(el('div', { class: 'spread', style: { padding: '3px 0', borderBottom: '1px solid var(--border)' } },
      el('div', { class: 'mono tiny', text: `${a.type} · D+${a.day ?? a.startDay}` }),
      el('button', { class: 'btn danger', text: '✕', onclick: () => removeSimAction(i) })));
  });
  return section('ACTION QUEUE', g, badge(`${state.config.actions.length}`, 'info'));
}
