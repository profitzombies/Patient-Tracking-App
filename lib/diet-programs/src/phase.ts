/**
 * Program phase, derived from the patient's current protocol episode.
 *
 * The THINNR protocol is 42 days; day 43 onward is the Metabolic
 * Normalization Phase ("maintenance"). A provider restart opens a new
 * episode whose start date resets the calendar to day one; earlier episodes
 * keep their rows, so the phase is always a function of the CURRENT episode
 * only. Patients whose program is "none" (tracking only, never enrolled on
 * the protocol) are treated as maintenance from day one for target purposes.
 */

export const PROTOCOL_LENGTH_DAYS = 42;

/** Verbatim phase names + day boundaries from the program instructions. */
export const PROGRAM_PHASES: ReadonlyArray<{ name: string; startDay: number; endDay: number | null }> = [
  { name: "Metabolic Activation Phase", startDay: 1, endDay: 2 },
  { name: "Metabolic Thinning Phase", startDay: 3, endDay: 39 },
  { name: "Metabolic Transition Phase", startDay: 40, endDay: 42 },
  { name: "Metabolic Normalization Phase", startDay: 43, endDay: null },
];

export type ProgramPhase = "protocol" | "maintenance";
export type ProgramId = "thinnr" | "glp1" | "none";

export interface PhaseInput {
  /** Start date of the current episode, YYYY-MM-DD (or an ISO timestamp; only the date part is used). */
  episodeStartedOn: string | null | undefined;
  /** The day being evaluated, YYYY-MM-DD. */
  todayKey: string;
  /** thinnr = protocol then maintenance; glp1 / none never lock the picker. */
  programId?: ProgramId | null;
}

export interface PhaseState {
  programDay: number;
  phase: ProgramPhase;
  phaseName: string;
  /** 1 on the first maintenance day, 0 while still in the protocol. */
  maintenanceDay: number;
  /** Whether the diet picker is locked to the protocol. */
  dietPickerLocked: boolean;
}

export function phaseNameForDay(day: number): string {
  const d = Math.max(1, Math.floor(day));
  const phase = PROGRAM_PHASES.find((p) => d >= p.startDay && (p.endDay === null || d <= p.endDay)) ?? PROGRAM_PHASES[PROGRAM_PHASES.length - 1];
  return phase.name;
}

/**
 * Day N of the program: whole days since the episode started, clamped so the
 * start day itself reads as day 1 (never 0) and nothing exceeds 2000. These
 * are the semantics the demo seed, the server and the app already share;
 * a restart simply moves the start date.
 */
export function programDayBetween(startedOn: string | null | undefined, todayKey: string): number {
  const startKey = String(startedOn ?? todayKey).slice(0, 10);
  const start = Date.parse(`${startKey}T00:00:00Z`);
  const today = Date.parse(`${todayKey}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(today)) return 1;
  const days = Math.round((today - start) / 86_400_000);
  return Math.max(1, Math.min(2000, days));
}

export function derivePhase(input: PhaseInput): PhaseState {
  const programDay = programDayBetween(input.episodeStartedOn, input.todayKey);
  const onProtocolProgram = (input.programId ?? "thinnr") === "thinnr";
  const inProtocolWindow = programDay <= PROTOCOL_LENGTH_DAYS;
  const phase: ProgramPhase = onProtocolProgram && inProtocolWindow ? "protocol" : "maintenance";
  return {
    programDay,
    phase,
    phaseName: onProtocolProgram ? phaseNameForDay(programDay) : PROGRAM_PHASES[PROGRAM_PHASES.length - 1].name,
    maintenanceDay: phase === "maintenance" ? (onProtocolProgram ? programDay - PROTOCOL_LENGTH_DAYS : programDay) : 0,
    dietPickerLocked: phase === "protocol",
  };
}
