import type { Network, ScenarioConfig, SharedConfig, SignalMap } from './types';
import { DT, Simulation, type SimResults } from './sim';

/** Runs one scenario headlessly for a fixed simulated duration. */
export function runScenario(net: Network, cfg: ScenarioConfig, durationS: number, warmupS: number): SimResults {
  const sim = new Simulation(net, () => cfg, warmupS);
  const steps = Math.round(durationS / DT);
  for (let i = 0; i < steps; i++) sim.step(DT);
  return sim.summary();
}

export interface Comparison {
  baseline: SimResults;
  intervention: SimResults;
}

/**
 * Baseline vs intervention with identical shared settings and seed.
 * Only the signal plans differ. Arrivals are drawn from their own random stream,
 * so the same demand reaches both runs.
 */
export function compareScenarios(
  net: Network,
  shared: SharedConfig,
  baselineSignals: SignalMap,
  interventionSignals: SignalMap,
  durationS = 3600,
  warmupS = 600,
): Comparison {
  return {
    baseline: runScenario(net, { ...shared, signals: baselineSignals }, durationS, warmupS),
    intervention: runScenario(net, { ...shared, signals: interventionSignals }, durationS, warmupS),
  };
}
