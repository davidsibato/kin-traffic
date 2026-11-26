import type { Axis, Network, NetLink, NetNode, SignalMap, SignalPlan } from './types';

export const DEFAULT_PLAN: SignalPlan = { cycleS: 90, splitA: 0.5, amberS: 3, lostS: 4 };

export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR;
  const dLng = (b.lng - a.lng) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function bearingDeg(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toR = Math.PI / 180;
  const y = Math.sin((b.lng - a.lng) * toR) * Math.cos(b.lat * toR);
  const x =
    Math.cos(a.lat * toR) * Math.sin(b.lat * toR) -
    Math.sin(a.lat * toR) * Math.cos(b.lat * toR) * Math.cos((b.lng - a.lng) * toR);
  return (Math.atan2(y, x) / toR + 360) % 360;
}

export function centroid(net: Network): { lat: number; lng: number } {
  const n = net.nodes.length || 1;
  return {
    lat: net.nodes.reduce((s, p) => s + p.lat, 0) / n,
    lng: net.nodes.reduce((s, p) => s + p.lng, 0) / n,
  };
}

/** Synthetic 6x5 grid placed near Limete for demonstration. Not real road geometry. */
export function buildDemoNetwork(): Network {
  const rows = 5;
  const cols = 6;
  const spacingM = 250;
  const c0 = { lat: -4.38, lng: 15.315 };
  const dLat = spacingM / 111320;
  const dLng = spacingM / (111320 * Math.cos((c0.lat * Math.PI) / 180));
  const id = (r: number, c: number) => `n${r}-${c}`;

  const nodes: NetNode[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      nodes.push({
        id: id(r, c),
        lat: c0.lat + (rows / 2 - r) * dLat,
        lng: c0.lng + (c - cols / 2) * dLng,
        entry: r === 0 || r === rows - 1 || c === 0 || c === cols - 1,
      });
    }
  }
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const links: NetLink[] = [];
  const addPair = (a: string, b: string, arterial: boolean) => {
    const na = byId.get(a)!;
    const nb = byId.get(b)!;
    for (const [f, t, fn, tn] of [
      [a, b, na, nb],
      [b, a, nb, na],
    ] as const) {
      links.push({
        id: `${f}>${t}`,
        from: f,
        to: t,
        lengthM: haversineM(fn, tn),
        lanes: arterial ? 2 : 1,
        vmaxMps: arterial ? 13.9 : 8.3,
        bearingDeg: bearingDeg(fn, tn),
        name: arterial ? 'Demo arterial' : 'Demo local street',
      });
    }
  };
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols - 1; c++) addPair(id(r, c), id(r, c + 1), r === 2);
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows - 1; r++) addPair(id(r, c), id(r + 1, c), c === 3);

  return {
    name: 'Demo grid near Limete (synthetic)',
    dataSource: 'synthetic-demo',
    attribution: 'Synthetic demo network generated in code. Not real road geometry.',
    generatedAt: new Date().toISOString(),
    nodes,
    links,
    defaultSignals: {
      'n1-1': { ...DEFAULT_PLAN },
      'n1-4': { ...DEFAULT_PLAN },
      'n3-2': { ...DEFAULT_PLAN },
      'n3-3': { ...DEFAULT_PLAN },
    },
  };
}

export function validateNetwork(net: Network): void {
  const ids = new Set(net.nodes.map((n) => n.id));
  if (ids.size !== net.nodes.length) throw new Error('Network has duplicate node ids.');
  for (const l of net.links) {
    if (!ids.has(l.from) || !ids.has(l.to)) throw new Error(`Link ${l.id} references an unknown node.`);
    if (!(l.lengthM > 0) || !(l.vmaxMps > 0) || !(l.lanes >= 1)) {
      throw new Error(`Link ${l.id} has an invalid length, speed or lane count.`);
    }
  }
  for (const nodeId of Object.keys(net.defaultSignals)) {
    if (!ids.has(nodeId)) throw new Error(`Signal references unknown node ${nodeId}.`);
  }
}

/** Approach axis of a link, from its bearing: A = roughly north-south, B = roughly east-west. */
export function approachAxis(link: NetLink): Axis {
  const b = link.bearingDeg % 180;
  return b < 45 || b > 135 ? 'A' : 'B';
}

export function cloneSignals(map: SignalMap): SignalMap {
  return JSON.parse(JSON.stringify(map)) as SignalMap;
}

/** Suggested intervention: add signals at up to `maxAdd` unsignalised four-leg junctions. */
export function suggestIntervention(net: Network, maxAdd = 2): SignalMap {
  const map = cloneSignals(net.defaultSignals);
  const outDeg = new Map<string, number>();
  for (const l of net.links) outDeg.set(l.from, (outDeg.get(l.from) ?? 0) + 1);
  const candidates = net.nodes
    .filter((n) => !map[n.id] && (outDeg.get(n.id) ?? 0) >= 4)
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const n of candidates.slice(0, maxAdd)) map[n.id] = { ...DEFAULT_PLAN };
  return map;
}
