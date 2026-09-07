/**
 * Missed-dose backup reminders.
 *
 * The phone's local reminder fires at the scheduled time; this evaluation is
 * the server-side backstop for a dose that is still unlogged a configurable
 * time after it was due (MEDICATION_BACKUP_DELAY_MINUTES, default 60). Each
 * scheduled occurrence in the trailing lookback window becomes at most one
 * outbox row (dedupe key per medication + occurrence), so a patient who logs
 * the dose from the check-in card before the delay elapses never hears from
 * us. The row rides the check_in_reminders category, so the patient's
 * category preferences and quiet hours are applied by the sender at send
 * time, exactly like every other outbox row — nothing is pre-filtered here.
 * Rows expire 24 h after the due time so a quiet-hours deferral can't
 * deliver yesterday's reminder tomorrow. An organization-wide daily cap for
 * this kind is reserved atomically by the store.
 */
import {
  DEFAULT_MISSED_GRACE_MINUTES,
  indexLogs,
  localDateKey,
  medicationLine,
  occurrenceKey,
  occurrencesBetween,
  formatClockTime,
  type DoseLogRecord,
  type DoseOccurrence,
  type MedicationRecord,
} from "../medications/schedule";
import { utcDayStart } from "./stall-outreach";
import type { NotificationStore } from "./store";

export const MISSED_DOSE_KIND = "medication_missed_dose";
export const MISSED_DOSE_CATEGORY = "check_in_reminders" as const;
export const MISSED_DOSE_ROUTE = "/check-in";
export const MISSED_DOSE_TITLE = "Missed dose?";
/** Occurrences older than this are never chased. */
export const MISSED_DOSE_LOOKBACK_MS = 24 * 60 * 60_000;
export const MISSED_DOSE_EXPIRY_MS = 24 * 60 * 60_000;
export const DEFAULT_MISSED_DOSE_DAILY_CAP = 1000;

/** Everything the evaluation reads for one patient. */
export interface MedicationDoseFacts {
  patientId: string;
  providerId: string;
  timezone: string | null;
  medications: MedicationRecord[];
  logs: DoseLogRecord[];
}

/** Blank-safe positive-integer env knob (unset/blank/invalid = fallback). */
export function envMinutes(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

export function missedDoseDelayMinutes(): number {
  return envMinutes("MEDICATION_BACKUP_DELAY_MINUTES", DEFAULT_MISSED_GRACE_MINUTES);
}

export function missedDoseDailyCap(): number {
  const value = envMinutes("MEDICATION_BACKUP_DAILY_CAP", DEFAULT_MISSED_DOSE_DAILY_CAP);
  return value > 0 ? value : DEFAULT_MISSED_DOSE_DAILY_CAP;
}

export function missedDoseDedupeKey(occurrence: Pick<DoseOccurrence, "medicationId" | "dueDate" | "dueTime">): string {
  return `medication-missed:${occurrence.medicationId}:${occurrence.dueDate}:${occurrence.dueTime}`;
}

export interface MissedDose {
  patientId: string;
  providerId: string;
  medication: MedicationRecord;
  occurrence: DoseOccurrence;
}

/**
 * Pure: every unlogged occurrence whose due time plus the delay has passed,
 * within the lookback window, for one patient.
 */
export function missedDosesFor(facts: MedicationDoseFacts, now: Date, delayMinutes: number, lookbackMs: number = MISSED_DOSE_LOOKBACK_MS): MissedDose[] {
  const logs = indexLogs(facts.logs);
  const from = new Date(now.getTime() - lookbackMs);
  const latestDue = new Date(now.getTime() - delayMinutes * 60_000);
  if (latestDue.getTime() < from.getTime()) return [];
  const byId = new Map(facts.medications.map((m) => [m.id, m]));
  const fromMs = from.getTime();
  const latestMs = latestDue.getTime();
  return occurrencesBetween(facts.medications, localDateKey(from, facts.timezone), localDateKey(latestDue, facts.timezone), facts.timezone)
    .filter((occurrence) => {
      const dueMs = new Date(occurrence.dueAt).getTime();
      return dueMs >= fromMs && dueMs <= latestMs;
    })
    .filter((occurrence) => !logs.has(occurrenceKey(occurrence.medicationId, occurrence.dueDate, occurrence.dueTime)))
    .map((occurrence) => ({
      patientId: facts.patientId,
      providerId: facts.providerId,
      medication: byId.get(occurrence.medicationId)!,
      occurrence,
    }));
}

export function missedDoseBody(medication: MedicationRecord, occurrence: DoseOccurrence): string {
  return `Your ${formatClockTime(occurrence.dueTime)} ${medicationLine(medication)} isn't logged yet. Tap to mark it taken or skipped.`;
}

export interface MissedDoseRunSummary {
  patients: number;
  due: number;
  sent: number;
  capped: number;
  errors: number;
}

export interface MissedDoseRunDeps {
  store: NotificationStore;
  now?: () => Date;
  delayMinutes?: number;
  dailyCap?: number;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export async function runMissedDoseEvaluation(deps: MissedDoseRunDeps): Promise<MissedDoseRunSummary> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const delayMinutes = deps.delayMinutes ?? missedDoseDelayMinutes();
  const cap = deps.dailyCap ?? missedDoseDailyCap();
  const summary: MissedDoseRunSummary = { patients: 0, due: 0, sent: 0, capped: 0, errors: 0 };
  const at = now();
  // Lookback in calendar terms: one day of slack past the window so a
  // patient-local date on either side of the UTC date boundary is covered.
  const fromDate = new Date(at.getTime() - MISSED_DOSE_LOOKBACK_MS - 36 * 60 * 60_000).toISOString().slice(0, 10);
  const facts = await deps.store.medicationDoseFacts(fromDate);
  for (const patient of facts) {
    summary.patients += 1;
    let missed: MissedDose[];
    try {
      missed = missedDosesFor(patient, at, delayMinutes);
    } catch (error) {
      summary.errors += 1;
      log("missed_dose_evaluation_error", { patientId: patient.patientId, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    for (const item of missed) {
      summary.due += 1;
      try {
        const reserved = await deps.store.enqueueCapped(
          {
            patientId: item.patientId,
            kind: MISSED_DOSE_KIND,
            category: MISSED_DOSE_CATEGORY,
            title: MISSED_DOSE_TITLE,
            body: missedDoseBody(item.medication, item.occurrence),
            data: {
              route: MISSED_DOSE_ROUTE,
              medicationId: item.medication.id,
              dueDate: item.occurrence.dueDate,
              dueTime: item.occurrence.dueTime,
            },
            dedupeKey: missedDoseDedupeKey(item.occurrence),
            scheduledAt: at,
            expiresAt: new Date(new Date(item.occurrence.dueAt).getTime() + MISSED_DOSE_EXPIRY_MS),
          },
          { limit: cap, since: utcDayStart(at) },
        );
        if (reserved.outcome === "created") summary.sent += 1;
        else if (reserved.outcome === "capped") summary.capped += 1;
      } catch (error) {
        summary.errors += 1;
        log("missed_dose_enqueue_error", {
          patientId: item.patientId,
          medicationId: item.medication.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return summary;
}
