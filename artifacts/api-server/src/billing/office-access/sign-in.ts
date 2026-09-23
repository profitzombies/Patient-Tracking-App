/**
 * Starting an office's included period.
 *
 * The clock starts the first time the office OWNER signs in to the provider
 * dashboard — not when the office record is created, and never when a patient
 * signs up or signs in. That is why this lives on the staff sign-in path and
 * takes a staff identity: there is no argument shape here that a patient
 * session could produce.
 */
import { loadAccessBillingSettings } from "./settings";
import { applyAccessInput, ensureAccessSubscription } from "./subscription";

export interface OwnerSignIn {
  /** The office whose owner just signed in. */
  providerId: string;
  /** Owner class only: an office admin or staff member must not start it. */
  staffClass: "hq" | "provider" | "team_member";
  authUserId: string | null;
  at?: Date;
}

/**
 * Stamp the start of the included period, exactly once. Later owner sign-ins
 * are no-ops, so the period can never be restarted by signing out and in.
 */
export async function noteOwnerDashboardSignIn(input: OwnerSignIn): Promise<void> {
  if (input.staffClass !== "provider" || !input.providerId) return;
  const at = input.at ?? new Date();
  const settings = await loadAccessBillingSettings();
  const row = await ensureAccessSubscription(input.providerId);
  if (row.included_period_started_at) return;
  await applyAccessInput({
    row,
    input: { kind: "owner_first_sign_in", at, includedPeriodDays: settings.includedPeriodDays },
    actor: { kind: "provider", userId: input.authUserId },
    event: "included_period_started",
    detail: { includedPeriodDays: settings.includedPeriodDays },
  });
}
