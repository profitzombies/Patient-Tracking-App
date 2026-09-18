/**
 * Verification cost visibility: text-message login codes per active patient
 * per month.
 *
 * Every patient SMS code is a paid Twilio Verify message, so HQ needs to see
 * how many codes patients redeem against how many patients actually used the
 * app. The numbers come from the service-role RPC hq_patient_sign_in_metrics
 * (auth_sign_ins, which records the method of every sign-in, joined per UTC
 * month with patient_app_presence). Counts only — no identities leave the
 * database.
 */
import { supabaseAdmin } from "../lib/supabase-admin";

export const SIGN_IN_METRIC_MONTHS = 6;

export interface PatientSignInMonth {
  /** First day of the UTC month, YYYY-MM-DD. */
  month: string;
  /** Patient sign-ins that redeemed a text-message code (sms_code, password_sms_code). */
  smsSignIns: number;
  /** Distinct patients who redeemed at least one SMS code that month. */
  patientsWithSmsSignIn: number;
  /** SMS sign-ins the ledger flagged as a new device. */
  newDeviceSmsSignIns: number;
  /** Account creations (their verification channel is not recorded). */
  signups: number;
  /** Distinct patients with at least one app-presence day that month. */
  activePatients: number;
  /** smsSignIns / activePatients, null while nobody was active. */
  smsPerActivePatient: number | null;
}

function count(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error("sign-in metrics returned a non-numeric count");
  return Math.trunc(n);
}

export function toPatientSignInMonth(row: Record<string, unknown>): PatientSignInMonth {
  const month = typeof row.month === "string" ? row.month.slice(0, 10) : null;
  if (!month || !/^\d{4}-\d{2}-\d{2}$/.test(month)) throw new Error("sign-in metrics returned a malformed month");
  const smsSignIns = count(row.sms_sign_ins);
  const activePatients = count(row.active_patients);
  return {
    month,
    smsSignIns,
    patientsWithSmsSignIn: count(row.patients_with_sms_sign_in),
    newDeviceSmsSignIns: count(row.new_device_sms_sign_ins),
    signups: count(row.signups),
    activePatients,
    smsPerActivePatient: activePatients > 0 ? Math.round((smsSignIns / activePatients) * 100) / 100 : null,
  };
}

/** Newest month first. Throws when the ledger cannot be read — never a silent zero. */
export async function readPatientSignInMetrics(months: number = SIGN_IN_METRIC_MONTHS): Promise<PatientSignInMonth[]> {
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/hq_patient_sign_in_metrics", { p_months: months });
  if (result.status >= 300 || !Array.isArray(result.json)) {
    throw new Error(`sign-in metrics read failed (${result.status})`);
  }
  return (result.json as Record<string, unknown>[]).map(toPatientSignInMonth);
}
