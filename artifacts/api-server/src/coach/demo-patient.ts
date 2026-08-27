/**
 * Server-derived demo patient context.
 *
 * The coach endpoint must not trust client-supplied patient context, so the
 * server derives it from the same deterministic demo seed the mobile app
 * uses. Parity contract (see .agents/memory/cross-artifact-seed-parity.md):
 *
 * - Fixed anchor date 2026-08-22 ("today" is never derived from the clock).
 * - Demo patient pat_100 (Emma Smith) enrolled exactly 94 days before the
 *   anchor (mobile mock-data: graduated patient at index 0 -> 94 + 0).
 * - Phase boundaries mirror the mobile program-instructions data, which is a
 *   verbatim extract of the manual's phase headers.
 *
 * If the mobile seed for pat_100 ever changes, this module must change with
 * it — the demo-parity suite is the place to catch drift.
 */

export const DEMO_PATIENT_FIRST_NAME = "Emma";

/** Days since enrollment at the fixed anchor date (day 94 of the program). */
export const DEMO_PROGRAM_DAY = 94;

/** Verbatim phase names + day boundaries from the program instructions. */
const PHASES: Array<{ name: string; startDay: number; endDay: number | null }> = [
  { name: "Metabolic Activation Phase", startDay: 1, endDay: 2 },
  { name: "Metabolic Thinning Phase", startDay: 3, endDay: 39 },
  { name: "Metabolic Transition Phase", startDay: 40, endDay: 42 },
  { name: "Metabolic Normalization Phase", startDay: 43, endDay: null },
];

export function phaseNameForDay(day: number): string {
  const d = Math.max(1, Math.floor(day));
  const phase =
    PHASES.find((p) => d >= p.startDay && (p.endDay === null || d <= p.endDay)) ??
    PHASES[PHASES.length - 1];
  return phase.name;
}

/**
 * Stall-outreach trend for the demo patient, matching what the mobile app
 * computes from its seeded records (mock-data stall seed for pat_100; the
 * stall-nudge verify suite pins these numbers against the client trigger).
 * The back-on-track prompt cites them so the model can reference the
 * patient's real numbers without trusting the client:
 *
 * - started at 180.0 lb, holding near 169.5 lb for about the last 3 weeks
 * - goal 150 lb
 * - diary window: repeated off-plan items over the last two weeks
 */
export const DEMO_STALL_TREND = {
  startWeightLb: 180,
  currentWeightLb: 169.5,
  goalWeightLb: 150,
  stalledWeeks: 3,
} as const;

export interface DemoPatientContext {
  firstName: string;
  programDay: number;
  phaseName: string;
}

export function demoPatientContext(): DemoPatientContext {
  return {
    firstName: DEMO_PATIENT_FIRST_NAME,
    programDay: DEMO_PROGRAM_DAY,
    phaseName: phaseNameForDay(DEMO_PROGRAM_DAY),
  };
}
