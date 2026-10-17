/**
 * The reseller agreement date as the anchor of an office's included period.
 *
 * Leadership expects a THINNR reseller's access billing to begin 12 months
 * (the organization's reseller included period) after the office signs its
 * reseller agreement. The agreement is signed off-platform, so HQ records the
 * date on the account (`providers.reseller_agreement_signed_on`); this module
 * turns that date into the subscription's included period, and re-anchors it
 * when HQ corrects the date. Without a date — and for every software-only
 * office — the period still runs from the owner's first dashboard sign-in
 * (sign-in.ts), which the subscription remembers separately so a cleared date
 * falls back to the real first sign-in rather than to "now".
 *
 * Only the included period moves. Paid-through coverage, the plan, the price,
 * grace and restriction rules are untouched: a date edit can never shorten
 * access an office has already paid for, and a lifetime office ignores it.
 */
import { supabaseAdmin } from "../../lib/supabase-admin";
import { officeKindOf, type OfficeKind } from "../../lib/office-kind";
import { getBillingModeStatus } from "../mode-state";
import { currentBillingIdentity, runWithBillingIdentity } from "../stripe-environment";
import { selectMany, type BillingOfficeAccessSubscriptionRow as Row } from "../store";
import { includedPeriodDaysFor, loadAccessBillingSettings } from "./settings";
import { includedPeriodAnchor, includedPeriodFrom } from "./state";
import { applyAccessInput, ensureAccessSubscription, type AccessActor } from "./subscription";

export interface OfficeAgreementFacts {
  officeKind: OfficeKind;
  /** `YYYY-MM-DD`, or null when HQ has not recorded the agreement date. */
  resellerAgreementSignedOn: string | null;
}

/** One office's kind and agreement date, read fresh. Unknown office = reseller without a date. */
export async function loadOfficeAgreementFacts(providerId: string): Promise<OfficeAgreementFacts> {
  const res = await supabaseAdmin(
    "GET",
    `/rest/v1/providers?provider_id=eq.${encodeURIComponent(providerId)}&select=provider_id,office_kind,reseller_agreement_signed_on&limit=1`,
  );
  if (res.status >= 300 || !Array.isArray(res.json)) throw new Error(`office agreement lookup failed (${res.status})`);
  const row = res.json[0] as { office_kind?: unknown; reseller_agreement_signed_on?: unknown } | undefined;
  return {
    officeKind: officeKindOf(row?.office_kind),
    resellerAgreementSignedOn: typeof row?.reseller_agreement_signed_on === "string" ? row.reseller_agreement_signed_on : null,
  };
}

/**
 * The included period a reseller office's agreement date implies: from that
 * day for the organization's reseller period. Null without a date, for a
 * software-only office, and for a period the organization set to zero days.
 */
export function agreementIncludedPeriod(
  facts: OfficeAgreementFacts,
  includedPeriodDays: number,
): { startedAt: Date; endsAt: Date } | null {
  const anchor = includedPeriodAnchor({ officeKind: facts.officeKind, resellerAgreementSignedOn: facts.resellerAgreementSignedOn, ownerFirstSignInAt: null });
  return anchor ? includedPeriodFrom(anchor, includedPeriodDays) : null;
}

/** The period write kept losing to concurrent subscription writes; the account date is saved, the period is not moved yet. */
export class AgreementAnchorConflictError extends Error {
  constructor(providerId: string, attempts: number) {
    super(`included period for ${providerId} could not be anchored after ${attempts} attempts (concurrent subscription writes)`);
    this.name = "AgreementAnchorConflictError";
  }
}

const ANCHOR_ATTEMPTS = 3;

function periodMatches(row: Row, period: { startedAt: Date; endsAt: Date } | null): boolean {
  const startedAt = period ? period.startedAt.toISOString() : null;
  const endsAt = period ? period.endsAt.toISOString() : null;
  return (row.included_period_started_at ?? null) === startedAt && (row.included_period_ends_at ?? null) === endsAt;
}

/**
 * Re-anchor the office's included period after HQ recorded, changed or
 * cleared its reseller agreement date. Anchors to the agreement date when
 * there is one, else to the owner's first sign-in when that is known; when
 * neither is known the period is cleared so the next owner sign-in starts it.
 * A software-only office is left alone (its clock is first sign-in only).
 *
 * The write is version-guarded, so it can lose to a concurrent sign-in or
 * subscription write; the account date is already saved by then, and a lost
 * write must not pass for success. Each loss re-reads the row and tries
 * again (the sign-in may have stamped the fallback anchor meanwhile); after
 * `ANCHOR_ATTEMPTS` losses the caller gets a conflict error to surface.
 */
export async function anchorIncludedPeriodToAgreement(input: {
  providerId: string;
  actor: AccessActor;
  facts: OfficeAgreementFacts;
  now?: Date;
}): Promise<Row> {
  const now = input.now ?? new Date();
  const [settings, first] = await Promise.all([loadAccessBillingSettings(), ensureAccessSubscription(input.providerId)]);
  if (input.facts.officeKind !== "reseller") return first;
  const includedPeriodDays = includedPeriodDaysFor(settings, input.facts.officeKind);
  let row = first;
  for (let attempt = 1; attempt <= ANCHOR_ATTEMPTS; attempt += 1) {
    if (attempt > 1) row = await ensureAccessSubscription(input.providerId);
    if (row.lifetime) return row;
    const anchor = includedPeriodAnchor({
      officeKind: input.facts.officeKind,
      resellerAgreementSignedOn: input.facts.resellerAgreementSignedOn,
      ownerFirstSignInAt: row.owner_first_sign_in_at ?? null,
    });
    const period = anchor ? includedPeriodFrom(anchor, includedPeriodDays) : null;
    const result = await applyAccessInput({
      row, actor: input.actor, event: "agreement_anchored",
      input: { kind: "agreement_anchor", at: now, period },
      detail: {
        resellerAgreementSignedOn: input.facts.resellerAgreementSignedOn,
        anchor: input.facts.resellerAgreementSignedOn ? "agreement" : anchor ? "owner_first_sign_in" : null,
        includedPeriodDays,
        startedAt: period ? period.startedAt.toISOString() : null,
        endsAt: period ? period.endsAt.toISOString() : null,
      },
      auditAction: "office_access_included_period_set",
    });
    // `changed: false` is either "already anchored there" (fine) or a lost
    // version race (the returned row is the winner's): only the row itself
    // tells them apart.
    if (result.changed || periodMatches(result.row, period)) return result.row;
    row = result.row;
  }
  throw new AgreementAnchorConflictError(input.providerId, ANCHOR_ATTEMPTS);
}

/**
 * The HQ account routes sit outside the billing request tree, so they carry no
 * billing identity, and every office-access row is Stripe-scoped. The period
 * belongs to the payments mode selected right now, like a first sign-in does.
 */
export async function anchorIncludedPeriodToAgreementForSelectedMode(
  input: Parameters<typeof anchorIncludedPeriodToAgreement>[0],
): Promise<Row> {
  return underSelectedMode(() => anchorIncludedPeriodToAgreement(input));
}

/**
 * Whether the office's period was ever anchored to this exact agreement date:
 * a successful anchoring writes an `agreement_anchored` history row naming the
 * date. The HQ account routes use it as the idempotent retry path — a save of
 * the same date re-anchors only when no anchoring for that date ever landed
 * (the write lost a race or the store was down), so HQ's later manual period
 * edits on a date that did land are never undone by an unrelated profile save.
 */
export async function agreementAnchorRecordedForSelectedMode(input: {
  providerId: string;
  resellerAgreementSignedOn: string;
}): Promise<boolean> {
  return underSelectedMode(async () => {
    const rows = await selectMany(
      "billing_office_access_events",
      `provider_id=eq.${encodeURIComponent(input.providerId)}&event=eq.agreement_anchored`
        + `&detail->>resellerAgreementSignedOn=eq.${encodeURIComponent(input.resellerAgreementSignedOn)}&limit=1`,
    );
    return rows.length > 0;
  });
}

async function underSelectedMode<T>(work: () => Promise<T>): Promise<T> {
  if (currentBillingIdentity()) return work();
  const selected = await getBillingModeStatus();
  return runWithBillingIdentity({ mode: selected.mode, platformAccountId: selected.platformAccountId }, work);
}
