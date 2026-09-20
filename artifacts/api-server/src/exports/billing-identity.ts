import { runWithBillingIdentity, type BillingIdentity } from "../billing/stripe-environment";
import type { ExportScope } from "./kinds";

/** Never substitute today's selection for a delayed job's missing identity. */
export function exportBillingIdentity(value: unknown): BillingIdentity {
  const identity = value as Partial<BillingIdentity> | null;
  if (!identity || (identity.mode !== "test" && identity.mode !== "live") ||
      typeof identity.platformAccountId !== "string" || !/^acct_[A-Za-z0-9]+$/.test(identity.platformAccountId)) {
    throw new Error("This financial export has no verified frozen billing identity. Request a new export.");
  }
  return { mode: identity.mode, platformAccountId: identity.platformAccountId };
}
export function withExportBillingIdentity<T>(scope: ExportScope, work: () => T): T {
  return runWithBillingIdentity(exportBillingIdentity(scope.billingIdentity), work);
}