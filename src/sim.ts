import type { Axis, Kind, LightState, Network, NetLink, NetNode, ScenarioConfig } from './types';
import { Rng } from './rng';
import { approachAxis } from './network';
import { lightFor, pedLossS } from './signals';

/** Fixed simulation step in seconds. */
export const DT = 0.5;

const ENTRY_TRIP_M = 300; // minimum travelled distance before a vehicle may leave at an entry node
const EXIT_PROB = 0.5; // chance of leaving at an entry node once that distance is reached
const MAX_AGE_S = 3600; // vehicles older than this are removed and counted as timed out
const MAX_WALKERS = 400;

interface KindParams {
  len: number; // vehicle length (m)
  T: number; // IDM desired time headway (s)
  s0: number; // IDM minimum gap (m)
  a: number; // IDM max acceleration (m/s^2)
  b: number; // IDM comfortable deceleration (m/s^2)
  headwayS: number; // base discharge headway per lane at a stop line (s)
  minEntryM: number; // required clear space at the start of a link (m)
  speedMult: number; // desired speed relative to link limit
}

/** ASSUMED parameters. Not calibrated to Kinshasa observations. */
const PARAMS: Record<Kind, KindParams> = {
  car: { len: 4.5, T: 1.5, s0: 2.0, a: 1.2, b: 2.0, headwayS: 1.9, minEntryM: 7, speedMult: 1.0 },
  moto: { len: 2.0, T: 1.0, s0: 1.0, a: 1.8, b: 2.5, headwayS: 1.2, minEntryM: 3, speedMult: 1.1 },
};

export interface Vehicle {
  id: number;
  kind: Kind;
  link: string;
  /** Front position along the current link (m). */
  s: number;
  v: number;
  a: number;
  spawnT: number;
  travelledM: number;
  freeFlowS: number;
  complies: boolean;
  /** Next link id chosen at the stop line. null = leaves the network. undefined = not chosen yet. */
  pending?: string | null;
}

/** Pedestrian shown crossing near a signalised junction (visual only; effect is in pedLossS). */
export interface Walker {
  id: number;
  node: string;
  bearingDeg: number;
  age: number;
  dur: number;
}

export interface LinkStat {
  linkId: string;
  meanSpeedRatio: number;
  congestion: number;
  maxQueue: number;
}

export interface SimResults {
  simulatedS: number;
  measuredS: number;
  arrivals: number;
  spawned: number;
  spawnBlocked: number;
  completedTotal: number;
  completedAfterWarmup: number;
  inSystem: number;
  timedOut: number;
  throughputVph: number;
  avgTravelTimeS: number;
  avgDelayS: number;
  avgQueueVehicles: number;
  maxQueueVehicles: number;
  redCrossings: number;
  topCongestedLinks: LinkStat[];
}

/** Intelligent Driver Model acceleration. */
function idmAccel(v: number, v0: number, gap: number, dv: number, p: KindParams): number {
  const sStar = p.s0 + Math.max(0, v * p.T + (v * dv) / (2 * Math.sqrt(p.a * p.b)));
  const g = Math.max(gap, 0.1);
  return p.a * (1 - Math.pow(v / v0, 4) - (sStar / g) ** 2);
}

function gauss(x: number, mu: number, sd: number): number {
  return Math.exp(-((x - mu) ** 2) / (2 * sd * sd));
}

/**
 * Microscopic, discrete-time traffic model for one network.
 * Cars and motorcycles follow each other with IDM on each link. Signals act as stop-line obstacles.
 * Junctions use a discharge headway per lane. Turns are chosen at random from configured weights.
 * Pedestrians only reduce green time (pedLossS) and appear as visual walkers.
 * All outputs are simulated estimates.
 */
export class Simulation {
  t = 0;
  vehicles: Vehicle[] = [];
  walkers: Walker[] = [];
  readonly nodeById: Map<string, NetNode>;
  readonly linkById: Map<string, NetLink>;
  readonly outgoing = new Map<string, NetLink[]>();
  /** Current-step mean speed ratio (v / desired) per link, for rendering. */
  readonly linkRatio = new Map<string, number>();

  private nextId = 1;
  private byLink = new Map<string, Vehicle[]>();
  private backS = new Map<string, number>();
  private lastDepart = new Map<string, number>();
  private linkLight = new Map<string, LightState>();
  private entryNodes: NetNode[];
  // Separate streams so demand draws do not depend on routing or walker draws.
  private rSpawn: Rng;
  private rRoute: Rng;
  private rPed: Rng;
  private acc = {
    arrivals: 0,
    spawned: 0,
    spawnBlocked: 0,
    completedTotal: 0,
    completed: 0,
    travelS: 0,
    delayS: 0,
    redCrossings: 0,
    timedOut: 0,
    queueSum: 0,
    queueSamples: 0,
    linkRatioSum: new Map<string, number>(),
    linkRatioN: new Map<string, number>(),
    linkMaxQueue: new Map<string, number>(),
  };

  constructor(
    readonly net: Network,
    private readonly getCfg: () => ScenarioConfig,
    readonly warmupS = 600,
  ) {
    const cfg = getCfg();
    this.nodeById = new Map(net.nodes.map((n): [string, NetNode] => [n.id, n]));
    this.linkById = new Map(net.links.map((l): [string, NetLink] => [l.id, l]));
    for (const l of net.links) {
      const arr = this.outgoing.get(l.from) ?? [];
      arr.push(l);
      this.outgoing.set(l.from, arr);
    }
    this.entryNodes = net.nodes.filter((n) => n.entry && (this.outgoing.get(n.id)?.length ?? 0) > 0);
    this.rSpawn = new Rng(cfg.seed + 101);
    this.rRoute = new Rng(cfg.seed + 202);
    this.rPed = new Rng(cfg.seed + 303);
  }

  get config(): ScenarioConfig {
    return this.getCfg();
  }

  step(dt: number = DT): void {
    const cfg = this.getCfg();
    this.spawn(dt, cfg);
    this.pedestrians(dt, cfg);
    this.rebuildIndex();
    this.computeLights(cfg);
    this.accelerate(cfg);
    const crossing = this.move(dt);
    this.rebuildIndex();
    this.transfer(crossing, cfg);
    this.collectStats(cfg);
    this.t += dt;
  }

  /** Signal colour for one approach axis at a junction, or null if the junction is unsignalised. */
  nodeLight(nodeId: string, axis: Axis): LightState | null {
    const cfg = this.getCfg();
    const plan = cfg.signals[nodeId];
    if (!plan) return null;
    return lightFor(plan, axis, this.t, pedLossS(plan, cfg.pedPerMinPerCrossing));
  }

  summary(): SimResults {
    const a = this.acc;
    const measuredS = Math.max(0, this.t - this.warmupS);
    let maxQueue = 0;
    const congestion: LinkStat[] = [];
    for (const [linkId, n] of a.linkRatioN) {
      const mean = (a.linkRatioSum.get(linkId) ?? 0) / n;
      const q = a.linkMaxQueue.get(linkId) ?? 0;
      maxQueue = Math.max(maxQueue, q);
      congestion.push({ linkId, meanSpeedRatio: mean, congestion: 1 - mean, maxQueue: q });
    }
    congestion.sort((x, y) => y.congestion - x.congestion);
    return {
      simulatedS: this.t,
      measuredS,
      arrivals: a.arrivals,
      spawned: a.spawned,
      spawnBlocked: a.spawnBlocked,
      completedTotal: a.completedTotal,
      completedAfterWarmup: a.completed,
      inSystem: this.vehicles.length,
      timedOut: a.timedOut,
      throughputVph: measuredS > 0 ? a.completed / (measuredS / 3600) : NaN,
      avgTravelTimeS: a.completed ? a.travelS / a.completed : NaN,
      avgDelayS: a.completed ? a.delayS / a.completed : NaN,
      avgQueueVehicles: a.queueSamples ? a.queueSum / a.queueSamples : NaN,
      maxQueueVehicles: maxQueue,
      redCrossings: a.redCrossings,
      topCongestedLinks: congestion.slice(0, 8),
    };
  }

  // ---- internals -----------------------------------------------------------

  private demandMultiplier(cfg: ScenarioConfig): number {
    const hour = ((cfg.timeOfDayStartH * 3600 + this.t) / 3600) % 24;
    // ASSUMED peak shape: evening peak around 18:00 and morning peak around 07:00.
    const peak = cfg.peakProfile ? 1 + 0.9 * gauss(hour, 18, 1.2) + 0.6 * gauss(hour, 7, 1.0) : 1;
    return cfg.demandMultiplier * peak;
  }

  private incidentFactor(cfg: ScenarioConfig, linkId: string): number {
    const inc = cfg.incidents.find((i) => i.linkId === linkId);
    return inc ? inc.speedFactor : 1;
  }

  private desiredSpeed(cfg: ScenarioConfig, link: NetLink, kind: Kind): number {
    return link.vmaxMps * cfg.speedFactor * this.incidentFactor(cfg, link.id) * PARAMS[kind].speedMult;
  }

  private spawn(dt: number, cfg: ScenarioConfig): void {
    const mult = this.demandMultiplier(cfg);
    const pCar = (cfg.carVphPerEntry * mult * dt) / 3600;
    const pMoto = (cfg.motoVphPerEntry * mult * dt) / 3600;
    for (const node of this.entryNodes) {
      const outs = this.outgoing.get(node.id)!;
      // Draw both arrivals every step, in fixed order, so demand stays identical across scenarios.
      const carArrives = this.rSpawn.next() < pCar;
      const motoArrives = this.rSpawn.next() < pMoto;
      if (carArrives) this.trySpawn(outs, 'car', cfg);
      if (motoArrives) this.trySpawn(outs, 'moto', cfg);
    }
  }

  private trySpawn(outs: NetLink[], kind: Kind, cfg: ScenarioConfig): void {
    this.acc.arrivals++;
    const link = outs[Math.floor(this.rSpawn.next() * outs.length)];
    const complies = this.rSpawn.next() < cfg.compliance[kind];
    const p = PARAMS[kind];
    const back = this.backS.get(link.id) ?? Infinity;
    if (back < p.minEntryM) {
      this.acc.spawnBlocked++;
      return;
    }
    const v0 = this.desiredSpeed(cfg, link, kind);
    this.vehicles.push({
      id: this.nextId++,
      kind,
      link: link.id,
      s: 0,
      v: 0.8 * v0,
      a: 0,
      spawnT: this.t,
      travelledM: 0,
      freeFlowS: 0,
      complies,
    });
    this.backS.set(link.id, -p.len);
    this.acc.spawned++;
  }

  private pedestrians(dt: number, cfg: ScenarioConfig): void {
    const p = (cfg.pedPerMinPerCrossing / 60) * dt;
    for (const nodeId of Object.keys(cfg.signals)) {
      const draw = this.rPed.next();
      if (draw >= p || this.walkers.length >= MAX_WALKERS) continue;
      const outs = this.outgoing.get(nodeId) ?? [];
      if (!outs.length) continue;
      const arm = outs[Math.floor(this.rPed.next() * outs.length)];
      this.walkers.push({ id: this.nextId++, node: nodeId, bearingDeg: arm.bearingDeg, age: 0, dur: 12 });
    }
    for (const w of this.walkers) w.age += dt;
    this.walkers = this.walkers.filter((w) => w.age < w.dur);
  }

  private rebuildIndex(): void {
    this.byLink.clear();
    this.backS.clear();
    for (const v of this.vehicles) {
      const arr = this.byLink.get(v.link);
      if (arr) arr.push(v);
      else this.byLink.set(v.link, [v]);
    }
    for (const [id, arr] of this.byLink) {
      arr.sort((a, b) => b.s - a.s); // front-most first
      const tail = arr[arr.length - 1];
      this.backS.set(id, tail.s - PARAMS[tail.kind].len);
    }
  }

  private computeLights(cfg: ScenarioConfig): void {
    this.linkLight.clear();
    for (const l of this.net.links) {
      const plan = cfg.signals[l.to];
      if (!plan) continue;
      const loss = pedLossS(plan, cfg.pedPerMinPerCrossing);
      this.linkLight.set(l.id, lightFor(plan, approachAxis(l), this.t, loss));
    }
  }

  /** Pass 1: compute accelerations from the current snapshot. */
  private accelerate(cfg: ScenarioConfig): void {
    for (const [linkId, list] of this.byLink) {
      const link = this.linkById.get(linkId)!;
      const light = this.linkLight.get(linkId);
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        const p = PARAMS[v.kind];
        const v0 = this.desiredSpeed(cfg, link, v.kind);
        let gap = Infinity;
        let dv = 0;
        if (i > 0) {
          const lead = list[i - 1];
          gap = lead.s - PARAMS[lead.kind].len - v.s;
          dv = v.v - lead.v;
        }
        // A compliant driver treats the stop line as a stationary obstacle if they can still stop.
        if ((light === 'red' || light === 'amber') && v.complies) {
          const d = link.lengthM - v.s;
          const stopDist = (v.v * v.v) / (2 * p.b);
          if (d > stopDist && d < gap) {
            gap = d;
            dv = v.v;
          }
        }
        v.a = idmAccel(v.v, v0, gap, dv, p);
      }
    }
  }

  /** Pass 2a: integrate positions. Returns vehicles that reached the end of their link. */
  private move(dt: number): Vehicle[] {
    this.vehicles = this.vehicles.filter((v) => {
      if (this.t - v.spawnT > MAX_AGE_S) {
        this.acc.timedOut++;
        return false;
      }
      return true;
    });
    const crossing: Vehicle[] = [];
    for (const v of this.vehicles) {
      v.v = Math.max(0, v.v + v.a * dt);
      const ds = v.v * dt;
      v.s += ds;
      v.travelledM += ds;
      if (v.s >= this.linkById.get(v.link)!.lengthM) crossing.push(v);
    }
    return crossing;
  }

  /** Pass 2b: move vehicles across junctions, subject to discharge headway and entry space. */
  private transfer(crossing: Vehicle[], cfg: ScenarioConfig): void {
    crossing.sort((a, b) => a.id - b.id);
    const exited = new Set<number>();
    for (const veh of crossing) {
      const from = this.linkById.get(veh.link)!;
      if (veh.pending === undefined) {
        veh.pending = this.chooseNext(from, veh, cfg)?.id ?? null;
      }
      if (veh.pending === null) {
        this.finish(veh, from, cfg);
        exited.add(veh.id);
        continue;
      }
      const to = this.linkById.get(veh.pending)!;
      const p = PARAMS[veh.kind];
      const headway = p.headwayS / (from.lanes * cfg.capacityFactor);
      const sinceDepart = this.t - (this.lastDepart.get(from.id) ?? -Infinity);
      const back = this.backS.get(to.id) ?? Infinity;
      if (sinceDepart < headway || back < p.minEntryM) {
        veh.s = from.lengthM; // held at the stop line
        veh.v = 0;
        continue;
      }
      if (this.linkLight.get(from.id) === 'red') this.acc.redCrossings++;
      veh.freeFlowS += from.lengthM / (from.vmaxMps * cfg.speedFactor);
      veh.s -= from.lengthM;
      veh.link = to.id;
      veh.pending = undefined;
      this.lastDepart.set(from.id, this.t);
      this.backS.set(to.id, Math.min(this.backS.get(to.id) ?? Infinity, veh.s - p.len));
    }
    if (exited.size) this.vehicles = this.vehicles.filter((v) => !exited.has(v.id));
  }

  private finish(veh: Vehicle, link: NetLink, cfg: ScenarioConfig): void {
    veh.freeFlowS += link.lengthM / (link.vmaxMps * cfg.speedFactor);
    this.acc.completedTotal++;
    if (this.t >= this.warmupS) {
      const travel = this.t - veh.spawnT;
      this.acc.completed++;
      this.acc.travelS += travel;
      this.acc.delayS += Math.max(0, travel - veh.freeFlowS);
    }
  }

  private chooseNext(from: NetLink, veh: Vehicle, cfg: ScenarioConfig): NetLink | null {
    const nodeId = from.to;
    const all = this.outgoing.get(nodeId) ?? [];
    if (!all.length) return null; // dead end
    const node = this.nodeById.get(nodeId)!;
    if (node.entry && veh.travelledM >= ENTRY_TRIP_M && this.rRoute.next() < EXIT_PROB) return null;
    let cand = all.filter((l) => l.to !== from.from); // avoid U-turns unless forced
    if (!cand.length) cand = all;
    const weights = cand.map((l) => this.turnWeight(from, l, cfg));
    const total = weights.reduce((x, y) => x + y, 0);
    if (total <= 0) return cand[Math.floor(this.rRoute.next() * cand.length)];
    let r = this.rRoute.next() * total;
    for (let i = 0; i < cand.length; i++) {
      r -= weights[i];
      if (r <= 0) return cand[i];
    }
    return cand[cand.length - 1];
  }

  private turnWeight(from: NetLink, to: NetLink, cfg: ScenarioConfig): number {
    const d = ((to.bearingDeg - from.bearingDeg + 540) % 360) - 180; // positive = clockwise = right turn
    if (Math.abs(d) < 30) return cfg.turning.straight;
    if (Math.abs(d) >= 150) return 0;
    return d > 0 ? cfg.turning.right : cfg.turning.left;
  }

  private collectStats(cfg: ScenarioConfig): void {
    this.rebuildIndex();
    this.linkRatio.clear();
    const measuring = this.t >= this.warmupS;
    let queue = 0;
    for (const [linkId, list] of this.byLink) {
      const link = this.linkById.get(linkId)!;
      let ratioSum = 0;
      let q = 0;
      for (const v of list) {
        ratioSum += Math.min(1, v.v / this.desiredSpeed(cfg, link, v.kind));
        if (v.v < 1) q++;
      }
      const ratio = ratioSum / list.length;
      this.linkRatio.set(linkId, ratio);
      queue += q;
      if (measuring) {
        this.acc.linkRatioSum.set(linkId, (this.acc.linkRatioSum.get(linkId) ?? 0) + ratio);
        this.acc.linkRatioN.set(linkId, (this.acc.linkRatioN.get(linkId) ?? 0) + 1);
        this.acc.linkMaxQueue.set(linkId, Math.max(this.acc.linkMaxQueue.get(linkId) ?? 0, q));
      }
    }
    if (measuring) {
      this.acc.queueSum += queue;
      this.acc.queueSamples++;
    }
  }
}
