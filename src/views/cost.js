// ═══════════════════════════════════════════════════════════════════════════
// src/views/cost.js — COST VIEW (원가 귀속) §4.3
//
// 기본 표시는 **무장애 기준선 대비 Δ** 다.
//
//   왜 절대 스택이 아닌가 — 기준 물류비는 baseline 총원가의 99.98% 를 차지하면서
//   장애가 심해질수록 오히려 *줄어든다*. 물건이 안 움직이면 트럭이 덜 뜨기
//   때문이다. 절대 워터폴에서는 이 감소가 "비용 절감"으로 읽히지만 실제로는
//   출하 실패의 증상이다. 그래서 물류비는 워터폴의 base 가 아니라 부호 있는
//   Δ 막대(미출하분)로 내리고, 절대액은 컨텍스트 수치로 뺐다.
//
// 막대를 클릭하면 그 원가를 발생시킨 노드 / 구간 / PO 목록으로 드릴다운한다.
// 반사실 토글 시 두 워터폴을 나란히 놓고 절감액을 표시한다.
// ═══════════════════════════════════════════════════════════════════════════

import { NODES, LANES } from '../data.js';
import { COST_BUCKETS } from '../cost.js';
import { svg, clear, el, showTip, moveTip, hideTip } from '../components.js';
import { usd, fmtNum } from '../units.js';
import { appState, setSelection, setCostMode } from '../store.js';

let root = null;
let selectedBucket = null;

const EPS_USD = 0.5;

export function mount(container) {
  root = container;
  window.addEventListener('resize', () => {
    if (appState.view === 'COST') render(appState);
  });
}

/** 기준선이 아직 없으면 Δ 를 만들 수 없다 — 절대 표시로 물러난다. */
function activeMode(state) {
  return state.baseline ? state.costMode : 'ABS';
}

export function render(state) {
  if (!root || !state.result) return;
  clear(root);
  const mode = activeMode(state);
  const wrap = el('div', {
    style: { position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  });

  const cf = state.showCounterfactual ? state.counterfactual : null;
  const chartH = cf ? 250 : 300;

  wrap.appendChild(header(state, cf, mode));
  wrap.appendChild(chartArea(state, cf, chartH, mode));
  wrap.appendChild(drilldown(state, mode));
  root.appendChild(wrap);
}

// ── 원가 스텝 ───────────────────────────────────────────────────────────
/**
 * 워터폴 좌표. mode='ABS' 면 절대 누적(기준 물류비에서 시작), 'DELTA' 면
 * 기준선 대비 차분을 0 에서 쌓는다. 어느 쪽이든 start→end 누적 규칙은 같다.
 */
function steps(result, baseline, mode) {
  const cur = result.system.costBreakdown;
  const base = baseline?.system?.costBreakdown;
  const out = [];
  let cursor = 0;
  for (const b of COST_BUCKETS) {
    const value = mode === 'DELTA'
      ? (cur[b.id] ?? 0) - (base?.[b.id] ?? 0)
      : (cur[b.id] ?? 0);
    const meta = mode === 'DELTA' && b.id === 'baseFreight'
      ? { label: '물류비 Δ', en: 'FREIGHT Δ', note: '미출하분' }
      : { label: b.label, en: b.en, note: null };
    out.push({ ...b, ...meta, value, start: cursor, end: cursor + value });
    cursor += value;
  }
  out.push({
    id: 'total',
    label: mode === 'DELTA' ? '장애 귀속 합계' : '총액',
    en: mode === 'DELTA' ? 'ATTRIBUTED' : 'TOTAL',
    sign: 'total', note: null,
    value: cursor, start: 0, end: cursor,
  });
  return out;
}

function attributedTotal(result, baseline) {
  return result.system.totalCostUSD - baseline.system.totalCostUSD;
}

// ── 헤더 ────────────────────────────────────────────────────────────────
function header(state, cf, mode) {
  const h = el('div', {
    style: { padding: '10px 14px', borderBottom: '1px solid var(--border)', flex: 'none' },
  });

  const toggle = el('div', { class: 'segmented' });
  for (const [id, label] of [['DELTA', 'Δ 귀속'], ['ABS', '절대값']]) {
    toggle.appendChild(el('button', {
      text: label,
      'aria-pressed': String(state.costMode === id),
      disabled: id === 'DELTA' && !state.baseline,
      onclick: () => setCostMode(id),
    }));
  }
  h.appendChild(el('div', { class: 'section-label', style: { padding: 0 } },
    el('span', { text: mode === 'DELTA' ? 'COST ATTRIBUTION · 120 DAY HORIZON' : 'COST BREAKDOWN · 120 DAY HORIZON' }),
    toggle));

  const row = el('div', { class: 'spread', style: { marginTop: '4px' } });
  row.appendChild(mode === 'DELTA' ? deltaHeadline(state) : absHeadline(state));
  if (cf) row.appendChild(counterfactualGrid(state, cf, mode));
  h.appendChild(row);

  if (mode === 'DELTA') h.appendChild(freightContext(state));
  return h;
}

function absHeadline(state) {
  const total = state.result.system.totalCostUSD;
  return el('div', {},
    el('div', { class: 'kpi-value big mono', text: usd(total, { compact: false }) }),
    el('div', { class: 'kpi-sub', text: `${fmtNum(total / state.result.system.deliveredMWh, 0)} USD / MWh 인도` }));
}

function deltaHeadline(state) {
  const d = attributedTotal(state.result, state.baseline);
  const undisrupted = Math.abs(d) < EPS_USD;
  return el('div', {},
    el('div', {
      class: 'kpi-value big mono',
      style: { color: undisrupted ? 'var(--text-muted)' : d > 0 ? 'var(--status-crit)' : 'var(--status-ok)' },
      text: undisrupted ? '$0' : usd(d, { compact: false, signed: true }),
    }),
    el('div', {
      class: 'kpi-sub',
      text: undisrupted ? '장애 없음 — 현재 시나리오가 곧 기준선' : '장애 귀속 비용 · 무장애 기준선 대비',
    }));
}

/**
 * 물류비를 워터폴 밖으로 뺀 자리. 절대액과 Δ 를 같이 보여주고, Δ 가 음수인
 * 이유(물량 감소)를 인도 MWh 당 단가로 드러낸다. 단가가 거의 안 움직이면
 * 그 Δ 는 효율 개선이 아니라 물량 손실이다.
 */
function freightContext(state) {
  const cur = state.result.system.costBreakdown.baseFreight;
  const base = state.baseline.system.costBreakdown.baseFreight;
  const d = cur - base;
  const unitCur = cur / state.result.system.deliveredMWh;
  const unitBase = base / state.baseline.system.deliveredMWh;
  const unitPct = unitBase ? (unitCur / unitBase - 1) * 100 : 0;

  const strip = el('div', {
    style: {
      display: 'flex', gap: '18px', marginTop: '8px', paddingTop: '8px',
      borderTop: '1px solid var(--border)', flexWrap: 'wrap', alignItems: 'baseline',
    },
  });
  const cell = (k, v, muted) => el('div', {},
    el('div', { class: 'tiny muted', text: k }),
    el('div', { class: 'mono', style: { color: muted ? 'var(--text-secondary)' : 'var(--text-primary)' }, text: v }));

  strip.appendChild(cell('기준 물류비 (물량 비례)', usd(cur), true));
  strip.appendChild(cell('무장애 기준선', usd(base), true));
  strip.appendChild(cell('Δ', usd(d, { signed: true }), true));
  strip.appendChild(cell('인도 MWh 당', `$${fmtNum(unitCur, 0)}  (${unitPct >= 0 ? '+' : ''}${fmtNum(unitPct, 2)}%)`, true));
  strip.appendChild(el('div', {
    class: 'tiny muted', style: { maxWidth: '340px', lineHeight: '1.4' },
    text: '단가가 거의 고정이면 물류비 Δ 는 효율이 아니라 출하하지 못한 물량이다.',
  }));
  return strip;
}

function counterfactualGrid(state, cf, mode) {
  const g = el('div', { class: 'cf-grid', style: { minWidth: '340px' } });
  const cur = mode === 'DELTA' ? attributedTotal(state.result, state.baseline) : state.result.system.totalCostUSD;
  const alt = mode === 'DELTA' ? attributedTotal(cf, state.baseline) : cf.system.totalCostUSD;
  g.appendChild(el('div', { class: 'cf-cell' },
    el('div', { class: 'k', text: '현재' }), el('div', { class: 'v', text: usd(cur, { signed: mode === 'DELTA' }) })));
  g.appendChild(el('div', { class: 'cf-cell' },
    el('div', { class: 'k', text: '즉시대응' }), el('div', { class: 'v', text: usd(alt, { signed: mode === 'DELTA' }) })));
  g.appendChild(el('div', { class: 'cf-cell saving' },
    el('div', { class: 'k', text: '절감' }), el('div', { class: 'v', text: usd(cur - alt) })));
  return g;
}

// ── 차트 ────────────────────────────────────────────────────────────────
function chartArea(state, cf, chartH, mode) {
  const box = el('div', { style: { flex: 'none', padding: '8px 14px' } });
  const w = Math.max(420, root.getBoundingClientRect().width - 28);

  if (mode === 'DELTA' && Math.abs(attributedTotal(state.result, state.baseline)) < EPS_USD) {
    box.appendChild(el('div', {
      class: 'empty-state',
      style: { height: `${chartH}px`, display: 'flex', alignItems: 'center', justifyContent: 'center' },
      text: '장애가 없어 귀속 비용이 0 입니다 — SCENARIO 패널에서 장애를 추가하거나 절대값 보기로 전환하세요.',
    }));
    return box;
  }

  if (!cf) {
    box.appendChild(waterfall(steps(state.result, state.baseline, mode), w, chartH,
      mode === 'DELTA' ? '장애 귀속 (무장애 기준선 대비)' : '현재 시나리오', true, mode));
  } else {
    const half = (w - 16) / 2;
    const row = el('div', { style: { display: 'flex', gap: '16px' } });
    // 두 워터폴은 같은 기준선을 쓰므로 축 눈금이 서로 비교 가능하다.
    row.appendChild(waterfall(steps(state.result, state.baseline, mode), half, chartH,
      '현재 (정보지연 있음)', true, mode));
    row.appendChild(waterfall(steps(cf, state.baseline, mode), half, chartH,
      '즉시 대응 시 (정보지연 0 · frozen 0)', false, mode));
    box.appendChild(row);
  }
  return box;
}

function waterfall(list, w, h, title, interactive, mode) {
  const padT = 26;
  // 반사실 나란히 보기처럼 폭이 반으로 줄면 가로 라벨이 서로 겹친다. 그때는
  // 단어를 자르는 대신 기울인다. 기울인 라벨은 첫 막대 왼쪽으로 삐져나가므로
  // 왼쪽 여백을 넓혀 잘리지 않게 한 뒤 막대 폭을 다시 잡는다.
  const layout = (insetL) => {
    const avail = w - insetL - 12;
    const barW = Math.max(18, avail / list.length - 12);
    return { insetL, barW, gap: (avail - barW * list.length) / Math.max(1, list.length - 1) };
  };
  let { insetL, barW, gap } = layout(12);
  const tight = barW + gap < 58;
  if (tight) ({ insetL, barW, gap } = layout(34));
  const padB = tight ? 58 : 40;

  // Δ 모드는 음수 막대가 나오므로 0 을 포함한 양방향 도메인을 잡는다.
  const marks = [0, ...list.map((s) => s.start), ...list.map((s) => s.end)];
  const lo = Math.min(...marks);
  const hi = Math.max(...marks);
  const span = hi - lo || 1;
  const y = (v) => padT + (1 - (v - lo) / span) * (h - padT - padB);

  const s = svg('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}` });
  s.appendChild(svg('text', { x: 0, y: 10, class: 'svg-sect', text: title }));
  // 0 기준선 — Δ 모드에서 막대의 부호를 읽는 기준이다.
  s.appendChild(svg('line', {
    x1: 0, x2: w, y1: y(0), y2: y(0), stroke: 'var(--border-strong)', 'stroke-width': 1,
  }));

  list.forEach((st, i) => {
    const x = insetL + i * (barW + gap);
    const isTotal = st.sign === 'total';
    const top = y(Math.max(st.start, st.end));
    const bot = y(Math.min(st.start, st.end));
    const color = isTotal
      ? (mode === 'DELTA' && st.value > 0 ? 'var(--status-crit)' : 'var(--accent)')
      : mode === 'ABS' && st.sign === 'base' ? 'var(--status-idle)'
      : bucketColor(st.id);

    const bar = svg('rect', {
      x, y: top, width: barW, height: Math.max(1, bot - top),
      fill: color, opacity: selectedBucket === st.id ? 1 : 0.82,
      stroke: selectedBucket === st.id ? 'var(--text-primary)' : 'none', 'stroke-width': 1,
      // 감소분은 빗금으로 구분해 "쌓이는 비용"과 시각적으로 섞이지 않게 한다.
      'fill-opacity': st.value < 0 ? 0.35 : undefined,
      'stroke-dasharray': st.value < 0 ? '3 2' : undefined,
      style: interactive ? 'cursor:pointer' : '',
    });
    if (st.value < 0) {
      bar.setAttribute('stroke', selectedBucket === st.id ? 'var(--text-primary)' : color);
      bar.setAttribute('stroke-width', 1);
    }
    if (interactive) {
      bar.addEventListener('click', () => {
        selectedBucket = selectedBucket === st.id ? null : st.id;
        render(appState);
      });
      bar.addEventListener('mouseenter', (e) => showTip(e, tipText(st, list, mode)));
      bar.addEventListener('mousemove', moveTip);
      bar.addEventListener('mouseleave', hideTip);
    }
    s.appendChild(bar);

    if (i > 0 && !isTotal) {
      s.appendChild(svg('line', {
        x1: x - gap, x2: x, y1: y(st.start), y2: y(st.start),
        stroke: 'var(--border-strong)', 'stroke-width': 1, 'stroke-dasharray': '2 2',
      }));
    }
    s.appendChild(svg('text', {
      x: x + barW / 2, y: top - 4, 'text-anchor': 'middle', class: 'svg-caption',
      fill: 'var(--text-primary)',
      text: usd(st.value, { signed: mode === 'DELTA' && !isTotal }),
    }));

    const cx = x + barW / 2;
    if (tight) {
      const ty = h - padB + 12;
      // 기울인 라벨에는 보조 문구(note)를 붙이지 않는다 — 길어질수록 잘린다.
      s.appendChild(svg('text', {
        x: cx, y: ty, 'text-anchor': 'end', transform: `rotate(-40 ${cx} ${ty})`,
        class: 'svg-caption', text: st.en,
      }));
    } else {
      const words = st.en.split(' ');
      words.forEach((word, k) => {
        s.appendChild(svg('text', {
          x: cx, y: h - padB + 12 + k * 9, 'text-anchor': 'middle',
          class: 'svg-caption', text: word,
        }));
      });
      if (st.note) {
        s.appendChild(svg('text', {
          x: cx, y: h - padB + 12 + words.length * 9, 'text-anchor': 'middle',
          class: 'svg-caption', fill: 'var(--text-muted)', text: st.note,
        }));
      }
    }
  });
  return s;
}

function tipText(st, list, mode) {
  const total = list.find((x) => x.sign === 'total');
  const denom = Math.abs(total?.value || 0);
  const share = denom > EPS_USD ? `${((st.value / denom) * 100).toFixed(1)}% of ${mode === 'DELTA' ? '귀속 합계' : 'total'}` : '';
  const head = `<b>${st.label}</b>\n${usd(st.value, { compact: false, signed: mode === 'DELTA' && st.sign !== 'total' })}`;
  if (mode === 'DELTA' && st.id === 'baseFreight') {
    return `${head}\n${share}\n출하하지 못한 물량만큼 발생하지 않은 운임이다 — 절감이 아니다.`;
  }
  return share ? `${head}\n${share}` : head;
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
function drilldown(state, mode) {
  const box = el('div', { style: { flex: '1', overflow: 'auto', borderTop: '1px solid var(--border)', minHeight: '0' } });
  if (!selectedBucket || selectedBucket === 'total') {
    box.appendChild(el('div', { class: 'empty-state', text: '막대를 클릭하면 그 원가를 만든 노드 · 구간 · PO 로 내려갑니다.' }));
    return box;
  }
  const bucket = COST_BUCKETS.find((b) => b.id === selectedBucket);
  if (!bucket) return box;

  const label = mode === 'DELTA' && bucket.id === 'baseFreight' ? 'FREIGHT Δ' : bucket.en;
  const head = el('div', { class: 'section-label' },
    el('span', { text: `${label} — 원천${mode === 'DELTA' ? ' (기준선 대비 Δ)' : ''}` }),
    el('button', { class: 'btn', text: '닫기', onclick: () => { selectedBucket = null; render(appState); } }));
  box.appendChild(head);

  const rows = sourceRows(state, selectedBucket, mode);
  const table = el('table', { class: 'grid' });
  table.appendChild(el('thead', {}, el('tr', {},
    el('th', { text: '원천' }), el('th', { text: '유형' }),
    el('th', { text: mode === 'DELTA' ? 'Δ 금액' : '금액', style: { textAlign: 'right' } }),
    el('th', { text: '비고', style: { textAlign: 'right' } }))));
  const tb = el('tbody');
  for (const r of rows) {
    const tr = el('tr', { onclick: () => r.sel && setSelection(r.sel) },
      el('td', { class: 'mono', text: r.id }),
      el('td', { class: 'tiny muted', text: r.kind }),
      el('td', { class: 'n', text: usd(r.value, { compact: false, signed: mode === 'DELTA' }) }),
      el('td', { class: 'n tiny muted', text: r.note || '' }));
    tb.appendChild(tr);
  }
  if (!rows.length) tb.appendChild(el('tr', {}, el('td', { colSpan: 4, class: 'muted tiny', text: '해당 원가 없음' })));
  table.appendChild(tb);
  box.appendChild(table);
  return box;
}

/**
 * 원천별 금액. Δ 모드에서는 같은 id 의 기준선 값을 빼서 부호 있는 차분을 낸다
 * (기준선에 없는 원천은 0 으로 본다). 헤드라인 막대와 드릴다운 합계가 서로
 * 어긋나지 않게 하려면 둘 다 같은 기준을 써야 한다.
 */
function sourceRows(state, bucket, mode) {
  const r = state.result;
  const b = mode === 'DELTA' ? state.baseline : null;
  const rows = [];
  const delta = (cur, base) => (mode === 'DELTA' ? cur - base : cur);

  if (bucket === 'blockingIdle' || bucket === 'starvingIdle') {
    const key = bucket === 'blockingIdle' ? 'blockingIdleUSD' : 'starvingIdleUSD';
    for (const n of NODES) {
      const p = r.perNode[n.id];
      const value = delta(p[key], b?.perNode[n.id]?.[key] ?? 0);
      if (Math.abs(value) > EPS_USD) {
        rows.push({
          id: n.id, kind: n.type, value,
          note: `${bucket === 'blockingIdle' ? p.blockedDays : p.starvedDays}d · LOST ${fmtNum(p.lostOutputMWh, 1)} MWh`,
          sel: { type: 'node', id: n.id },
        });
      }
    }
  } else if (bucket === 'baseFreight') {
    for (const l of LANES) {
      const pl = r.perLane[l.id];
      const bl = b?.perLane[l.id];
      const value = delta(pl.freightUSD + pl.hubHandlingUSD, (bl?.freightUSD ?? 0) + (bl?.hubHandlingUSD ?? 0));
      if (Math.abs(value) > EPS_USD) {
        const truckDelta = mode === 'DELTA' ? pl.trucks - (bl?.trucks ?? 0) : pl.trucks;
        rows.push({
          id: l.id, kind: l.laneType, value,
          note: `${truckDelta >= 0 && mode === 'DELTA' ? '+' : ''}${truckDelta} 트럭 · ${fmtNum(pl.miles, 0)} mi`,
          sel: { type: 'lane', id: l.id },
        });
      }
    }
  } else if (bucket === 'expedite') {
    for (const l of LANES) {
      const pl = r.perLane[l.id];
      const value = delta(pl.expediteUSD, b?.perLane[l.id]?.expediteUSD ?? 0);
      if (Math.abs(value) > EPS_USD) {
        rows.push({ id: l.id, kind: 'lane', value, note: '특송', sel: { type: 'lane', id: l.id } });
      }
    }
  } else if (bucket === 'excessStorage') {
    for (const n of NODES) {
      const value = delta(r.perNode[n.id].storageUSD, b?.perNode[n.id]?.storageUSD ?? 0);
      if (Math.abs(value) > EPS_USD) {
        rows.push({ id: n.id, kind: n.type, value, note: '완제품 초과보관', sel: { type: 'node', id: n.id } });
      }
    }
  } else if (bucket === 'ldPenalty') {
    const basePenalty = new Map((b?.orders || []).map((o) => [o.id, o.penaltyUSD]));
    for (const o of r.orders) {
      const value = delta(o.penaltyUSD, basePenalty.get(o.id) ?? 0);
      if (Math.abs(value) > EPS_USD) {
        rows.push({
          id: o.id, kind: o.customerId, value,
          note: `${o.lateDays}d 지연 · ${o.status}`,
          sel: { type: 'customer', id: o.customerId },
        });
      }
    }
  }
  rows.sort((a, b2) => Math.abs(b2.value) - Math.abs(a.value));
  return rows.slice(0, 60);
}

export function frame() { /* 원가 뷰는 플레이헤드에 반응하지 않는다 (전 기간 누계) */ }
