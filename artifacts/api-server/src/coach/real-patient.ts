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
import { supabaseAdmin } from "../lib/supabase-admin";
import { dayKeyInTimeZone, maxPlausibleDayKey } from "../lib/local-day";
import { phaseNameForDay } from "./demo-patient";
import type { PatientContext, PatientDayTargets } from "./prompt";

const enc = encodeURIComponent;

/**
 * Program defaults, mirrored from the mobile app's data/patient-data.ts
 * DEFAULT_TARGETS. Per-patient overrides ride patient_target_overrides rows.
 */
export const DEFAULT_TARGETS: PatientDayTargets = {
  calories: 1500,
  protein: 120,
  carbs: 130,
  fat: 50,
  waterOz: 64,
};

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Real calendar date in a sane window, formatted exactly YYYY-MM-DD. */
export function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_KEY_RE.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(time)) return false;
  if (new Date(time).toISOString().slice(0, 10) !== value) return false;
  return value >= "2020-01-01" && value <= "2035-12-31";
}

export interface PatientProfile {
  name: string | null;
  first_name?: string | null;
  last_name?: string | null;
  program_start_date: string | null;
  created_at: string | null;
  timezone?: string | null;
}

/** The clinical row facts the chat surfaces need (name, dates, timezone). */
export async function fetchPatientProfile(patientId: string): Promise<PatientProfile> {
  const lookup = await supabaseAdmin(
    "GET",
    `/rest/v1/patients?id=eq.${enc(patientId)}&select=first_name,last_name,name,program_start_date,created_at,timezone`,
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
 * Day N of the program at the given date key, using the demo seed's
 * semantics (days since enrollment, clamped so the enrollment day itself
 * reads as day 1, never day 0). Falls back to the row's creation date when
 * no program start is recorded.
 */
export function programDayFor(profile: PatientProfile, todayKey: string): number {
  const startRaw = profile.program_start_date ?? profile.created_at ?? todayKey;
  const startKey = String(startRaw).slice(0, 10);
  const start = Date.parse(`${startKey}T00:00:00Z`);
  const today = Date.parse(`${todayKey}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(today)) return 1;
  const days = Math.round((today - start) / 86_400_000);
  return Math.max(1, Math.min(2000, days));
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

  const [entries, water, overrides] = await Promise.all([
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
  const target = (key: keyof PatientDayTargets, column: string): number => {
    const value = overrideRow[column];
    return typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_TARGETS[key];
  };

  const waterRow = (water.json[0] ?? {}) as Record<string, unknown>;
  const programDay = programDayFor(profile, dateKey);

  return {
    firstName: firstNameOf(profile.name),
    programDay,
    phaseName: phaseNameForDay(programDay),
    today: {
      dateKey,
      calories: sumField(entries.json, "calories"),
      protein: sumField(entries.json, "protein"),
      carbs: sumField(entries.json, "carbs"),
      fat: sumField(entries.json, "fat"),
      waterOz:
        typeof waterRow.oz === "number" && Number.isFinite(waterRow.oz) ? waterRow.oz : 0,
      targets: {
        calories: target("calories", "calories"),
        protein: target("protein", "protein"),
        carbs: target("carbs", "carbs"),
        fat: target("fat", "fat"),
        waterOz: target("waterOz", "water_oz"),
      },
    },
  };
}
