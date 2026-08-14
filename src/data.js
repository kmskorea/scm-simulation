// ═══════════════════════════════════════════════════════════════════════════
// src/data.js — 마스터 데이터 + 모든 상수
//
// 이 파일 밖에서 하드코딩된 수치를 쓰지 않는다. 모든 가정·placeholder는
// 여기 상단에 모으고 출처/검증여부를 주석으로 남긴다.
// 단위 규약: 내부 계산은 전부 MWh / mile / day / USD.
// ═══════════════════════════════════════════════════════════════════════════

export const META = {
  title: 'ESS SUPPLY CHAIN DIGITAL TWIN',
  subtitle: 'LGES NA · CELL → PACK → LINK → CUSTOMER',
  caption: 'SIMULATED · LGES NA ESS NETWORK · DISTANCE DATA UNVERIFIED',
  distanceSource: '거리 데이터 출처: LGES 물류 슬라이드 (미검증)',
};

// ───────────────────────────────────────────────────────────────────────────
// 1. BOM — 확정값 (검증됨)
// ───────────────────────────────────────────────────────────────────────────
export const BOM = {
  cellWh: 509.4, // Wh/cell — 확정
  cellsPerPack: 120, // 확정
  packsPerLink: 84, // 확정
};

// 파생 단위 — 계산으로 유도한다. 하드코딩 금지.
export const UNITS = {
  cellMWh: BOM.cellWh / 1e6, //            0.0005094 MWh
  packMWh: (BOM.cellWh * BOM.cellsPerPack) / 1e6, //   0.061128  MWh (= 61.128 kWh)
  linkMWh: (BOM.cellWh * BOM.cellsPerPack * BOM.packsPerLink) / 1e6, // 5.134752 MWh
  cellsPerLink: BOM.cellsPerPack * BOM.packsPerLink, //           10,080
};

// ───────────────────────────────────────────────────────────────────────────
// 2. 명시적 가정 (§9) — UI 푸터/설정 패널에 그대로 노출한다
// ───────────────────────────────────────────────────────────────────────────
export const UPSTREAM_MODEL = 'infinite'; // 확장 지점: 양극재/음극재/분리막/전해액 제약 미모델링

export const ASSUMPTIONS = [
  {
    id: 'upstream',
    text: '상류 자재(양극재/음극재/분리막/전해액)는 무한 공급 가정 — 범위 밖',
    tag: 'SCOPE',
  },
  { id: 'hub', text: 'CHI Hub는 통과 환적(cross-dock), 보관 기능 없음', tag: 'MODEL' },
  { id: 'dist', text: '거리 데이터는 LGES 물류 슬라이드 기준, 일부 미검증', tag: 'UNVERIFIED' },
  { id: 'wh', text: '창고 capacity는 실측값 부재 → 일수 기준 추정, 레버화', tag: 'ESTIMATE' },
  {
    id: 'ld',
    text: '계약가 $350K/MWh, LD 0.2%/일·상한 10%는 placeholder',
    tag: 'PLACEHOLDER',
  },
  { id: 'capa', text: '이론 CAPA는 Pack이 병목이 되도록 역산한 가정치', tag: 'ESTIMATE' },
];

// ───────────────────────────────────────────────────────────────────────────
// 3. 엔진 상수
// ───────────────────────────────────────────────────────────────────────────
export const SIM = {
  horizonDays: 120,
  daysPerMonth: 30, // 주문 스케줄 단순화 — 1개월 = 30일
  roadFactor: 1.25, // haversine → 도로거리 우회계수 (레버 노출)
  milesPerDay: 550, // 트럭 일 주행거리 기본 (레버 400~700)
  loadUnloadDays: 1, // 상하차 (레버 0~3)
  hubDwellDays: 1, // CHI 환적 체류 (레버 0~3)

  // 초기 재고 — 실측값 부재. 정상가동 시작 상태를 흉내내기 위한 가정.
  // TODO: 실제 값 (기초 재고 실사)
  //
  // 중간 단계(Cell/Pack)의 출고 재고는 낮게 시작한다. 체인이 균형 설계라
  // (Pack 여유 0%) 기초 FGI 는 정상 운전 중에 배출될 곳이 없어 그대로 남고,
  // 남은 만큼 BLOCKING 여유가 깎인다. 완제품(Link)은 반대로 월 5회 인도
  // 러시를 받아내야 하므로 높게 시작한다.
  // 안전재고 = 입고창고의 25% (≈ 1.25일). 나머지 커버리지는 파이프라인이 담당한다.
  initialInputFillPct: 0.25,
  // 보충 목표 = 입고창고 × 이 비율 + 리드타임 소요분. 표준 order-up-to 정책이다.
  // 이동 중 물량을 창고 용량에서 그냥 빼면(= 리드타임 소요분을 안 더하면)
  // '창고 일수 ≈ 수송 일수'인 구간(AZL: 창고 5일 / 수송 5일)에서 현물 재고가
  // 0 으로 수렴해, 상류가 조금만 흔들려도 즉시 STARVED 가 된다.
  targetInputFillPct: 0.25,
  initialOutputFillPct: { CELL: 0.35, PACK: 0.35, LINK: 0.6 },

  // 계획이 겨냥하는 출고재고 수준. replan 때 '인지된' 재고를 이 값으로 되돌리는
  // 방향으로 생산율을 보정한다 (MRP 의 재고 상계). Link 는 생기는 대로 고객에게
  // 밀어내므로 목표 0.
  targetOutputFillPct: { CELL: 0.35, PACK: 0.35, LINK: 0.0 },
  inventoryCorrectionDays: 10, // 재고 편차를 며칠에 걸쳐 되돌릴 것인가
  // 불감대. 계획주기 7일 + frozen 14일이라 되먹임에 죽은 시간이 길어서, 몇 %의
  // 재고 흔들림까지 매번 생산율을 고쳐잡으면 계통이 진동한다(= 인위적 bullwhip).
  // 실제 계획자도 이 정도 편차로는 레이트를 건드리지 않는다.
  inventoryDeadBandPct: 0.15,

  // 고객 출하 착수 선행일. 인도일이 월 5회(5/10/15/20/25)에 몰려 있어 한 날짜에
  // 최대 29 Link ≈ 149 MWh 가 몰리는데 AZL 출고버퍼는 4일 ≈ 91 MWh 뿐이다.
  // 즉 완제품을 쌓아 두고 치는 구조가 물리적으로 불가능하므로, 생산되는 대로
  // 납기 임박순으로 계속 밀어내야 한다 → 창을 넉넉히 연다.
  preShipDays: 21,
  ttsProbeStartDay: 20, // TTS 계산 시 장애 주입 시점
  freeStorageDays: 2, // 이 일수 초과분만 '초과보관비' 부과
  monteCarloRuns: 200,
  epsilon: 1e-9,
};

// ───────────────────────────────────────────────────────────────────────────
// 4. 노드 — 좌표는 placeholder.  // TODO: 실좌표 검증
// ───────────────────────────────────────────────────────────────────────────
export const NODES = [
  // Cell 공장 (5)
  { id: 'ESMI_H', name: 'ESMI Holland', short: 'ESMI-H', type: 'CELL', place: 'Holland, MI', state: 'MI', lat: 42.79, lng: -86.11, owner: 'LGES', capaPerHour: 0.42 },
  { id: 'ESMI_L', name: 'ESMI Lansing', short: 'ESMI-L', type: 'CELL', place: 'Lansing, MI', state: 'MI', lat: 42.73, lng: -84.55, owner: 'LGES', capaPerHour: 0.28 },
  { id: 'ESST', name: 'ESST', short: 'ESST', type: 'CELL', place: 'Spring Hill, TN', state: 'TN', lat: 35.75, lng: -87.04, owner: 'JV', capaPerHour: 0.24 },
  { id: 'ESHD', name: 'ESHD', short: 'ESHD', type: 'CELL', place: 'Jeffersonville, OH', state: 'OH', lat: 39.65, lng: -83.56, owner: 'JV', capaPerHour: 0.22 },
  { id: 'UC2', name: 'UC2', short: 'UC2', type: 'CELL', place: 'Lordstown, OH', state: 'OH', lat: 41.24, lng: -80.81, owner: 'JV', capaPerHour: 0.18 },
  // Pack 공장 (2)
  { id: 'PW1', name: 'PW1 (People Works)', short: 'PW1', type: 'PACK', place: 'Holland, MI', state: 'MI', lat: 42.80, lng: -86.09, owner: '외주', capaPerHour: 0.62 },
  { id: 'PW2', name: 'PW2 (신규)', short: 'PW2', type: 'PACK', place: 'Holland, MI', state: 'MI', lat: 42.81, lng: -86.13, owner: '외주', capaPerHour: 0.48 },
  // Link 조립 (1)
  { id: 'AZL', name: 'AZ Link Line', short: 'AZL', type: 'LINK', place: 'Queen Creek, AZ', state: 'AZ', lat: 33.25, lng: -111.63, owner: 'LGES', capaPerHour: 1.15 },
];

// Hub — 생산능력 없음. 통과 환적만.
export const HUB = {
  id: 'CHI',
  name: 'CHI Hub W/H',
  short: 'CHI',
  type: 'HUB',
  place: 'Chicago, IL',
  state: 'IL',
  lat: 41.85,
  lng: -87.65,
  owner: '3PL',
  mode: 'cross-dock', // 보관 없음. dwellDays 만 리드타임에 가산.
};

export const PRODUCTION_NODE_IDS = NODES.map((n) => n.id);
export const CELL_IDS = NODES.filter((n) => n.type === 'CELL').map((n) => n.id);
export const PACK_IDS = NODES.filter((n) => n.type === 'PACK').map((n) => n.id);
export const LINK_IDS = NODES.filter((n) => n.type === 'LINK').map((n) => n.id);

// 노드별 라벨 수동 배치 (자동 배치 금지 — 겹치면 인포그래픽 실격)
export const LABEL_OFFSETS = {
  ESMI_H: { dx: 0, dy: -14, anchor: 'middle' },
  ESMI_L: { dx: 12, dy: 4, anchor: 'start' },
  ESST: { dx: 0, dy: 20, anchor: 'middle' },
  ESHD: { dx: 12, dy: 12, anchor: 'start' },
  UC2: { dx: 12, dy: -6, anchor: 'start' },
  PW1: { dx: -12, dy: -4, anchor: 'end' },
  PW2: { dx: -12, dy: 10, anchor: 'end' },
  AZL: { dx: 0, dy: 22, anchor: 'middle' },
  CHI: { dx: 0, dy: -13, anchor: 'middle' },
  NEER_ND: { dx: 0, dy: -9, anchor: 'middle' },
  DESRI_MN: { dx: 8, dy: -6, anchor: 'start' },
  DTE_MI: { dx: 9, dy: 10, anchor: 'start' },
  AVANGRID_OR: { dx: -8, dy: -6, anchor: 'end' },
  NEER_CA: { dx: -8, dy: 0, anchor: 'end' },
  IOWN_NV: { dx: 0, dy: -9, anchor: 'middle' },
  AVANTUS_CA: { dx: -8, dy: 10, anchor: 'end' },
  TERRAGEN_CA: { dx: -8, dy: 12, anchor: 'end' },
  SBE_NM: { dx: 0, dy: 15, anchor: 'middle' },
  NEER_AZ: { dx: -7, dy: 13, anchor: 'end' },
  HYUNDAI_TX: { dx: 0, dy: 15, anchor: 'middle' },
  NEER_FL: { dx: 7, dy: 8, anchor: 'start' },
};

// ───────────────────────────────────────────────────────────────────────────
// 5. 고객 (12) — 전량 AZL 직송
// ───────────────────────────────────────────────────────────────────────────
const DELIVERY_DAYS = [5, 10, 15, 20, 25];

export const CUSTOMERS = [
  { id: 'NEER_ND', name: 'Neer', poCode: 'NND', state: 'ND', lat: 47.0, lng: -100.5, monthlyLinks: 10, priorityTier: 2 },
  { id: 'DESRI_MN', name: 'Desri', poCode: 'DMN', state: 'MN', lat: 45.0, lng: -94.5, monthlyLinks: 8, priorityTier: 3 },
  { id: 'DTE_MI', name: 'DTE / RWE', poCode: 'DMI', state: 'MI', lat: 42.3, lng: -83.0, monthlyLinks: 12, priorityTier: 1 },
  { id: 'AVANGRID_OR', name: 'Avangrid', poCode: 'AOR', state: 'OR', lat: 44.0, lng: -120.5, monthlyLinks: 9, priorityTier: 2 },
  { id: 'NEER_CA', name: 'Neer', poCode: 'NCA', state: 'CA', lat: 35.5, lng: -119.0, monthlyLinks: 11, priorityTier: 1 },
  { id: 'IOWN_NV', name: 'IOWN / Q-Cells', poCode: 'INV', state: 'NV', lat: 39.0, lng: -117.0, monthlyLinks: 8, priorityTier: 3 },
  { id: 'AVANTUS_CA', name: 'Avantus', poCode: 'ACA', state: 'CA', lat: 34.5, lng: -117.5, monthlyLinks: 10, priorityTier: 2 },
  { id: 'TERRAGEN_CA', name: 'Terragen', poCode: 'TCA', state: 'CA', lat: 33.9, lng: -116.5, monthlyLinks: 9, priorityTier: 3 },
  { id: 'SBE_NM', name: 'SB Energy / Desri', poCode: 'SNM', state: 'NM', lat: 34.5, lng: -106.0, monthlyLinks: 10, priorityTier: 2 },
  { id: 'NEER_AZ', name: 'Neer', poCode: 'NAZ', state: 'AZ', lat: 33.4, lng: -112.0, monthlyLinks: 12, priorityTier: 1 },
  { id: 'HYUNDAI_TX', name: 'Hyundai / OCI', poCode: 'HTX', state: 'TX', lat: 31.5, lng: -99.0, monthlyLinks: 11, priorityTier: 1 },
  { id: 'NEER_FL', name: 'Neer', poCode: 'NFL', state: 'FL', lat: 28.5, lng: -81.5, monthlyLinks: 10, priorityTier: 2 },
].map((c, i) => ({ ...c, deliveryDayOfMonth: DELIVERY_DAYS[i % DELIVERY_DAYS.length] }));

// 계약 조건 전역 기본값 — 전부 placeholder (§9-5)
export const CONTRACT_DEFAULTS = {
  contractValuePerMWh: 350000, // USD/MWh — TODO: 실제 값
  graceDays: 3,
  ldRatePerDay: 0.002, // 계약가 0.2%/일
  ldCapPct: 0.10, // 상한 10%
};

export const PO_BASE_YEAR_MONTH = { year: 26, month: 1 }; // PO-XXX-2601 … 2604

// ───────────────────────────────────────────────────────────────────────────
// 6. 거리 — 슬라이드 확정값 우선, 나머지는 haversine × roadFactor
//    // 검증 필요: 일부 값이 실도로거리와 어긋난다.
//      · CHI(2,024mi)가 Holland(1,882mi)보다 AZ에서 멀게 표기됨
//      · Holland↔Lansing 311mi — 실제 약 90mi
//    슬라이드 값을 그대로 쓰되 여기 분리해 둔다.
// ───────────────────────────────────────────────────────────────────────────
export const DISTANCE_OVERRIDES = {
  'AZL|ESMI_H': 1882,
  'AZL|CHI': 2024,
  'AZL|PW1': 1745,
  'AZL|PW2': 1745,
  'ESMI_H|ESMI_L': 311, // 검증 필요
  'ESHD|PW1': 517,
  'ESHD|PW2': 517,
  'ESST|PW1': 331,
  'ESST|PW2': 331,
  'ESMI_H|PW1': 174,
  'ESMI_H|PW2': 174,
};

export function distanceKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

const R_MILES = 3958.7613;
export function haversineMiles(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_MILES * Math.asin(Math.sqrt(s));
}

const GEO = {};
for (const n of NODES) GEO[n.id] = n;
GEO[HUB.id] = HUB;
for (const c of CUSTOMERS) GEO[c.id] = c;
export const GEO_INDEX = GEO;

/** 두 지점 사이 거리(mile). override 있으면 그 값, 없으면 haversine × roadFactor. */
export function milesBetween(aId, bId, roadFactor = SIM.roadFactor) {
  const k = distanceKey(aId, bId);
  if (DISTANCE_OVERRIDES[k] != null) return DISTANCE_OVERRIDES[k];
  const a = GEO[aId];
  const b = GEO[bId];
  if (!a || !b) throw new Error(`unknown geo node: ${aId} / ${bId}`);
  return Math.round(haversineMiles(a, b) * roadFactor);
}

export function isOverriddenDistance(aId, bId) {
  return DISTANCE_OVERRIDES[distanceKey(aId, bId)] != null;
}

// ───────────────────────────────────────────────────────────────────────────
// 7. Lane — 구간별 적재 단위가 다르다 (§2.5)
//    Link 완제품 컨테이너는 트럭 1대당 1기가 물리적 한계(약 37톤).
//    확인된 "트럭당 39대"는 Pack 단위다.
// ───────────────────────────────────────────────────────────────────────────
export const LANE_TYPES = {
  cellToPack: { id: 'cellToPack', label: 'CELL → PACK', unit: 'CELL', unitMWh: UNITS.cellMWh, defaultLoad: 3600, min: 1200, max: 12000, step: 100 },
  packToLink: { id: 'packToLink', label: 'PACK → LINK', unit: 'PACK', unitMWh: UNITS.packMWh, defaultLoad: 39, min: 10, max: 120, step: 1 },
  linkToCustomer: { id: 'linkToCustomer', label: 'LINK → CUSTOMER', unit: 'LINK', unitMWh: UNITS.linkMWh, defaultLoad: 1, min: 1, max: 40, step: 1 },
};

/** 논리 토폴로지에서 구체 Lane 목록을 생성한다. */
export function buildLanes() {
  const lanes = [];
  const push = (from, to, laneType, role) =>
    lanes.push({ id: `${from}->${to}`, from, to, laneType, role });

  for (const c of CELL_IDS) for (const p of PACK_IDS) push(c, p, 'cellToPack', 'production');
  for (const p of PACK_IDS) push(p, 'AZL', 'packToLink', 'direct');
  for (const p of PACK_IDS) push(p, HUB.id, 'packToLink', 'toHub');
  push(HUB.id, 'AZL', 'packToLink', 'fromHub');
  for (const cu of CUSTOMERS) push('AZL', cu.id, 'linkToCustomer', 'delivery');
  return lanes;
}

export const LANES = buildLanes();
export const LANE_INDEX = Object.fromEntries(LANES.map((l) => [l.id, l]));

// ───────────────────────────────────────────────────────────────────────────
// 8. 원가 (§2.7) — 슬라이드 물류비 버킷 구조. 상류 자재 물류비(①)는 범위 밖.
// ───────────────────────────────────────────────────────────────────────────
export const COST_DEFAULTS = {
  freightPerMileTruck: 2.35, // USD/mile — TODO: 실제 요율
  hubHandlingPerTruck: 180, // 환적 취급비
  storagePerMWhDay: 42, // Link 보관비
  idleCostPerHour: { CELL: 8500, PACK: 3200, LINK: 2400 }, // 감가 + 인건
  expediteMultiplier: 3.2,
  inventoryValuePerMWh: 180000, // TODO: 실제 재공품 평가액
};

// ───────────────────────────────────────────────────────────────────────────
// 9. 레버 기본값
// ───────────────────────────────────────────────────────────────────────────
export const NODE_LEVER_DEFAULTS = {
  operatingHoursPerDay: 24,
  operatingDaysPerWeek: 7,
  availability: 0.88,
  yield: 0.94,
  inputBufferDays: 5,
  outputBufferDays: 4,
  mtbfDays: 45, // 확률모드 비계획 다운타임
  mttrDays: 2,
};

export const NODE_LEVER_SPEC = [
  { key: 'theoreticalCapaPerHour', label: '이론 CAPA', kind: 'number', unit: 'MWh/h', min: 0.01, max: 4, step: 0.01 },
  { key: 'operatingHoursPerDay', label: '조업시간', kind: 'slider', unit: 'h/day', min: 8, max: 24, step: 1 },
  { key: 'operatingDaysPerWeek', label: '조업일수', kind: 'segmented', unit: 'day/wk', options: [5, 6, 7] },
  { key: 'availability', label: '가동률', kind: 'slider', unit: '%', min: 0.5, max: 1, step: 0.005, pct: true },
  { key: 'yield', label: '수율', kind: 'slider', unit: '%', min: 0.8, max: 0.999, step: 0.001, pct: true },
  { key: 'inputBufferDays', label: '입고창고', kind: 'slider', unit: 'day', min: 0.5, max: 30, step: 0.5 },
  { key: 'outputBufferDays', label: '출고창고', kind: 'slider', unit: 'day', min: 0.5, max: 30, step: 0.5 },
];

export const SHIPPING_DEFAULTS = {
  frequency: 'daily', // 'daily' | 'weekly'
  shipDaysOfWeek: [1, 3, 5],
  minLoadPct: 0.8, // 이 미만이면 대기 → batch effect (bullwhip 발원지)
  forceShipAfterDays: 3,
  routeViaHub: false,
  expediteEnabled: true,
  expediteSpeedup: 0.5,
  expediteCostMultiplier: 3.2,
  milesPerDay: SIM.milesPerDay,
  loadUnloadDays: SIM.loadUnloadDays,
};

export const PLANNING_DEFAULTS = {
  replanCycleDays: 7,
  frozenWindowDays: 14,
  infoLagDays: 3,
  allocationRule: 'dueDate', // dueDate | penaltyValue | priorityTier | proRata | fcfs
};

export const ALLOCATION_RULES = [
  { id: 'dueDate', label: 'DUE DATE', desc: '납기 임박순' },
  { id: 'penaltyValue', label: 'PENALTY', desc: '페널티 노출액 큰 순' },
  { id: 'priorityTier', label: 'TIER', desc: '계약 등급순' },
  { id: 'proRata', label: 'PRO-RATA', desc: '비례 배분' },
  { id: 'fcfs', label: 'FCFS', desc: '접수순' },
];

// ───────────────────────────────────────────────────────────────────────────
// 10. 기본 config 생성 — 이것이 유일한 진실의 원천(single source of truth)
// ───────────────────────────────────────────────────────────────────────────
export function buildDefaultConfig() {
  const nodes = {};
  for (const n of NODES) {
    nodes[n.id] = {
      theoreticalCapaPerHour: n.capaPerHour,
      ...NODE_LEVER_DEFAULTS,
      plannedDowntime: [], // [{ startDay, durationDays, label }]
    };
  }
  const lanes = {};
  for (const l of LANES) {
    const t = LANE_TYPES[l.laneType];
    lanes[l.id] = {
      truckLoad: t.defaultLoad,
      frequency: SHIPPING_DEFAULTS.frequency,
      shipDaysOfWeek: [...SHIPPING_DEFAULTS.shipDaysOfWeek],
      minLoadPct: SHIPPING_DEFAULTS.minLoadPct,
      forceShipAfterDays: SHIPPING_DEFAULTS.forceShipAfterDays,
      milesPerDay: SHIPPING_DEFAULTS.milesPerDay,
      loadUnloadDays: SHIPPING_DEFAULTS.loadUnloadDays,
      expediteEnabled: SHIPPING_DEFAULTS.expediteEnabled,
      expediteSpeedup: SHIPPING_DEFAULTS.expediteSpeedup,
      expediteCostMultiplier: SHIPPING_DEFAULTS.expediteCostMultiplier,
    };
  }
  const customers = {};
  for (const c of CUSTOMERS) {
    customers[c.id] = {
      monthlyLinks: c.monthlyLinks,
      deliveryDayOfMonth: c.deliveryDayOfMonth,
      priorityTier: c.priorityTier,
      ...CONTRACT_DEFAULTS,
    };
  }
  return {
    version: 2,
    seed: 20260101,
    horizonDays: SIM.horizonDays,
    stochastic: false,
    monteCarloRuns: SIM.monteCarloRuns,
    roadFactor: SIM.roadFactor,
    hubDwellDays: SIM.hubDwellDays,
    routeViaHub: SHIPPING_DEFAULTS.routeViaHub,
    nodes,
    lanes,
    customers,
    planning: { ...PLANNING_DEFAULTS },
    cost: JSON.parse(JSON.stringify(COST_DEFAULTS)),
    disruptions: [], // §3.5
    actions: [], // OPERATE 모드 Action 큐 — { day, type, ... }
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 11. 시나리오 프리셋 (6종)
// ───────────────────────────────────────────────────────────────────────────
export const PRESETS = [
  { id: 'BASELINE', label: 'BASELINE', desc: '장애 없음 · 검증 기준선', disruptions: [] },
  {
    id: 'PACK_DOWN',
    label: 'PACK LINE DOWN 5D',
    desc: 'PW1 5일 정지 — 상류 BLOCKING / 하류 STARVING 시차 확인',
    disruptions: [{ type: 'nodeDown', target: 'PW1', startDay: 20, durationDays: 5 }],
  },
  {
    id: 'LANE_DELAY',
    label: 'LANE DELAY +4D',
    desc: 'PW1→AZL 구간 14일간 +4일 지연',
    disruptions: [{ type: 'laneDelay', target: 'PW1->AZL', startDay: 25, durationDays: 14, extraDays: 4 }],
  },
  {
    id: 'YIELD_DROP',
    label: 'YIELD DROP',
    desc: 'ESST 수율 −5%p 20일',
    disruptions: [{ type: 'yieldDrop', target: 'ESST', startDay: 15, durationDays: 20, deltaPct: -0.05 }],
  },
  {
    id: 'DEMAND_SURGE',
    label: 'DEMAND SURGE',
    desc: 'NEER_AZ 수요 ×1.5',
    disruptions: [{ type: 'demandSpike', target: 'NEER_AZ', startDay: 40, multiplier: 1.5 }],
  },
  {
    id: 'COMPOUND',
    label: 'COMPOUND',
    desc: '복합 장애 — Pack 정지 + CAPA 저하 + 구간 지연. 완충재고가 소진되어 LD 가 터진다.',
    disruptions: [
      { type: 'nodeDown', target: 'PW1', startDay: 20, durationDays: 12 },
      { type: 'capacityDrop', target: 'ESMI_H', startDay: 38, durationDays: 14, pct: 0.4 },
      { type: 'laneDelay', target: 'PW2->AZL', startDay: 30, durationDays: 14, extraDays: 4 },
      { type: 'yieldDrop', target: 'ESST', startDay: 45, durationDays: 20, deltaPct: -0.05 },
    ],
  },
];

export const DISRUPTION_TYPES = [
  { id: 'nodeDown', label: 'NODE DOWN', targets: 'node', fields: ['startDay', 'durationDays'] },
  { id: 'capacityDrop', label: 'CAPACITY DROP', targets: 'node', fields: ['startDay', 'durationDays', 'pct'] },
  { id: 'yieldDrop', label: 'YIELD DROP', targets: 'node', fields: ['startDay', 'durationDays', 'deltaPct'] },
  { id: 'laneDelay', label: 'LANE DELAY', targets: 'lane', fields: ['startDay', 'durationDays', 'extraDays'] },
  { id: 'demandSpike', label: 'DEMAND SPIKE', targets: 'customer', fields: ['startDay', 'multiplier'] },
];

// ───────────────────────────────────────────────────────────────────────────
// 12. Foundry Ontology 매핑 (§4.4-⑤)
// ───────────────────────────────────────────────────────────────────────────
export const ONTOLOGY = {
  objectTypes: [
    { id: 'Facility', props: ['facilityId', 'name', 'geo', 'owner', 'stage'] },
    { id: 'ProductionLine', props: ['lineId', 'theoreticalCapaPerHour', 'availability', 'yield'] },
    { id: 'Shipment', props: ['shipmentId', 'laneId', 'qtyMWh', 'departDay', 'arriveDay', 'expedited'] },
    { id: 'InventoryPosition', props: ['facilityId', 'bucket', 'qtyMWh', 'daysOfSupply'] },
    { id: 'CustomerSite', props: ['siteId', 'name', 'state', 'priorityTier'] },
    { id: 'PurchaseOrder', props: ['poId', 'siteId', 'qtyLinks', 'dueDay', 'status', 'penaltyUSD'] },
    { id: 'DisruptionEvent', props: ['eventId', 'type', 'target', 'startDay', 'durationDays'] },
  ],
  linkTypes: [
    { from: 'Facility', to: 'ProductionLine', name: 'operates' },
    { from: 'Shipment', to: 'PurchaseOrder', name: 'fulfills' },
    { from: 'InventoryPosition', to: 'Facility', name: 'heldAt' },
    { from: 'Shipment', to: 'Facility', name: 'originatesFrom' },
    { from: 'DisruptionEvent', to: 'Facility', name: 'impacts' },
    { from: 'PurchaseOrder', to: 'CustomerSite', name: 'placedBy' },
  ],
  actionTypes: [
    { id: 'ExpediteShipment', sim: 'expediteShipment', applies: ['lane', 'shipment'], desc: '리드타임 ×0.5 · 운임 ×3.2' },
    { id: 'ReallocateInventory', sim: 'reallocateInventory', applies: ['node'], desc: '노드 간 출고재고 이관' },
    { id: 'RescheduleProduction', sim: 'rescheduleProduction', applies: ['node'], desc: '레버 재설정 (계획 반영)' },
    { id: 'AdjustShift', sim: 'adjustShift', applies: ['node'], desc: '조업시간 변경' },
  ],
};

// ───────────────────────────────────────────────────────────────────────────
// 13. 표시 단위 (§4.9)
// ───────────────────────────────────────────────────────────────────────────
export const DISPLAY_UNITS = [
  { id: 'MWh', label: 'MWh', perMWh: 1, digits: 1 },
  { id: 'LINK', label: 'Link 대수', perMWh: 1 / UNITS.linkMWh, digits: 2 },
  { id: 'PACK', label: 'Pack 수', perMWh: 1 / UNITS.packMWh, digits: 0 },
  { id: 'CELL', label: 'Cell 수', perMWh: 1 / UNITS.cellMWh, digits: 0 },
];

export const STATUS_ORDER = ['RUNNING', 'BLOCKED', 'STARVED', 'DOWN'];
