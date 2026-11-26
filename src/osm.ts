import type { Network, NetLink, NetNode, SignalMap } from './types';
import { DEFAULT_PLAN, bearingDeg, haversineM } from './network';

/** South, west, north, east in decimal degrees. */
export type Bbox = [number, number, number, number];

/** Default area: Échangeur (Limete) to Gare Centrale, with margin. Approximate; confirm on the map. */
export const DEFAULT_BBOX: Bbox = [-4.39, 15.3, -4.29, 15.36];

/** Public Overpass endpoint. Override with VITE_OVERPASS_URL if it is busy or blocked. */
/** Public Overpass servers, tried in order. Overpass servers can be busy or refuse browser requests. */
const OVERPASS_URLS: string[] = [
  import.meta.env?.VITE_OVERPASS_URL,
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
].filter((u): u is string => !!u);

/** Lanes and default speed per road class, used when OSM tags are missing. ASSUMED defaults. */
const CLASS: Record<string, { lanes: number; kmh: number }> = {
  trunk: { lanes: 2, kmh: 50 },
  primary: { lanes: 2, kmh: 50 },
  secondary: { lanes: 1, kmh: 40 },
  tertiary: { lanes: 1, kmh: 40 },
};

interface OsmElement {
  type: 'node' | 'way';
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  tags?: Record<string, string>;
}

export function overpassQuery(b: Bbox): string {
  const [s, w, n, e] = b;
  // Main roads only for the first version: keeps the download small enough for a browser.
  return `[out:json][timeout:90];
(
  way["highway"~"^(trunk|primary|secondary|tertiary)$"](${s},${w},${n},${e});
  node["highway"="traffic_signals"](${s},${w},${n},${e});
);
(._;>;);
out body;`;
}

/** Converts an Overpass JSON response into the app's network format. Pure function, no network access. */
export function buildNetwork(elements: OsmElement[], b: Bbox): Network {
  const osmNodes = new Map<string, OsmElement>();
  const signalIds = new Set<string>();
  for (const el of elements) {
    if (el.type !== 'node' || el.lat === undefined || el.lon === undefined) continue;
    osmNodes.set(String(el.id), el);
    if (el.tags?.highway === 'traffic_signals') signalIds.add(String(el.id));
  }

  const linkMap = new Map<string, NetLink>();
  const neighbours = new Map<string, Set<string>>();
  const addNeighbour = (a: string, c: string) => {
    const set = neighbours.get(a) ?? new Set<string>();
    set.add(c);
    neighbours.set(a, set);
  };

  for (const way of elements) {
    if (way.type !== 'way' || !way.nodes) continue;
    const tags = way.tags ?? {};
    const cls = CLASS[tags.highway ?? ''] ?? CLASS.tertiary;
    const lanes = Number.parseInt(tags.lanes ?? '', 10) || cls.lanes;
    const kmh = /^\d+$/.test(tags.maxspeed ?? '') ? Number(tags.maxspeed) : cls.kmh; // ignore "mph" strings
    const oneway = tags.oneway === 'yes' || tags.oneway === '1';
    const reverse = tags.oneway === '-1';

    for (let i = 0; i < way.nodes.length - 1; i++) {
      const aId = String(way.nodes[i]);
      const bId = String(way.nodes[i + 1]);
      const fn = osmNodes.get(aId);
      const tn = osmNodes.get(bId);
      if (!fn || !tn) continue;
      const pairs: Array<[string, string]> = reverse
        ? [[bId, aId]]
        : oneway
          ? [[aId, bId]]
          : [
              [aId, bId],
              [bId, aId],
            ];
      for (const [f, t] of pairs) {
        const id = `${f}>${t}`;
        if (linkMap.has(id)) continue;
        const from = osmNodes.get(f)!;
        const to = osmNodes.get(t)!;
        const lengthM = haversineM({ lat: from.lat!, lng: from.lon! }, { lat: to.lat!, lng: to.lon! });
        if (!(lengthM > 0)) continue;
        linkMap.set(id, {
          id,
          from: f,
          to: t,
          lengthM: Math.round(lengthM * 10) / 10,
          lanes,
          vmaxMps: Math.round((kmh / 3.6) * 100) / 100,
          bearingDeg: Math.round(bearingDeg({ lat: from.lat!, lng: from.lon! }, { lat: to.lat!, lng: to.lon! }) * 10) / 10,
          name: tags.name ?? '',
        });
        addNeighbour(f, t);
        addNeighbour(t, f);
      }
    }
  }

  const links = [...linkMap.values()];
  const usedNodeIds = new Set(links.flatMap((l) => [l.from, l.to]));
  const nodes: NetNode[] = [...usedNodeIds].map((id) => {
    const o = osmNodes.get(id)!;
    // Dead ends (one neighbour) act as entry and exit points. Clipped bbox edges also look like this.
    return { id, lat: o.lat!, lng: o.lon!, entry: (neighbours.get(id)?.size ?? 0) === 1 };
  });

  const defaultSignals: SignalMap = {};
  for (const id of signalIds) if (usedNodeIds.has(id)) defaultSignals[id] = { ...DEFAULT_PLAN };

  return {
    name: `OpenStreetMap roads, bbox S${b[0]} W${b[1]} N${b[2]} E${b[3]}`,
    dataSource: 'openstreetmap',
    attribution: '© OpenStreetMap contributors (ODbL 1.0, https://www.openstreetmap.org/copyright). Retrieved via Overpass API.',
    generatedAt: new Date().toISOString(),
    nodes,
    links,
    defaultSignals,
  };
}

/** Downloads the roads for a bounding box from the browser, trying each public Overpass server in turn. */
export async function fetchNetworkFromOverpass(b: Bbox): Promise<Network> {
  const errors: string[] = [];
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: overpassQuery(b) }) });
      if (!res.ok) {
        errors.push(`${new URL(url).host} returned HTTP ${res.status}`);
        continue;
      }
      const json = (await res.json()) as { elements: OsmElement[] };
      const network = buildNetwork(json.elements, b);
      if (!network.links.length) throw new Error('No main roads found in this area. Check the coordinates.');
      return network;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('No main roads')) throw err;
      errors.push(`${new URL(url).host} unreachable from this browser`);
    }
  }
  throw new Error(
    `${errors.join('; ')}. Public OpenStreetMap servers may be busy or block browser requests. ` +
      'Try again later, or use a prebuilt road file (see README).',
  );
}
