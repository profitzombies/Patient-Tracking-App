/**
 * Patient app event ledger — the single write helper behind HQ Insights.
 *
 * Each tracked feature's server write seam calls `recordPatientEvent` after
 * its own write succeeds. The database RPC resolves the patient's office and
 * effective timezone and stores the LOCAL day / weekday / hour, so the
 * patient app needs no changes and every caller passes the same three things:
 * who, which feature, and (from the request headers) which platform.
 *
 * Recording is fire-and-forget: the patient's own write has already landed
 * and an analytics miss must never turn a saved meal into a 502. Failures are
 * logged with the feature so a broken seam is visible in the API log.
 */
import { platformOf, type Platform } from "../security/device";
import { logger } from "./logger";
import { supabaseAdmin } from "./supabase-admin";
import type { InsightsDataset } from "@workspace/app-usage-insights";

export type PatientEventFeature = Exclude<InsightsDataset, "app_open">;

export interface RecordPatientEventOptions {
  /** Request headers; the platform hint (`x-thinnr-platform`) is read from them. */
  headers?: Record<string, unknown>;
  platform?: Platform;
  /** Instant of the action; defaults to the database clock. */
  at?: Date;
  /** One event per counted action (a multi-entry meal save); clamped to 50 by the database. */
  count?: number;
  /**
   * Natural keys of the counted source rows (a message id, a diary entry id).
   * When given, the database keys each event on (feature, source key) and a
   * replay of the same keys inserts nothing; `count` is ignored. Formats must
   * match the backfill: `<conversation_id>:<client_id>` for chat messages,
   * `<patient_id>:<entry_id>` for diary entries.
   */
  sourceKeys?: string[];
}

/** Number of events a write would attempt (0 = nothing to record). */
function attempted(options: RecordPatientEventOptions): number {
  return options.sourceKeys ? options.sourceKeys.length : options.count ?? 1;
}

/**
 * Write one (or `count` / one per source key) events now; throws on failure.
 * Returns the number of rows the database actually inserted (keyed replays
 * report 0).
 */
export async function writePatientEvent(patientId: string, feature: PatientEventFeature, options: RecordPatientEventOptions = {}): Promise<number> {
  const count = attempted(options);
  if (count <= 0) return 0;
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/patient_app_event_record", {
    p_patient_id: patientId,
    p_feature: feature,
    p_platform: options.platform ?? (options.headers ? platformOf(options.headers) : "unknown"),
    p_at: (options.at ?? new Date()).toISOString(),
    p_count: count,
    p_source_keys: options.sourceKeys ?? null,
  });
  if (result.status >= 300) throw new Error(`patient event record failed (${result.status})`);
  const recorded = Number(result.json);
  return Number.isFinite(recorded) ? recorded : count;
}

export interface RecordPatientEventDeps {
  write?: typeof writePatientEvent;
}

/**
 * Record after a successful feature write. Returns true when a write was
 * started (callers never await it; tests use the return value).
 */
export function recordPatientEvent(
  patientId: string,
  feature: PatientEventFeature,
  options: RecordPatientEventOptions = {},
  deps: RecordPatientEventDeps = {},
): boolean {
  if (attempted(options) <= 0) return false;
  const write = deps.write ?? writePatientEvent;
  void write(patientId, feature, options).catch((error: unknown) => {
    logger.warn({ err: error, patientId, feature }, "patient app event write failed");
  });
  return true;
}
