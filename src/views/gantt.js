// ═══════════════════════════════════════════════════════════════════════════
// src/views/gantt.js — 하단 상태 타임라인 + 납기 마커 §4.6
//
// 행 = 생산 노드 8개, x = 일. 각 행 하단 3px 띠에는
//   · 반사실 토글 시   → 반사실 상태 밴드 (§4.7)
//   · 확률 모드 결과 시 → BLOCKED 확률 히트 스트립 (§1.5.4)
// 슬라이더를 드래그하면 이 그림이 통째로 재구성된다 — 인과관계가 손에 잡힌다.
// ═══════════════════════════════════════════════════════════════════════════

import { NODES } from '../data.js';
import { svg, clear, showTip, moveTip, hideTip } from '../components.js';
import { STATUS_COLOR, usd } from '../units.js';
import { appState, setPlayhead, setSelection } from '../store.js';
import { fmtDateShort, fmtDate } from '../clock.js';

let root = null;
let refs = null;
let dims = { w: 1000, h: 118 };

const LABEL_W = 60;
const PAD_R = 12;
const AXIS_H = 12;
const ROW_H = 11;
const BAND_H = 7;
const STRIP_H = 3;
const DUE_H = 15;

export function mount(container) {
  root = container;
  window.addEventListener('resize', () => render(appState));
}

const xOf = (day, H) => LABEL_W + (day / H) * (dims.w - LABEL_W - PAD_R);

export function render(state) {
  if (!root || !state.result) return;
  const rect = root.getBoundingClientRect();
  dims = { w: Math.max(480, rect.width), h: Math.max(90, rect.height) };
  clear(root);

  const H = state.config.horizonDays;
  const s = svg('svg', { width: dims.w, height: dims.h, viewBox: `0 0 ${dims.w} ${dims.h}` });
  refs = { cursor: null, cfStrips: {} };
  const bw = (dims.w - LABEL_W - PAD_R) / H;

  // ── 축 ────────────────────────────────────────────────────────────────
  for (let d = 0; d <= H; d += 10) {
    const x = xOf(d, H);
    s.appendChild(svg('line', {
      x1: x, x2: x, y1: AXIS_H - 3, y2: dims.h - DUE_H,
      stroke: 'var(--border)', 'stroke-width': 1, opacity: d % 30 === 0 ? 0.9 : 0.4,
    }));
    if (d % 20 === 0 && d < H) {
      s.appendChild(svg('text', { x: x + 2, y: 9, class: 'svg-caption', text: fmtDateShort(d) }));
    }
  }

  // ── 예측 구간 + NOW 경계 ──────────────────────────────────────────────
  // 관측 시점 이후는 계측이 아니라 가정이다. 실제 가림막은 상태 막대를 전부
  // 그린 뒤에 덮어야 하므로(먼저 깔면 막대가 위로 올라온다) 여기서는 경계선만
  // 세우고, 마스크는 render 말미의 maskForecast() 가 붙인다.
  const hideForecast = state.mode === 'LIVE' && !state.projectionRevealed;
  const nowX = xOf(state.nowDay, H);
  if (!hideForecast) {
    s.appendChild(svg('rect', {
      x: nowX, y: AXIS_H - 3, width: Math.max(0, dims.w - PAD_R - nowX), height: dims.h - DUE_H - AXIS_H + 3,
      fill: 'var(--bg-app)', opacity: 0.35,
    }));
  }
  s.appendChild(svg('line', {
    x1: nowX, x2: nowX, y1: 0, y2: dims.h - DUE_H,
    stroke: 'var(--status-ok)', 'stroke-width': 1.5,
  }));
  s.appendChild(svg('text', {
    x: nowX + 3, y: dims.h - DUE_H - 3, class: 'svg-caption',
    fill: 'var(--status-ok)', text: 'NOW',
  }));

  // ── 노드 행 ───────────────────────────────────────────────────────────
  NODES.forEach((n, i) => {
    const y = AXIS_H + i * ROW_H;
    const p = state.result.perNode[n.id];

    const label = svg('text', {
      x: 4, y: y + BAND_H, class: 'svg-caption', fill: 'var(--text-secondary)',
      text: n.short, style: 'cursor:pointer',
    });
    label.addEventListener('click', () => setSelection({ type: 'node', id: n.id }));
    s.appendChild(label);

    // 상태 밴드 — 연속 구간을 하나의 rect 로 묶어 그린다
    let start = 0;
    for (let d = 1; d <= H; d++) {
      const cur = p.stateTimeline[d];
      const prev = p.stateTimeline[start];
      if (d === H || cur !== prev) {
        s.appendChild(svg('rect', {
          x: xOf(start, H), y, width: Math.max(0.5, (d - start) * bw), height: BAND_H,
          fill: STATUS_COLOR[prev] || 'var(--status-idle)',
          opacity: prev === 'RUNNING' ? 0.45 : 0.95,
        }));
        start = d;
      }
    }

    // 하단 3px 띠
    const strip = svg('g');
    s.appendChild(strip);
    refs.cfStrips[n.id] = { g: strip, y: y + BAND_H + 0.5, bw, H };

    // 행 전체 hover
    const hit = svg('rect', {
      x: LABEL_W, y, width: dims.w - LABEL_W - PAD_R, height: ROW_H,
      fill: 'transparent', style: 'cursor:pointer',
    });
    hit.addEventListener('mousemove', (e) => {
      const d = dayFromEvent(e, H);
      showTip(e, [
        `<b>${n.id}</b>  ${fmtDate(d)}`,
        `상태  ${p.stateTimeline[d]}`,
        `산출  ${p.producedSeries[d].toFixed(2)} / 계획 ${p.planSeries[d].toFixed(2)} MWh`,
        `출고버퍼 ${((p.outputBufferSeries[d] / p.outputCapacity) * 100).toFixed(0)}%`,
      ].join('\n'));
      moveTip(e);
    });
    hit.addEventListener('mouseleave', hideTip);
    hit.addEventListener('click', (e) => setPlayhead(dayFromEvent(e, H)));
    s.appendChild(hit);
  });

  // ── 납기 마커 행 ──────────────────────────────────────────────────────
  const dueY = dims.h - DUE_H + 2;
  s.appendChild(svg('text', { x: 4, y: dueY + 8, class: 'svg-caption', text: '▼납기' }));
  for (const o of state.result.orders) {
    const late = o.status === 'LATE' || o.status === 'UNDELIVERED';
    const x = xOf(o.dueDay, H);
    const m = svg('path', {
      d: `M${x - 3},${dueY}L${x + 3},${dueY}L${x},${dueY + 5}z`,
      fill: late ? 'var(--status-crit)' : 'var(--text-muted)',
      style: 'cursor:pointer',
    });
    m.addEventListener('mouseenter', (e) => showTip(e, [
      `<b>${o.id}</b>`,
      `DUE      ${fmtDate(o.dueDay)}`,
      `인도     ${o.deliveredDay != null ? fmtDate(o.deliveredDay) : '미완료'}`,
      `수량     ${o.qtyLinks.toFixed(1)} Link`,
      `상태     ${o.status}${o.lateDays ? ' · ' + o.lateDays + 'd 지연' : ''}`,
      o.penaltyUSD > 0 ? `LD       ${usd(o.penaltyUSD)}` : '',
    ].filter(Boolean).join('\n')));
    m.addEventListener('mousemove', moveTip);
    m.addEventListener('mouseleave', hideTip);
    m.addEventListener('click', () => setSelection({ type: 'order', id: o.id }));
    s.appendChild(m);
  }

  // ── 예측 구간 가림막 — 상태 막대 · 납기 마커를 전부 덮는다 ────────────
  if (hideForecast) {
    const mw = Math.max(0, dims.w - PAD_R - nowX);
    s.appendChild(svg('rect', {
      x: nowX, y: 0, width: mw, height: dims.h,
      fill: 'var(--bg-app)', opacity: 0.96, 'pointer-events': 'none',
    }));
    s.appendChild(svg('text', {
      x: nowX + mw / 2, y: (dims.h - DUE_H + AXIS_H) / 2, 'text-anchor': 'middle',
      class: 'svg-caption', fill: 'var(--text-muted)', 'pointer-events': 'none',
      text: '전망 미실행 — 우측 패널에서 90일 전망을 실행하세요',
    }));
    s.appendChild(svg('line', {
      x1: nowX, x2: nowX, y1: 0, y2: dims.h - DUE_H,
      stroke: 'var(--status-ok)', 'stroke-width': 1.5, 'pointer-events': 'none',
    }));
  }

  // ── 현재 시점 커서 ────────────────────────────────────────────────────
  refs.cursor = svg('line', {
    x1: 0, x2: 0, y1: 0, y2: dims.h - 2,
    stroke: 'var(--text-primary)', 'stroke-width': 1, 'pointer-events': 'none',
  });
  s.appendChild(refs.cursor);

  // 드래그 scrub
  let dragging = false;
  s.addEventListener('mousedown', (e) => { dragging = true; setPlayhead(dayFromEvent(e, H)); });
  window.addEventListener('mouseup', () => { dragging = false; });
  s.addEventListener('mousemove', (e) => { if (dragging) setPlayhead(dayFromEvent(e, H)); });

  root.appendChild(s);
  paintStrips(state);
  frame(state);
}

function dayFromEvent(e, H) {
  const r = root.getBoundingClientRect();
  const x = e.clientX - r.left;
  const t = (x - LABEL_W) / (dims.w - LABEL_W - PAD_R);
  return Math.max(0, Math.min(H - 1, Math.round(t * H)));
}

/** 반사실 밴드 또는 확률 히트 스트립을 각 행 하단에 그린다. */
function paintStrips(state) {
  if (!refs) return;
  const H = state.config.horizonDays;
  for (const n of NODES) {
    const ref = refs.cfStrips[n.id];
    clear(ref.g);
    if (state.showCounterfactual && state.counterfactual) {
      const tl = state.counterfactual.perNode[n.id].stateTimeline;
      let start = 0;
      for (let d = 1; d <= H; d++) {
        if (d === H || tl[d] !== tl[start]) {
          ref.g.appendChild(svg('rect', {
            x: xOf(start, H), y: ref.y, width: Math.max(0.5, (d - start) * ref.bw), height: STRIP_H,
            fill: tl[start] === 'RUNNING' ? 'var(--ghost)' : STATUS_COLOR[tl[start]],
            opacity: tl[start] === 'RUNNING' ? 0.5 : 0.8,
          }));
          start = d;
        }
      }
    } else if (state.mc?.blockedProb) {
      const prob = state.mc.blockedProb[n.id];
      for (let d = 0; d < H; d++) {
        if (prob[d] <= 0.01) continue;
        ref.g.appendChild(svg('rect', {
          x: xOf(d, H), y: ref.y, width: Math.max(0.5, ref.bw), height: STRIP_H,
          fill: 'var(--status-warn)', opacity: Math.min(1, prob[d]),
        }));
      }
    }
  }
}

export function frame(state) {
  if (!refs?.cursor) return;
  const x = xOf(state.playhead, state.config.horizonDays);
  refs.cursor.setAttribute('x1', x);
  refs.cursor.setAttribute('x2', x);
}

export { paintStrips };
