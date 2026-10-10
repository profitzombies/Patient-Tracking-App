/**
 * Patient targets — the server side of the shared goal + BMR calculator.
 *
 * Diet choice has NO effect here (owner decision). Targets come from the
 * clinical row (gender, date of birth, height, current and goal weight), the
 * latest recorded activity level and the explicit phase derived from the open
 * protocol episode; patient overrides win field by field. The calculation is
 * the shared pure function the mobile app also runs offline, so both show
 * the same numbers.
 *
 * A snapshot per patient-local day is upserted on every read so the record
 * export and the staff record page can show what the app told the patient.
 */
import { supabaseAdmin } from "../lib/supabase-admin";
import {
  ageFromDateOfBirth,
  calculateTargets,
  derivePhase,
  type ActivityLevel,
  type CalculatedTargets,
  type PhaseState,
  type ProgramId,
  type TargetInput,
  type TargetOverrides,
} from "@workspace/diet-programs";
import type { EpisodeRecord } from "./store";

const enc = encodeURIComponent;

export interface TargetPatientRow {
  gender?: string | null;
  date_of_birth?: string | null;
  height_inches?: number | string | null;
  current_weight?: number | string | null;
  goal_weight?: number | string | null;
  program_id?: string | null;
  program_start_date?: string | null;
  created_at?: string | null;
}

const num = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") { const n = Number(value); return Number.isFinite(n) ? n : null; }
  return null;
};

export function programIdOf(row: TargetPatientRow): ProgramId {
  return row.program_id === "glp1" || row.program_id === "none" ? row.program_id : "thinnr";
}

/** The phase for a patient on a day: open episode first, else the row's start date, else enrollment. */
export function phaseFor(row: TargetPatientRow, episode: EpisodeRecord | null, dateKey: string): PhaseState {
  const startedOn = episode?.startedOn ?? row.program_start_date ?? row.created_at ?? dateKey;
  return derivePhase({ episodeStartedOn: startedOn, todayKey: dateKey, programId: programIdOf(row) });
}

export function targetInputFor(row: TargetPatientRow, phase: PhaseState, activityLevel: ActivityLevel | null, dateKey: string): TargetInput {
  return {
    gender: row.gender === "male" || row.gender === "female" ? row.gender : null,
    ageYears: ageFromDateOfBirth(row.date_of_birth, dateKey),
    heightInches: num(row.height_inches),
    weightLb: num(row.current_weight),
    goalWeightLb: num(row.goal_weight),
    activityLevel,
    phase: phase.phase,
    programDay: phase.programDay,
    maintenanceDay: phase.maintenanceDay,
    cameFromProtocol: programIdOf(row) === "thinnr",
  };
}

export interface PatientTargetsResult {
  dateKey: string;
  phase: PhaseState;
  input: TargetInput;
  targets: CalculatedTargets;
}

export function computePatientTargets(row: TargetPatientRow, episode: EpisodeRecord | null, activityLevel: ActivityLevel | null, overrides: TargetOverrides, dateKey: string): PatientTargetsResult {
  const phase = phaseFor(row, episode, dateKey);
  const input = targetInputFor(row, phase, activityLevel, dateKey);
  return { dateKey, phase, input, targets: calculateTargets(input, overrides) };
}

/** Best-effort daily snapshot; failures are the caller's to log, never to surface. */
export async function upsertTargetSnapshot(patientId: string, result: PatientTargetsResult, at: Date): Promise<void> {
  const res = await supabaseAdmin("POST", "/rest/v1/patient_target_snapshots?on_conflict=patient_id,date_key", [{
    patient_id: patientId, date_key: result.dateKey, phase: result.phase.phase, program_day: result.phase.programDay,
    inputs: { ...result.input, activityLevel: result.input.activityLevel ?? null },
    calculated: result.targets.calculated, effective: result.targets.effective, updated_at: at.toISOString(),
  }], "resolution=merge-duplicates,return=minimal");
  if (res.status >= 300) throw new Error(`target snapshot write failed (${res.status})`);
}

export async function loadTargetSnapshots(patientId: string, limit = 30): Promise<Array<Record<string, unknown>>> {
  const res = await supabaseAdmin("GET", `/rest/v1/patient_target_snapshots?patient_id=eq.${enc(patientId)}&select=date_key,phase,program_day,inputs,calculated,effective,updated_at&order=date_key.desc&limit=${limit}`);
  if (res.status >= 300) throw new Error(`target snapshot read failed (${res.status})`);
  return Array.isArray(res.json) ? (res.json as Array<Record<string, unknown>>) : [];
}

export function targetsDto(result: PatientTargetsResult, overrides: TargetOverrides) {
  const t = result.targets;
  return {
    dateKey: result.dateKey,
    phase: result.phase.phase,
    programDay: result.phase.programDay,
    maintenanceDay: result.phase.maintenanceDay,
    calculated: t.calculated,
    effective: t.effective,
    overrides: {
      calories: overrides.calories ?? null, protein: overrides.protein ?? null, carbs: overrides.carbs ?? null,
      fat: overrides.fat ?? null, waterOz: overrides.waterOz ?? null,
    },
    overridden: t.overridden,
    bmr: t.bmr,
    maintenanceCalories: t.maintenanceCalories,
    goalDirection: t.goalDirection,
    rampStep: t.rampStep,
    ramping: t.ramping,
    missing: t.missing,
    activityLevel: result.input.activityLevel ?? null,
  };
}
