import { getStripeCredentials } from "./stripe-client";
import { currentBillingIdentity, runWithBillingIdentity, type StripeMode } from "./stripe-environment";
import { supabaseAdmin } from "../lib/supabase-admin";

/** Discovery only: never use an unscoped read to operate on a transaction. */
async function persistedScopes(): Promise<Map<StripeMode, Set<string>>> {
  const scopes = new Map<StripeMode, Set<string>>();
  for (const table of ["billing_connected_accounts", "billing_orders", "billing_subscriptions"]) {
    for (let offset = 0; ; offset += 500) {
      const order = table === "billing_connected_accounts" ? "provider_id,stripe_mode,stripe_platform_account_id" : "id";
      const result = await supabaseAdmin("GET", `/rest/v1/${table}?select=stripe_mode,stripe_platform_account_id&stripe_mode=not.is.null&stripe_platform_account_id=not.is.null&order=${order}&limit=500&offset=${offset}`);
      if (result.status >= 300 || !Array.isArray(result.json)) throw new Error("Persisted billing scopes could not be loaded.");
      for (const row of result.json) {
        if ((row.stripe_mode !== "test" && row.stripe_mode !== "live") || !row.stripe_platform_account_id) {
          throw new Error("Persisted billing scope is invalid.");
        }
        const accounts = scopes.get(row.stripe_mode) ?? new Set<string>();
        accounts.add(row.stripe_platform_account_id);
        scopes.set(row.stripe_mode, accounts);
      }
      if (result.json.length < 500) break;
    }
  }
  return scopes;
}

/**
 * Scheduled lifecycle work is independent of the interactive mode selector.
 * A partially configured scope fails visibly, but cannot starve the other scope.
 */
export async function forEachBillingScope(work: () => Promise<void>, modes: readonly StripeMode[] = ["test", "live"]): Promise<void> {
  const failures: unknown[] = [];
  const persisted = await persistedScopes();
  let configured = 0;
  for (const mode of modes) {
    const prefix = `STRIPE_${mode.toUpperCase()}_`;
    if (!persisted.has(mode) && !Object.keys(process.env).some((key) => key.startsWith(prefix) && process.env[key]?.trim())) continue;
    configured++;
    try {
      const credentials = await getStripeCredentials(mode);
      for (const account of persisted.get(mode) ?? []) {
        if (account !== credentials.account_id) failures.push(new Error(`Historical ${mode} billing scope has no matching platform credentials.`));
      }
      await runWithBillingIdentity({ mode, platformAccountId: credentials.account_id }, work);
    } catch (error) { failures.push(error); }
  }
  if (!configured) throw new Error("Payments lifecycle work is unavailable: no configured Stripe scope.");
  if (failures.length) throw new AggregateError(failures, "One or more Stripe lifecycle scopes could not be processed.");
}

/** Outbound effects require an explicitly pinned live scope, never an implicit default. */
export function liveBillingEffectsAllowed(): boolean {
  return currentBillingIdentity()?.mode === "live";
}

/** Operational health observes real fulfillment, not the staff demo selector. */
export async function withLiveBillingScope<T>(work: () => Promise<T>): Promise<T> {
  let value: T;
  await forEachBillingScope(async () => { value = await work(); }, ["live"]);
  return value!;
}