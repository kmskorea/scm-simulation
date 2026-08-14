// ═══════════════════════════════════════════════════════════════════════════
// src/geo.js — Albers USA 등적 원뿔 투영 + 최소 path 생성기
//
// 왜 직접 구현했나
//   §1 은 d3 v7 을 '허용 CDN'으로 두지만 필수로 요구하지는 않는다. 노드 배치는
//   이 앱의 지리적 논거 자체 — AZ 가 중서부에서 물리적으로 멀다 — 를 떠받치므로
//   CDN 도달 여부에 걸려 있으면 안 된다. 투영은 여기서 직접 계산하고,
//   외곽 실루엣만 topojson-client 로 디코드한다(실패해도 앱은 그대로 동작).
//
//   파라미터는 d3.geoAlbersUsa 의 본토(lower 48) 설정과 동일하다:
//     parallels [29.5°, 45.5°] · rotate [96°, 0] · center [-0.6°, 38.7°]
//   알래스카/하와이 인셋은 구현하지 않는다 — 본 네트워크에 해당 노드가 없다.
// ═══════════════════════════════════════════════════════════════════════════

const RAD = Math.PI / 180;
const PARALLEL_0 = 29.5 * RAD;
const PARALLEL_1 = 45.5 * RAD;
const LAMBDA_0 = -96 * RAD;
const PHI_CENTER = 38.7 * RAD;

const N = 0.5 * (Math.sin(PARALLEL_0) + Math.sin(PARALLEL_1));
const C = Math.cos(PARALLEL_0) ** 2 + 2 * N * Math.sin(PARALLEL_0);
const RHO_0 = Math.sqrt(C - 2 * N * Math.sin(PHI_CENTER)) / N;

/** 경위도 → 단위 스케일 평면 좌표 (y 는 위쪽이 음수인 화면 좌표계). */
export function albersRaw(lng, lat) {
  const lambda = lng * RAD - LAMBDA_0;
  const phi = lat * RAD;
  const q = C - 2 * N * Math.sin(phi);
  if (q < 0) return null;
  const rho = Math.sqrt(q) / N;
  const theta = N * lambda;
  return [rho * Math.sin(theta), RHO_0 - rho * Math.cos(theta)];
}

// 본토 외곽 범위 — fitExtent 기준점 (미국 48주 대략 bbox 둘레를 샘플링)
const US_BOUNDS = { lng0: -124.8, lng1: -66.9, lat0: 24.4, lat1: 49.4 };

function rawBounds() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const step = 0.5;
  const push = (lng, lat) => {
    const p = albersRaw(lng, lat);
    if (!p) return;
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
    y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
  };
  for (let lng = US_BOUNDS.lng0; lng <= US_BOUNDS.lng1; lng += step) {
    push(lng, US_BOUNDS.lat0);
    push(lng, US_BOUNDS.lat1);
  }
  for (let lat = US_BOUNDS.lat0; lat <= US_BOUNDS.lat1; lat += step) {
    push(US_BOUNDS.lng0, lat);
    push(US_BOUNDS.lng1, lat);
  }
  return { x0, y0, x1, y1 };
}

const RAW = rawBounds();

/**
 * [[x0,y0],[x1,y1]] 박스에 미국 본토를 맞춘 투영 함수를 만든다.
 * 반환값은 d3 투영과 같은 형태의 호출 가능 함수: projection([lng, lat]) -> [x, y]
 */
export function albersUsa(extent) {
  const [[ex0, ey0], [ex1, ey1]] = extent;
  const bw = RAW.x1 - RAW.x0;
  const bh = RAW.y1 - RAW.y0;
  const k = Math.min((ex1 - ex0) / bw, (ey1 - ey0) / bh);
  const tx = ex0 + ((ex1 - ex0) - bw * k) / 2 - RAW.x0 * k;
  const ty = ey0 + ((ey1 - ey0) - bh * k) / 2 - RAW.y0 * k;

  const proj = (coords) => {
    const p = albersRaw(coords[0], coords[1]);
    if (!p) return null;
    return [p[0] * k + tx, p[1] * k + ty];
  };
  proj.scale = k;
  proj.isAlbers = true;
  return proj;
}

/**
 * GeoJSON (Polygon / MultiPolygon) → SVG path d 문자열.
 * d3-geo 없이도 실루엣을 그리기 위한 최소 구현.
 */
export function geoPathString(geometry, project) {
  const parts = [];
  const ring = (coords) => {
    let d = '';
    let prev = null;
    for (const c of coords) {
      const p = project(c);
      if (!p) continue;
      // 10m 해상도는 점이 촘촘하므로 0.4px 미만 이동은 버려 경로를 가볍게 한다
      if (prev && Math.abs(p[0] - prev[0]) < 0.4 && Math.abs(p[1] - prev[1]) < 0.4) continue;
      d += `${d ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
      prev = p;
    }
    if (d) parts.push(d + 'Z');
  };

  const walk = (geom) => {
    if (!geom) return;
    if (geom.type === 'GeometryCollection') { geom.geometries.forEach(walk); return; }
    if (geom.type === 'FeatureCollection') { geom.features.forEach((f) => walk(f.geometry)); return; }
    if (geom.type === 'Feature') { walk(geom.geometry); return; }
    if (geom.type === 'Polygon') { geom.coordinates.forEach(ring); return; }
    if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates) poly.forEach(ring);
    }
  };
  walk(geometry);
  return parts.join('');
}

/** 축척 바 라벨용 — 화면 80px 이 실제 몇 마일인지. */
export function milesPerPixel(project, atLat = 39) {
  const a = project([-100, atLat]);
  const b = project([-99, atLat]);
  if (!a || !b) return null;
  const px = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const MILES_PER_DEG_LNG = Math.cos(atLat * RAD) * 69.17;
  return px > 0.01 ? MILES_PER_DEG_LNG / px : null;
}
