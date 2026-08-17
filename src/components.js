// ═══════════════════════════════════════════════════════════════════════════
// src/components.js — DOM / SVG 헬퍼 + 공용 컨트롤 빌더
// 여기에 데이터나 시뮬 로직을 두지 않는다. 순수 표현 계층.
// ═══════════════════════════════════════════════════════════════════════════

import { fmtNum, HEALTH, HEALTH_ORDER } from './units.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  applyAttrs(n, attrs);
  append(n, children);
  return n;
}

export function svg(tag, attrs = {}, ...children) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.setAttribute('class', v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v);
  }
  append(n, children);
  return n;
}

function applyAttrs(n, attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in n && k !== 'list' && typeof v !== 'object') n[k] = v;
    else n.setAttribute(k, v);
  }
}

function append(n, children) {
  for (const c of children.flat(4)) {
    if (c == null || c === false) continue;
    n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

// ── 섹션 ────────────────────────────────────────────────────────────────
export function section(label, body, right) {
  return el('div', { class: 'section' },
    el('div', { class: 'section-label' }, el('span', { text: label }), right || null),
    el('div', { class: 'section-body' }, body)
  );
}

// ── 슬라이더 ────────────────────────────────────────────────────────────
/**
 * @param {object} o
 *   label, value, min, max, step, unit, pct, sub (fn(value)->string),
 *   format (fn(value)->string), onInput (fn(value))
 */
export function slider(o) {
  const valueEl = el('span', { class: 'ctrl-value' });
  const subEl = o.sub ? el('div', { class: 'ctrl-sub' }) : null;

  const paint = (v) => {
    valueEl.textContent = o.format
      ? o.format(v)
      : o.pct
        ? `${fmtNum(v * 100, o.digits ?? 1)}%`
        : `${fmtNum(v, o.digits ?? (o.step < 1 ? 1 : 0))}${o.unit ? ' ' + o.unit : ''}`;
    if (subEl) subEl.textContent = o.sub(v);
  };

  const input = el('input', {
    type: 'range', min: o.min, max: o.max, step: o.step, value: o.value,
    oninput: (e) => {
      const v = Number(e.target.value);
      paint(v);
      o.onInput(v);
    },
  });
  paint(o.value);

  return el('div', { class: 'ctrl' },
    el('div', { class: 'ctrl-head' }, el('span', { class: 'ctrl-label', text: o.label }), valueEl),
    input,
    subEl
  );
}

// ── 세그먼트 ────────────────────────────────────────────────────────────
export function segmented(o) {
  const wrap = el('div', { class: 'segmented' });
  for (const opt of o.options) {
    const v = typeof opt === 'object' ? opt.value : opt;
    const label = typeof opt === 'object' ? opt.label : String(opt);
    wrap.appendChild(el('button', {
      text: label,
      title: typeof opt === 'object' ? opt.title || '' : '',
      'aria-pressed': String(v === o.value),
      onclick: () => {
        for (const b of wrap.children) b.setAttribute('aria-pressed', 'false');
        o.onChange(v);
      },
    }));
  }
  return o.label
    ? el('div', { class: 'ctrl' },
        el('div', { class: 'ctrl-head' }, el('span', { class: 'ctrl-label', text: o.label })), wrap)
    : wrap;
}

// ── 숫자 필드 ───────────────────────────────────────────────────────────
export function numberField(o) {
  const subEl = o.sub ? el('div', { class: 'ctrl-sub', text: o.sub(o.value) }) : null;
  return el('div', { class: 'ctrl' },
    el('div', { class: 'ctrl-head' },
      el('span', { class: 'ctrl-label', text: o.label }),
      o.unit ? el('span', { class: 'ctrl-value muted tiny', text: o.unit }) : null),
    el('input', {
      type: 'number', value: o.value, min: o.min, max: o.max, step: o.step,
      oninput: (e) => {
        const v = Number(e.target.value);
        if (!isFinite(v)) return;
        if (subEl) subEl.textContent = o.sub(v);
        o.onInput(v);
      },
    }),
    subEl
  );
}

export function selectField(o) {
  const sel = el('select', {
    class: 'field',
    onchange: (e) => o.onChange(e.target.value),
  });
  for (const opt of o.options) {
    sel.appendChild(el('option', {
      value: opt.value, text: opt.label, selected: opt.value === o.value,
    }));
  }
  return o.label
    ? el('div', { class: 'ctrl' },
        el('div', { class: 'ctrl-head' }, el('span', { class: 'ctrl-label', text: o.label })), sel)
    : sel;
}

export function checkbox(o) {
  return el('label', { class: 'ctrl spread', style: { cursor: 'pointer' } },
    el('span', { class: 'ctrl-label', text: o.label }),
    el('input', { type: 'checkbox', checked: o.value, onchange: (e) => o.onChange(e.target.checked) })
  );
}

export function badge(text, kind = 'muted') {
  return el('span', { class: `badge ${kind}`, text });
}

export function callout(text, kind = 'warn') {
  return el('div', { class: `callout ${kind}`, html: text });
}

export function kv(pairs) {
  const g = el('div', { class: 'kv' });
  for (const [k, v] of pairs) {
    if (v == null) continue;
    g.appendChild(el('span', { class: 'k', text: k }));
    g.appendChild(typeof v === 'string' || typeof v === 'number'
      ? el('span', { class: 'v', text: String(v) })
      : el('span', { class: 'v' }, v));
  }
  return g;
}

export function button(label, onclick, kind = '') {
  return el('button', { class: `btn ${kind}`.trim(), text: label, onclick });
}

// ── 스파크라인 ──────────────────────────────────────────────────────────
/**
 * @param {number[]} series
 * @param {object} o  width,height,max,color,threshold,marker(현재 일자)
 */
export function sparkline(series, o = {}) {
  const w = o.width ?? 292;
  const h = o.height ?? 30;
  const max = o.max ?? Math.max(1e-6, ...series.filter(Number.isFinite));
  const n = series.length;
  // 위아래 3px 여백 — 값이 거의 일정한 계열이 테두리에 붙어 사라지지 않게 한다
  const pad = Math.min(3, h / 6);
  const x = (i) => (n <= 1 ? 0 : (i / (n - 1)) * w);
  const y = (v) => h - pad - Math.max(0, Math.min(1, v / max)) * (h - pad * 2);

  let d = '';
  for (let i = 0; i < n; i++) {
    const v = series[i];
    if (!Number.isFinite(v)) continue;
    d += `${d ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  }

  const g = svg('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}` },
    svg('rect', { x: 0, y: 0, width: w, height: h, fill: 'var(--bg-app)' }),
    o.threshold != null
      ? svg('line', {
          x1: 0, x2: w, y1: y(o.threshold), y2: y(o.threshold),
          stroke: 'var(--status-warn)', 'stroke-width': 1, 'stroke-dasharray': '2 2', opacity: 0.6,
        })
      : null,
    d ? svg('path', { d, fill: 'none', stroke: o.color ?? 'var(--accent)', 'stroke-width': 1.2 }) : null,
    o.marker != null && n > 1
      ? svg('line', {
          x1: x(o.marker), x2: x(o.marker), y1: 0, y2: h,
          stroke: 'var(--text-primary)', 'stroke-width': 1, opacity: 0.55,
        })
      : null
  );
  return g;
}

// ── 버퍼 게이지 (사각 세그먼트, 둥근 끝 금지) ───────────────────────────
export function gaugeBar(fillPct, o = {}) {
  const w = o.width ?? 60;
  const h = o.height ?? 6;
  const f = Math.max(0, Math.min(1, fillPct));
  const color = o.color ?? (f > 0.95 ? 'var(--status-warn)' : f < 0.05 ? 'var(--status-danger)' : 'var(--accent)');
  return svg('svg', { width: w, height: h },
    svg('rect', { x: 0, y: 0, width: w, height: h, fill: 'var(--bg-app)', stroke: 'var(--border-strong)', 'stroke-width': 1 }),
    svg('rect', { x: 1, y: 1, width: Math.max(0, f * (w - 2)), height: h - 2, fill: color })
  );
}

// ── 툴팁 ────────────────────────────────────────────────────────────────
const tipEl = () => document.getElementById('tooltip');

export function showTip(evt, html) {
  const t = tipEl();
  if (!t) return;
  t.innerHTML = html;
  t.hidden = false;
  moveTip(evt);
}

export function moveTip(evt) {
  const t = tipEl();
  if (!t || t.hidden) return;
  const pad = 14;
  const r = t.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - pad;
  t.style.left = `${Math.max(4, x)}px`;
  t.style.top = `${Math.max(4, y)}px`;
}

export function hideTip() {
  const t = tipEl();
  if (t) t.hidden = true;
}

/** 요소에 툴팁을 붙인다. content 는 () => html 문자열. */
export function attachTip(node, content) {
  node.addEventListener('mouseenter', (e) => showTip(e, content()));
  node.addEventListener('mousemove', moveTip);
  node.addEventListener('mouseleave', hideTip);
  return node;
}

// ── 인라인 SVG 아이콘 (16px, stroke 1.5) ────────────────────────────────
export const ICONS = {
  inspector: '<path d="M2 3h12v10H2zM2 6h12M6 6v7" />',
  scenario: '<path d="M8 2v12M3 5l5-3 5 3M3 5v6l5 3 5-3V5" />',
  planning: '<path d="M2 4h12v9H2zM2 7h12M5.5 2v3M10.5 2v3M5 10h2M9 10h2" />',
  customers: '<circle cx="5.5" cy="5" r="2" /><circle cx="11" cy="6.5" r="1.6" /><path d="M1.5 13c0-2.2 1.8-3.6 4-3.6s4 1.4 4 3.6M10 9.6c2 0 4 1 4 3.4" />',
  ontology: '<circle cx="8" cy="3" r="1.6" /><circle cx="3" cy="12" r="1.6" /><circle cx="13" cy="12" r="1.6" /><path d="M7 4.4 4 10.5M9 4.4l3 6.1M4.6 12h6.8" />',
  // AI — 큰 스파클 + 작은 스파클. 현재 AI 기능의 통용 기호이고, 노드-링크
  // 아이콘(ontology)과 형태가 완전히 달라 레일에서 혼동되지 않는다.
  ai: '<path d="M6.2 1.8 7.4 5 10.6 6.2 7.4 7.4 6.2 10.6 5 7.4 1.8 6.2 5 5z" /><path d="M11.8 9 12.5 11 14.5 11.7 12.5 12.4 11.8 14.4 11.1 12.4 9.1 11.7 11.1 11z" />',
  settings: '<circle cx="8" cy="8" r="2.2" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" />',
  watchlist: '<path d="M8 1.8l1.8 4.1 4.4.4-3.3 2.9 1 4.3L8 11.2 4.1 13.5l1-4.3L1.8 6.3l4.4-.4z" />',
};

export function icon(name) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('width', '16');
  s.setAttribute('height', '16');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.5');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.innerHTML = ICONS[name] || '';
  return s;
}

// ── 상태 범례 (§4.1 / §4.2) ─────────────────────────────────────────────
/**
 * NETWORK · FLOW 가 공유하는 상태 글리프 범례. 두 뷰가 같은 기호를 쓰므로
 * 범례도 한 곳에서만 만든다 — 각자 그리면 반드시 어긋난다.
 */
export function healthLegend(opts = {}) {
  const box = el('div', { class: `health-legend${opts.inline ? ' inline' : ''}` });
  for (const id of HEALTH_ORDER) {
    const h = HEALTH[id];
    box.appendChild(el('span', { class: 'hl-item', title: `${h.label} · ${h.ko}` },
      el('span', { class: 'hl-glyph', style: { color: h.color }, text: h.glyph }),
      el('span', { class: 'hl-label', text: h.label })));
  }
  return box;
}
