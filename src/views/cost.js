// ═══════════════════════════════════════════════════════════════════════════
// src/views/cost.js — COST VIEW (원가 워터폴) §4.3
//
// 기준 물류비 ─▶ Blocking 유휴 ─▶ Starving 유휴 ─▶ 초과보관 ─▶ 특송 ─▶ LD ─▶ 총액
// 막대를 클릭하면 그 원가를 발생시킨 노드 / 구간 / PO 목록으로 드릴다운한다.
// 반사실 토글 시 두 워터폴을 나란히 놓고 절감액을 표시한다.
// ═══════════════════════════════════════════════════════════════════════════

import { NODES, LANES } from '../data.js';
import { COST_BUCKETS, waterfallSteps } from '../cost.js';
import { svg, clear, el, showTip, moveTip, hideTip } from '../components.js';
import { usd, fmtNum } from '../units.js';
import { appState, setSelection } from '../store.js';

let root = null;
let selectedBucket = null;

export function mount(container) {
  root = container;
  window.addEventListener('resize', () => {
    if (appState.view === 'COST') render(appState);
  });
}

export function render(state) {
  if (!root || !state.result) return;
  clear(root);
  const wrap = el('div', {
    style: { position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  });

  const cf = state.showCounterfactual ? state.counterfactual : null;
  const chartH = cf ? 250 : 300;

  wrap.appendChild(header(state, cf));
  wrap.appendChild(chartArea(state, cf, chartH));
  wrap.appendChild(drilldown(state));
  root.appendChild(wrap);
}

function header(state, cf) {
  const total = state.result.system.totalCostUSD;
  const h = el('div', {
    style: { padding: '10px 14px', borderBottom: '1px solid var(--border)', flex: 'none' },
  });
  h.appendChild(el('div', { class: 'section-label', style: { padding: 0 } },
    el('span', { text: 'COST BREAKDOWN · 120 DAY HORIZON' })));
  const row = el('div', { class: 'spread', style: { marginTop: '4px' } });
  row.appendChild(el('div', {},
    el('div', { class: 'kpi-value big mono', text: usd(total, { compact: false }) }),
    el('div', { class: 'kpi-sub', text: `${fmtNum(total / state.result.system.deliveredMWh, 0)} USD / MWh 인도` })));
  if (cf) {
    const saving = total - cf.system.totalCostUSD;
    const g = el('div', { class: 'cf-grid', style: { minWidth: '340px' } });
    g.appendChild(el('div', { class: 'cf-cell' },
      el('div', { class: 'k', text: '현재' }), el('div', { class: 'v', text: usd(total) })));
    g.appendChild(el('div', { class: 'cf-cell' },
      el('div', { class: 'k', text: '즉시대응' }), el('div', { class: 'v', text: usd(cf.system.totalCostUSD) })));
    g.appendChild(el('div', { class: 'cf-cell saving' },
      el('div', { class: 'k', text: '절감' }), el('div', { class: 'v', text: usd(saving) })));
    row.appendChild(g);
  }
  h.appendChild(row);
  return h;
}

function chartArea(state, cf, chartH) {
  const box = el('div', { style: { flex: 'none', padding: '8px 14px' } });
  const w = Math.max(420, root.getBoundingClientRect().width - 28);
  if (!cf) {
    box.appendChild(waterfall(state.result, w, chartH, '현재 시나리오', true));
  } else {
    const half = (w - 16) / 2;
    const row = el('div', { style: { display: 'flex', gap: '16px' } });
    row.appendChild(waterfall(state.result, half, chartH, '현재 (정보지연 있음)', true));
    row.appendChild(waterfall(cf, half, chartH, '반사실 (정보지연 0 · frozen 0)', false));
    box.appendChild(row);
  }
  return box;
}

function waterfall(result, w, h, title, interactive) {
  const steps = waterfallSteps(result.system.costBreakdown);
  const max = Math.max(...steps.map((s) => s.end), 1);
  const padT = 26;
  const padB = 40;
  const barW = Math.max(18, (w - 24) / steps.length - 12);
  const gap = (w - 24 - barW * steps.length) / Math.max(1, steps.length - 1);
  const y = (v) => padT + (1 - v / max) * (h - padT - padB);

  const s = svg('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}` });
  s.appendChild(svg('text', { x: 0, y: 10, class: 'svg-sect', text: title }));
  s.appendChild(svg('line', {
    x1: 0, x2: w, y1: h - padB, y2: h - padB, stroke: 'var(--border-strong)', 'stroke-width': 1,
  }));

  steps.forEach((st, i) => {
    const x = 12 + i * (barW + gap);
    const isTotal = st.sign === 'total';
    const top = y(Math.max(st.start, st.end));
    const bot = y(Math.min(st.start, st.end));
    const color = isTotal ? 'var(--accent)' : st.sign === 'base' ? 'var(--status-idle)' : bucketColor(st.id);

    const bar = svg('rect', {
      x, y: top, width: barW, height: Math.max(1, bot - top),
      fill: color, opacity: selectedBucket === st.id ? 1 : 0.82,
      stroke: selectedBucket === st.id ? 'var(--text-primary)' : 'none', 'stroke-width': 1,
      style: interactive ? 'cursor:pointer' : '',
    });
    if (interactive) {
      bar.addEventListener('click', () => {
        selectedBucket = selectedBucket === st.id ? null : st.id;
        render(appState);
      });
      bar.addEventListener('mouseenter', (e) =>
        showTip(e, `<b>${st.label}</b>\n${usd(st.value, { compact: false })}\n${((st.value / max) * 100).toFixed(1)}% of total`));
      bar.addEventListener('mousemove', moveTip);
      bar.addEventListener('mouseleave', hideTip);
    }
    s.appendChild(bar);

    // 연결선
    if (i > 0 && !isTotal) {
      s.appendChild(svg('line', {
        x1: x - gap, x2: x, y1: y(st.start), y2: y(st.start),
        stroke: 'var(--border-strong)', 'stroke-width': 1, 'stroke-dasharray': '2 2',
      }));
    }
    s.appendChild(svg('text', {
      x: x + barW / 2, y: top - 4, 'text-anchor': 'middle', class: 'svg-caption',
      fill: 'var(--text-primary)', text: usd(st.value),
    }));
    // 라벨은 2줄로 접어 겹침을 피한다
    const words = st.en.split(' ');
    words.forEach((word, k) => {
      s.appendChild(svg('text', {
        x: x + barW / 2, y: h - padB + 12 + k * 9, 'text-anchor': 'middle',
        class: 'svg-caption', text: word,
      }));
    });
  });
  return s;
}

function bucketColor(id) {
  return {
    baseFreight: 'var(--status-idle)',
    blockingIdle: 'var(--status-warn)',
    starvingIdle: 'var(--status-danger)',
    excessStorage: 'var(--cyan)',
    expedite: 'var(--accent)',
    ldPenalty: 'var(--status-crit)',
  }[id] || 'var(--text-muted)';
}

// ── 드릴다운 ────────────────────────────────────────────────────────────
function drilldown(state) {
  const box = el('div', { style: { flex: '1', overflow: 'auto', borderTop: '1px solid var(--border)', minHeight: '0' } });
  if (!selectedBucket) {
    box.appendChild(el('div', { class: 'empty-state', text: '막대를 클릭하면 그 원가를 만든 노드 · 구간 · PO 로 내려갑니다.' }));
    return box;
  }
  const bucket = COST_BUCKETS.find((b) => b.id === selectedBucket);
  const head = el('div', { class: 'section-label' },
    el('span', { text: `${bucket.en} — 원천` }),
    el('button', { class: 'btn', text: '닫기', onclick: () => { selectedBucket = null; render(appState); } }));
  box.appendChild(head);

  const rows = sourceRows(state, selectedBucket);
  const table = el('table', { class: 'grid' });
  table.appendChild(el('thead', {}, el('tr', {},
    el('th', { text: '원천' }), el('th', { text: '유형' }),
    el('th', { text: '금액', style: { textAlign: 'right' } }),
    el('th', { text: '비고', style: { textAlign: 'right' } }))));
  const tb = el('tbody');
  for (const r of rows) {
    const tr = el('tr', { onclick: () => r.sel && setSelection(r.sel) },
      el('td', { class: 'mono', text: r.id }),
      el('td', { class: 'tiny muted', text: r.kind }),
      el('td', { class: 'n', text: usd(r.value, { compact: false }) }),
      el('td', { class: 'n tiny muted', text: r.note || '' }));
    tb.appendChild(tr);
  }
  if (!rows.length) tb.appendChild(el('tr', {}, el('td', { colSpan: 4, class: 'muted tiny', text: '해당 원가 없음' })));
  table.appendChild(tb);
  box.appendChild(table);
  return box;
}

function sourceRows(state, bucket) {
  const r = state.result;
  const rows = [];
  if (bucket === 'blockingIdle' || bucket === 'starvingIdle') {
    const key = bucket === 'blockingIdle' ? 'blockingIdleUSD' : 'starvingIdleUSD';
    for (const n of NODES) {
      const p = r.perNode[n.id];
      if (p[key] > 0.5) {
        rows.push({
          id: n.id, kind: n.type, value: p[key],
          note: `${bucket === 'blockingIdle' ? p.blockedDays : p.starvedDays}d · LOST ${fmtNum(p.lostOutputMWh, 1)} MWh`,
          sel: { type: 'node', id: n.id },
        });
      }
    }
  } else if (bucket === 'baseFreight') {
    for (const l of LANES) {
      const pl = r.perLane[l.id];
      if (pl.freightUSD + pl.hubHandlingUSD > 0.5) {
        rows.push({
          id: l.id, kind: l.laneType, value: pl.freightUSD + pl.hubHandlingUSD,
          note: `${pl.trucks} 트럭 · ${fmtNum(pl.miles, 0)} mi`,
          sel: { type: 'lane', id: l.id },
        });
      }
    }
  } else if (bucket === 'expedite') {
    for (const l of LANES) {
      const pl = r.perLane[l.id];
      if (pl.expediteUSD > 0.5) {
        rows.push({ id: l.id, kind: 'lane', value: pl.expediteUSD, note: '특송', sel: { type: 'lane', id: l.id } });
      }
    }
  } else if (bucket === 'excessStorage') {
    for (const n of NODES) {
      const p = r.perNode[n.id];
      if (p.storageUSD > 0.5) {
        rows.push({ id: n.id, kind: n.type, value: p.storageUSD, note: '완제품 초과보관', sel: { type: 'node', id: n.id } });
      }
    }
  } else if (bucket === 'ldPenalty') {
    for (const o of r.orders) {
      if (o.penaltyUSD > 0.5) {
        rows.push({
          id: o.id, kind: o.customerId, value: o.penaltyUSD,
          note: `${o.lateDays}d 지연 · ${o.status}`,
          sel: { type: 'customer', id: o.customerId },
        });
      }
    }
  }
  rows.sort((a, b) => b.value - a.value);
  return rows.slice(0, 60);
}

export function frame() { /* 원가 뷰는 플레이헤드에 반응하지 않는다 (전 기간 누계) */ }
