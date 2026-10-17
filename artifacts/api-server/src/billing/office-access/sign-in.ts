/**
 * Starting an office's included period.
 *
 * The clock starts the first time the office OWNER signs in to the provider
 * dashboard — not when the office record is created, and never when a patient
 * signs up or signs in. That is why this lives on the staff sign-in path and
 * takes a staff identity: there is no argument shape here that a patient
 * session could produce.
 *
 * A THINNR reseller whose agreement date HQ recorded is the one exception to
 * "from the sign-in": its period runs from the agreement date (agreement.ts),
 * so the first sign-in only starts a period that was not already anchored, and
 * may start one that has already elapsed — the office is then billed at the
 * next pass once setup completes, never restricted on day one.
 */
import { getBillingModeStatus } from "../mode-state";
import { currentBillingIdentity, runWithBillingIdentity } from "../stripe-environment";
import { loadOfficeAgreementFacts } from "./agreement";
import { includedPeriodDaysFor, loadAccessBillingSettings } from "./settings";
import { includedPeriodAnchor } from "./state";
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
 * Stamp the owner's first sign-in and the start of the included period,
 * exactly once each. Later owner sign-ins are no-ops, so the period can never
 * be restarted by signing out and in.
 */
export async function noteOwnerDashboardSignIn(input: OwnerSignIn): Promise<void> {
  if (input.staffClass !== "provider" || !input.providerId) return;
  const at = input.at ?? new Date();
  const [settings, row] = await Promise.all([loadAccessBillingSettings(), ensureAccessSubscription(input.providerId)]);
  if (row.included_period_started_at && row.owner_first_sign_in_at) return;
  // The window depends on what THINNR sold the office: a software-only office
  // gets the (shorter) software default, a reseller the reseller default —
  // and a reseller with a recorded agreement date counts from that day.
  const facts = await loadOfficeAgreementFacts(input.providerId);
  const includedPeriodDays = includedPeriodDaysFor(settings, facts.officeKind);
  const anchor = includedPeriodAnchor({ officeKind: facts.officeKind, resellerAgreementSignedOn: facts.resellerAgreementSignedOn, ownerFirstSignInAt: null });
  const startsPeriod = !row.included_period_started_at;
  await applyAccessInput({
    row,
    input: { kind: "owner_first_sign_in", at, includedPeriodDays, ...(anchor ? { anchor } : {}) },
    actor: { kind: "provider", userId: input.authUserId },
    event: startsPeriod ? "included_period_started" : "owner_first_sign_in",
    detail: {
      includedPeriodDays, officeKind: facts.officeKind,
      ...(startsPeriod ? { anchor: anchor ? "agreement" : "owner_first_sign_in", resellerAgreementSignedOn: facts.resellerAgreementSignedOn } : {}),
    },
  });
}

/**
 * The staff sign-in routes sit outside the billing request tree, so they carry
 * no billing identity, and every office-access row is Stripe-scoped. Without
 * this the store refuses the read and the period silently never starts.
 *
 * The period belongs to the payments mode selected right now: an owner who
 * signs in while Live is selected starts the Live period, and a period started
 * in Test never carries over into Live.
 */
export async function noteOwnerDashboardSignInForSelectedMode(input: OwnerSignIn): Promise<void> {
  if (input.staffClass !== "provider" || !input.providerId) return;
  if (currentBillingIdentity()) { await noteOwnerDashboardSignIn(input); return; }
  const selected = await getBillingModeStatus();
  await runWithBillingIdentity({ mode: selected.mode, platformAccountId: selected.platformAccountId }, () => noteOwnerDashboardSignIn(input));
}
