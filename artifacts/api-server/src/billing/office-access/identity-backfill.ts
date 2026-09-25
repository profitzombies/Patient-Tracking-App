/**
 * One-time catch-up for office access customers created before they carried
 * the office's identity (they read "Unnamed customer" in THINNR's Stripe
 * dashboard). Runs in the CURRENT billing identity; the script walks both
 * payment modes. A dry run reports exactly what an apply would change and
 * writes nothing — neither to Stripe nor to THINNR's rows.
 *
 * What it brings up to date, per office:
 *   - the customer's name, business/owner names, email, phone, address,
 *     description and metadata (see customer-identity.ts);
 *   - Stripe's default payment method = the primary card;
 *   - a holder name and email on each saved card/bank that lacks them;
 *   - replaced methods still attached (detached, THINNR's history kept);
 *   - methods attached by an abandoned form (a confirmed SetupIntent whose
 *     save never landed) older than an hour, which no slot references.
 */
import type Stripe from "stripe";
import { getStripe } from "../stripe-client";
import { currentBillingIdentity } from "../stripe-environment";
import { selectMany, update, type BillingOfficeAccessInstrumentRow as Instrument } from "../store";
import { accessCustomerFields, loadOfficeIdentity, type AccessCustomerFields } from "./customer-identity";
import { ensureBillingDetails, retireInstruments } from "./instruments";

export interface IdentityBackfillOffice {
  providerId: string;
  customerId: string;
  /** Customer fields that differ from what THINNR knows (or were set). */
  customerChanges: string[];
  methodNamesFilled: number;
  replacedDetached: number;
  replacedDeferred: number;
  untrackedDetached: string[];
  error?: string;
}

export interface IdentityBackfillReport {
  mode: string;
  apply: boolean;
  offices: IdentityBackfillOffice[];
}

/** Long enough that a form someone is filling in right now is never touched. */
const UNTRACKED_GRACE_MS = 3_600_000;

function same(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null);
}

/** The customer fields an update would change, by name. */
export function customerDiff(
  customer: Stripe.Customer,
  desired: AccessCustomerFields,
  defaultPaymentMethod: string | null,
): string[] {
  const changes: string[] = [];
  const scalar = ["name", "business_name", "individual_name", "email", "phone", "description"] as const;
  for (const key of scalar) {
    if (desired[key] !== undefined && !same((customer as unknown as Record<string, unknown>)[key], desired[key])) changes.push(key);
  }
  if (desired.address) {
    const have = customer.address ?? ({} as Stripe.Address);
    const want = desired.address as Stripe.AddressParam;
    const keys = ["line1", "line2", "city", "state", "postal_code", "country"] as const;
    if (keys.some((key) => !same(have[key] || null, want[key] || null))) changes.push("address");
  }
  const metadata = (desired.metadata ?? {}) as Record<string, string>;
  if (Object.entries(metadata).some(([key, value]) => !same(customer.metadata?.[key] ?? "", value))) changes.push("metadata");
  const currentDefault = customer.invoice_settings?.default_payment_method;
  const currentDefaultId = typeof currentDefault === "string" ? currentDefault : currentDefault?.id ?? null;
  if (defaultPaymentMethod && currentDefaultId !== defaultPaymentMethod) changes.push("default_payment_method");
  return changes;
}

export async function backfillAccessIdentity(options: { apply: boolean; now?: Date }): Promise<IdentityBackfillReport> {
  const identity = currentBillingIdentity();
  if (!identity) throw new Error("Run the back-fill inside a billing identity.");
  const now = options.now ?? new Date();
  const stripe = await getStripe();
  const subscriptions = (await selectMany("billing_office_access_subscriptions", "order=created_at.asc"))
    .filter((row) => row.stripe_customer_id);
  const offices: IdentityBackfillOffice[] = [];

  for (const row of subscriptions) {
    const customerId = row.stripe_customer_id!;
    const office: IdentityBackfillOffice = {
      providerId: row.provider_id, customerId, customerChanges: [], methodNamesFilled: 0,
      replacedDetached: 0, replacedDeferred: 0, untrackedDetached: [],
    };
    offices.push(office);
    try {
      const facts = await loadOfficeIdentity(row.provider_id);
      const rows: Instrument[] = await selectMany("billing_office_access_instruments", `subscription_id=eq.${encodeURIComponent(row.id)}`);
      const open = rows.filter((item) => !item.removed_at);
      const primary = open.find((item) => item.slot === "card_primary" && !item.staged_at) ?? null;

      const customer = await stripe.customers.retrieve(customerId);
      if ((customer as Stripe.DeletedCustomer).deleted) throw new Error("The Stripe customer was deleted.");
      if (facts) {
        const desired = accessCustomerFields(facts, identity.mode);
        office.customerChanges = customerDiff(customer as Stripe.Customer, desired, primary?.stripe_payment_method_id ?? null);
        if (options.apply && office.customerChanges.length) {
          await stripe.customers.update(customerId, {
            ...desired,
            ...(primary ? { invoice_settings: { default_payment_method: primary.stripe_payment_method_id } } : {}),
          });
        }
      }

      // Holder names on the methods in service (and a staged bank).
      for (const item of open) {
        const method = await stripe.paymentMethods.retrieve(item.stripe_payment_method_id);
        const missing = !method.billing_details?.name?.trim() || (!method.billing_details?.email?.trim() && facts?.email);
        if (!missing && item.billing_name) continue;
        office.methodNamesFilled += missing ? 1 : 0;
        if (!options.apply) continue;
        const name = await ensureBillingDetails(stripe, method, facts);
        if (name !== (item.billing_name ?? null)) {
          await update("billing_office_access_instruments", `id=eq.${encodeURIComponent(item.id)}`, { billing_name: name });
        }
      }

      // Replaced methods still attached.
      const replaced = rows.filter((item) => item.removed_at && !item.detached_at);
      if (options.apply) {
        const outcome = await retireInstruments(row.id, replaced);
        office.replacedDetached = outcome.detached;
        office.replacedDeferred = outcome.deferred;
      } else {
        office.replacedDetached = replaced.length;
      }

      // Methods on the customer that no THINNR row knows about.
      const known = new Set(rows.map((item) => item.stripe_payment_method_id));
      const attached = await stripe.customers.listPaymentMethods(customerId, { limit: 100 });
      for (const method of attached.data) {
        if (known.has(method.id)) continue;
        if (now.getTime() - method.created * 1000 < UNTRACKED_GRACE_MS) continue;
        office.untrackedDetached.push(method.id);
        if (options.apply) await stripe.paymentMethods.detach(method.id);
      }
    } catch (error) {
      office.error = String((error as Error)?.message ?? error);
    }
  }
  return { mode: identity.mode, apply: options.apply, offices };
}
