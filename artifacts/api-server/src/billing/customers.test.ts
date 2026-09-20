import Stripe from "stripe";
import { afterAll, beforeEach, describe, expect, vi } from "vitest";
import { it } from "./testing/context";
import { ensureCustomer } from "./customers";
import { __setStripeForTests } from "./stripe-client";

vi.hoisted(() => {
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
});

const originalFetch = global.fetch;
let stripe: any;
let patches: Array<Record<string, unknown>>;
const payer = { id: "payer-1", provider_id: "office-1", name: "Pat", email: "pat@example.com", phone: null, patient_id: null, stripe_customer_id: "cus_old" } as any;
const address = { name: "Pat", line1: "1 Main", line2: null, city: "Austin", state: "TX", postal_code: "78701", country: "US", phone: null };
const account = { provider_id: "office-1", stripe_account_id: "acct_new" } as any;

beforeEach(() => {
  patches = [];
  global.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PATCH") patches.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify([{ ...payer, ...(patches.at(-1) ?? {}) }]), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  stripe = {
    customers: {
      update: vi.fn(async () => ({ id: "cus_old" })),
      create: vi.fn(async () => ({ id: "cus_new" })),
    },
  };
  __setStripeForTests(stripe);
});
afterAll(() => {
  global.fetch = originalFetch;
  __setStripeForTests(null);
});

describe("ensureCustomer", () => {
  it("reuses the stored customer when it still exists on the connected account", async () => {
    await expect(ensureCustomer(payer, address, account)).resolves.toBe("cus_old");
    expect(stripe.customers.update.mock.calls[0][2]).toMatchObject({ stripeAccount: "acct_new" });
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(patches).toEqual([]);
  });

  it("recreates the customer on the current account when the stored id lives on another account", async () => {
    stripe.customers.update.mockRejectedValue(new Stripe.errors.StripeInvalidRequestError({
      message: "No such customer: 'cus_old'", code: "resource_missing", type: "invalid_request_error",
    }));
    await expect(ensureCustomer(payer, address, account)).resolves.toBe("cus_new");
    const [params, opts] = stripe.customers.create.mock.calls[0];
    expect(params).toMatchObject({ name: "Pat", metadata: { thinnr_payer_id: "payer-1" } });
    expect(opts).toMatchObject({ stripeAccount: "acct_new", idempotencyKey: "customer:payer-1:acct_new" });
    expect(patches).toEqual([{ stripe_customer_id: "cus_new", stripe_mode: "test", stripe_platform_account_id: "acct_platform" }]);
  });

  it("does not replace the customer on transient Stripe failures", async () => {
    const outage = new Stripe.errors.StripeConnectionError({ message: "socket hang up", type: "api_error" });
    stripe.customers.update.mockRejectedValue(outage);
    await expect(ensureCustomer(payer, address, account)).rejects.toBe(outage);
    expect(stripe.customers.create).not.toHaveBeenCalled();
  });
});
