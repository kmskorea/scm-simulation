// ═══════════════════════════════════════════════════════════════════════════
// src/panels/inspector.js — ① NODE / LANE / HUB / CUSTOMER INSPECTOR §4.4-①
//
// 레버는 어떤 상태에서도 잠기지 않는다 (§8). 재생 중에도 조정 가능하며,
// OPERATE 모드에서는 계획 레이어가 계산한 '최단 적용 가능일'을 경고로 띄울 뿐
// 컨트롤을 비활성화하지 않는다.
// ═══════════════════════════════════════════════════════════════════════════

import {
  NODES, HUB, CUSTOMERS, LANE_TYPES, LANE_INDEX, NODE_LEVER_SPEC,
  isOverriddenDistance, UNITS,
} from '../data.js';
import {
  el, section, slider, segmented, numberField, checkbox, badge, callout,
  kv, button, sparkline, clear,
} from '../components.js';
import { qty, fmtNum, usd, dualQty, miles as fmtMiles, STATUS_CLASS, loadQty } from '../units.js';
import {
  setNodeLever, setLaneLever, setCustomerLever, setGlobal,
  resetNode, setSelection, toggleWatch, isWatched, pushSimAction,
} from '../store.js';
import {
  effectiveDailyOutput, outputBufferCapacity, inputBufferCapacity, effectiveDailyInput,
} from '../sim.js';

export const title = 'Inspector';

export function render(state) {
  const box = el('div');
  const sel = state.selection;
  if (!sel) {
    box.appendChild(el('div', { class: 'empty-state', text: '지도 · 흐름도 · 간트에서 대상을 선택하세요.\n\n노드 / Lane / Hub / 고객 전부 클릭 가능합니다.' }));
    return box;
  }
  if (sel.type === 'node') return nodeInspector(state, sel.id);
  if (sel.type === 'lane') return laneInspector(state, sel.id);
  if (sel.type === 'hub') return hubInspector(state);
  if (sel.type === 'customer' || sel.type === 'order') return customerInspector(state, sel);
  return box;
}

// ── 공통 헤더 ───────────────────────────────────────────────────────────
function head(id, subtitle, right) {
  return el('div', { style: { padding: '8px 10px', borderBottom: '1px solid var(--border)' } },
    el('div', { class: 'spread' },
      el('span', { class: 'mono', style: { fontSize: '13px', color: 'var(--text-primary)' }, text: id }),
      right || null),
    el('div', { class: 'tiny muted', style: { marginTop: '2px' }, text: subtitle })
  );
}

function watchBtn(type, id) {
  const on = isWatched(type, id);
  return el('button', {
    class: 'btn', text: on ? '★ 워치' : '☆ 워치',
    onclick: () => toggleWatch(type, id),
  });
}

// ═══════════════════════════════════════════════════════════════════════
// NODE INSPECTOR
// ═══════════════════════════════════════════════════════════════════════
function nodeInspector(state, id) {
  const n = NODES.find((x) => x.id === id);
  const lev = state.config.nodes[id];
  const p = state.result.perNode[id];
  const day = state.playhead;
  const st = p.stateTimeline[day];

  const box = el('div');
  box.appendChild(head(id, `${n.name} · ${n.place}`,
    el('div', { style: { display: 'flex', gap: '4px' } },
      badge(st, STATUS_CLASS[st]), badge(n.owner, 'muted'))));

  // ── 실시간 readout ────────────────────────────────────────────────────
  // draft 는 '사용자가 지금 돌리고 있는 값'의 사본이다. config 를 직접 만지면
  // OPERATE 모드에서 이전 이력이 함께 바뀌어 버린다(§1.5.2 위반). 실제 반영은
  // 반드시 setNodeLever() 를 통해서만 한다.
  const draft = { ...lev };
  const readout = el('div', { style: { padding: '8px 10px', background: 'var(--bg-elevated)' } });
  const paintReadout = () => {
    clear(readout);
    const out = effectiveDailyOutput(draft);
    readout.appendChild(kv([
      ['유효 일산출', `${fmtNum(out, 2)} MWh/day`],
      ['', `${fmtNum(out / UNITS.linkMWh, 2)} Link/day`],
      ['입고 소요', `${fmtNum(effectiveDailyInput(draft), 2)} MWh/day`],
      ['입고 창고', `${fmtNum(inputBufferCapacity(draft), 1)} MWh`],
      ['출고 창고', `${fmtNum(outputBufferCapacity(draft), 1)} MWh`],
    ]));
  };
  paintReadout();
  box.appendChild(readout);

  if (state.mode === 'OPERATE') box.appendChild(operateNotice(state, id));

  // ── 레버 ──────────────────────────────────────────────────────────────
  const levers = el('div');
  for (const spec of NODE_LEVER_SPEC) {
    const v = lev[spec.key];
    const onChange = (val) => { draft[spec.key] = val; paintReadout(); setNodeLever(id, spec.key, val); };

    if (spec.kind === 'slider') {
      levers.appendChild(slider({
        label: spec.label, value: v, min: spec.min, max: spec.max, step: spec.step,
        unit: spec.pct ? '' : spec.unit, pct: spec.pct,
        digits: spec.step < 0.01 ? 1 : spec.step < 1 ? 1 : 0,
        sub: spec.key.includes('BufferDays')
          ? (val) => {
              const tmp = { ...draft, [spec.key]: val };
              return dualQty(spec.key === 'inputBufferDays'
                ? inputBufferCapacity(tmp) : outputBufferCapacity(tmp));
            }
          : null,
        onInput: onChange,
      }));
    } else if (spec.kind === 'segmented') {
      levers.appendChild(segmented({
        label: spec.label, value: v,
        options: spec.options.map((o) => ({ value: o, label: `${o}` })),
        onChange,
      }));
    } else if (spec.kind === 'number') {
      levers.appendChild(numberField({
        label: spec.label, unit: spec.unit, value: v,
        min: spec.min, max: spec.max, step: spec.step,
        sub: (val) => `유효 ${fmtNum(effectiveDailyOutput({ ...draft, [spec.key]: val }), 2)} MWh/day`,
        onInput: onChange,
      }));
    }
  }
  box.appendChild(section('LEVERS', levers,
    el('button', { class: 'btn', text: '↺ Reset', onclick: () => resetNode(id) })));

  // ── 재고 sparkline ────────────────────────────────────────────────────
  const spark = el('div');
  if (n.type !== 'CELL') {
    spark.appendChild(el('div', { class: 'ctrl-sub', text: `입고 ${qty(p.inputBufferSeries[day])} / ${fmtNum(p.inputCapacity, 1)} MWh` }));
    spark.appendChild(sparkline(p.inputBufferSeries, {
      max: p.inputCapacity, color: 'var(--accent)', marker: day, threshold: p.inputCapacity * 0.1,
    }));
  } else {
    spark.appendChild(el('div', { class: 'ctrl-sub', text: 'UPSTREAM: UNCONSTRAINED (§9-1)' }));
  }
  spark.appendChild(el('div', { class: 'ctrl-sub', style: { marginTop: '6px' }, text: `출고 ${qty(p.outputBufferSeries[day])} / ${fmtNum(p.outputCapacity, 1)} MWh` }));
  spark.appendChild(sparkline(p.outputBufferSeries, {
    max: p.outputCapacity, color: 'var(--cyan)', marker: day, threshold: p.outputCapacity * 0.9,
  }));
  box.appendChild(section('INVENTORY', spark));

  // ── 누적 ──────────────────────────────────────────────────────────────
  box.appendChild(section('CUMULATIVE', kv([
    ['BLOCKED', `${p.blockedDays} d`],
    ['STARVED', `${p.starvedDays} d`],
    ['DOWN', `${p.downDays} d`],
    ['LOST OUTPUT', qty(p.lostOutputMWh)],
    ['가동률', `${fmtNum(p.utilizationPct, 1)}%`],
    ['유휴 비용', usd(p.idleCostUSD)],
    ['TTS', state.result.tts?.[id] == null ? '> horizon' : `${state.result.tts[id]} d`],
  ]), watchBtn('node', id)));

  return box;
}

/**
 * OPERATE 모드 최단 적용 가능일 경고 (§1.5.2).
 * UI 가 임의로 거는 락이 아니라, 계획 시스템이 물리적으로 거는 락이다.
 */
function operateNotice(state, nodeId) {
  const n = state.lastApplyNotice;
  const box = el('div', { style: { padding: '0 10px' } });
  const { infoLagDays, replanCycleDays, frozenWindowDays } = state.config.planning;
  const day = state.playhead;
  const perceived = day + infoLagDays;
  const replanDay = Math.ceil(perceived / Math.max(1, replanCycleDays)) * Math.max(1, replanCycleDays);
  const effective = replanDay + frozenWindowDays;

  if (infoLagDays === 0 && frozenWindowDays === 0) {
    box.appendChild(callout(
      `<b>즉시 적용</b>  D+${String(day).padStart(3, '0')}\n계획 지연 파라미터가 0 이라 조정이 바로 발효됩니다.`, 'ok'));
    return box;
  }

  // 지금 조정해도 늦는가? 플레이헤드 이후 첫 이상 상태를 찾는다.
  let firstTrouble = null;
  for (const node of NODES) {
    const tl = state.result.perNode[node.id].stateTimeline;
    for (let d = day; d < tl.length; d++) {
      if (tl[d] === 'STARVED' || tl[d] === 'BLOCKED' || tl[d] === 'DOWN') {
        if (firstTrouble === null || d < firstTrouble.day) firstTrouble = { day: d, id: node.id, state: tl[d] };
        break;
      }
    }
  }

  const lines = [
    `현재 D+${String(day).padStart(3, '0')} · ${nodeId} 조정 시도`,
    `  ├─ 정보 지연        ${String(infoLagDays).padStart(2)}일  →  D+${String(perceived).padStart(3, '0')}`,
    `  ├─ 다음 replan 경계       →  D+${String(replanDay).padStart(3, '0')}`,
    `  ├─ frozen window   ${String(frozenWindowDays).padStart(2)}일  →  D+${String(effective).padStart(3, '0')}`,
    `  └─ <b>▲ 최단 적용 가능일   D+${String(effective).padStart(3, '0')}</b>`,
  ];
  let kind = 'warn';
  if (firstTrouble && firstTrouble.day < effective) {
    lines.push(`     그러나 ${firstTrouble.id} ${firstTrouble.state} 시작은 D+${String(firstTrouble.day).padStart(3, '0')} — 이미 늦음`);
    kind = 'danger';
  }
  box.appendChild(callout(lines.join('\n'), kind));
  if (n && n.nodeId === nodeId) {
    box.appendChild(el('div', { class: 'tiny muted', style: { padding: '4px 0' },
      text: `Action 큐에 등록됨 · ${state.config.actions.length}건` }));
  }
  return box;
}

// ═══════════════════════════════════════════════════════════════════════
// LANE INSPECTOR (§1.5.3 — 트럭은 엔티티가 아니다. 구간이 엔티티다.)
// ═══════════════════════════════════════════════════════════════════════
function laneInspector(state, laneId) {
  const lane = LANE_INDEX[laneId];
  const lc = state.config.lanes[laneId];
  const pl = state.result.perLane[laneId];
  const t = LANE_TYPES[lane.laneType];
  const day = state.playhead;

  const box = el('div');
  box.appendChild(head(laneId, `${t.label} · ${lane.role}`, badge(t.unit, 'info')));

  const inflight = state.result.shipments.filter(
    (s) => s.laneId === laneId && s.departDay <= day && s.arriveDay > day);

  box.appendChild(section('LANE', kv([
    ['거리', fmtMiles(pl.miles) + (isOverriddenDistance(lane.from, lane.to) ? '  ⚠' : '')],
    ['기준 리드타임', `T+${pl.baseTransitDays} d`],
    ['실적 평균', `${fmtNum(pl.avgTransitDays, 2)} d`],
    ['이동 중', `${qty(inflight.reduce((a, b) => a + b.qtyMWh, 0))} · ${inflight.length}건`],
    ['누적 출하', qty(pl.shippedMWh)],
    ['트럭 대수', `${pl.trucks}`],
    ['운임 누계', usd(pl.freightUSD)],
    ['특송 추가', usd(pl.expediteUSD)],
  ])));
  if (isOverriddenDistance(lane.from, lane.to)) {
    box.appendChild(el('div', { style: { padding: '0 10px' } },
      callout('⚠ 이 구간 거리는 LGES 물류 슬라이드 값이며 실도로거리와 어긋날 수 있습니다 (§9-3).', 'warn')));
  }

  // ── 적재 / 출하 레버 ──────────────────────────────────────────────────
  const levers = el('div');
  levers.appendChild(slider({
    label: `트럭 적재단위 (${t.unit})`, value: lc.truckLoad,
    min: t.min, max: t.max, step: t.step, digits: 0,
    sub: (v) => loadQty(v, t.unitMWh, t.unit),
    onInput: (v) => setLaneLever(laneId, 'truckLoad', v),
  }));
  levers.appendChild(segmented({
    label: '출하 빈도', value: lc.frequency,
    options: [{ value: 'daily', label: 'DAILY' }, { value: 'weekly', label: 'WEEKLY' }],
    onChange: (v) => setLaneLever(laneId, 'frequency', v),
  }));
  levers.appendChild(slider({
    label: '최소 적재율', value: lc.minLoadPct, min: 0.1, max: 1, step: 0.05, pct: true, digits: 0,
    sub: () => '이 미만이면 대기 → 계단식 증폭(bullwhip)의 발원지',
    onInput: (v) => setLaneLever(laneId, 'minLoadPct', v),
  }));
  levers.appendChild(slider({
    label: '대기 상한', value: lc.forceShipAfterDays, min: 0, max: 14, step: 1, unit: 'day', digits: 0,
    onInput: (v) => setLaneLever(laneId, 'forceShipAfterDays', v),
  }));
  levers.appendChild(slider({
    label: '주행 속도', value: lc.milesPerDay, min: 400, max: 700, step: 10, unit: 'mi/day', digits: 0,
    sub: (v) => `리드타임 ${Math.ceil(pl.miles / v) + lc.loadUnloadDays} d`,
    onInput: (v) => setLaneLever(laneId, 'milesPerDay', v),
  }));
  levers.appendChild(slider({
    label: '상하차', value: lc.loadUnloadDays, min: 0, max: 3, step: 1, unit: 'day', digits: 0,
    onInput: (v) => setLaneLever(laneId, 'loadUnloadDays', v),
  }));
  levers.appendChild(checkbox({
    label: '특송 허용', value: lc.expediteEnabled,
    onChange: (v) => setLaneLever(laneId, 'expediteEnabled', v),
  }));
  levers.appendChild(slider({
    label: '특송 리드타임 배수', value: lc.expediteSpeedup, min: 0.2, max: 1, step: 0.05, digits: 2,
    onInput: (v) => setLaneLever(laneId, 'expediteSpeedup', v),
  }));
  levers.appendChild(slider({
    label: '특송 비용 배수', value: lc.expediteCostMultiplier, min: 1, max: 6, step: 0.1, digits: 1, unit: '×',
    onInput: (v) => setLaneLever(laneId, 'expediteCostMultiplier', v),
  }));
  box.appendChild(section('LOAD & DISPATCH', levers));

  box.appendChild(section('ACTION', el('div', { class: 'btn-row' },
    button('⚡ 이 구간 특송 (14일)', () => pushSimAction({
      type: 'expediteLane', laneId, startDay: state.playhead, durationDays: 14,
    }), 'primary'))));

  box.appendChild(section('IN-TRANSIT', sparkline(pl.inTransitMWhSeries, {
    marker: day, color: 'var(--cyan)',
  })));
  return box;
}

// ═══════════════════════════════════════════════════════════════════════
// HUB INSPECTOR
// ═══════════════════════════════════════════════════════════════════════
function hubInspector(state) {
  const box = el('div');
  box.appendChild(head(HUB.id, `${HUB.name} · ${HUB.place}`, badge('CROSS-DOCK', 'info')));
  box.appendChild(el('div', { style: { padding: '0 10px 8px' } },
    callout('통과 환적입니다. 생산 능력도 보관 기능도 없습니다.\n경유 시 dwell 일수만 리드타임에 가산되고 화물은 그대로 통과합니다.\n환적 중 물량은 in-transit 재고로 계상됩니다 (§9-2).', 'ok')));

  const levers = el('div');
  levers.appendChild(slider({
    label: 'Dwell days', value: state.config.hubDwellDays, min: 0, max: 5, step: 0.5, unit: 'day', digits: 1,
    onInput: (v) => setGlobal('hubDwellDays', v),
  }));
  levers.appendChild(checkbox({
    label: 'CHI 환적 경유 (직송 ↔ 환적)', value: state.config.routeViaHub,
    onChange: (v) => setGlobal('routeViaHub', v),
  }));
  box.appendChild(section('ROUTING', levers));

  const viaHub = state.config.routeViaHub;
  const direct = state.result.perLane['PW1->AZL'];
  box.appendChild(section('현재 라우팅', kv([
    ['모드', viaHub ? 'PW → CHI → AZL (환적)' : 'PW → AZL (직송)'],
    ['PW1 리드타임', `T+${direct.baseTransitDays} d`],
    ['환적 취급비', usd(state.config.cost.hubHandlingPerTruck, { compact: false }) + ' / 트럭'],
    ['누적 환적비', usd(state.result.system.hubHandlingUSD)],
  ])));
  return box;
}

// ═══════════════════════════════════════════════════════════════════════
// CUSTOMER INSPECTOR
// ═══════════════════════════════════════════════════════════════════════
function customerInspector(state, sel) {
  const id = sel.type === 'order'
    ? state.result.orders.find((o) => o.id === sel.id)?.customerId
    : sel.id;
  const c = CUSTOMERS.find((x) => x.id === id);
  if (!c) return el('div');
  const cc = state.config.customers[id];
  const pc = state.result.perCustomer[id];

  const box = el('div');
  box.appendChild(head(id, `${c.name} · ${c.state}`, badge(`TIER ${cc.priorityTier}`, 'info')));

  box.appendChild(section('DELIVERY', kv([
    ['월 인도량', `${cc.monthlyLinks} Link`],
    ['인도일', `매월 ${cc.deliveryDayOfMonth}일`],
    ['누적 주문', qty(pc.orderedMWh)],
    ['누적 인도', qty(pc.deliveredMWh)],
    ['지연 PO', `${pc.lateOrders} / ${pc.orders.length}`],
    ['LD 누계', usd(pc.penaltyUSD)],
  ]), watchBtn('customer', id)));

  const levers = el('div');
  levers.appendChild(slider({
    label: '월 인도량', value: cc.monthlyLinks, min: 1, max: 30, step: 1, unit: 'Link', digits: 0,
    sub: (v) => `${fmtNum(v * UNITS.linkMWh, 1)} MWh/월`,
    onInput: (v) => setCustomerLever(id, 'monthlyLinks', v),
  }));
  levers.appendChild(slider({
    label: '인도일', value: cc.deliveryDayOfMonth, min: 1, max: 28, step: 1, unit: '일', digits: 0,
    onInput: (v) => setCustomerLever(id, 'deliveryDayOfMonth', v),
  }));
  levers.appendChild(segmented({
    label: '우선순위 등급', value: cc.priorityTier,
    options: [{ value: 1, label: 'TIER 1' }, { value: 2, label: 'TIER 2' }, { value: 3, label: 'TIER 3' }],
    onChange: (v) => setCustomerLever(id, 'priorityTier', v),
  }));
  box.appendChild(section('DEMAND', levers));

  const ld = el('div');
  ld.appendChild(numberField({
    label: '계약가', unit: 'USD/MWh', value: cc.contractValuePerMWh, min: 0, step: 10000,
    sub: (v) => `PO 1건 노출액 ≈ ${usd(v * cc.monthlyLinks * UNITS.linkMWh)}`,
    onInput: (v) => setCustomerLever(id, 'contractValuePerMWh', v),
  }));
  ld.appendChild(slider({
    label: 'LD 일률', value: cc.ldRatePerDay, min: 0, max: 0.01, step: 0.0005, pct: true, digits: 2,
    onInput: (v) => setCustomerLever(id, 'ldRatePerDay', v),
  }));
  ld.appendChild(slider({
    label: 'LD 상한', value: cc.ldCapPct, min: 0, max: 0.3, step: 0.01, pct: true, digits: 0,
    onInput: (v) => setCustomerLever(id, 'ldCapPct', v),
  }));
  ld.appendChild(slider({
    label: '유예일', value: cc.graceDays, min: 0, max: 14, step: 1, unit: 'day', digits: 0,
    onInput: (v) => setCustomerLever(id, 'graceDays', v),
  }));
  box.appendChild(section('LIQUIDATED DAMAGES', ld));

  const table = el('table', { class: 'grid' });
  table.appendChild(el('thead', {}, el('tr', {},
    el('th', { text: 'PO' }), el('th', { text: '납기' }), el('th', { text: '인도' }),
    el('th', { text: 'LD', style: { textAlign: 'right' } }))));
  const tb = el('tbody');
  for (const o of pc.orders) {
    const late = o.status === 'LATE' || o.status === 'UNDELIVERED';
    tb.appendChild(el('tr', {
      class: late ? 'late' : '',
      'aria-selected': String(sel.type === 'order' && sel.id === o.id),
      onclick: () => setSelection({ type: 'order', id: o.id }),
    },
      el('td', { class: 'mono tiny', text: o.id }),
      el('td', { class: 'n tiny', text: `D+${o.dueDay}` }),
      el('td', { class: 'n tiny', text: o.deliveredDay != null ? `D+${o.deliveredDay}` : '—' }),
      el('td', { class: 'n tiny', text: o.penaltyUSD > 0 ? usd(o.penaltyUSD) : '—' })));
  }
  table.appendChild(tb);
  box.appendChild(section('PURCHASE ORDERS', table));
  return box;
}
