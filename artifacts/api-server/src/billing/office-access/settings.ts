/**
 * The one place the engine reads its pricing and policy from, so the charge
 * waterfall, the dunning job and the HQ operations all see the same effective
 * values. Everything here comes from the versioned HQ organization settings.
 */
import { loadOrgPolicy, type AccessBillingPolicy } from "../../lib/org-policy";
import type { OfficeKind } from "../../lib/office-kind";

export type AccessBillingSettings = AccessBillingPolicy;

/**
 * The free window an office of this kind gets from its owner's first
 * dashboard sign-in. Resellers and software-only offices have separate
 * HQ-editable defaults; prices, instruments, grace and shares are shared.
 */
export function includedPeriodDaysFor(settings: AccessBillingSettings, kind: OfficeKind): number {
  return kind === "software" ? settings.softwareIncludedPeriodDays : settings.includedPeriodDays;
}

/**
 * The agreement an office of this kind accepts in setup: the reseller access
 * disclosure or the software agreement. The kind rides with the text so the
 * acknowledgment can record which one was shown.
 */
export function agreementFor(settings: AccessBillingSettings, kind: OfficeKind): { kind: OfficeKind; text: string } {
  return kind === "software"
    ? { kind: "software", text: settings.softwareAgreementText }
    : { kind: "reseller", text: settings.disclosureText };
}

/** 48 hours from setup for a microdeposit bank account to be verified. */
export const BANK_VERIFICATION_WINDOW_HOURS = 48;

export async function loadAccessBillingSettings(options: { fresh?: boolean } = {}): Promise<AccessBillingSettings> {
  return (await loadOrgPolicy(options)).accessBilling;
}

/**
 * THINNR's share of a patient payment, which depends on whether the office is
 * paying for its own access. The restricted share is applied by the
 * restricted-access work; the engine only publishes the numbers.
 */
export function revenueSharePercent(settings: AccessBillingSettings, restricted: boolean): number {
  return restricted ? settings.restrictedSharePercent : settings.normalSharePercent;
}
