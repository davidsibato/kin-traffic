/**
 * Headless checks for the simulation core. Run with: npm run verify
 * These checks test the code. They do not validate the model against real traffic.
 */
import { buildDemoNetwork, suggestIntervention, validateNetwork } from '../src/network';
import { compareScenarios, runScenario } from '../src/scenario';
import type { SharedConfig } from '../src/types';
import { buildNetwork } from '../src/osm';

const net = buildDemoNetwork();
validateNetwork(net);

const shared: SharedConfig = {
  seed: 42,
  timeOfDayStartH: 17,
  peakProfile: false,
  carVphPerEntry: 120,
  motoVphPerEntry: 160,
  pedPerMinPerCrossing: 15,
  demandMultiplier: 1,
  turning: { straight: 0.6, left: 0.2, right: 0.2 },
  compliance: { car: 0.85, moto: 0.6 },
  capacityFactor: 1,
  speedFactor: 1,
  incidents: [],
};

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

// 1. Determinism: the same seed and settings give identical results.
const r1 = runScenario(net, { ...shared, signals: net.defaultSignals }, 1800, 300);
const r2 = runScenario(net, { ...shared, signals: net.defaultSignals }, 1800, 300);
check('same seed gives identical results', JSON.stringify(r1) === JSON.stringify(r2));

// 2. Common demand: baseline and intervention receive the same arrivals.
const cmp = compareScenarios(net, shared, net.defaultSignals, suggestIntervention(net), 1800, 300);
check(
  'baseline and intervention share identical arrivals',
  cmp.baseline.arrivals === cmp.intervention.arrivals,
  `${cmp.baseline.arrivals} vs ${cmp.intervention.arrivals}`,
);

// 3. Bookkeeping: every arrival is either entered or blocked; every entered vehicle is accounted for.
for (const [name, r] of [
  ['baseline', cmp.baseline],
  ['intervention', cmp.intervention],
] as const) {
  check(`${name}: arrivals = entered + blocked`, r.arrivals === r.spawned + r.spawnBlocked);
  check(
    `${name}: entered = completed + in system + timed out`,
    r.spawned === r.completedTotal + r.inSystem + r.timedOut,
    `${r.spawned} = ${r.completedTotal} + ${r.inSystem} + ${r.timedOut}`,
  );
  check(`${name}: travel time is finite once trips complete`, r.completedAfterWarmup === 0 || Number.isFinite(r.avgTravelTimeS));
}

// 4. Sanity: very light traffic with no signals should have little delay.
const light = runScenario(
  net,
  { ...shared, carVphPerEntry: 20, motoVphPerEntry: 0, pedPerMinPerCrossing: 0, signals: {} },
  1800,
  300,
);
check('light traffic without signals has small average delay', light.avgDelayS < 20, `avg delay ${light.avgDelayS.toFixed(1)} s`);

// 5. Signals should produce red-light events when present and none when absent.
check('no signals means no red crossings', light.redCrossings === 0, `${light.redCrossings}`);

// 6. OSM parser: fixture with two ways, one one-way street and one signal.
const osmFixture = buildNetwork(
  [
    { type: 'node', id: 1, lat: -4.3, lon: 15.31 },
    { type: 'node', id: 2, lat: -4.3, lon: 15.32, tags: { highway: 'traffic_signals' } },
    { type: 'node', id: 3, lat: -4.31, lon: 15.32 },
    { type: 'way', id: 10, nodes: [1, 2, 3], tags: { highway: 'primary', name: 'Test avenue' } },
    { type: 'way', id: 11, nodes: [3, 1], tags: { highway: 'secondary', oneway: 'yes' } },
  ],
  [-4.4, 15.3, -4.29, 15.36],
);
check('OSM parser: two-way road gives 4 directed links, one-way gives 1 more', osmFixture.links.length === 5, `${osmFixture.links.length} links`);
check('OSM parser: traffic signal is picked up', osmFixture.defaultSignals['2'] !== undefined);
check('OSM parser: junctions with two or more neighbours are not entries', osmFixture.nodes.find((n) => n.id === '1')?.entry === false);
check('OSM parser: link lengths are positive', osmFixture.links.every((l) => l.lengthM > 0));

console.log('\nBaseline vs intervention (30 simulated min, seed 42):');
const rows: Array<[string, number, number]> = [
  ['Throughput veh/h', cmp.baseline.throughputVph, cmp.intervention.throughputVph],
  ['Avg travel time s', cmp.baseline.avgTravelTimeS, cmp.intervention.avgTravelTimeS],
  ['Avg delay s', cmp.baseline.avgDelayS, cmp.intervention.avgDelayS],
  ['Avg queue veh', cmp.baseline.avgQueueVehicles, cmp.intervention.avgQueueVehicles],
];
for (const [label, b, i] of rows) console.log(`  ${label.padEnd(20)} baseline ${String(b.toFixed(1)).padStart(9)}   intervention ${String(i.toFixed(1)).padStart(9)}`);

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
