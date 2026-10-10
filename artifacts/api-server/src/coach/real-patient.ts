/**
 * Real-patient grounding for the coach — the live-account counterpart of
 * demo-patient.ts.
 *
 * When a coach chat request carries a patient's bearer session, the coach
 * grounds its personalization on that patient's account instead of the demo
 * seed: their first name, their program day (from the clinical row's
 * program start date), and a live "today so far" block summed from the
 * patient-diary rail (logged calories/macros/water against their effective
 * targets).
 *
 * Failures THROW — the route answers with a retryable JSON error before the
 * stream opens. A real patient must never be silently grounded on the demo
 * patient's numbers.
 */
import { FALLBACK_TARGETS, isActivityLevel, programDayBetween, type ActivityLevel } from "@workspace/diet-programs";
import { supabaseAdmin } from "../lib/supabase-admin";
import { dayKeyInTimeZone, maxPlausibleDayKey } from "../lib/local-day";
import { computePatientTargets, type TargetPatientRow } from "../diet/targets";
import { episodeRecord, EPISODE_SELECT, type EpisodeRecord } from "../diet/store";
import type { PatientContext, PatientDayTargets } from "./prompt";

const enc = encodeURIComponent;

/**
 * Targets used only while the body numbers the calculator needs are missing
 * (the shared calculator's fallback). Real targets come from the patient's
 * goals, BMR, activity level and phase — never from a fixed table.
 */
export const DEFAULT_TARGETS: PatientDayTargets = { ...FALLBACK_TARGETS };

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Real calendar date in a sane window, formatted exactly YYYY-MM-DD. */
export function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_KEY_RE.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(time)) return false;
  if (new Date(time).toISOString().slice(0, 10) !== value) return false;
  return value >= "2020-01-01" && value <= "2035-12-31";
}

export interface PatientProfile extends TargetPatientRow {
  name: string | null;
  first_name?: string | null;
  last_name?: string | null;
  program_start_date: string | null;
  created_at: string | null;
  timezone?: string | null;
}

/** The clinical row facts the chat surfaces need (name, dates, timezone, body numbers for targets). */
export async function fetchPatientProfile(patientId: string): Promise<PatientProfile> {
  const lookup = await supabaseAdmin(
    "GET",
    `/rest/v1/patients?id=eq.${enc(patientId)}&select=first_name,last_name,name,program_id,program_start_date,created_at,timezone,gender,date_of_birth,height_inches,current_weight,goal_weight`,
  );
  if (lookup.status >= 300 || !Array.isArray(lookup.json) || lookup.json.length === 0) {
    throw new Error(`patient profile lookup failed (${lookup.status})`);
  }
  const row = lookup.json[0] as PatientProfile;
  const canonicalName = [row.first_name, row.last_name]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map(part => part.trim())
    .join(" ");
  return { ...row, name: canonicalName || row.name };
}

/** First word of the clinical name; "there" when the row has none. */
export function firstNameOf(name: string | null | undefined): string {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return first.length > 0 ? first : "there";
}

/**
 * Day N of the program at the given date key (shared rule: whole days since
 * the current episode started, clamped so the start day reads as day 1).
 * The clinical row's program_start_date mirrors the open protocol episode
 * (a database trigger keeps them in step), so a provider restart moves it;
 * the row's creation date is the fallback when no start is recorded.
 */
export function programDayFor(profile: Pick<PatientProfile, "program_start_date" | "created_at">, todayKey: string): number {
  return programDayBetween(profile.program_start_date ?? profile.created_at ?? todayKey, todayKey);
}

/** The open protocol episode, or null when the row predates the episode ledger. */
export async function fetchOpenEpisode(patientId: string): Promise<EpisodeRecord | null> {
  const res = await supabaseAdmin("GET", `/rest/v1/patient_protocol_episodes?patient_id=eq.${enc(patientId)}&ended_on=is.null&select=${EPISODE_SELECT}&order=episode_number.desc&limit=1`);
  if (res.status >= 300 || !Array.isArray(res.json)) throw new Error(`protocol episode lookup failed (${res.status})`);
  return res.json[0] ? episodeRecord(res.json[0] as Record<string, unknown>) : null;
}

/** The latest recorded activity level, or null when never asked. */
export async function fetchActivityLevel(patientId: string): Promise<ActivityLevel | null> {
  const res = await supabaseAdmin("GET", `/rest/v1/patient_activity_levels?patient_id=eq.${enc(patientId)}&select=level&order=recorded_on.desc,created_at.desc&limit=1`);
  if (res.status >= 300 || !Array.isArray(res.json)) throw new Error(`activity level lookup failed (${res.status})`);
  const level = (res.json[0] as { level?: unknown } | undefined)?.level;
  return isActivityLevel(level) ? level : null;
}

function sumField(rows: unknown[], field: string): number {
  let total = 0;
  for (const row of rows) {
    const value = (row as Record<string, unknown>)[field];
    if (typeof value === "number" && Number.isFinite(value)) total += value;
  }
  return total;
}

/**
 * Build the coach's patient context from the live account. `localDate` is
 * the app's own calendar date for the diary day it is showing (the client
 * sends it with authenticated turns). When it's missing or implausible
 * (older client, wrong device clock), the patient's stored timezone decides
 * the day — never the server's UTC clock, which flips to tomorrow
 * mid-evening for US patients.
 */
export async function realPatientContext(
  patientId: string,
  localDate: string | undefined,
): Promise<PatientContext> {
  const profile = await fetchPatientProfile(patientId);
  const dateKey =
    isDateKey(localDate) && localDate <= maxPlausibleDayKey()
      ? localDate
      : dayKeyInTimeZone(profile.timezone);

  const [entries, water, overrides, episode, activityLevel] = await Promise.all([
    supabaseAdmin(
      "GET",
      `/rest/v1/patient_diary_entries?patient_id=eq.${enc(patientId)}&date_key=eq.${dateKey}&select=calories,protein,carbs,fat`,
    ),
    supabaseAdmin(
      "GET",
      `/rest/v1/patient_water_days?patient_id=eq.${enc(patientId)}&date_key=eq.${dateKey}&select=oz`,
    ),
    supabaseAdmin(
      "GET",
      `/rest/v1/patient_target_overrides?patient_id=eq.${enc(patientId)}&select=calories,protein,carbs,fat,water_oz`,
    ),
    fetchOpenEpisode(patientId),
    fetchActivityLevel(patientId),
  ]);
  if (entries.status >= 300 || !Array.isArray(entries.json)) {
    throw new Error(`patient diary lookup failed (${entries.status})`);
  }
  if (water.status >= 300 || !Array.isArray(water.json)) {
    throw new Error(`patient water lookup failed (${water.status})`);
  }
  if (overrides.status >= 300 || !Array.isArray(overrides.json)) {
    throw new Error(`patient targets lookup failed (${overrides.status})`);
  }

  const overrideRow = (overrides.json[0] ?? {}) as Record<string, unknown>;
  const override = (column: string): number | null => {
    const value = overrideRow[column];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  // Diet choice never changes targets: goals + BMR + activity + phase do.
  const computed = computePatientTargets(profile, episode, activityLevel, {
    calories: override("calories"), protein: override("protein"), carbs: override("carbs"), fat: override("fat"), waterOz: override("water_oz"),
  }, dateKey);

  const waterRow = (water.json[0] ?? {}) as Record<string, unknown>;

  return {
    firstName: firstNameOf(profile.name),
    programDay: computed.phase.programDay,
    phaseName: computed.phase.phaseName,
    today: {
      dateKey,
      calories: sumField(entries.json, "calories"),
      protein: sumField(entries.json, "protein"),
      carbs: sumField(entries.json, "carbs"),
      fat: sumField(entries.json, "fat"),
      waterOz:
        typeof waterRow.oz === "number" && Number.isFinite(waterRow.oz) ? waterRow.oz : 0,
      targets: { ...computed.targets.effective },
    },
  };
}
