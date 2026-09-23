/**
 * The one place the engine reads its pricing and policy from, so the charge
 * waterfall, the dunning job and the HQ operations all see the same effective
 * values. Everything here comes from the versioned HQ organization settings.
 */
import { loadOrgPolicy, type AccessBillingPolicy } from "../../lib/org-policy";

export type AccessBillingSettings = AccessBillingPolicy;

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
