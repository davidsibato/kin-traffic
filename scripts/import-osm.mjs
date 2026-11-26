#!/usr/bin/env node
/**
 * Builds public/data/kinshasa-osm-network.json from OpenStreetMap via the public Overpass API.
 *
 * Usage:
 *   npm run import:osm -- S W N E      # bounding box: south west north east, in decimal degrees
 *
 * The bbox is required. Pick one that covers your area, for example Limete to Gare Centrale.
 * Check the coordinates yourself first (for example on openstreetmap.org); no default area is assumed.
 *
 * Licence: OpenStreetMap data is © OpenStreetMap contributors, ODbL 1.0. Attribution is written into the file
 * and shown in the app. Respect Overpass usage policy: keep bboxes small and do not hammer the endpoint.
 * Signal timings are NOT in OSM. Each signal gets a default plan that you must replace with observed timings.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../public/data/kinshasa-osm-network.json');
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const DEFAULT_PLAN = { cycleS: 90, splitA: 0.5, amberS: 3, lostS: 4 };
const CLASS = {
  trunk: { lanes: 2, kmh: 50 },
  primary: { lanes: 2, kmh: 50 },
  secondary: { lanes: 1, kmh: 40 },
  tertiary: { lanes: 1, kmh: 40 },
  unclassified: { lanes: 1, kmh: 30 },
  residential: { lanes: 1, kmh: 30 },
};

if (process.argv.length !== 6) {
  console.error('Usage: npm run import:osm -- SOUTH WEST NORTH EAST   (decimal degrees)');
  process.exit(1);
}
const bbox = process.argv.slice(2).map(Number);
if (bbox.some((x) => !Number.isFinite(x)) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
  console.error('bbox must be four numbers with SOUTH < NORTH and WEST < EAST.');
  process.exit(1);
}
const [s, w, n, e] = bbox;

const query = `[out:json][timeout:120];
(
  way["highway"~"^(trunk|primary|secondary|tertiary|unclassified|residential)$"](${s},${w},${n},${e});
  node["highway"="traffic_signals"](${s},${w},${n},${e});
);
(._;>;);
out body;`;

console.log(`Querying Overpass for bbox S=${s} W=${w} N=${n} E=${e} ...`);
const res = await fetch(OVERPASS, {
  method: 'POST',
  headers: { 'user-agent': 'kin-traffic-mvp/0.1 (educational MVP)' },
  body: new URLSearchParams({ data: query }),
});
if (!res.ok) throw new Error(`Overpass returned HTTP ${res.status}`);
const json = await res.json();

const haversine = (a, b) => {
  const R = 6371000;
  const t = Math.PI / 180;
  const dLat = (b.lat - a.lat) * t;
  const dLng = (b.lon - a.lon) * t;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const bearing = (a, b) => {
  const t = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * t) * Math.cos(b.lat * t);
  const x = Math.cos(a.lat * t) * Math.sin(b.lat * t) - Math.sin(a.lat * t) * Math.cos(b.lat * t) * Math.cos((b.lon - a.lon) * t);
  return (Math.atan2(y, x) / t + 360) % 360;
};

const osmNodes = new Map();
const signalIds = new Set();
for (const el of json.elements) {
  if (el.type !== 'node') continue;
  osmNodes.set(String(el.id), el);
  if (el.tags?.highway === 'traffic_signals') signalIds.add(String(el.id));
}

const linkMap = new Map();
const undirectedDeg = new Map();
const hasOut = new Set();
for (const way of json.elements.filter((x) => x.type === 'way')) {
  const tags = way.tags ?? {};
  const cls = CLASS[tags.highway] ?? CLASS.residential;
  const lanes = Number.parseInt(tags.lanes, 10) || cls.lanes;
  const kmh = /^\d+$/.test(tags.maxspeed ?? '') ? Number(tags.maxspeed) : cls.kmh; // ignore "mph" strings
  const oneway = tags.oneway === 'yes' || tags.oneway === '1';
  const reverse = tags.oneway === '-1';
  for (let i = 0; i < way.nodes.length - 1; i++) {
    const aId = String(way.nodes[i]);
    const bId = String(way.nodes[i + 1]);
    const a = osmNodes.get(aId);
    const b = osmNodes.get(bId);
    if (!a || !b) continue;
    const pairs = reverse ? [[bId, aId]] : oneway ? [[aId, bId]] : [[aId, bId], [bId, aId]];
    for (const [f, t] of pairs) {
      const fn = osmNodes.get(f);
      const tn = osmNodes.get(t);
      const id = `${f}>${t}`;
      if (!linkMap.has(id)) {
        linkMap.set(id, {
          id,
          from: f,
          to: t,
          lengthM: Math.round(haversine(fn, tn) * 10) / 10,
          lanes,
          vmaxMps: Math.round((kmh / 3.6) * 100) / 100,
          bearingDeg: Math.round(bearing(fn, tn) * 10) / 10,
          name: tags.name ?? '',
        });
        hasOut.add(f);
        undirectedDeg.set(f, (undirectedDeg.get(f) ?? new Set()).add(t));
        undirectedDeg.set(t, (undirectedDeg.get(t) ?? new Set()).add(f));
      }
    }
  }
}

const links = [...linkMap.values()].filter((l) => l.lengthM > 0);
const usedNodes = new Set(links.flatMap((l) => [l.from, l.to]));
const nodes = [...usedNodes].map((id) => {
  const o = osmNodes.get(id);
  // Dead ends (one undirected neighbour) are treated as entry/exit points. Clipped bbox edges also appear this way.
  return { id, lat: o.lat, lng: o.lon, entry: (undirectedDeg.get(id)?.size ?? 0) === 1 };
});
const defaultSignals = {};
for (const id of signalIds) if (usedNodes.has(id)) defaultSignals[id] = { ...DEFAULT_PLAN };

const network = {
  name: `OpenStreetMap extract, bbox S${s} W${w} N${n} E${e}`,
  dataSource: 'openstreetmap',
  attribution: '© OpenStreetMap contributors (ODbL 1.0, https://www.openstreetmap.org/copyright). Retrieved via Overpass API.',
  generatedAt: new Date().toISOString(),
  nodes,
  links,
  defaultSignals,
};

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(network));
console.log(
  `Wrote ${OUT}\n  nodes: ${nodes.length}, links: ${links.length}, signals: ${Object.keys(defaultSignals).length} ` +
    '(default timing, not observed).',
);
