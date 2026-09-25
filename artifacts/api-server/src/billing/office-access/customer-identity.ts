/**
 * What THINNR's own Stripe dashboard shows for an office's access customer.
 *
 * The customer lives on THINNR's PLATFORM account (see instruments.ts), one
 * per office per payment mode. Before this module it carried only a provider
 * id in metadata, so HQ saw "Unnamed customer". Everything here is built from
 * the office's saved practice details and owner contact on `providers` — the
 * same row the practice-details step and HQ's provider editor write.
 *
 * One builder feeds all three moments the customer is written: creation, a
 * change to the office's details, and the one-time back-fill. Syncing on a
 * change reaches both payment modes, because an office may hold a customer in
 * Test and in Live and both should keep its current name.
 */
import type Stripe from "stripe";
import { logger } from "../../lib/logger";
import { supabaseAdmin } from "../../lib/supabase-admin";
import { getStripe } from "../stripe-client";
import { currentBillingIdentity, runWithBillingIdentity, type StripeMode } from "../stripe-environment";
import { selectOne, type BillingOfficeAccessSubscriptionRow as Row } from "../store";
import { findAccessSubscription } from "./subscription";

export interface OfficeIdentityFacts {
  providerId: string;
  officeName: string | null;
  ownerName: string | null;
  email: string | null;
  phone: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
}

type ProviderRow = {
  provider_id: string; provider_name: string | null; office_name: string | null; email: string | null;
  phone: string | null; address_line_1: string | null; address_line_2: string | null;
  city: string | null; state: string | null; postal_code: string | null;
};

function clean(value: string | null | undefined, max: number): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed.slice(0, max) : null;
}

/** The office's saved details, or null when the office row does not exist. */
export async function loadOfficeIdentity(providerId: string): Promise<OfficeIdentityFacts | null> {
  const result = await supabaseAdmin(
    "GET",
    `/rest/v1/providers?provider_id=eq.${encodeURIComponent(providerId)}&select=provider_id,provider_name,office_name,email,phone,address_line_1,address_line_2,city,state,postal_code&limit=1`,
  );
  if (result.status >= 300) throw new Error(`Office details could not be read (${result.status}).`);
  const row = Array.isArray(result.json) ? result.json[0] as ProviderRow | undefined : undefined;
  if (!row) return null;
  return {
    providerId: row.provider_id,
    officeName: clean(row.office_name, 150),
    ownerName: clean(row.provider_name, 150),
    email: clean(row.email, 512),
    phone: clean(row.phone, 20),
    address1: clean(row.address_line_1, 200),
    address2: clean(row.address_line_2, 200),
    city: clean(row.city, 100),
    state: clean(row.state, 100),
    postalCode: clean(row.postal_code, 20),
  };
}

/**
 * The name and email the card/bank form starts with. The practice is who
 * pays THINNR, so its business name leads; the owner's name stands in when
 * the practice has not been named yet.
 */
export function defaultBillingDetails(facts: OfficeIdentityFacts | null): { name: string | null; email: string | null } {
  return { name: facts?.officeName ?? facts?.ownerName ?? null, email: facts?.email ?? null };
}

export type AccessCustomerFields = Pick<
  Stripe.CustomerCreateParams,
  "name" | "business_name" | "individual_name" | "email" | "phone" | "address" | "description" | "metadata"
>;

/**
 * The customer fields for one office. Fields THINNR does not know are left
 * out rather than blanked, so a back-fill never erases something HQ typed
 * into Stripe by hand.
 */
export function accessCustomerFields(facts: OfficeIdentityFacts, mode: StripeMode | null): AccessCustomerFields {
  const label = facts.officeName ?? facts.ownerName;
  const fields: AccessCustomerFields = {
    description: `THINNR office access — ${label ?? "office"} (${facts.providerId})`.slice(0, 350),
    metadata: {
      thinnr_provider_id: facts.providerId,
      thinnr_purpose: "office_access",
      thinnr_office_name: (facts.officeName ?? "").slice(0, 500),
      ...(mode ? { thinnr_payment_mode: mode } : {}),
    },
  };
  if (label) fields.name = label;
  if (facts.officeName) fields.business_name = facts.officeName;
  if (facts.ownerName) fields.individual_name = facts.ownerName;
  if (facts.email) fields.email = facts.email;
  if (facts.phone) fields.phone = facts.phone;
  if (facts.address1 && facts.city && facts.state && facts.postalCode) {
    fields.address = {
      line1: facts.address1, line2: facts.address2 ?? undefined, city: facts.city,
      state: facts.state, postal_code: facts.postalCode, country: "US",
    };
  }
  return fields;
}

function modeOf(): StripeMode | null {
  return currentBillingIdentity()?.mode ?? null;
}

/**
 * Bring one existing access customer up to date in the CURRENT payment mode,
 * including which card Stripe treats as the default (the primary card).
 */
export async function syncAccessCustomer(row: Row, facts?: OfficeIdentityFacts | null): Promise<boolean> {
  if (!row.stripe_customer_id) return false;
  const known = facts === undefined ? await loadOfficeIdentity(row.provider_id) : facts;
  if (!known) return false;
  const primary = await selectOne(
    "billing_office_access_instruments",
    `subscription_id=eq.${encodeURIComponent(row.id)}&slot=eq.card_primary&removed_at=is.null&staged_at=is.null`,
  );
  const stripe = await getStripe();
  await stripe.customers.update(row.stripe_customer_id, {
    ...accessCustomerFields(known, modeOf()),
    ...(primary ? { invoice_settings: { default_payment_method: primary.stripe_payment_method_id } } : {}),
  });
  return true;
}

/** The payment modes this deployment holds Stripe credentials for. */
export function configuredModes(): Array<{ mode: StripeMode; platformAccountId: string }> {
  return (["test", "live"] as const).flatMap((mode) => {
    const platformAccountId = process.env[`STRIPE_${mode.toUpperCase()}_PLATFORM_ACCOUNT_ID`]?.trim();
    return platformAccountId && /^acct_[A-Za-z0-9]+$/.test(platformAccountId) ? [{ mode, platformAccountId }] : [];
  });
}

/** Test seam: the modes a change-sync walks. */
let modesForSync: () => Array<{ mode: StripeMode; platformAccountId: string }> = configuredModes;
export function __setSyncModesForTests(fn: (() => Array<{ mode: StripeMode; platformAccountId: string }>) | null): void {
  modesForSync = fn ?? configuredModes;
}

/**
 * The office's practice details or owner contact changed: refresh its access
 * customer in every mode it has one. Never throws — a Stripe outage must not
 * undo a saved details change — and reports what happened per mode instead.
 */
export async function syncOfficeStripeIdentity(
  providerId: string,
): Promise<Array<{ mode: StripeMode; updated: boolean; error?: string }>> {
  let facts: OfficeIdentityFacts | null;
  try { facts = await loadOfficeIdentity(providerId); }
  catch (error) { return modesForSync().map(({ mode }) => ({ mode, updated: false, error: String((error as Error)?.message ?? error) })); }
  const outcomes: Array<{ mode: StripeMode; updated: boolean; error?: string }> = [];
  for (const identity of modesForSync()) {
    try {
      const updated = await runWithBillingIdentity(identity, async () => {
        const row = await findAccessSubscription(providerId);
        return row ? syncAccessCustomer(row, facts) : false;
      });
      outcomes.push({ mode: identity.mode, updated });
    } catch (error) {
      outcomes.push({ mode: identity.mode, updated: false, error: String((error as Error)?.message ?? error) });
    }
  }
  return outcomes;
}

/**
 * Fire-and-forget form for request handlers: the details change is already
 * saved, so the response does not wait on Stripe. Failures are logged per
 * mode; the next change or the back-fill script catches the customer up.
 */
export function queueOfficeStripeIdentitySync(providerId: string, log?: { warn: (obj: object, msg: string) => void }): void {
  void syncOfficeStripeIdentity(providerId).then((outcomes) => {
    for (const outcome of outcomes) {
      if (outcome.error) (log ?? logger).warn({ providerId, mode: outcome.mode, error: outcome.error }, "office access: Stripe customer details sync failed");
    }
  }).catch((error) => (log ?? logger).warn({ providerId, err: error }, "office access: Stripe customer details sync failed"));
}
