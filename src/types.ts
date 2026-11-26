export type Kind = 'car' | 'moto';
/** A = north-south approaches, B = east-west approaches (derived from link bearing). */
export type Axis = 'A' | 'B';
export type LightState = 'green' | 'amber' | 'red';

export interface NetNode {
  id: string;
  lat: number;
  lng: number;
  /** Boundary node where vehicles may enter and leave the modelled area. */
  entry: boolean;
}

/** One directed road segment between two nodes. */
export interface NetLink {
  id: string;
  from: string;
  to: string;
  lengthM: number;
  lanes: number;
  vmaxMps: number;
  bearingDeg: number;
  name?: string;
}

export interface SignalPlan {
  cycleS: number;
  /** Share of effective green given to the A (north-south) approaches. */
  splitA: number;
  amberS: number;
  /** All-red lost time per cycle. */
  lostS: number;
}

export type SignalMap = Record<string, SignalPlan>;

export interface Network {
  name: string;
  dataSource: 'synthetic-demo' | 'openstreetmap';
  attribution: string;
  generatedAt: string;
  nodes: NetNode[];
  links: NetLink[];
  /** Signals present in the network data (baseline). Not observed timing data. */
  defaultSignals: SignalMap;
}

export interface Incident {
  linkId: string;
  /** Multiplier on the link's free-flow speed while the incident is active. */
  speedFactor: number;
}

/** Settings shared by baseline and intervention so demand and behaviour are identical. */
export interface SharedConfig {
  seed: number;
  timeOfDayStartH: number;
  peakProfile: boolean;
  carVphPerEntry: number;
  motoVphPerEntry: number;
  pedPerMinPerCrossing: number;
  demandMultiplier: number;
  /** Relative weights for turning movements at each junction. */
  turning: { straight: number; left: number; right: number };
  /** Share of drivers who stop for red or amber. */
  compliance: Record<Kind, number>;
  /** Multiplies lane count in the discharge-headway model. */
  capacityFactor: number;
  speedFactor: number;
  incidents: Incident[];
}

/** A runnable scenario: shared settings plus its own signal plan. */
export interface ScenarioConfig extends SharedConfig {
  signals: SignalMap;
}
