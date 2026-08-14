// ═══════════════════════════════════════════════════════════════════════════
// tools/validate.mjs — §3.9 검증 게이트 (headless)
//
//   node tools/validate.mjs
//
// sim.js 는 DOM 을 모른다. 이 스크립트는 UI 없이 엔진만 돌려 5개 게이트를
// 통과하는지 확인한다. UI 를 건드리기 전에 반드시 여기부터 초록이어야 한다.
// ═══════════════════════════════════════════════════════════════════════════

import { buildDefaultConfig, UNITS, BOM, NODES, CELL_IDS, PACK_IDS, LINK_IDS } from '../src/data.js';
import { runSim, computeTTS, effectiveDailyOutput, counterfactualConfig } from '../src/sim.js';

let failures = 0;
const results = [];

function gate(name, pass, detail) {
  results.push({ name, pass, detail });
  if (!pass) failures++;
}
const fmt = (v, d = 2) => Number(v).toFixed(d);
const near = (a, b, tolPct) => Math.abs(a - b) <= (Math.abs(b) * tolPct) / 100;

// ───────────────────────────────────────────────────────────────────────────
console.log('\n\x1b[1m ESS SUPPLY CHAIN DIGITAL TWIN — VALIDATION GATE (§3.9)\x1b[0m\n');

const cfg = buildDefaultConfig();

// ── 베이스라인 용량 설계 리포트 (§2.8) ─────────────────────────────────────
const stageOut = (ids) => ids.reduce((s, id) => s + effectiveDailyOutput(cfg.nodes[id]), 0);
const cellOut = stageOut(CELL_IDS);
const packOut = stageOut(PACK_IDS);
const linkOut = stageOut(LINK_IDS);
const yPack = cfg.nodes.PW1.yield;
const yLink = cfg.nodes.AZL.yield;
const demand = Object.values(cfg.customers).reduce((s, c) => s + c.monthlyLinks, 0) * UNITS.linkMWh / 30;
const linkReq = demand;
const packReq = linkReq / yLink;
const cellReq = packReq / yPack;

console.log(' \x1b[2mBASELINE CAPACITY DESIGN\x1b[0m');
console.log(`   CELL   capa ${fmt(cellOut)}  req ${fmt(cellReq)}  slack ${fmt((cellOut / cellReq - 1) * 100, 1)}%`);
console.log(`   PACK   capa ${fmt(packOut)}  req ${fmt(packReq)}  slack ${fmt((packOut / packReq - 1) * 100, 1)}%`);
console.log(`   LINK   capa ${fmt(linkOut)}  req ${fmt(linkReq)}  slack ${fmt((linkOut / linkReq - 1) * 100, 1)}%`);
console.log(`   DEMAND ${fmt(demand)} MWh/day  (${fmt(demand / UNITS.linkMWh, 2)} Link/day)\n`);

// ═══ GATE 1 — 무장애 결정론 → 전 노드 RUNNING, blocked/starved = 0 ═════════
const t0 = performance.now();
const base = runSim(cfg);
const t1 = performance.now();

gate(
  '1  무장애 결정론 · blocked/starved = 0',
  base.system.totalBlockedDays === 0 && base.system.totalStarvedDays === 0,
  `blocked ${base.system.totalBlockedDays}d · starved ${base.system.totalStarvedDays}d · down ${base.system.totalDownDays}d`
);

// ═══ GATE 2 — Little's Law ════════════════════════════════════════════════
const L = base.system.little;
const expected = L.avgDailyShippedMWh * L.avgTransitDays;
gate(
  "2  Little's Law · 평균 in-transit ≈ 일평균출하 × 평균수송일 (±5%)",
  near(L.avgInTransitMWh, expected, 5),
  `actual ${fmt(L.avgInTransitMWh)} vs expected ${fmt(expected)} ` +
    `(${fmt(((L.avgInTransitMWh / expected) - 1) * 100, 2)}%)`
);

// ═══ GATE 3 — 물질수지 ════════════════════════════════════════════════════
const b = base.system.balance;
const lhs = b.rawInputMWh + b.initialInventoryMWh;
const rhs = b.deliveredMWh + b.endInventoryMWh + b.yieldLossMWh;
gate(
  '3  물질수지 · 투입+기초 = 인도+기말+수율손실 (±0.1%)',
  near(lhs, rhs, 0.1),
  `in ${fmt(lhs, 3)} vs out ${fmt(rhs, 3)} (${fmt(((lhs / rhs) - 1) * 100, 5)}%)`
);

// ═══ GATE 4 — BOM 왕복 ════════════════════════════════════════════════════
const bomOk =
  UNITS.cellsPerLink === 10080 &&
  Math.abs(UNITS.linkMWh - 5.134752) < 1e-9 &&
  Math.abs(UNITS.packMWh * BOM.packsPerLink - UNITS.linkMWh) < 1e-12 &&
  Math.abs(UNITS.cellMWh * BOM.cellsPerPack - UNITS.packMWh) < 1e-12;
gate(
  '4  BOM 왕복 · 1 Link = 84 Pack = 10,080 Cell = 5.134752 MWh',
  bomOk,
  `link ${UNITS.linkMWh} MWh · pack ${UNITS.packMWh} MWh · cells/link ${UNITS.cellsPerLink}`
);

// ═══ GATE 5 — PW1 5일 정지 → Cell BLOCKED 가 AZL STARVED 보다 먼저 ════════
const dis = {
  ...cfg,
  disruptions: [{ type: 'nodeDown', target: 'PW1', startDay: 20, durationDays: 5 }],
};
const r5 = runSim(dis);
const firstDay = (id, state) => {
  const tl = r5.perNode[id].stateTimeline;
  for (let d = 0; d < tl.length; d++) if (tl[d] === state) return d;
  return null;
};
const cellBlocked = CELL_IDS.map((id) => firstDay(id, 'BLOCKED')).filter((v) => v !== null);
const firstCellBlocked = cellBlocked.length ? Math.min(...cellBlocked) : null;
const azlStarved = firstDay('AZL', 'STARVED');
gate(
  '5  PW1 DOWN 5D · Cell BLOCKED 가 AZL STARVED 보다 먼저',
  firstCellBlocked !== null && azlStarved !== null && firstCellBlocked < azlStarved,
  `Cell BLOCKED D+${firstCellBlocked} (장애 +${firstCellBlocked - 20}d) · ` +
    `AZL STARVED D+${azlStarved} (장애 +${azlStarved - 20}d)`
);

// ═══ 추가: 순수성 / 성능 / 결정론 ══════════════════════════════════════════
const snapshot = JSON.stringify(cfg);
const again = runSim(cfg);
gate(
  'P  runSim 순수성 · config 미변경 + 동일 결과',
  JSON.stringify(cfg) === snapshot &&
    again.system.totalCostUSD === base.system.totalCostUSD &&
    again.system.otdPct === base.system.otdPct,
  `cost ${fmt(base.system.totalCostUSD, 0)} · otd ${fmt(base.system.otdPct, 2)}%`
);

const tPerf = performance.now();
for (let i = 0; i < 10; i++) runSim(cfg);
const perRun = (performance.now() - tPerf) / 10;
gate('P  120일 결정론 시뮬 1회 < 50ms', perRun < 50, `${fmt(perRun, 2)} ms/run (첫 실행 ${fmt(t1 - t0, 2)} ms)`);

gate(
  'P  PO 48건 (12 고객 × 4개월)',
  base.orders.length === 48,
  `${base.orders.length} orders · ${new Set(base.orders.map((o) => o.customerId)).size} customers`
);

// ── 리포트 ────────────────────────────────────────────────────────────────
console.log(' \x1b[2mGATES\x1b[0m');
for (const r of results) {
  const mark = r.pass ? '\x1b[32m PASS \x1b[0m' : '\x1b[31m FAIL \x1b[0m';
  console.log(`  [${mark}] ${r.name}`);
  console.log(`           \x1b[2m${r.detail}\x1b[0m`);
}

console.log('\n \x1b[2mBASELINE KPI\x1b[0m');
console.log(`   OTD              ${fmt(base.system.otdPct, 1)}%  (on-time ${base.system.ordersOnTime}/${base.system.ordersTotal}, late ${base.system.ordersLate}, undelivered ${base.system.ordersUndelivered})`);
console.log(`   THROUGHPUT       ${fmt(base.system.throughputAvg)} / ${fmt(base.system.demandAvg)} MWh/day`);
console.log(`   LD PENALTY       $${Math.round(base.system.totalPenaltyUSD).toLocaleString('en-US')}`);
console.log(`   TOTAL COST       $${Math.round(base.system.totalCostUSD).toLocaleString('en-US')}`);
console.log(`   AVG WIP          ${fmt(base.system.avgWipMWh)} MWh   IN-TRANSIT ${fmt(base.system.avgInTransitMWh)} MWh`);
console.log(`   LOST OUTPUT      ${fmt(base.system.totalLostOutputMWh)} MWh`);

console.log('\n \x1b[2mPW1 DOWN 5D — 상태 전개\x1b[0m');
for (const n of NODES) {
  const p = r5.perNode[n.id];
  console.log(
    `   ${n.id.padEnd(7)} ${p.type.padEnd(5)} blocked ${String(p.blockedDays).padStart(3)}d  ` +
    `starved ${String(p.starvedDays).padStart(3)}d  down ${String(p.downDays).padStart(3)}d  ` +
    `lost ${fmt(p.lostOutputMWh, 1).padStart(7)} MWh  util ${fmt(p.utilizationPct, 1).padStart(5)}%`
  );
}
console.log(`   OTD ${fmt(r5.system.otdPct, 1)}%  ·  LD $${Math.round(r5.system.totalPenaltyUSD).toLocaleString('en-US')}  ·  TOTAL $${Math.round(r5.system.totalCostUSD).toLocaleString('en-US')}`);

// 반사실
const cf = runSim(counterfactualConfig(dis));
console.log('\n \x1b[2m반사실 (infoLag=0, frozen=0)\x1b[0m');
console.log(`   현재 $${Math.round(r5.system.totalCostUSD).toLocaleString('en-US')}  │  즉시대응 $${Math.round(cf.system.totalCostUSD).toLocaleString('en-US')}  │  절감 $${Math.round(r5.system.totalCostUSD - cf.system.totalCostUSD).toLocaleString('en-US')}`);

// TTS
const tTts = performance.now();
const tts = computeTTS(cfg);
console.log(`\n \x1b[2mTTS (§3.8) — ${fmt(performance.now() - tTts, 0)}ms\x1b[0m`);
Object.entries(tts)
  .sort((a, b) => (a[1] ?? 999) - (b[1] ?? 999))
  .forEach(([id, d]) => console.log(`   ${id.padEnd(8)} ${d === null ? '> horizon' : d + 'd'}`));

console.log(
  failures === 0
    ? '\n\x1b[32m ✓ ALL GATES PASSED — UI 착수 가능\x1b[0m\n'
    : `\n\x1b[31m ✗ ${failures} GATE(S) FAILED — UI 착수 금지\x1b[0m\n`
);
process.exit(failures === 0 ? 0 : 1);
