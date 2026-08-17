// ═══════════════════════════════════════════════════════════════════════════
// src/panels/ontology.js — ⑤ ONTOLOGY §4.4-⑤
//
// 선택된 객체가 Foundry Ontology 에서 어떻게 모델링되는지 보여주고,
// Action 버튼은 말이 아니라 동작으로 폐루프를 증명한다 —
// 누르면 config.actions 에 들어가고 즉시 재계산되어 KPI·원가가 실제로 움직인다.
// ═══════════════════════════════════════════════════════════════════════════

import { ONTOLOGY, NODES, LANES, CUSTOMERS, HUB, LANE_INDEX, PACK_IDS, CELL_IDS } from '../data.js';
import { el, section, badge, button, kv, callout, slider } from '../components.js';
import { usd, fmtNum } from '../units.js';
import { pushSimAction, setSelection, removeSimAction, approveRecommendation } from '../store.js';
import { isApplied, findConstraint, activeDrifts, demandOutlook } from '../recommend.js';
import { fmtDate } from '../clock.js';

export const title = 'AI Decision Support';

let reallocQty = 5;

export function render(state) {
  const box = el('div');
  const sel = state.selection;

  box.appendChild(el('div', { style: { padding: '8px 10px', borderBottom: '1px solid var(--border)' } },
    el('div', { class: 'tiny muted', text: 'Ontology 기반 진단 → Action 추천 → 승인 → 실행' })));

  // 진단과 추천은 선택 대상과 무관하게 항상 맨 위에 온다 —
  // '무엇을 클릭해야 할지' 자체를 알려 주는 것이 이 패널의 첫 임무다.
  box.appendChild(diagnosisCard(state));
  box.appendChild(recommendationList(state));
  if (state.config.actions.length) box.appendChild(actionQueue(state));

  if (!sel) {
    box.appendChild(section('OBJECT TYPES', typeList()));
    box.appendChild(section('LINK TYPES', linkList()));
    box.appendChild(section('ACTION TYPES', actionTypeList()));
    return box;
  }

  box.appendChild(objectCard(state, sel));
  box.appendChild(linkedObjects(state, sel));
  box.appendChild(actions(state, sel));
  return box;
}

// ── 진단 ────────────────────────────────────────────────────────────────
function diagnosisCard(state) {
  const g = el('div');
  const cons = findConstraint(state.result);
  const drifts = activeDrifts(state.config, state.nowDay);
  const outlook = demandOutlook(state.result, state.nowDay);

  g.appendChild(el('div', { class: 'diag-line' },
    el('span', { class: 'diag-k', text: '제약 공정' }),
    el('span', { class: 'diag-v', style: { color: 'var(--status-warn)' },
      text: `${cons.nodeId} (${cons.stage}) · 가동률 ${cons.utilizationPct.toFixed(1)}%` })));

  for (const d of drifts) {
    g.appendChild(el('div', { class: 'diag-line' },
      el('span', { class: 'diag-k', text: '실측 편차' }),
      el('span', { class: 'diag-v', style: { color: 'var(--status-danger)' },
        text: `${d.nodeId} ${d.label} — 계획 미반영` })));
  }

  if (outlook.rising) {
    g.appendChild(el('div', { class: 'diag-line' },
      el('span', { class: 'diag-k', text: '수요 전망' }),
      el('span', { class: 'diag-v',
        text: `${outlook.riseDay != null ? fmtDate(outlook.riseDay) + ' 부터 ' : ''}+${outlook.risePct.toFixed(0)}%` })));
  }

  const s = state.result.system;
  g.appendChild(el('div', { class: 'diag-line' },
    el('span', { class: 'diag-k', text: '영향' }),
    el('span', { class: 'diag-v',
      text: `OTD ${s.otdPct.toFixed(1)}% · LD ${usd(s.costBreakdown.ldPenalty)} · 일실 ${s.totalLostOutputMWh.toFixed(0)} MWh` })));

  return section('진단 · DIAGNOSIS', g);
}

// ── 추천 ────────────────────────────────────────────────────────────────
function recommendationList(state) {
  const recs = state.recommendations || [];
  const g = el('div');

  if (!recs.length) {
    g.appendChild(el('div', { class: 'empty-state',
      text: '추천할 조치가 없습니다.\n총원가를 낮추는 후보가 없거나, 아직 계산 중입니다.' }));
    return section('추천 ACTION · RECOMMENDED', g);
  }

  recs.forEach((rec, i) => g.appendChild(recommendationCard(state, rec, i + 1)));
  g.appendChild(el('div', { class: 'ctrl-note', style: { marginTop: '6px' },
    text: '예상 효과는 추정이 아니라, 그 Action 을 넣고 120일을 실제로 다시 시뮬레이션한 결과입니다.' }));
  return section('추천 ACTION · RECOMMENDED', g, badge(`${recs.length}`, 'info'));
}

const KIND_LABEL = {
  MAINTENANCE: '설비 정비', CAPACITY: '생산능력', INVENTORY: '재고 운영',
  LOGISTICS: '물류', PLANNING: '계획 체계',
};

function recommendationCard(state, rec, rank) {
  const applied = isApplied(state.config, rec);
  const card = el('div', { class: `rec-card${applied ? ' applied' : ''}` });

  // 헤더 — 순위 · 분류 · 제목
  card.appendChild(el('div', { class: 'rec-head' },
    el('span', { class: 'rec-rank', text: `${rank}` }),
    el('span', { class: 'rec-title', text: rec.title }),
    applied ? badge('승인됨', 'ok') : badge(KIND_LABEL[rec.kind] || rec.kind, 'info')));

  // 예상 효과 — 가장 먼저 보여야 할 숫자
  const im = rec.impact;
  const eff = el('div', { class: 'rec-impact' });
  const metric = (k, v, good) => el('div', { class: 'rec-metric' },
    el('div', { class: 'k', text: k }),
    el('div', { class: 'v', style: { color: good ? 'var(--status-ok)' : 'var(--text-primary)' }, text: v }));
  eff.appendChild(metric('총원가', usd(im.totalCostUSD), im.totalCostUSD < 0));
  eff.appendChild(metric('OTD', `${im.otdPct >= 0 ? '+' : ''}${im.otdPct.toFixed(1)}%p`, im.otdPct > 0));
  eff.appendChild(metric('LD', usd(im.penaltyUSD), im.penaltyUSD < 0));
  eff.appendChild(metric('일실 산출', `${im.lostMWh >= 0 ? '+' : ''}${im.lostMWh.toFixed(1)} MWh`, im.lostMWh < 0));
  card.appendChild(eff);

  // 실행 정보 — 담당자 · 적용 예정일 · 대상
  const r = rec.responsible;
  card.appendChild(el('div', { class: 'rec-meta' },
    metaRow('담당', `${r.owner} · ${r.org}`),
    metaRow('승인', r.approver),
    metaRow('대상', rec.targetNode ? `${rec.targetNode}${rec.targetOrder ? ` · ${rec.targetOrder}` : ''}` : '계획 시스템 전역'),
    metaRow('적용 예정일', `${fmtDate(rec.effectiveDay)}${rec.configPatch ? ' (즉시)' : ` · 대응지연 ${rec.lag.totalLagDays}일`}`)));

  // 근거
  const why = el('div', { class: 'rec-why' });
  for (const line of rec.why) why.appendChild(el('div', { class: 'rec-why-line', text: `· ${line}` }));
  card.appendChild(why);

  if (rec.evidence?.length) {
    const ev = el('div', { class: 'rec-evidence' });
    for (const [k, v] of rec.evidence) {
      ev.appendChild(el('div', { class: 'rec-ev-row' },
        el('span', { class: 'k', text: k }), el('span', { class: 'v', text: v })));
    }
    card.appendChild(el('details', { class: 'rec-details' },
      el('summary', { text: '관련 데이터' }), ev));
  }

  // 승인 · 실행
  const btn = button(applied ? '✓ 승인 완료' : '▶ 승인 · 실행',
    () => { if (!applied) approveRecommendation(rec); },
    applied ? '' : 'primary');
  btn.classList.add('wide');
  if (applied) btn.disabled = true;
  card.appendChild(el('div', { style: { marginTop: '6px' } }, btn));
  return card;
}

function metaRow(k, v) {
  return el('div', { class: 'rec-meta-row' },
    el('span', { class: 'k', text: k }), el('span', { class: 'v', text: v }));
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
