/**
 * Versioned patient consent.
 *
 * `CONSENT_POLICY_VERSION` is the single knob: bump it when the terms,
 * privacy notice, or health-data wording changes and every real patient is
 * re-prompted on their next launch (the app blocks protected routes until a
 * record for the CURRENT version exists server-side). The legal text itself
 * is a placeholder keyed by this version — drafting it is out of scope here.
 */
import { supabaseAdmin } from "../lib/supabase-admin";

export const CONSENT_POLICY_VERSION = "2026-09-01";

const enc = encodeURIComponent;

export interface ConsentRow {
  id: string;
  patient_id: string;
  policy_version: string;
  terms_accepted: boolean;
  privacy_accepted: boolean;
  health_data_accepted: boolean;
  photo_analysis_accepted: boolean;
  app_version: string | null;
  platform: string | null;
  recorded_at: string;
}

export interface ConsentDto {
  /** Version the app must have on record before protected routes open. */
  requiredVersion: string;
  /** Latest version this patient recorded, or null when nothing is on file. */
  recordedVersion: string | null;
  /** True only when recordedVersion === requiredVersion. */
  satisfied: boolean;
  /** Optional photo-analysis choice on the latest record (null = none yet). */
  photoAnalysis: boolean | null;
  recordedAt: string | null;
}

export const CONSENT_SELECT =
  "id,patient_id,policy_version,terms_accepted,privacy_accepted,health_data_accepted,photo_analysis_accepted,app_version,platform,recorded_at";

export function consentDto(latest: ConsentRow | null): ConsentDto {
  return {
    requiredVersion: CONSENT_POLICY_VERSION,
    recordedVersion: latest?.policy_version ?? null,
    satisfied: latest?.policy_version === CONSENT_POLICY_VERSION,
    photoAnalysis: latest ? latest.photo_analysis_accepted === true : null,
    recordedAt: latest?.recorded_at ?? null,
  };
}

/** The most recent record — the current version when present, else the newest older one. */
export async function loadLatestConsent(patientId: string): Promise<ConsentRow | null> {
  const result = await supabaseAdmin(
    "GET",
    `/rest/v1/patient_consents?patient_id=eq.${enc(patientId)}&select=${CONSENT_SELECT}` +
      `&order=recorded_at.desc&limit=25`,
  );
  if (result.status >= 300 || !Array.isArray(result.json)) {
    throw new Error(`consent lookup failed (${result.status})`);
  }
  const rows = result.json as ConsentRow[];
  return rows.find((row) => row.policy_version === CONSENT_POLICY_VERSION) ?? rows[0] ?? null;
}
