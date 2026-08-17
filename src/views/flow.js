// ═══════════════════════════════════════════════════════════════════════════
// src/views/flow.js — FLOW VIEW (공정 스키매틱) §4.2
//
// 지리를 완전히 버린 좌→우 흐름도. 실무자용 주력 화면.
// 이 뷰의 핵심은 버퍼 게이지다 — 출고 100% = BLOCKED, 입고 0% = STARVED 가
// 한눈에 보이고, 레인 사이 여백의 점이 '지도에서 안 보이는 파이프라인 재고'다.
// ═══════════════════════════════════════════════════════════════════════════

import { NODES, CUSTOMERS, CELL_IDS, PACK_IDS } from '../data.js';
import { svg, clear, showTip, moveTip, hideTip } from '../components.js';
import { qty, fmtNum, usd, STATUS_COLOR, nodeHealth } from '../units.js';
import { appState, setSelection } from '../store.js';
import { effectiveDailyOutput } from '../sim.js';

let root = null;
let refs = null;
let dims = { w: 900, h: 560 };

const CARD = { w: 128, h: 44 };
const COLS = ['RAW MATERIAL', 'CELL', 'PACK', 'TRANSIT', 'LINK', 'CUSTOMERS'];
const RAW_W = 92; // 원자재 공급 열 — 카드보다 좁게 둬서 '범위 밖'임을 형태로 드러낸다

export function mount(container) {
  root = container;
  window.addEventListener('resize', () => {
    if (appState.view === 'FLOW') render(appState);
  });
}

export function render(state) {
  if (!root || !state.result) return;
  const rect = root.getBoundingClientRect();
  dims = { w: Math.max(560, rect.width), h: Math.max(320, rect.height) };
  clear(root);

  const s = svg('svg', { width: dims.w, height: dims.h, viewBox: `0 0 ${dims.w} ${dims.h}` });
  refs = { cards: {}, bands: {}, transit: null, customers: {}, transitBox: null };

  const marginX = 24;
  const usable = dims.w - marginX * 2;
  // 열 x 좌표 — TRANSIT 열이 파이프라인 재고를 담는 넓은 여백이다
  const colW = [RAW_W, CARD.w, CARD.w, Math.max(140, usable * 0.20), CARD.w, Math.max(140, usable * 0.20)];
  const gap = Math.max(14, (usable - colW.reduce((a, b) => a + b, 0)) / (colW.length - 1));
  const colX = [];
  let cx = marginX;
  for (const w of colW) { colX.push(cx); cx += w + gap; }

  // 열 헤더
  COLS.forEach((c, i) => {
    // CUSTOMERS 열 머리글은 '고객 전체'로 들어가는 입구다 — 개별 행은 그 고객
    // 한 곳을, 머리글은 12곳 전부와 PO 48건을 연다.
    if (c === 'CUSTOMERS') {
      const hdr = svg('g', { class: 'node-hit col-head-link' });
      hdr.appendChild(svg('text', {
        x: colX[i], y: 20, class: 'svg-sect', fill: 'var(--accent)', text: `${c} ▸`,
      }));
      hdr.addEventListener('click', () => setSelection({ type: 'customerGroup' }));
      hdr.addEventListener('mouseenter', (e) => showTip(e, '고객 12곳 · PO 48건 전체 열기'));
      hdr.addEventListener('mousemove', moveTip);
      hdr.addEventListener('mouseleave', hideTip);
      s.appendChild(hdr);
      return;
    }
    s.appendChild(svg('text', { x: colX[i], y: 20, class: 'svg-sect', text: c }));
  });

  const top = 40;
  const cellGap = Math.min(58, (dims.h - top - 100) / CELL_IDS.length);
  const yOfCell = (i) => top + 10 + i * cellGap;
  const packBase = top + 10 + (cellGap * CELL_IDS.length - CARD.h) / 2 - 40;
  const yOfPack = (i) => packBase + i * 78;
  const yLink = top + 10 + (cellGap * CELL_IDS.length - CARD.h) / 2;

  const pos = {};
  CELL_IDS.forEach((id, i) => (pos[id] = [colX[1], yOfCell(i)]));
  PACK_IDS.forEach((id, i) => (pos[id] = [colX[2], yOfPack(i)]));
  pos.AZL = [colX[4], yLink];

  // ── 흐름 밴드 (굵기 = MWh/day) ───────────────────────────────────────
  const bandLayer = svg('g', { opacity: 0.5 });
  s.appendChild(bandLayer);

  // 원자재 → Cell. 무한 공급 가정이라 물량 데이터가 없으므로 굵기를 계산하지
  // 않고 고정 점선으로 둔다 — 실제 흐름 밴드와 형태로 구분되어야 한다.
  const rawLayer = svg('g');
  s.appendChild(rawLayer);
  for (const cid of CELL_IDS) {
    const [cxCell, cyCell] = pos[cid];
    rawLayer.appendChild(svg('line', {
      x1: colX[0] + RAW_W, y1: yOfCell(CELL_IDS.indexOf(cid)) + CARD.h / 2,
      x2: cxCell, y2: cyCell + CARD.h / 2,
      stroke: 'var(--border-strong)', 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0.7,
    }));
  }

  for (const cid of CELL_IDS) {
    for (const pid of PACK_IDS) {
      const lane = `${cid}->${pid}`;
      const band = svg('path', { d: '', fill: 'var(--accent-dim)', opacity: 0.55 });
      bandLayer.appendChild(band);
      refs.bands[lane] = { el: band, from: pos[cid], to: pos[pid], x0: colX[1] + CARD.w, x1: colX[2] };
    }
  }
  for (const pid of PACK_IDS) {
    const lane = `${pid}->AZL`;
    const band = svg('path', { d: '', fill: 'var(--accent-dim)', opacity: 0.55 });
    bandLayer.appendChild(band);
    refs.bands[lane] = { el: band, from: pos[pid], to: pos.AZL, x0: colX[2] + CARD.w, x1: colX[4] };
  }

  // ── 원자재 공급 (범위 밖) ────────────────────────────────────────────
  s.appendChild(rawMaterialCard(colX[0], yOfCell(0), yOfCell(CELL_IDS.length - 1) + CARD.h));

  // ── TRANSIT 열: 이동 중 화물 점 ──────────────────────────────────────
  const tx = colX[3];
  const tw = colW[3];
  s.appendChild(svg('rect', {
    x: tx - 6, y: top, width: tw + 12, height: dims.h - top - 60,
    fill: 'none', stroke: 'var(--border)', 'stroke-width': 1, 'stroke-dasharray': '2 4',
  }));
  refs.transitBox = { x: tx, w: tw, y: top + 12, h: dims.h - top - 90 };
  refs.transit = svg('g');
  s.appendChild(refs.transit);
  refs.transitLabel = svg('text', {
    x: tx + tw / 2, y: dims.h - 52, 'text-anchor': 'middle', class: 'svg-caption', text: '',
  });
  s.appendChild(refs.transitLabel);

  // ── 노드 카드 ────────────────────────────────────────────────────────
  for (const n of NODES) {
    const [x, y] = pos[n.id];
    s.appendChild(nodeCard(n, x, y, state));
  }

  // ── 고객 열 ──────────────────────────────────────────────────────────
  s.appendChild(customerColumn(colX[5], colW[5], top + 6, state));

  // 범례는 NETWORK 에만 둔다. FLOW 는 카드마다 상태를 글자로 이미 찍고 있어
  // (stateTag: BLOCKED / STARVED) 범례가 같은 정보를 한 번 더 말하면서
  // 열 머리글 위를 가린다.
  root.appendChild(s);
  frame(state);
}

/**
 * 원자재 공급 — 양극재/음극재/분리막/전해액. 모델링 범위 밖이라 제약이 없다.
 * Cell 카드마다 'UPSTREAM: UNCONSTRAINED' 를 반복해 찍는 대신 공급원을 하나의
 * 객체로 세워, 무한 공급이 '가정'임을 흐름도의 구조로 드러낸다.
 */
function rawMaterialCard(x, yTop, yBottom) {
  const h = Math.max(CARD.h, yBottom - yTop);
  const g = svg('g');
  g.appendChild(svg('rect', {
    x, y: yTop, width: RAW_W, height: h,
    fill: 'none', stroke: 'var(--border-strong)', 'stroke-width': 1, 'stroke-dasharray': '3 3',
  }));
  const cy = yTop + h / 2;
  g.appendChild(svg('text', {
    x: x + RAW_W / 2, y: cy - 16, 'text-anchor': 'middle',
    class: 'flow-card-title', fill: 'var(--text-secondary)', text: '원자재',
  }));
  g.appendChild(svg('text', {
    x: x + RAW_W / 2, y: cy - 3, 'text-anchor': 'middle',
    class: 'svg-caption', text: '양극재 · 음극재',
  }));
  g.appendChild(svg('text', {
    x: x + RAW_W / 2, y: cy + 7, 'text-anchor': 'middle',
    class: 'svg-caption', text: '분리막 · 전해액',
  }));
  g.appendChild(svg('text', {
    x: x + RAW_W / 2, y: cy + 24, 'text-anchor': 'middle',
    class: 'svg-caption', fill: 'var(--status-idle)', text: 'UNCONSTRAINED',
  }));
  g.appendChild(svg('text', {
    x: x + RAW_W / 2, y: cy + 34, 'text-anchor': 'middle',
    class: 'svg-caption', text: '(범위 밖 · §9-1)',
  }));
  return g;
}

function nodeCard(n, x, y, state) {
  const grp = svg('g', { transform: `translate(${x},${y})`, class: 'node-hit' });
  grp.appendChild(svg('rect', {
    x: 0, y: 0, width: CARD.w, height: CARD.h,
    fill: 'var(--bg-panel)', stroke: 'var(--border-strong)', 'stroke-width': 1,
  }));
  const statusBar = svg('rect', { x: 0, y: 0, width: 4, height: CARD.h, fill: 'var(--status-ok)' });
  grp.appendChild(statusBar);
  grp.appendChild(svg('text', {
    x: 10, y: 14, class: 'flow-card-title', fill: 'var(--text-primary)', text: n.short,
  }));
  const stateTag = svg('text', {
    x: CARD.w - 8, y: 14, 'text-anchor': 'end', class: 'flow-card-sub', text: '',
  });
  grp.appendChild(stateTag);
  // 상태 글리프 — NETWORK 뷰와 같은 기호를 쓴다 (범례 공유).
  const glyph = svg('text', {
    x: CARD.w - 8, y: 26, 'text-anchor': 'end', class: 'svg-health-glyph', text: '',
  });
  grp.appendChild(glyph);
  const outLabel = svg('text', { x: 10, y: 26, class: 'flow-card-sub', text: '' });
  grp.appendChild(outLabel);

  // 입고 / 출고 게이지 — 이 뷰의 핵심. 좌측에 IN/OUT 라벨 자리를 비워 둔다.
  const GAUGE_X = 26;
  const gw = CARD.w - GAUGE_X - 10;
  const mkGauge = (yy) => {
    const bg = svg('rect', { x: GAUGE_X, y: yy, width: gw, height: 5, fill: 'var(--bg-app)', stroke: 'var(--border)', 'stroke-width': 1 });
    const fg = svg('rect', { x: GAUGE_X + 1, y: yy + 1, width: 0, height: 3, fill: 'var(--accent)' });
    grp.appendChild(bg); grp.appendChild(fg);
    return fg;
  };
  // 게이지 앞에 무엇을 재는 선인지 적는다 — 두 줄이 무엇인지 모르면
  // 이 뷰의 핵심(출고 100% = BLOCKED, 입고 0% = STARVED)이 읽히지 않는다.
  const gaugeTag = (yy, text) => svg('text', {
    x: 4, y: yy + 4.5, class: 'flow-gauge-tag', text,
  });
  const inBar = mkGauge(31);
  const outBar = mkGauge(38);
  grp.appendChild(gaugeTag(31, 'IN'));
  grp.appendChild(gaugeTag(38, 'OUT'));

  grp.addEventListener('mouseenter', (e) => showTip(e, cardTip(n.id)));
  grp.addEventListener('mousemove', moveTip);
  grp.addEventListener('mouseleave', hideTip);
  grp.addEventListener('click', () => setSelection({ type: 'node', id: n.id }));

  refs.cards[n.id] = { grp, statusBar, outLabel, inBar, outBar, stateTag, glyph, gw };
  return grp;
}

function cardTip(id) {
  const p = appState.result.perNode[id];
  const day = appState.playhead;
  const lev = appState.config.nodes[id];
  return [
    `<b>${id}</b>  ${p.stateTimeline[day]}`,
    `유효 일산출  ${fmtNum(effectiveDailyOutput(lev), 2)} MWh/day`,
    `입고  ${fmtNum(p.inputBufferSeries[day], 1)} / ${fmtNum(p.inputCapacity, 1)} MWh`,
    `출고  ${fmtNum(p.outputBufferSeries[day], 1)} / ${fmtNum(p.outputCapacity, 1)} MWh`,
    `가동률 ${fmtNum(p.utilizationPct, 1)}%  ·  LOST ${fmtNum(p.lostOutputMWh, 1)} MWh`,
  ].join('\n');
}

function customerColumn(x, w, y0, state) {
  const g = svg('g');
  // 열 테두리 자체도 '고객 전체' 입구다. 행 사이 여백을 눌러도 열리게 해서
  // 머리글만 정확히 찍어야 하는 상황을 만들지 않는다.
  const groupSelected = state.selection?.type === 'customerGroup';
  const frame = svg('rect', {
    x, y: y0, width: w, height: dims.h - y0 - 60,
    fill: 'var(--bg-panel)',
    stroke: groupSelected ? 'var(--accent)' : 'var(--border-strong)',
    'stroke-width': groupSelected ? 1.5 : 1,
    class: 'node-hit',
  });
  frame.addEventListener('click', () => setSelection({ type: 'customerGroup' }));
  g.appendChild(frame);
  const rowH = Math.min(21, (dims.h - y0 - 76) / CUSTOMERS.length);
  CUSTOMERS.forEach((c, i) => {
    const yy = y0 + 6 + i * rowH;
    const row = svg('g', { class: 'node-hit' });
    const bg = svg('rect', { x: x + 1, y: yy, width: w - 2, height: rowH - 1, fill: 'transparent' });
    row.appendChild(bg);
    row.appendChild(svg('text', {
      x: x + 8, y: yy + rowH * 0.72, class: 'svg-label', fill: 'var(--text-secondary)',
      text: `${c.id.replace(/_/g, ' ')}`,
    }));
    const marker = svg('text', {
      x: x + w - 8, y: yy + rowH * 0.72, 'text-anchor': 'end', class: 'svg-label',
      fill: 'var(--status-crit)', text: '',
    });
    row.appendChild(marker);
    row.addEventListener('mouseenter', (e) => showTip(e, custTip(c.id)));
    row.addEventListener('mousemove', moveTip);
    row.addEventListener('mouseleave', hideTip);
    row.addEventListener('click', () => setSelection({ type: 'customer', id: c.id }));
    g.appendChild(row);
    refs.customers[c.id] = { bg, marker, row };
  });
  return g;
}

function custTip(id) {
  const pc = appState.result.perCustomer[id];
  const next = pc.orders.find((o) => o.deliveredMWh < o.qtyMWh - 1e-9) || pc.orders[pc.orders.length - 1];
  return [
    `<b>${id}</b>`,
    next ? `다음 PO   ${next.id}  DUE D+${next.dueDay}` : '',
    next ? `진척      ${fmtNum((next.deliveredMWh / next.qtyMWh) * 100, 0)}%` : '',
    `LD 누계   ${usd(pc.penaltyUSD)}`,
  ].filter(Boolean).join('\n');
}

/** 밴드(refs.bands 의 키는 '${from}->${to}' 형태 lane id)로 직접 이어진 상대 노드 id 집합. */
function connectedNodeIds(nodeId) {
  const out = new Set();
  for (const laneId of Object.keys(refs.bands)) {
    const [from, to] = laneId.split('->');
    if (from === nodeId) out.add(to);
    else if (to === nodeId) out.add(from);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
export function frame(state) {
  if (!refs || !state.result) return;
  const day = state.playhead;
  const r = state.result;
  const sel = state.selection;
  // 선택된 노드와 직접 연결된(밴드로 이어진) 노드 id 집합 — 선택 노드는
  // 최대 밝기, 연결 노드 · 밴드는 중간 밝기, 무관한 것들만 어둡게 뺀다.
  const connected = sel && sel.type === 'node' ? connectedNodeIds(sel.id) : null;

  for (const n of NODES) {
    const ref = refs.cards[n.id];
    if (!ref) continue;
    const p = r.perNode[n.id];
    const st = p.stateTimeline[day] || 'RUNNING';
    ref.outLabel.textContent = `${fmtNum(p.producedSeries[day], 2)} MWh/d`;
    ref.outLabel.setAttribute('fill', 'var(--text-muted)');

    const inF = n.type === 'CELL' ? 1 : p.inputCapacity > 0 ? p.inputBufferSeries[day] / p.inputCapacity : 0;
    const outF = p.outputCapacity > 0 ? p.outputBufferSeries[day] / p.outputCapacity : 0;
    ref.inBar.setAttribute('width', Math.max(0, inF) * (ref.gw - 2));
    ref.inBar.setAttribute('fill',
      n.type === 'CELL' ? 'var(--status-idle)' : inF < 0.05 ? 'var(--status-danger)' : 'var(--accent)');
    ref.outBar.setAttribute('width', Math.max(0, outF) * (ref.gw - 2));
    ref.outBar.setAttribute('fill', outF > 0.95 ? 'var(--status-warn)' : 'var(--cyan)');
    ref.stateTag.textContent = st === 'RUNNING' ? '' : st;
    ref.stateTag.setAttribute('fill', STATUS_COLOR[st]);
    const health = nodeHealth(st, r.tts?.[n.id]);
    ref.glyph.textContent = health.glyph;
    ref.glyph.setAttribute('fill', health.color);
    ref.statusBar.setAttribute('fill', health.color);
    // Cell 은 입고 제약이 없으므로 게이지 자체를 숨긴다
    ref.inBar.setAttribute('opacity', n.type === 'CELL' ? 0 : 1);

    const isSel = sel && sel.type === 'node' && sel.id === n.id;
    const isConnected = connected?.has(n.id);
    ref.grp.setAttribute('opacity', !sel ? 1 : isSel ? 1 : isConnected ? 0.75 : 0.3);
  }

  // 흐름 밴드 — 최근 7일 이동평균
  let maxMA = 1e-6;
  const ma = {};
  for (const id of Object.keys(refs.bands)) {
    const s = r.perLane[id]?.shippedSeries;
    if (!s) { ma[id] = 0; continue; }
    let acc = 0;
    for (let i = Math.max(0, day - 6); i <= day; i++) acc += s[i] || 0;
    ma[id] = acc / 7;
    maxMA = Math.max(maxMA, ma[id]);
  }
  for (const [id, b] of Object.entries(refs.bands)) {
    const [from, to] = id.split('->');
    const touchesSel = sel && sel.type === 'node' && (from === sel.id || to === sel.id);
    b.el.setAttribute('opacity', !sel ? 0.55 : touchesSel ? 0.9 : 0.1);

    const t = ma[id] / maxMA;
    const h = t * 12;
    if (h < 0.35) { b.el.setAttribute('d', ''); continue; }
    const y0 = b.from[1] + CARD.h / 2;
    const y1 = b.to[1] + CARD.h / 2;
    const mx = (b.x0 + b.x1) / 2;
    b.el.setAttribute('d',
      `M${b.x0},${y0 - h / 2}C${mx},${y0 - h / 2} ${mx},${y1 - h / 2} ${b.x1},${y1 - h / 2}` +
      `L${b.x1},${y1 + h / 2}C${mx},${y1 + h / 2} ${mx},${y0 + h / 2} ${b.x0},${y0 + h / 2}Z`);
  }

  // 파이프라인 재고 — 이동 중 화물을 점으로
  clear(refs.transit);
  const box = refs.transitBox;
  const inflight = r.shipments.filter((s) => s.departDay <= day && s.arriveDay > day);
  let totalIT = 0;
  for (const s of inflight) totalIT += s.qtyMWh;
  const shown = inflight.slice(0, 160);
  shown.forEach((s, i) => {
    const t = Math.max(0, Math.min(1, (day - s.departDay) / Math.max(1, s.transitDays)));
    const rowSeed = (i * 37) % 100;
    refs.transit.appendChild(svg('circle', {
      cx: box.x + t * box.w,
      cy: box.y + (rowSeed / 100) * box.h,
      r: s.expedited ? 2.4 : 1.7,
      fill: s.expedited ? 'var(--status-warn)' : 'var(--cyan)',
      opacity: 0.85,
    }));
  });
  refs.transitLabel.textContent =
    `IN-TRANSIT ${qty(totalIT)} · ${inflight.length} SHIPMENTS  (파이프라인 재고)`;

  // 고객 행 — 납기 임박순 정렬은 표시 순서로, 지연은 danger 톤 + ▲
  for (const c of CUSTOMERS) {
    const ref = refs.customers[c.id];
    if (!ref) continue;
    const grace = state.config.customers[c.id].graceDays;
    const late = r.perCustomer[c.id].orders.some(
      (o) => o.dueDay + grace < day && o.deliveredMWh < o.qtyMWh - 1e-9
    );
    ref.marker.textContent = late ? '▲' : '';
    ref.bg.setAttribute('fill', late ? 'rgba(205,66,70,0.14)' : 'transparent');
  }
}
