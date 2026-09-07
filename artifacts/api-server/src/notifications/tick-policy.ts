/**
 * The organization policy as one notification tick sees it: HQ's policy plus
 * every office override, loaded once per tick so a batch of rows agrees on
 * the cooldown, cap, default categories, and quiet hours it applies.
 */
import {
  DEFAULT_ORG_POLICY,
  effectivePolicyFor,
  loadAllOfficeOverrides,
  loadOrgPolicy,
  type OfficeOverrides,
  type OrgPolicy,
} from "../lib/org-policy";
import type { PolicyDefaults } from "./policy";

export interface TickPolicy {
  org: OrgPolicy;
  overrides: Map<string, OfficeOverrides>;
}

export const DEFAULT_TICK_POLICY: TickPolicy = { org: DEFAULT_ORG_POLICY, overrides: new Map() };

/** The defaults a patient of `providerId` inherits when their own prefs are unset. */
export function defaultsFor(policy: TickPolicy, providerId: string | null): PolicyDefaults {
  const overrides = providerId ? policy.overrides.get(providerId) ?? null : null;
  return {
    categories: { ...policy.org.defaultCategories },
    quietHours: effectivePolicyFor(policy.org, overrides).quietHours,
  };
}

/**
 * Loads the live policy. A failed read falls back to the loader's
 * last-known-good policy; with none, the built-in defaults apply and the
 * caller's log records it so a settings outage is visible, not silent.
 */
export async function loadTickPolicy(
  log: (event: string, detail: Record<string, unknown>) => void = () => undefined,
): Promise<TickPolicy> {
  let org: OrgPolicy;
  try {
    org = await loadOrgPolicy();
  } catch (error) {
    log("org_policy_unavailable", { error: error instanceof Error ? error.message : String(error) });
    org = DEFAULT_ORG_POLICY;
  }
  let overrides: Map<string, OfficeOverrides>;
  try {
    overrides = await loadAllOfficeOverrides();
  } catch (error) {
    log("office_overrides_unavailable", { error: error instanceof Error ? error.message : String(error) });
    overrides = new Map();
  }
  return { org, overrides };
}
