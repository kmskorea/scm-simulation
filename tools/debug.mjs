import { buildDefaultConfig, NODES, CELL_IDS } from '../src/data.js';
import { runSim } from '../src/sim.js';

const cfg = buildDefaultConfig();
const scenario = process.argv[2] === 'pw1'
  ? { ...cfg, disruptions: [{ type: 'nodeDown', target: 'PW1', startDay: 20, durationDays: 5 }] }
  : cfg;
const r = runSim(scenario);

console.log('\nPER-NODE');
for (const n of NODES) {
  const p = r.perNode[n.id];
  console.log(
    `${n.id.padEnd(7)} blk ${String(p.blockedDays).padStart(3)} stv ${String(p.starvedDays).padStart(3)} ` +
    `lost ${p.lostOutputMWh.toFixed(1).padStart(7)} util ${p.utilizationPct.toFixed(1).padStart(5)}% ` +
    `inCap ${p.inputCapacity.toFixed(1).padStart(6)} outCap ${p.outputCapacity.toFixed(1).padStart(6)}`
  );
}
console.log(`throughput ${r.system.throughputAvg.toFixed(2)} demand ${r.system.demandAvg.toFixed(2)} otd ${r.system.otdPct.toFixed(1)}%`);

const who = process.argv[3] || 'ESST';
const p = r.perNode[who];
console.log(`\n${who} trace`);
for (let d = 0; d < Number(process.argv[4] || 40); d++) {
  console.log(
    `D+${String(d).padStart(3)} ${String(p.stateTimeline[d]).padEnd(8)} ` +
    `in ${p.inputBufferSeries[d].toFixed(1).padStart(6)}/${p.inputCapacity.toFixed(0)} ` +
    `out ${p.outputBufferSeries[d].toFixed(1).padStart(6)}/${p.outputCapacity.toFixed(0)} ` +
    `prod ${p.producedSeries[d].toFixed(2).padStart(5)} plan ${p.planSeries[d].toFixed(2)}`
  );
}

console.log('\nfirst BLOCKED per cell:', CELL_IDS.map((id) => {
  const tl = r.perNode[id].stateTimeline;
  return `${id}:${tl.indexOf('BLOCKED')}`;
}).join('  '));
console.log('AZL first STARVED:', r.perNode.AZL.stateTimeline.indexOf('STARVED'));

console.log('\nNON-RUNNING DAYS (baseline)');
for (const n of NODES) {
  const tl = r.perNode[n.id].stateTimeline;
  const days = tl.map((s, i) => (s === 'RUNNING' ? null : `${i}:${s[0]}`)).filter(Boolean);
  if (days.length) console.log(`  ${n.id.padEnd(7)} ${days.join(' ')}`);
}
console.log('\nplanLog');
for (const pl of r.planLog.slice(0, 8)) console.log('  ', JSON.stringify(pl));
