// ═══════════════════════════════════════════════════════════════════════════
// src/views/network.js — NETWORK VIEW (인포그래픽, 기본 뷰) §4.1
//
// 실사 위성지도 / 주 경계 / 지형 / 도로망 없음. 미국 외곽 실루엣 하나만 깐다.
// 다만 투영은 geoAlbersUsa 를 유지한다 — AZ 가 중서부에서 물리적으로 멀다는
// 사실이 리드타임의 시각적 근거이기 때문이다.
// ═══════════════════════════════════════════════════════════════════════════

import {
  NODES, HUB, CUSTOMERS, LANES, LABEL_OFFSETS, MAP_OFFSETS, CELL_IDS, PACK_IDS,
  GEO_INDEX, isOverriddenDistance,
} from '../data.js';
import { svg, clear, showTip, moveTip, hideTip } from '../components.js';
import { albersUsa, geoPathString, milesPerPixel, filterToConus } from '../geo.js';
import { qty, usd, miles as fmtMiles, STATUS_COLOR, fmtNum } from '../units.js';
import { appState, setSelection } from '../store.js';

const NATION_URL = 'https://cdn.jsdelivr.net/npm/us-atlas@3/nation-10m.json';
const TOPO_URL = 'https://cdn.jsdelivr.net/npm/topojson-client@3/+esm';

const MAX_DOTS = 40;

let root = null;
let svgEl = null;
let zoomG = null;
let projection = null;
let nationFeature = null;
let silhouetteTried = false;
let dims = { w: 800, h: 600 };
let refs = null; // 프레임 갱신용 엘리먼트 참조
let transform = { k: 1, x: 0, y: 0 };

/**
 * 외곽 실루엣만 CDN 에서 가져온다. 좌표 투영은 src/geo.js 가 직접 계산하므로
 * 이 요청이 실패해도 노드 · 아크 · 인셋은 전부 정상 위치에 그려진다.
 */
async function loadSilhouette() {
  if (silhouetteTried) return;
  silhouetteTried = true;
  try {
    const topojson = await import(TOPO_URL);
    const topo = await fetch(NATION_URL).then((r) => r.json());
    // 알래스카 · 하와이 등 도서는 이 앱의 단일 원뿔 투영에서 본토와 겹쳐
    // 찍히므로 실루엣에서 제외한다 (src/geo.js 의 filterToConus 참고).
    nationFeature = filterToConus(topojson.feature(topo, topo.objects.nation));
  } catch {
    // 네트워크가 없는 환경에서도 앱은 그대로 쓸 수 있어야 한다.
    nationFeature = null;
  }
}

/** 실제 투영 좌표. */
function projectTrue(id) {
  const g = GEO_INDEX[id];
  return projection([g.lng, g.lat]) || [0, 0];
}

/** 표시 좌표 — 동일 지점에 겹치는 노드는 MAP_OFFSETS 만큼 벌린다. */
function project(id) {
  const p = projectTrue(id);
  const o = MAP_OFFSETS[id];
  return o ? [p[0] + o.dx, p[1] + o.dy] : p;
}

// ── 심볼 ────────────────────────────────────────────────────────────────
function symbolPath(type, r) {
  switch (type) {
    case 'PACK': return `M${-r},${-r}h${r * 2}v${r * 2}h${-r * 2}z`;
    case 'LINK': return `M0,${-r}L${r},0L0,${r}L${-r},0z`;
    case 'HUB': return `M0,${-r}L${r * 0.92},${r * 0.72}L${-r * 0.92},${r * 0.72}z`;
    default: return `M${-r},0a${r},${r} 0 1,0 ${r * 2},0a${r},${r} 0 1,0 ${-r * 2},0`;
  }
}

function nodeRadius(n) {
  const caps = NODES.map((x) => x.capaPerHour);
  const lo = Math.min(...caps);
  const hi = Math.max(...caps);
  return 5 + ((n.capaPerHour - lo) / Math.max(1e-6, hi - lo)) * 5;
}

function customerRadius(c) {
  const links = CUSTOMERS.map((x) => x.monthlyLinks);
  const lo = Math.min(...links);
  const hi = Math.max(...links);
  return 2.5 + ((c.monthlyLinks - lo) / Math.max(1e-6, hi - lo)) * 2.5;
}

// ── 툴팁 ────────────────────────────────────────────────────────────────
function nodeTip(id, day) {
  const r = appState.result;
  const p = r.perNode[id];
  const n = NODES.find((x) => x.id === id);
  if (!p) return `<b>${id}</b>`;
  const st = p.stateTimeline[day];
  return [
    `<b>${id}</b> · ${n.name}`,
    `${n.place} · ${n.owner}`,
    `STATUS   ${st}`,
    `IN       ${qty(p.inputBufferSeries[day])} / ${fmtNum(p.inputCapacity, 1)} MWh`,
    `OUT      ${qty(p.outputBufferSeries[day])} / ${fmtNum(p.outputCapacity, 1)} MWh`,
    `OUTPUT   ${qty(p.producedSeries[day])} /day`,
    `누적     BLOCKED ${p.blockedDays}d · STARVED ${p.starvedDays}d · DOWN ${p.downDays}d`,
  ].join('\n');
}

function laneTip(laneId, day) {
  const r = appState.result;
  const pl = r.perLane[laneId];
  const inflight = r.shipments.filter((s) => s.laneId === laneId && s.departDay <= day && s.arriveDay > day);
  const it = inflight.reduce((a, b) => a + b.qtyMWh, 0);
  return [
    `<b>${laneId}</b>`,
    `거리      ${fmtMiles(pl.miles)}${isOverriddenDistance(pl.from, pl.to) ? '  (슬라이드 · 미검증)' : ''}`,
    `리드타임  T+${pl.baseTransitDays}d  (실적 ${fmtNum(pl.avgTransitDays, 1)}d)`,
    `이동 중   ${qty(it)}  ·  ${inflight.length}건`,
    `누적출하  ${qty(pl.shippedMWh)}  ·  ${pl.trucks} 트럭`,
    `운임누계  ${usd(pl.freightUSD + pl.expediteUSD + pl.hubHandlingUSD)}`,
  ].join('\n');
}

function customerTip(id, day) {
  const r = appState.result;
  const pc = r.perCustomer[id];
  const c = CUSTOMERS.find((x) => x.id === id);
  const late = pc.orders.filter((o) => o.status === 'LATE' || o.status === 'UNDELIVERED');
  return [
    `<b>${id}</b> · ${c.name} (${c.state})`,
    `월 인도    ${c.monthlyLinks} Link`,
    `인도완료   ${qty(pc.deliveredMWh)} / ${qty(pc.orderedMWh)}`,
    `지연 PO    ${late.length} / ${pc.orders.length}`,
    `LD 누계    ${usd(pc.penaltyUSD)}`,
    `Tier       ${appState.config.customers[id].priorityTier}`,
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════════════════
export function mount(container) {
  root = container;
  // 첫 렌더는 ui.js 가 recomputeNow() 뒤에 호출한다. 여기서는 실루엣만 받아 온다.
  loadSilhouette().then(() => { if (appState.view === 'NETWORK') render(appState); });
  window.addEventListener('resize', () => { if (appState.view === 'NETWORK') render(appState); });
}

export function render(state) {
  if (!root || !state.result) return;
  const rect = root.getBoundingClientRect();
  dims = { w: Math.max(320, rect.width), h: Math.max(240, rect.height) };
  clear(root);

  // 인셋을 없앤 뒤로는 지도가 뷰포트 폭 전체를 그대로 쓴다.
  projection = albersUsa([[16, 16], [dims.w - 16, dims.h - 34]]);

  svgEl = svg('svg', { width: dims.w, height: dims.h, viewBox: `0 0 ${dims.w} ${dims.h}` });
  zoomG = svg('g', { class: 'zoom-layer' });
  svgEl.appendChild(zoomG);

  refs = { nodes: {}, customers: {}, arcs: {}, dots: null };

  drawSilhouette(zoomG);
  const groupLayer = svg('g'); zoomG.appendChild(groupLayer);
  const arcLayer = svg('g'); zoomG.appendChild(arcLayer);
  const nodeLayer = svg('g'); zoomG.appendChild(nodeLayer);
  refs.dots = svg('g'); zoomG.appendChild(refs.dots);

  drawGroups(groupLayer);
  drawArcs(arcLayer, state);
  drawCustomers(nodeLayer, state);
  drawNodes(nodeLayer, state);

  root.appendChild(svgEl);
  drawChrome(root);
  clampTransform();
  applyTransform();
  frame(state);
}

// ── 배경 실루엣 ─────────────────────────────────────────────────────────
function drawSilhouette(g) {
  if (!nationFeature) return; // 실루엣 없이도 나머지는 정상 동작
  g.appendChild(svg('path', {
    d: geoPathString(nationFeature, projection),
    fill: 'var(--bg-elevated)',
    stroke: 'var(--border)',
    'stroke-width': 1,
    'fill-rule': 'evenodd',
  }));
}

// ── 영역 그룹핑 ─────────────────────────────────────────────────────────
function bboxOf(ids, pad) {
  const pts = ids.map(project);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return {
    x: Math.min(...xs) - pad, y: Math.min(...ys) - pad,
    w: Math.max(...xs) - Math.min(...xs) + pad * 2,
    h: Math.max(...ys) - Math.min(...ys) + pad * 2,
  };
}

function drawGroups(g) {
  const az = bboxOf(['AZL'], 30);
  g.appendChild(svg('rect', {
    x: az.x, y: az.y, width: az.w, height: az.h, rx: 2,
    fill: 'none', stroke: 'var(--status-crit)', 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0.75,
  }));
  g.appendChild(svg('text', {
    x: az.x + az.w / 2, y: az.y - 5, class: 'svg-sect', 'text-anchor': 'middle',
    fill: 'var(--status-crit)', text: 'SINGLE POINT OF FAILURE',
  }));
}

// ── 흐름 아크 ───────────────────────────────────────────────────────────
function arcPath(a, b, bend = 0.16) {
  const [x1, y1] = a;
  const [x2, y2] = b;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const cx = mx - dy * bend;
  const cy = my + dx * bend;
  return { d: `M${x1},${y1}Q${cx},${cy} ${x2},${y2}`, mid: [0.25 * x1 + 0.5 * cx + 0.25 * x2, 0.25 * y1 + 0.5 * cy + 0.25 * y2] };
}

/** 중서부 클러스터 내부 아크는 인셋에서 보여주므로 지도에서는 생략한다. */
function visibleLanes(state) {
  const viaHub = state.config.routeViaHub;
  return LANES.filter((l) => {
    if (l.laneType === 'cellToPack') return false; // 인셋 담당
    if (l.role === 'toHub' || l.role === 'fromHub') return viaHub;
    if (l.role === 'direct') return !viaHub;
    return true;
  });
}

function drawArcs(g, state) {
  const day = state.playhead;
  // PW1/PW2 는 같은 Holland 안에 있어 AZL 로 가는 아크가 사실상 포개진다.
  // 라벨을 둘 다 찍으면 글자가 겹치므로 이미 찍은 위치 근처는 건너뛴다.
  const placed = [];
  const canPlace = (x, y) => {
    if (placed.some((p) => Math.abs(p[0] - x) < 46 && Math.abs(p[1] - y) < 11)) return false;
    placed.push([x, y]);
    return true;
  };
  for (const lane of visibleLanes(state)) {
    const a = project(lane.from);
    const b = project(lane.to);
    const { d, mid } = arcPath(a, b, lane.laneType === 'linkToCustomer' ? 0.1 : 0.18);
    const pl = state.result.perLane[lane.id];

    const hit = svg('path', {
      d, class: 'arc-hit',
      onmouseenter: (e) => showTip(e, laneTip(lane.id, appState.playhead)),
      onmousemove: moveTip,
      onmouseleave: hideTip,
      onclick: () => setSelection({ type: 'lane', id: lane.id }),
    });
    const stroke = svg('path', {
      d, class: 'arc', stroke: 'var(--border-strong)', 'stroke-width': 1,
      'stroke-linecap': 'butt', opacity: 0.9,
    });
    g.appendChild(stroke);
    g.appendChild(hit);

    // 거리 · 리드타임 라벨을 아크 중앙에 직접 표기 (§4.1)
    if (lane.laneType !== 'linkToCustomer' && canPlace(mid[0], mid[1])) {
      g.appendChild(svg('text', {
        x: mid[0], y: mid[1] - 3, 'text-anchor': 'middle', class: 'svg-caption',
        text: `${fmtMiles(pl.miles)} · T+${pl.baseTransitDays}d`,
      }));
    }
    refs.arcs[lane.id] = { stroke, path: stroke, laneType: lane.laneType };
  }
}

// ── 노드 ────────────────────────────────────────────────────────────────
function gaugePair(x, y, h) {
  const inBar = svg('rect', { x, y: y - h / 2, width: 2, height: h, fill: 'var(--accent)' });
  const outBar = svg('rect', { x: x + 3, y: y - h / 2, width: 2, height: h, fill: 'var(--accent)' });
  const inBg = svg('rect', { x, y: y - h / 2, width: 2, height: h, fill: 'var(--border)' });
  const outBg = svg('rect', { x: x + 3, y: y - h / 2, width: 2, height: h, fill: 'var(--border)' });
  return { inBg, outBg, inBar, outBar };
}

/** 중서부 클러스터 소속인가 — 전국 스케일에서 서로 겹치는 7개소. */
function isClustered(id) {
  return CELL_IDS.includes(id) || PACK_IDS.includes(id);
}

function drawNodes(g, state) {
  // Holland 3개소(ESMI_H · PW1 · PW2)는 상호 3마일 이내라 같은 픽셀에 찍힌다.
  // 개별 클릭이 가능하도록만 MAP_OFFSETS 로 살짝 벌리고 그 사실을 캡션으로 밝힌다.
  const holland = projectTrue('ESMI_H');
  const hollandCap = svg('g', { transform: `translate(${holland[0]},${holland[1]})` });
  const hollandIcon = svg('g'); // 바로 옆 클러스터 아이콘과 같은 배율(updateIconScale)을 받는다
  hollandCap.appendChild(hollandIcon);
  hollandIcon.appendChild(svg('text', {
    x: 0, y: -15, 'text-anchor': 'middle', class: 'svg-caption', text: 'HOLLAND, MI ×3',
  }));
  g.appendChild(hollandCap);
  refs.hollandIcon = hollandIcon;

  for (const n of [...NODES, HUB]) {
    const [x, y] = project(n.id);
    // 클러스터 노드는 전국 지도에서 '상태 점'으로만 찍는다. 라벨 · 버퍼 게이지 ·
    // 식별은 전부 인셋이 담당한다 — 500마일 반경에 7개소가 뭉쳐 있어 전국
    // 스케일에서 라벨을 달면 반드시 겹치고, 겹치는 인포그래픽은 실격이다(§8).
    // 위치만은 실제 투영 좌표를 유지한다: ESST 가 테네시에 있다는 사실은
    // 리드타임의 근거이므로 버리면 안 된다.
    const clustered = isClustered(n.id);
    const r = clustered ? 3.5 : n.type === 'HUB' ? 7 : nodeRadius(n);
    const grp = svg('g', { transform: `translate(${x},${y})`, class: 'node-hit' });
    // iconG 는 확대·축소를 상쇄하는 역배율을 받는다(updateIconScale) — 그래야
    // 지도를 확대할수록 노드 사이 간격은 벌어지는데 아이콘 자체는 화면상
    // 일정 크기를 유지해, 전국 스케일에서 겹쳐 보이던 클러스터가 확대하면
    // 실제로 분리되어 보인다. 위치(translate)는 grp 에 남겨 팬·줌을 그대로 따른다.
    const iconG = svg('g');
    grp.appendChild(iconG);

    const ring = svg('path', {
      d: symbolPath(n.type, r + (clustered ? 1.7 : 2.9)), fill: 'none',
      stroke: 'var(--status-ok)', 'stroke-width': clustered ? 1.3 : 1.8,
    });
    const body = svg('path', {
      d: symbolPath(n.type, r),
      fill: n.type === 'HUB' ? 'none' : 'var(--bg-panel)',
      stroke: 'var(--text-secondary)', 'stroke-width': 1.2,
    });
    iconG.appendChild(ring);
    iconG.appendChild(body);

    let gauges = null;
    if (n.type !== 'HUB' && !clustered) {
      gauges = gaugePair(r + 7, 0, r * 1.7);
      iconG.appendChild(gauges.inBg); iconG.appendChild(gauges.outBg);
      iconG.appendChild(gauges.inBar); iconG.appendChild(gauges.outBar);
    }

    if (!clustered) {
      const off = LABEL_OFFSETS[n.id] || { dx: 0, dy: -12, anchor: 'middle' };
      iconG.appendChild(svg('text', {
        x: off.dx, y: off.dy, 'text-anchor': off.anchor, class: 'svg-label',
        fill: 'var(--text-primary)', text: n.short || n.id,
      }));
      if (n.type === 'HUB') {
        iconG.appendChild(svg('text', {
          x: off.dx, y: off.dy + 10, 'text-anchor': off.anchor, class: 'svg-caption',
          text: 'CROSS-DOCK',
        }));
      }
    }

    grp.addEventListener('mouseenter', (e) =>
      showTip(e, n.type === 'HUB'
        ? `<b>CHI</b> · ${HUB.name}\n통과 환적 (cross-dock)\n보관 없음 · dwell ${appState.config.hubDwellDays}d`
        : nodeTip(n.id, appState.playhead)));
    grp.addEventListener('mousemove', moveTip);
    grp.addEventListener('mouseleave', hideTip);
    grp.addEventListener('click', () =>
      setSelection({ type: n.type === 'HUB' ? 'hub' : 'node', id: n.id }));

    g.appendChild(grp);
    refs.nodes[n.id] = { grp, iconG, ring, body, gauges, type: n.type };
  }
}

function drawCustomers(g, state) {
  for (const c of CUSTOMERS) {
    const [x, y] = project(c.id);
    const r = customerRadius(c);
    const grp = svg('g', { transform: `translate(${x},${y})`, class: 'node-hit' });
    const iconG = svg('g'); // updateIconScale 이 확대·축소 역배율을 준다
    grp.appendChild(iconG);
    const body = svg('circle', {
      cx: 0, cy: 0, r, fill: 'none', stroke: 'var(--text-muted)', 'stroke-width': 1.2,
    });
    const marker = svg('path', {
      d: 'M0,-9L2.9,-4.6L-2.9,-4.6z', fill: 'var(--status-crit)', opacity: 0,
    });
    iconG.appendChild(body);
    iconG.appendChild(marker);

    const off = LABEL_OFFSETS[c.id] || { dx: 0, dy: -8, anchor: 'middle' };
    iconG.appendChild(svg('text', {
      x: off.dx, y: off.dy, 'text-anchor': off.anchor, class: 'svg-caption',
      text: c.poCode, // 주 코드는 CA 가 3곳이라 중복된다 — PO 코드가 고유하다
    }));

    grp.addEventListener('mouseenter', (e) => showTip(e, customerTip(c.id, appState.playhead)));
    grp.addEventListener('mousemove', moveTip);
    grp.addEventListener('mouseleave', hideTip);
    grp.addEventListener('click', () => setSelection({ type: 'customer', id: c.id }));
    g.appendChild(grp);
    refs.customers[c.id] = { grp, iconG, body, marker };
  }
}

// ── 뷰 크롬 ─────────────────────────────────────────────────────────────
function drawChrome(container) {
  // 축척 표시는 유지한다 — 지도 스케일을 가늠하는 실질적인 정보다.
  // 데이터 출처 · 미검증 고지 문구는 지도 위에서는 지우고 설정(⌘K) 모달의
  // '데이터 출처' 섹션에서만 보여준다 (src/ui.js openSettings 참고).
  const src = document.createElement('div');
  src.className = 'scale-bar';
  src.innerHTML = `<div>${scaleLabel()}</div><div class="rule" style="width:80px"></div>`;
  container.appendChild(src);

  const ctrls = document.createElement('div');
  ctrls.className = 'view-controls';
  const mk = (label, title, fn) => {
    const b = document.createElement('button');
    b.textContent = label; b.title = title; b.onclick = fn;
    return b;
  };
  ctrls.appendChild(mk('+', '확대', () => zoomBy(1.25)));
  ctrls.appendChild(mk('−', '축소', () => zoomBy(0.8)));
  ctrls.appendChild(mk('⤢', 'fit', () => { transform = { k: 1, x: 0, y: 0 }; clampTransform(); applyTransform(); }));
  container.appendChild(ctrls);

  // 팬 / 줌 — 드래그 가능 범위는 지도 콘텐츠 자체 크기로 제한한다
  // (clampTransform). 배율이 1 이하로 축소되면 콘텐츠가 뷰포트보다
  // 작아지므로 가운데 고정하고 팬을 잠근다 — 그때는 확대·축소만 남는다.
  let dragging = false;
  let last = null;
  svgEl.addEventListener('mousedown', (e) => {
    if (e.target.closest('.node-hit') || e.target.closest('.arc-hit')) return;
    dragging = true; last = [e.clientX, e.clientY];
  });
  window.addEventListener('mouseup', () => { dragging = false; });
  svgEl.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    transform.x += e.clientX - last[0];
    transform.y += e.clientY - last[1];
    last = [e.clientX, e.clientY];
    clampTransform();
    applyTransform();
  });
  svgEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = svgEl.getBoundingClientRect();
    const cx = (e.clientX - rect.left) * (dims.w / rect.width);
    const cy = (e.clientY - rect.top) * (dims.h / rect.height);
    zoomBy(e.deltaY < 0 ? 1.08 : 0.926, cx, cy);
  }, { passive: false });
  svgEl.addEventListener('click', (e) => {
    if (!e.target.closest('.node-hit') && !e.target.closest('.arc-hit')) setSelection(null);
  });
}

function scaleLabel() {
  const mpp = projection ? milesPerPixel(projection) : null;
  if (!mpp) return '';
  return `≈ ${Math.round((mpp * 80) / 50) * 50} mi`;
}

const ZOOM_MIN = 0.6;
const ZOOM_MAX = 6;

/**
 * 팬 가능 범위를 지도 콘텐츠(dims.w × dims.h, k=1 일 때 뷰포트를 정확히
 * 채우도록 투영을 fit 했다) 자체 크기로 제한한다. 배율이 1 이하로 축소되면
 * 콘텐츠가 뷰포트보다 작아지므로 그 경우엔 가운데로 고정한다 — 빈 여백으로
 * 드래그해 지도를 놓치는 상황을 막는다.
 */
function clampTransform() {
  const k = transform.k;
  const scaledW = dims.w * k;
  const scaledH = dims.h * k;
  transform.x = scaledW <= dims.w
    ? (dims.w - scaledW) / 2
    : Math.min(0, Math.max(dims.w - scaledW, transform.x));
  transform.y = scaledH <= dims.h
    ? (dims.h - scaledH) / 2
    : Math.min(0, Math.max(dims.h - scaledH, transform.y));
}

/** (cx,cy) 뷰포트 좌표를 고정점으로 줌 — 그 아래 콘텐츠가 배율 전후로 같은 화면 위치에 남는다. */
function zoomBy(f, cx = dims.w / 2, cy = dims.h / 2) {
  const k0 = transform.k;
  const k1 = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, k0 * f));
  if (k1 === k0) return;
  const scale = k1 / k0;
  transform.x = cx - (cx - transform.x) * scale;
  transform.y = cy - (cy - transform.y) * scale;
  transform.k = k1;
  clampTransform();
  applyTransform();
}

function applyTransform() {
  if (!zoomG) return;
  zoomG.setAttribute('transform', `translate(${transform.x},${transform.y}) scale(${transform.k})`);
  updateIconScale();
}

/**
 * 노드 · 고객 아이콘에 확대율의 역수를 걸어 화면상 크기를 고정한다. 걸지
 * 않으면 지도를 확대할 때 아이콘도 배율만큼 커져, 노드 간격은 벌어져도
 * 아이콘끼리는 여전히 같은 비율로 겹친 채 남는다 — 확대가 겹침 해소에
 * 아무 도움이 안 된다. 위치(각 그룹의 translate)는 그대로 두고 시각 요소를
 * 담은 내부 iconG 에만 scale(1/k) 를 줘서, 확대할수록 아이콘은 화면에서
 * 같은 크기를 유지하고 간격만 넓어지게 한다.
 */
function updateIconScale() {
  if (!refs) return;
  const s = 1 / transform.k;
  for (const ref of Object.values(refs.nodes)) ref.iconG?.setAttribute('transform', `scale(${s})`);
  for (const ref of Object.values(refs.customers)) ref.iconG?.setAttribute('transform', `scale(${s})`);
  refs.hollandIcon?.setAttribute('transform', `scale(${s})`);
}

// ═══════════════════════════════════════════════════════════════════════
// 프레임 갱신 — 엔진 재호출 없이 result 의 k일 슬라이스만 읽는다
// ═══════════════════════════════════════════════════════════════════════
export function frame(state) {
  if (!refs || !state.result) return;
  const day = state.playhead;
  const r = state.result;
  const sel = state.selection;

  // 노드 상태 링 + 버퍼 게이지
  for (const n of NODES) {
    const p = r.perNode[n.id];
    const st = p.stateTimeline[day] || 'RUNNING';
    const inF = p.inputCapacity > 0 ? p.inputBufferSeries[day] / p.inputCapacity : 0;
    const outF = p.outputCapacity > 0 ? p.outputBufferSeries[day] / p.outputCapacity : 0;

    const ref = refs.nodes[n.id];
    if (!ref) continue;
    ref.ring.setAttribute('stroke', STATUS_COLOR[st]);
    ref.ring.setAttribute('stroke-dasharray', st === 'DOWN' ? '3 2' : 'none');
    if (ref.gauges) {
      paintGauge(ref.gauges.inBar, ref.gauges.inBg, n.type === 'CELL' ? 1 : inF,
        n.type === 'CELL' ? 'var(--status-idle)' : inF < 0.05 ? 'var(--status-danger)' : 'var(--accent)');
      paintGauge(ref.gauges.outBar, ref.gauges.outBg, outF,
        outF > 0.95 ? 'var(--status-warn)' : 'var(--cyan)');
    }
    const on = !sel || (sel.type === 'node' && sel.id === n.id);
    ref.grp.setAttribute('opacity', on ? 1 : 0.2);
  }
  if (refs.nodes[HUB.id]) {
    refs.nodes[HUB.id].grp.setAttribute('opacity', !sel || sel.id === HUB.id ? 1 : 0.2);
  }

  // 고객 — 지연 마커
  for (const c of CUSTOMERS) {
    const ref = refs.customers[c.id];
    if (!ref) continue;
    const late = r.perCustomer[c.id].orders.some(
      (o) => o.dueDay + appState.config.customers[c.id].graceDays < day && o.deliveredMWh < o.qtyMWh - 1e-9
    );
    ref.marker.setAttribute('opacity', late ? 1 : 0);
    ref.body.setAttribute('stroke', late ? 'var(--status-crit)' : 'var(--text-muted)');
    const on = !sel || (sel.type === 'customer' && sel.id === c.id);
    ref.grp.setAttribute('opacity', on ? 1 : 0.2);
  }

  // 아크 굵기 = 최근 7일 이동평균 물동량
  let maxMA = 1e-6;
  const ma = {};
  for (const id of Object.keys(refs.arcs)) {
    const s = r.perLane[id].shippedSeries;
    let acc = 0;
    for (let i = Math.max(0, day - 6); i <= day; i++) acc += s[i] || 0;
    ma[id] = acc / 7;
    maxMA = Math.max(maxMA, ma[id]);
  }
  for (const [id, ref] of Object.entries(refs.arcs)) {
    const w = 1 + (ma[id] / maxMA) * 5;
    ref.stroke.setAttribute('stroke-width', w.toFixed(2));
    const delayed = r.perLane[id].avgTransitDays > r.perLane[id].baseTransitDays + 0.5;
    ref.stroke.setAttribute('stroke', delayed ? 'var(--status-warn)' : 'var(--border-strong)');
    ref.stroke.setAttribute('stroke-dasharray', delayed ? '8 6' : '5 5');
    ref.stroke.classList.toggle('flowing', ma[id] > 1e-6);
    const on = !sel || (sel.type === 'lane' && sel.id === id) ||
      (sel.type === 'node' && (id.startsWith(sel.id + '-') || id.endsWith('>' + sel.id) || id.endsWith('->' + sel.id)));
    ref.stroke.setAttribute('opacity', on ? 0.9 : 0.2);
  }

  // 이동 중 화물을 아크 위 점으로 (최대 40개)
  clear(refs.dots);
  const inflight = r.shipments.filter((s) => s.departDay <= day && s.arriveDay > day && refs.arcs[s.laneId]);
  const step = Math.max(1, Math.ceil(inflight.length / MAX_DOTS));
  for (let i = 0; i < inflight.length; i += step) {
    const s = inflight[i];
    const path = refs.arcs[s.laneId].path;
    let len = 0;
    try { len = path.getTotalLength(); } catch { continue; }
    const t = Math.max(0, Math.min(1, (day - s.departDay) / Math.max(1, s.transitDays)));
    const pt = path.getPointAtLength(t * len);
    refs.dots.appendChild(svg('circle', {
      cx: pt.x, cy: pt.y, r: s.expedited ? 2.2 : 1.6,
      fill: s.expedited ? 'var(--status-warn)' : 'var(--cyan)',
    }));
  }

  // 반사실 유령선
  if (state.showCounterfactual && state.counterfactual) {
    for (const [id, ref] of Object.entries(refs.arcs)) {
      const cf = state.counterfactual.perLane[id];
      let acc = 0;
      for (let i = Math.max(0, day - 6); i <= day; i++) acc += cf.shippedSeries[i] || 0;
      const w = 1 + (acc / 7 / maxMA) * 5;
      const ghost = svg('path', {
        d: ref.stroke.getAttribute('d'), fill: 'none',
        stroke: 'var(--ghost)', 'stroke-width': w.toFixed(2), 'stroke-dasharray': '2 4',
      });
      refs.dots.appendChild(ghost);
    }
  }
}

function paintGauge(bar, bg, f, color) {
  const h = Number(bg.getAttribute('height'));
  const y0 = Number(bg.getAttribute('y'));
  const fh = Math.max(0, Math.min(1, f)) * h;
  bar.setAttribute('height', fh);
  bar.setAttribute('y', y0 + h - fh);
  bar.setAttribute('fill', color);
}
