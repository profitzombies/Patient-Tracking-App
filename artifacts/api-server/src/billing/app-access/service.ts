/**
 * App access for REAL accounts: loads the facts the pure rule needs (the
 * patient's program and open episode, activation, timezone; the office's
 * settings; the governing subscription) and evaluates them.
 *
 * Subscription rows are Stripe-scoped, so they are read under the billing
 * identity: the request's own when a billing route already resolved one,
 * otherwise the current mode (the premium routes sit outside /api/billing).
 * The office settings are shared across identities and need no scope. When
 * the office does not charge, no subscription read happens at all.
 */
import { dayKeyInTimeZone } from "../../lib/local-day";
import { supabaseAdmin } from "../../lib/supabase-admin";
import { getBillingModeStatus } from "../mode-state";
import { selectMany, selectOne, type BillingSubscriptionRow } from "../store";
import { currentBillingIdentity, runWithBillingIdentity } from "../stripe-environment";
import { evaluateAppAccess, localDayOf, staffState, type AppAccessEntitlement, type AppAccessOfficeSettings, type AppAccessStaffState } from "./entitlement";
import { officeSettingsFacts } from "./settings";
import { findAppAccessSubscription, subscriptionFacts } from "./subscription";

const enc = encodeURIComponent;

/** The patient columns the rule reads (one narrow select). */
export const APP_ACCESS_PATIENT_SELECT = "id,provider_id,program_id,program_start_date,timezone,claimed_at,activation_updated_at,created_at,closed_at";

export interface AppAccessPatientFacts {
  id: string;
  provider_id: string | null;
  program_id: string | null;
  program_start_date: string | null;
  timezone: string | null;
  claimed_at: string | null;
  activation_updated_at: string | null;
  created_at: string | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function patientFacts(row: Record<string, unknown>): AppAccessPatientFacts {
  return {
    id: String(row.id), provider_id: text(row.provider_id), program_id: text(row.program_id),
    program_start_date: text(row.program_start_date), timezone: text(row.timezone), claimed_at: text(row.claimed_at),
    activation_updated_at: text(row.activation_updated_at), created_at: text(row.created_at),
  };
}

/**
 * The moment the account became the patient's own: the claim (invited
 * patients) else the activation stamp (self sign-ups) else the row's birth.
 */
export function activationInstant(patient: AppAccessPatientFacts): string | null {
  return patient.claimed_at ?? patient.activation_updated_at ?? patient.created_at;
}

/** The current episode's start day; like the coach, the row's creation day stands in for a legacy row. */
export function episodeStartDay(patient: AppAccessPatientFacts): string | null {
  if (patient.program_start_date) return patient.program_start_date.slice(0, 10);
  return patient.created_at ? localDayOf(patient.created_at, patient.timezone) : null;
}

export async function loadPatientFacts(patientId: string): Promise<AppAccessPatientFacts | null> {
  const result = await supabaseAdmin("GET", `/rest/v1/patients?id=eq.${enc(patientId)}&select=${APP_ACCESS_PATIENT_SELECT}&limit=1`);
  if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`patient lookup failed (${result.status})`);
  const row = result.json[0] as Record<string, unknown> | undefined;
  return row ? patientFacts(row) : null;
}

export async function loadOfficeSettingsFacts(providerId: string): Promise<AppAccessOfficeSettings> {
  return officeSettingsFacts(await selectOne("billing_office_settings", `provider_id=eq.${enc(providerId)}`));
}

async function scoped<T>(read: () => Promise<T>): Promise<T> {
  if (currentBillingIdentity()) return read();
  return runWithBillingIdentity(await getBillingModeStatus(), read);
}

export function evaluateFor(
  patient: AppAccessPatientFacts, office: AppAccessOfficeSettings, subscription: BillingSubscriptionRow | null, now: Date,
): AppAccessEntitlement {
  return evaluateAppAccess({
    todayKey: dayKeyInTimeZone(patient.timezone, now), now,
    programId: patient.program_id, episodeStartedOn: episodeStartDay(patient),
    activatedAt: activationInstant(patient), timeZone: patient.timezone,
    office, subscription: subscriptionFacts(subscription),
  });
}

/** Whether the rule even needs the subscription: only a charging office outside the free window. */
function needsSubscription(patient: AppAccessPatientFacts, office: AppAccessOfficeSettings, now: Date): boolean {
  if (!(office.enabled && office.price_cents !== null && office.price_cents > 0)) return false;
  return !evaluateFor(patient, office, null, now).available;
}

export interface PatientAppAccessResult {
  patient: AppAccessPatientFacts;
  entitlement: AppAccessEntitlement;
  subscription: BillingSubscriptionRow | null;
}

/** The signed-in patient's entitlement today. Null when the patient row is missing. */
export async function patientAppAccess(patientId: string, now = new Date()): Promise<PatientAppAccessResult | null> {
  const patient = await loadPatientFacts(patientId);
  if (!patient) return null;
  const office = patient.provider_id
    ? await loadOfficeSettingsFacts(patient.provider_id)
    : officeSettingsFacts(null);
  const subscription = needsSubscription(patient, office, now)
    ? await scoped(() => findAppAccessSubscription(patientId))
    : null;
  return { patient, entitlement: evaluateFor(patient, office, subscription, now), subscription };
}

/** What a roster row / patient record shows. */
export interface RosterAppAccess {
  state: AppAccessStaffState;
  available: boolean;
  /** Last free local day of the protocol or trial window; null when none applies. */
  freeUntil: string | null;
  subscriptionState: "none" | "active" | "past_due" | "canceled";
  currentPeriodEnd: string | null;
}

export function rosterAppAccessDto(entitlement: AppAccessEntitlement): RosterAppAccess {
  return {
    state: staffState(entitlement), available: entitlement.available,
    freeUntil: entitlement.free_window?.ends_on ?? null,
    subscriptionState: entitlement.subscription?.state ?? "none",
    currentPeriodEnd: entitlement.subscription?.current_period_end ?? null,
  };
}

/**
 * App-access state for every patient of one office in two reads: the office
 * settings and, only when the office charges, every app-access subscription
 * at the office (newest first; an open one wins per patient).
 */
export async function officeAppAccessStates(
  providerId: string, rows: Record<string, unknown>[], now = new Date(),
): Promise<Map<string, RosterAppAccess>> {
  const office = await loadOfficeSettingsFacts(providerId);
  const charges = office.enabled && office.price_cents !== null && office.price_cents > 0;
  const byPatient = new Map<string, BillingSubscriptionRow>();
  if (charges) {
    const subs = await scoped(() => selectMany("billing_subscriptions",
      `provider_id=eq.${enc(providerId)}&kind=eq.app_access&status=neq.incomplete&order=created_at.desc&limit=5000`));
    for (const sub of subs) {
      if (!sub.patient_id) continue;
      const held = byPatient.get(sub.patient_id);
      const open = (row: BillingSubscriptionRow) => ["active", "past_due", "unpaid"].includes(row.status);
      if (!held || (!open(held) && open(sub))) byPatient.set(sub.patient_id, sub);
    }
  }
  const out = new Map<string, RosterAppAccess>();
  for (const row of rows) {
    const patient = patientFacts(row);
    out.set(patient.id, rosterAppAccessDto(evaluateFor(patient, office, byPatient.get(patient.id) ?? null, now)));
  }
  return out;
}
