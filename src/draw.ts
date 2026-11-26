import type { Simulation } from './sim';

export type Projector = (lat: number, lng: number) => { x: number; y: number };

const ROAD_EMPTY = '#4a4f57';
const LIGHT_COLOR = { green: '#2fb368', amber: '#f0b429', red: '#e0534a' } as const;
const CAR_COLORS = ['#5b8def', '#e8e8e8', '#c0392b', '#f1c40f', '#8e44ad', '#16a085'];

function roadColor(ratio: number | undefined): string {
  if (ratio === undefined) return ROAD_EMPTY;
  if (ratio >= 0.7) return '#2fb368';
  if (ratio >= 0.4) return '#e3a72f';
  return '#e0534a';
}

/** Metres to lat/lng offset around a point. */
function offsetLatLng(lat: number, lng: number, eastM: number, northM: number): [number, number] {
  return [lat + northM / 111320, lng + eastM / (111320 * Math.cos((lat * Math.PI) / 180))];
}

function drawCar(ctx: CanvasRenderingContext2D, id: number): void {
  // Plan view with a ground shadow and roof highlight to suggest volume. These are 2D sprites, not 3D models.
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(-2.5, -1, 8, 5);
  ctx.fillStyle = CAR_COLORS[id % CAR_COLORS.length];
  ctx.fillRect(-4, -2.5, 8, 5);
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillRect(-2, -1.8, 4, 3.6);
}

function drawMoto(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(0.8, 0.8, 2.6, 1.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ff8c42';
  ctx.beginPath();
  ctx.ellipse(0, 0, 2.6, 1.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#222';
  ctx.beginPath();
  ctx.arc(-0.3, 0, 0.9, 0, Math.PI * 2);
  ctx.fill();
}

/** Draws roads (colour = speed ratio), incidents, signals, pedestrians and vehicles. */
export function drawScene(ctx: CanvasRenderingContext2D, project: Projector, sim: Simulation): void {
  const cfg = sim.config;
  const pos = new Map<string, { x: number; y: number }>();
  for (const n of sim.net.nodes) pos.set(n.id, project(n.lat, n.lng));

  ctx.lineCap = 'round';
  ctx.globalAlpha = 0.9;
  for (const l of sim.net.links) {
    const a = pos.get(l.from)!;
    const b = pos.get(l.to)!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ox = (-dy / len) * 2.5; // offset each direction so both are visible
    const oy = (dx / len) * 2.5;
    ctx.strokeStyle = roadColor(sim.linkRatio.get(l.id));
    ctx.lineWidth = 3 + l.lanes * 2.5;
    ctx.beginPath();
    ctx.moveTo(a.x + ox, a.y + oy);
    ctx.lineTo(b.x + ox, b.y + oy);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  for (const inc of cfg.incidents) {
    const l = sim.linkById.get(inc.linkId);
    if (!l) continue;
    const a = pos.get(l.from)!;
    const b = pos.get(l.to)!;
    ctx.strokeStyle = '#ff5ec4';
    ctx.lineWidth = 3;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  for (const nodeId of Object.keys(cfg.signals)) {
    const p = pos.get(nodeId);
    if (!p) continue;
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();
    (['A', 'B'] as const).forEach((axis, i) => {
      ctx.fillStyle = LIGHT_COLOR[sim.nodeLight(nodeId, axis) ?? 'red'];
      ctx.beginPath();
      ctx.arc(p.x + (i ? 2.5 : -2.5), p.y, 2, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  for (const w of sim.walkers) {
    const n = sim.nodeById.get(w.node);
    if (!n) continue;
    const b = (w.bearingDeg * Math.PI) / 180;
    const along = 8;
    const lateral = -6 + 12 * (w.age / w.dur); // crosses the arm from one side to the other
    const east = along * Math.sin(b) + lateral * Math.cos(b);
    const north = along * Math.cos(b) - lateral * Math.sin(b);
    const [lat, lng] = offsetLatLng(n.lat, n.lng, east, north);
    const p = project(lat, lng);
    ctx.fillStyle = '#f4f4f4';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const v of sim.vehicles) {
    const l = sim.linkById.get(v.link);
    if (!l) continue;
    const a = pos.get(l.from)!;
    const b = pos.get(l.to)!;
    const f = Math.min(1, v.s / l.lengthM);
    const x = a.x + (b.x - a.x) * f;
    const y = a.y + (b.y - a.y) * f;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.atan2(b.y - a.y, b.x - a.x));
    if (v.kind === 'car') drawCar(ctx, v.id);
    else drawMoto(ctx);
    ctx.restore();
  }
}
