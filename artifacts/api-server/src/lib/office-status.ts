/**
 * Office lifecycle status shared by every selector that must skip offices
 * whose THINNR contract is ending or has ended.
 *
 * `providers.offboarding_status` is the coarse state:
 *   * active      — a normal office.
 *   * offboarding — HQ started the offboarding stepper: staff sign-in is
 *                   disabled while records are handed over and charts sealed.
 *                   HQ reads (the bundle export, the drill-in) still work.
 *   * offboarded  — the stepper finished; charts are sealed and the office is
 *                   also marked access_disabled so the SQL rollups that only
 *                   know that flag exclude it too.
 *
 * Selectors that already select the providers row check `officeIsActive`
 * (missing column = active, so fixtures and legacy mocks stay valid);
 * selectors keyed on other tables load the excluded id set once per run.
 */
import { supabaseAdmin } from "./supabase-admin";

export const OFFICE_OFFBOARDING_STATUSES = ["active", "offboarding", "offboarded"] as const;
export type OfficeOffboardingStatus = (typeof OFFICE_OFFBOARDING_STATUSES)[number];

/** Columns a selector must include in its providers select to call `officeIsActive`. */
export const OFFICE_STATUS_COLUMNS = "access_disabled,offboarding_status";

export function offboardingStatusOf(value: unknown): OfficeOffboardingStatus {
  return value === "offboarding" || value === "offboarded" ? value : "active";
}

/** True for offices that should appear in rosters, boards, digests, renewals and counts. */
export function officeIsActive(row: { access_disabled?: unknown; offboarding_status?: unknown } | null | undefined): boolean {
  if (!row) return false;
  return row.access_disabled !== true && offboardingStatusOf(row.offboarding_status) === "active";
}

/** The neutral wording staff and patients of an ended program see. */
export const PROGRAM_ENDED_MESSAGE = "This program has ended. Contact your provider.";
/** A reopened chart whose login was retired at closure: the office, not the app, brings the patient back. */
export const REENROLL_REQUIRED_MESSAGE =
  "Your office has rejoined THINNR, but this login was retired when the program ended. Contact the office to re-enroll.";
export const OFFICE_OFFBOARDED_STAFF_MESSAGE =
  "This office's THINNR program has ended. Contact THINNR support if you believe this is a mistake.";

/** Ids of every office that is offboarding or offboarded (one read per caller run). */
export async function loadInactiveOfficeIds(): Promise<Set<string>> {
  const res = await supabaseAdmin(
    "GET",
    "/rest/v1/providers?offboarding_status=in.(offboarding,offboarded)&select=provider_id&limit=5000",
  );
  if (res.status >= 300 || !Array.isArray(res.json)) throw new Error(`office status scan failed (${res.status})`);
  return new Set((res.json as Array<{ provider_id?: unknown }>).map((row) => String(row.provider_id)));
}

/** One office's status; null when the office does not exist. */
export async function loadOfficeOffboardingStatus(providerId: string): Promise<OfficeOffboardingStatus | null> {
  const res = await supabaseAdmin(
    "GET",
    `/rest/v1/providers?provider_id=eq.${encodeURIComponent(providerId)}&select=provider_id,offboarding_status&limit=1`,
  );
  if (res.status >= 300 || !Array.isArray(res.json)) throw new Error(`office status lookup failed (${res.status})`);
  const row = res.json[0] as { offboarding_status?: unknown } | undefined;
  return row ? offboardingStatusOf(row.offboarding_status) : null;
}
