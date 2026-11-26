import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { cloneSignals, DEFAULT_PLAN, suggestIntervention, validateNetwork } from './network';
import { DT, Simulation, type SimResults } from './sim';
import { compareScenarios } from './scenario';
import { drawScene } from './draw';
import { createMapView, type MapView } from './mapview';
import { DEFAULT_BBOX, fetchNetworkFromOverpass, type Bbox } from './osm';
import type { Network, ScenarioConfig, SharedConfig, SignalMap } from './types';

type ScenarioName = 'baseline' | 'intervention';

const WARMUP_S = 600; // metrics ignore the first 10 simulated minutes
const COMPARE_S = 3600; // headless comparison length (1 simulated hour)

const shared: SharedConfig = {
  seed: 42,
  timeOfDayStartH: 17,
  peakProfile: false,
  carVphPerEntry: 120, // ASSUMED, no observed counts
  motoVphPerEntry: 160, // ASSUMED
  pedPerMinPerCrossing: 15, // ASSUMED
  demandMultiplier: 1,
  turning: { straight: 0.6, left: 0.2, right: 0.2 }, // ASSUMED
  compliance: { car: 0.85, moto: 0.6 }, // ASSUMED
  capacityFactor: 1,
  speedFactor: 1,
  incidents: [],
};

let net: Network;
let view: MapView;
let sim: Simulation;
const signals: Record<ScenarioName, SignalMap> = { baseline: {}, intervention: {} };
let active: ScenarioName = 'baseline';
let playing = true;
let speed = 4;
let accSimS = 0;
let lastFrame = performance.now();
let metricsEl: HTMLElement;
let compareEl: HTMLElement;
let clockEl: HTMLElement;
let playBtn: HTMLButtonElement;
let started = false; // true once a road network is loaded and the simulation exists
let panelEl: HTMLElement;
let panelNote: string | undefined;

const configFor = (name: ScenarioName): ScenarioConfig => ({ ...shared, signals: signals[name] });

function resetSim(): void {
  sim = new Simulation(net, () => configFor(active), WARMUP_S);
}

// ---- small DOM helper ------------------------------------------------------

type Child = Node | string | false | null | undefined;
function h(tag: string, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false || v === null) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

type Tag = 'ASSUMED' | 'USER-SET' | 'DEMO';
function badge(tag: Tag): HTMLElement {
  return h('span', { class: `badge b-${tag.toLowerCase()}` }, tag);
}

function slider(
  label: string,
  tag: Tag,
  min: number,
  max: number,
  step: number,
  value: number,
  onChange: (v: number) => void,
  fmt: (v: number) => string = (v) => String(v),
): HTMLElement {
  const out = h('span', { class: 'val' }, fmt(value));
  const input = h('input', { type: 'range', min, max, step, value }) as HTMLInputElement;
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = fmt(v);
    onChange(v);
  });
  return h('label', { class: 'ctl' }, h('div', { class: 'lbl' }, label, ' ', badge(tag)), input, out);
}

function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  return h(
    'label',
    { class: 'ctl check' },
    h('input', {
      type: 'checkbox',
      checked,
      onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked),
    }),
    ` ${label}`,
  );
}

function section(title: string, ...children: Child[]): HTMLElement {
  return h('section', {}, h('h2', {}, title), ...children);
}

function line(label: string, value: string): HTMLElement {
  return h('p', { class: 'line' }, h('b', {}, `${label}: `), value);
}

// ---- formatting -----------------------------------------------------------

const fmt0 = (x: number) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : '—');
const fmt1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—');

const ROWS: Array<[string, keyof SimResults, (x: number) => string]> = [
  ['Vehicles arrived (demand)', 'arrivals', fmt0],
  ['Vehicles entered network', 'spawned', fmt0],
  ['Completed trips (after warm-up)', 'completedAfterWarmup', fmt0],
  ['Throughput (veh/h)', 'throughputVph', fmt0],
  ['Average travel time (s)', 'avgTravelTimeS', fmt0],
  ['Average delay vs free flow (s)', 'avgDelayS', fmt0],
  ['Average queue (vehicles, network)', 'avgQueueVehicles', fmt1],
  ['Max queue on one link (vehicles)', 'maxQueueVehicles', fmt0],
  ['Red-light crossings', 'redCrossings', fmt0],
  ['Vehicles still in network', 'inSystem', fmt0],
];

function clockText(): string {
  const s = Math.floor((shared.timeOfDayStartH * 3600 + sim.t) % 86400);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

// ---- panel ----------------------------------------------------------------

function playbackControls(): HTMLElement {
  playBtn = h(
    'button',
    {
      onclick: () => {
        playing = !playing;
        playBtn.textContent = playing ? 'Pause' : 'Play';
      },
    },
    'Pause',
  ) as HTMLButtonElement;
  const speedSel = h(
    'select',
    { onchange: (e: Event) => (speed = Number((e.target as HTMLSelectElement).value)) },
    ...[1, 4, 16, 60].map((s) => h('option', { value: s, selected: s === speed }, `${s}×`)),
  );
  const radio = (name: ScenarioName, label: string) =>
    h(
      'label',
      { class: 'radio' },
      h('input', {
        type: 'radio',
        name: 'scn',
        value: name,
        checked: name === active,
        onchange: () => {
          active = name;
          resetSim();
        },
      }),
      ` ${label}`,
    );
  clockEl = h('div', { class: 'clock' });
  return h(
    'div',
    {},
    h('div', { class: 'row' }, playBtn, h('button', { onclick: () => resetSim() }, 'Reset'), speedSel),
    clockEl,
    h('div', { class: 'row' }, radio('baseline', 'Baseline'), radio('intervention', 'Intervention')),
  );
}

function demandControls(): HTMLElement {
  return h(
    'div',
    {},
    slider('Car arrivals per entry (veh/h)', 'ASSUMED', 0, 600, 10, shared.carVphPerEntry, (v) => (shared.carVphPerEntry = v)),
    slider('Moto arrivals per entry (veh/h)', 'ASSUMED', 0, 800, 10, shared.motoVphPerEntry, (v) => (shared.motoVphPerEntry = v)),
    slider('Pedestrians per min per crossing', 'ASSUMED', 0, 60, 1, shared.pedPerMinPerCrossing, (v) => (shared.pedPerMinPerCrossing = v)),
    slider('Demand multiplier', 'USER-SET', 0.2, 2.5, 0.1, shared.demandMultiplier, (v) => (shared.demandMultiplier = v)),
    slider('Car compliance with red/amber', 'ASSUMED', 0, 1, 0.05, shared.compliance.car, (v) => (shared.compliance.car = v), (v) => `${Math.round(v * 100)}%`),
    slider('Moto compliance with red/amber', 'ASSUMED', 0, 1, 0.05, shared.compliance.moto, (v) => (shared.compliance.moto = v), (v) => `${Math.round(v * 100)}%`),
    slider('Lane / capacity factor', 'USER-SET', 0.5, 1.5, 0.05, shared.capacityFactor, (v) => (shared.capacityFactor = v)),
    slider('Speed factor', 'USER-SET', 0.5, 1.3, 0.05, shared.speedFactor, (v) => (shared.speedFactor = v)),
    slider('Turn weight: straight', 'ASSUMED', 0, 1, 0.05, shared.turning.straight, (v) => (shared.turning.straight = v)),
    slider('Turn weight: left', 'ASSUMED', 0, 1, 0.05, shared.turning.left, (v) => (shared.turning.left = v)),
    slider('Turn weight: right', 'ASSUMED', 0, 1, 0.05, shared.turning.right, (v) => (shared.turning.right = v)),
    slider('Start time of day (h)', 'USER-SET', 0, 23, 1, shared.timeOfDayStartH, (v) => (shared.timeOfDayStartH = v)),
    checkbox('Morning and evening peak profile', shared.peakProfile, (v) => (shared.peakProfile = v)),
    h(
      'label',
      { class: 'ctl' },
      h('div', { class: 'lbl' }, 'Random seed ', badge('USER-SET')),
      h('input', {
        type: 'number',
        value: shared.seed,
        onchange: (e: Event) => {
          shared.seed = Number((e.target as HTMLInputElement).value) || 42;
          resetSim();
        },
      }),
    ),
  );
}

function signalControls(): HTMLElement {
  const sel = h(
    'select',
    {},
    ...net.nodes.map((n) => h('option', { value: n.id }, n.id)),
  ) as HTMLSelectElement;
  let cycle = DEFAULT_PLAN.cycleS;
  let split = DEFAULT_PLAN.splitA;
  const status = h('p', { class: 'muted' });
  const refresh = () => {
    const on = !!signals.intervention[sel.value];
    status.textContent =
      `Signalised junctions: baseline ${Object.keys(signals.baseline).length}, ` +
      `intervention ${Object.keys(signals.intervention).length}. ` +
      `${sel.value} is ${on ? 'signalised' : 'not signalised'} in the intervention.`;
  };
  sel.addEventListener('change', refresh);
  const apply = h(
    'button',
    {
      onclick: () => {
        signals.intervention[sel.value] = { cycleS: cycle, splitA: split, amberS: DEFAULT_PLAN.amberS, lostS: DEFAULT_PLAN.lostS };
        refresh();
      },
    },
    'Add / update signal',
  );
  const remove = h(
    'button',
    {
      onclick: () => {
        delete signals.intervention[sel.value];
        refresh();
      },
    },
    'Remove signal',
  );
  const resetBtn = h(
    'button',
    {
      onclick: () => {
        signals.intervention = cloneSignals(signals.baseline);
        refresh();
      },
    },
    'Reset intervention to baseline',
  );
  refresh();
  return h(
    'div',
    {},
    h('label', { class: 'ctl' }, 'Junction ', sel),
    slider('Cycle length (s)', 'USER-SET', 30, 150, 5, cycle, (v) => (cycle = v)),
    slider('Green share, N–S approaches', 'USER-SET', 0.2, 0.8, 0.05, split, (v) => (split = v), (v) => `${Math.round(v * 100)}%`),
    h('div', { class: 'row' }, apply, remove),
    resetBtn,
    status,
  );
}

function incidentControls(): HTMLElement {
  const sel = h(
    'select',
    {},
    ...net.links.map((l) => h('option', { value: l.id }, `${l.id}${l.name ? ` · ${l.name}` : ''}`)),
  ) as HTMLSelectElement;
  let factor = 0.3;
  const list = h('p', { class: 'muted' });
  const refresh = () => {
    list.textContent = shared.incidents.length
      ? `Active: ${shared.incidents.map((i) => `${i.linkId} (speed ×${i.speedFactor})`).join('; ')}`
      : 'No incidents active.';
  };
  refresh();
  return h(
    'div',
    {},
    sel,
    slider('Incident speed factor', 'USER-SET', 0.05, 1, 0.05, factor, (v) => (factor = v)),
    h(
      'button',
      {
        onclick: () => {
          const on = shared.incidents.some((i) => i.linkId === sel.value);
          shared.incidents = on
            ? shared.incidents.filter((i) => i.linkId !== sel.value)
            : [...shared.incidents, { linkId: sel.value, speedFactor: factor }];
          refresh();
        },
      },
      'Toggle incident on selected link',
    ),
    list,
  );
}

function comparisonTable(b: SimResults, i: SimResults): HTMLElement {
  const rows = ROWS.map(([label, key, f]) => {
    const bv = b[key] as number;
    const iv = i[key] as number;
    const d = Number.isFinite(bv) && Number.isFinite(iv) ? iv - bv : NaN;
    return h(
      'tr',
      {},
      h('td', {}, label),
      h('td', {}, f(bv)),
      h('td', {}, f(iv)),
      h('td', {}, Number.isFinite(d) ? `${d > 0 ? '+' : ''}${f(d)}` : '—'),
    );
  });
  return h(
    'div',
    {},
    h('table', {}, h('tr', {}, h('th', {}, 'Measure'), h('th', {}, 'Baseline'), h('th', {}, 'Intervention'), h('th', {}, 'Change')), ...rows),
    h(
      'p',
      { class: 'muted' },
      `Simulated estimates: ${COMPARE_S / 60} min run, first ${WARMUP_S / 60} min excluded. ` +
        `Same seed and demand (arrivals identical: ${b.arrivals === i.arrivals ? 'yes' : 'NO, check'}). ` +
        'Not calibrated to real Kinshasa counts.',
    ),
  );
}

function compareControls(): HTMLElement {
  compareEl = h('div', { class: 'metrics' }, 'Press the button to run both scenarios headlessly.');
  return h(
    'div',
    {},
    h(
      'button',
      {
        onclick: () => {
          compareEl.textContent = 'Running…';
          // Yield once so the status text paints before the synchronous run.
          setTimeout(() => {
            const c = compareScenarios(net, shared, signals.baseline, signals.intervention, COMPARE_S, WARMUP_S);
            compareEl.replaceChildren(comparisonTable(c.baseline, c.intervention));
          }, 20);
        },
      },
      'Run 1-hour comparison',
    ),
    compareEl,
  );
}

function buildPanel(panel: HTMLElement, mapLabel: string): void {
  metricsEl = h('div', { class: 'metrics' });
  panel.replaceChildren(
    h('h1', {}, 'Kin Traffic MVP'),
    h('p', { class: 'muted' }, 'Kinshasa congestion simulation. Output is an estimate, not observed traffic.'),
    h(
      'section',
      { class: 'truth' },
      h('h2', {}, 'Data status'),
      line('Basemap', mapLabel),
      line('Road graph', `${net.name} · source: ${net.dataSource}`),
      line('Attribution', net.attribution),
      line('Traffic', 'No live or observed traffic feed is configured. All flows are SIMULATED ESTIMATES from ASSUMED demand.'),
    ),
    section('Playback', playbackControls()),
    section('Demand and behaviour (shared by both scenarios)', demandControls()),
    section('Signals (editing the intervention scenario)', signalControls()),
    section('Incidents (applied to both scenarios)', incidentControls()),
    section('Live metrics (simulated estimates)', metricsEl),
    section('Baseline vs intervention', compareControls()),
  );
}

function renderMetrics(): void {
  if (!started) return;
  const r = sim.summary();
  const table = h(
    'table',
    {},
    ...ROWS.map(([label, key, f]) => h('tr', {}, h('td', {}, label), h('td', {}, f(r[key] as number)))),
  );
  const top = h(
    'ol',
    { class: 'muted' },
    ...r.topCongestedLinks.slice(0, 5).map((l) =>
      h('li', {}, `${l.linkId}: congestion ${Math.round(l.congestion * 100)}%, max queue ${l.maxQueue}`),
    ),
  );
  metricsEl.replaceChildren(
    table,
    h('p', { class: 'muted' }, `Scenario shown: ${active}. Observed traffic: none.`),
    h('p', { class: 'muted' }, 'Most congested links:'),
    top,
  );
}

// ---- startup, loading and frame loop -------------------------------------

/** Optional committed network file (created with npm run import:osm). Used if present. */
async function loadCommittedNetwork(): Promise<Network | null> {
  try {
    const res = await fetch('/data/kinshasa-osm-network.json');
    if (res.ok && (res.headers.get('content-type') ?? '').includes('json')) {
      const data = (await res.json()) as Network;
      validateNetwork(data);
      return data;
    }
  } catch (err) {
    console.warn('No committed road network found.', err);
  }
  return null;
}

function bboxOf(net: Network): Bbox {
  const lats = net.nodes.map((n) => n.lat);
  const lngs = net.nodes.map((n) => n.lng);
  return [Math.min(...lats), Math.min(...lngs), Math.max(...lats), Math.max(...lngs)];
}

/** Starts the simulation on a loaded network. The map is already visible. */
function startSimulation(network: Network): void {
  net = network;
  signals.baseline = cloneSignals(net.defaultSignals);
  signals.intervention = suggestIntervention(net);
  view.fit(bboxOf(net));
  buildPanel(panelEl, view.label);
  resetSim();
  started = true;
}

/** Panel for choosing an area and loading its roads from OpenStreetMap in the browser. */
function showAreaLoader(message?: string): void {
  const note = panelNote;
  const inputs = ['South', 'West', 'North', 'East'].map((label, i) =>
    h('label', { class: 'bbox' }, h('span', {}, label), h('input', { type: 'number', step: '0.0001', value: DEFAULT_BBOX[i] })),
  );
  const status = h('p', { class: 'muted' }, message ?? 'Choose an area, then load its main roads from OpenStreetMap.');
  const warning = note ? h('p', { class: 'warn' }, note) : false;
  const button = h('button', {}, 'Load roads') as HTMLButtonElement;
  button.addEventListener('click', async () => {
    const values = inputs.map((l) => Number((l.querySelector('input') as HTMLInputElement).value));
    const [s, w, n, e] = values;
    if (values.some((x) => !Number.isFinite(x)) || s >= n || w >= e) {
      status.textContent = 'Check the box: South must be less than North, and West less than East.';
      return;
    }
    if ((n - s) * (e - w) > 0.02) {
      status.textContent = 'That area is too large for a browser download. Use a smaller box (about 0.15 × 0.1 degrees at most).';
      return;
    }
    button.disabled = true;
    status.textContent = 'Downloading roads from OpenStreetMap (can take 10–60 s)…';
    try {
      const network = await fetchNetworkFromOverpass([s, w, n, e]);
      validateNetwork(network);
      startSimulation(network);
    } catch (err) {
      status.textContent = `Could not load roads: ${err instanceof Error ? err.message : String(err)}`;
      button.disabled = false;
    }
  });
  panelEl.replaceChildren(
    h('h1', {}, 'Kin Traffic MVP'),
    h(
      'section',
      { class: 'truth' },
      h('h2', {}, 'Choose an area'),
      h('p', { class: 'muted' }, 'Default: Échangeur (Limete) to Gare Centrale, Kinshasa. Edit the box if needed.'),
      h('div', { class: 'bboxes' }, ...inputs),
      warning,
      button,
      status,
      h('p', { class: 'muted' }, 'Roads: © OpenStreetMap contributors (ODbL). Signals start with default timing, not observed timing.'),
    ),
  );
}

/** Stand-in view when WebGL is unavailable: a plain background, so the panel still works. */
function mapFailedView(host: HTMLElement): MapView {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
  host.appendChild(canvas);
  return {
    label: 'No map (WebGL unavailable)',
    canvas,
    ready: () => true,
    project: (lat, lng) => ({ x: host.clientWidth / 2 + (lng - 15.33) * 60000, y: host.clientHeight / 2 - (lat + 4.34) * 60000 }),
    beginFrame: (ctx) => {
      ctx.fillStyle = '#1b1f24';
      ctx.fillRect(0, 0, host.clientWidth, host.clientHeight);
    },
    fit: () => {},
  };
}

function frame(now: number): void {
  const dtReal = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  const dpr = window.devicePixelRatio || 1;
  const ctx = view.canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  view.beginFrame(ctx);
  if (started) {
    if (playing) {
      accSimS += dtReal * speed;
      while (accSimS >= DT) {
        sim.step(DT);
        accSimS -= DT;
      }
    }
    if (view.ready()) drawScene(ctx, view.project, sim);
    clockEl.textContent = `Sim clock ${clockText()}`;
  }
  requestAnimationFrame(frame);
}

async function main(): Promise<void> {
  const host = document.getElementById('map') as HTMLElement;
  panelEl = document.getElementById('panel')!;
  try {
    view = createMapView(host, DEFAULT_BBOX); // the map shows immediately when WebGL is available
  } catch (err) {
    console.error('Map could not start (WebGL unavailable?)', err);
    view = mapFailedView(host);
    panelNote = 'The map needs WebGL. Enable hardware acceleration in your browser, or try another browser. The simulation still runs without the map preview.';
  }

  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    view.canvas.width = host.clientWidth * dpr;
    view.canvas.height = host.clientHeight * dpr;
  };
  resize();
  window.addEventListener('resize', resize);
  setInterval(renderMetrics, 500);
  requestAnimationFrame(frame);

  const committed = await loadCommittedNetwork();
  if (committed) startSimulation(committed);
  else showAreaLoader();
}

main();
