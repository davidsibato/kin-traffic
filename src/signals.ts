import type { Axis, LightState, SignalPlan } from './types';

/**
 * Pedestrian clearance time (s) taken out of each cycle.
 * ASSUMED model: about 0.5 s of green per pedestrian arriving in the cycle, capped at 15% of cycle.
 */
export function pedLossS(plan: SignalPlan, pedPerMin: number): number {
  const pedsPerCycle = (pedPerMin * plan.cycleS) / 60;
  const maxLoss = Math.max(0, plan.cycleS - 2 * plan.amberS - plan.lostS - 5);
  return Math.min(0.15 * plan.cycleS, 0.5 * pedsPerCycle, maxLoss);
}

/**
 * Two-phase fixed-time signal.
 * Timeline: A green, A amber, B green, B amber, then all-red (lost time and pedestrian clearance).
 */
export function lightFor(plan: SignalPlan, axis: Axis, tS: number, pedLoss: number): LightState {
  const C = plan.cycleS;
  const A = plan.amberS;
  const green = C - 2 * A - plan.lostS - pedLoss;
  const gA = green * plan.splitA;
  const gB = green - gA;
  const t = ((tS % C) + C) % C;

  if (axis === 'A') {
    if (t < gA) return 'green';
    if (t < gA + A) return 'amber';
    return 'red';
  }
  const bStart = gA + A;
  if (t >= bStart && t < bStart + gB) return 'green';
  if (t >= bStart + gB && t < bStart + gB + A) return 'amber';
  return 'red';
}
