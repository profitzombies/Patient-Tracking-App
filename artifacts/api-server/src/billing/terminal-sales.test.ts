import crypto from "node:crypto";
import Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, vi } from "vitest";
import { it } from "./testing/context";
import { FakePostgrest, type Row } from "./testing/fake-postgrest";

/**
 * Tap to Pay on the provider's phone, server side: Terminal locations and
 * connection tokens per connected account, a card-present intent per order
 * group staged behind the usual rows, capture + out-of-band invoice settlement
 * through the shared paid-order bookkeeping, and honest teardown when the tap
 * is declined or abandoned. Runs the real cart/orders/subscriptions modules
 * against a PostgREST-shaped fake and a scripted Stripe.
 */
const SUPABASE = "http://terminal-sales.supabase.test";
const OFFICE = "office-1";
const ACCT = "acct_office1";
const PRODUCT = "11111111-1111-4111-8111-111111111111";
const ADDON = "22222222-2222-4222-8222-222222222222";
const PATIENT = "33333333-3333-4333-8333-333333333333";
const ADDRESS = { name: "Pat Patient", line1: "1 Main St", line2: null, city: "Austin", state: "TX", postal_code: "78701", country: "US", phone: null };
const TABLES = [
  "patients", "providers", "billing_connected_accounts", "billing_settings", "billing_products", "billing_product_images",
  "billing_office_prices", "billing_office_settings", "billing_orders", "billing_order_items", "billing_refunds", "billing_subscriptions",
  "billing_payment_links", "billing_payers", "billing_shipments", "billing_ledger", "billing_carts",
];

vi.mock("./prices", async (original) => ({
  ...(await original<typeof import("./prices")>()),
  ensureRecurringPrices: vi.fn(async (_providerId: string, productId: string) => ({
    provider_id: OFFICE, product_id: productId, sell_price_cents: 6999, subscription_enabled: true,
    stripe_product_id: "prod_1", stripe_price_id: "price_legacy", stripe_shipping_price_id: "price_ship_legacy",
    stripe_cadence_prices: { "4": { price_id: "price_4w", shipping_price_id: "price_ship_4w", unit_amount_cents: 6299, interval_count: 4 } },
  })),
}));

function invalid(message: string): Error {
  return new Stripe.errors.StripeInvalidRequestError({ message, type: "invalid_request_error" });
}

const backend = new FakePostgrest(TABLES);
type Intent = { id: string; status: string; amount: number; client_secret: string; params: Row; opts: Row; generated: string | null };

/** Scripted Stripe: real enough for the modules under test, and every call is recorded. */
const stripe = {
  intents: new Map<string, Intent>(),
  invoices_: new Map<string, Row>(),
  subs: new Map<string, Row>(),
  locations: new Map<string, Row>(),
  totals: new Map<string, number>(),
  defaults: new Map<string, string>(),
  rejectTerminal: false,
  terminal: {
    locations: {
      create: vi.fn(async (params: Row, opts: Row) => {
        if (stripe.rejectTerminal) throw invalid("Terminal is not available for this account.");
        const location = { id: `tml_${stripe.locations.size + 1}`, ...params, account: opts.stripeAccount };
        stripe.locations.set(location.id, location);
        return location;
      }),
      retrieve: vi.fn(async (id: string) => {
        const location = stripe.locations.get(id);
        if (!location) throw invalid("No such terminal location");
        return location;
      }),
    },
    connectionTokens: {
      create: vi.fn(async (params: Row, opts: Row) => {
        if (stripe.rejectTerminal) throw invalid("Terminal is not available for this account.");
        return { object: "terminal.connection_token", secret: `pst_test_${params.location}_${opts.stripeAccount}`, location: params.location };
      }),
    },
  },
  customers: {
    create: vi.fn(async (params: Row) => ({ id: `cus_${crypto.randomUUID().slice(0, 8)}`, ...params })),
    update: vi.fn(async (id: string, params: Row) => {
      const next = params?.invoice_settings?.default_payment_method;
      if (typeof next === "string") stripe.defaults.set(id, next);
      return { id, ...params };
    }),
    retrieve: vi.fn(async (id: string) => ({ id, invoice_settings: { default_payment_method: stripe.defaults.get(id) ?? null } })),
  },
  paymentMethods: {
    retrieve: vi.fn(async (id: string) => ({ id, customer: null, card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 } })),
    attach: vi.fn(async (id: string, params: Row) => ({ id, customer: params.customer })),
    list: vi.fn(async () => ({ data: [] })),
  },
  invoices: {
    create: vi.fn(async (params: Row) => {
      const invoice = { id: `in_${crypto.randomUUID().slice(0, 8)}`, status: "draft", ...params };
      stripe.invoices_.set(invoice.id, invoice);
      return invoice;
    }),
    finalizeInvoice: vi.fn(async (id: string) => {
      const invoice = { ...stripe.invoices_.get(id), id, status: "open", total: stripe.totals.get(id) ?? 0, payment_intent: null };
      stripe.invoices_.set(id, invoice);
      return invoice;
    }),
    pay: vi.fn(async (id: string, params: Row) => {
      const current = stripe.invoices_.get(id);
      if (!current) throw invalid("No such invoice");
      if (current.status === "paid") throw invalid("Invoice is already paid");
      // Like Stripe: a void (or deleted) invoice can never be paid again.
      if (current.status !== "open") throw invalid(`Invoice ${id} cannot be paid from status ${current.status}`);
      if (!params?.paid_out_of_band) throw new Error("tap sales must settle invoices out of band");
      const paid = { ...current, status: "paid", amount_paid: current.total };
      stripe.invoices_.set(id, paid);
      return paid;
    }),
    retrieve: vi.fn(async (id: string) => {
      const invoice = stripe.invoices_.get(id);
      if (!invoice) throw invalid("No such invoice");
      return invoice;
    }),
    voidInvoice: vi.fn(async (id: string) => {
      const invoice = { ...stripe.invoices_.get(id), id, status: "void" };
      stripe.invoices_.set(id, invoice);
      return invoice;
    }),
    del: vi.fn(async (id: string) => ({ id, deleted: true })),
  },
  invoiceItems: {
    create: vi.fn(async (params: Row) => {
      stripe.totals.set(params.invoice, (stripe.totals.get(params.invoice) ?? 0) + Number(params.unit_amount_decimal) * params.quantity);
      return { id: `ii_${crypto.randomUUID().slice(0, 6)}`, ...params };
    }),
  },
  subscriptions: {
    create: vi.fn(async (params: Row) => {
      const id = `sub_${crypto.randomUUID().slice(0, 8)}`;
      const invoiceId = `in_first_${id}`;
      const total = params.items.reduce((sum: number, item: Row) => sum + (item.price === "price_ship_4w" ? 1000 : 6299 * (item.quantity ?? 1)), 0);
      stripe.invoices_.set(invoiceId, { id: invoiceId, status: "open", total, subscription: id, billing_reason: "subscription_create", payment_intent: `pi_auto_${id}` });
      const subscription = { id, status: "incomplete", latest_invoice: invoiceId, current_period_end: 1_790_000_000, customer: params.customer, default_payment_method: null as string | null, items: { data: params.items.map((item: Row, index: number) => ({ id: `si_${index}_${id}`, price: { id: item.price, product: "prod_1" }, quantity: item.quantity ?? 1 })) } };
      stripe.subs.set(id, subscription);
      return subscription;
    }),
    update: vi.fn(async (id: string, params: Row) => {
      if (stripe.subs.get(id)?.status === "canceled") throw invalid(`Subscription ${id} is canceled and cannot be updated`);
      const next = { ...stripe.subs.get(id), id, ...params };
      stripe.subs.set(id, next);
      return next;
    }),
    retrieve: vi.fn(async (id: string) => stripe.subs.get(id)),
    cancel: vi.fn(async (id: string) => { const next = { ...stripe.subs.get(id), id, status: "canceled" }; stripe.subs.set(id, next); return next; }),
  },
  paymentIntents: {
    create: vi.fn(async (params: Row, opts: Row) => {
      const id = `pi_tap_${stripe.intents.size + 1}`;
      const intent: Intent = { id, status: "requires_payment_method", amount: params.amount, client_secret: `${id}_secret`, params, opts, generated: null };
      stripe.intents.set(id, intent);
      return { id, status: intent.status, client_secret: intent.client_secret, amount: params.amount };
    }),
    retrieve: vi.fn(async (id: string) => {
      const intent = stripe.intents.get(id);
      if (!intent) {
        // The subscription's own automatic intent: never charged in a tap sale.
        if (id.startsWith("pi_auto_")) return { id, status: "canceled", latest_charge: null };
        throw invalid("No such payment intent");
      }
      return view(intent);
    }),
    capture: vi.fn(async (id: string) => {
      const intent = stripe.intents.get(id)!;
      if (intent.status !== "requires_capture") throw invalid(`PaymentIntent ${id} cannot be captured from ${intent.status}`);
      intent.status = "succeeded";
      return view(intent);
    }),
    cancel: vi.fn(async (id: string) => {
      const intent = stripe.intents.get(id)!;
      // Like Stripe: a captured (or already canceled) intent cannot be canceled.
      if (intent.status === "succeeded" || intent.status === "canceled" || intent.status === "processing") {
        throw new Stripe.errors.StripeInvalidRequestError({ message: `PaymentIntent ${id} cannot be canceled from ${intent.status}`, type: "invalid_request_error", code: "payment_intent_unexpected_state" });
      }
      intent.status = "canceled";
      return view(intent);
    }),
  },
  charges: { retrieve: vi.fn(async (id: string) => ({ id, receipt_url: `https://receipts.test/${id}` })) },
};
function view(intent: Intent): Row {
  const charged = intent.status === "succeeded" || intent.status === "requires_capture";
  return {
    id: intent.id, status: intent.status, client_secret: intent.client_secret, amount: intent.amount,
    latest_charge: charged ? {
      id: `ch_${intent.id}`, application_fee_amount: intent.params.application_fee_amount,
      balance_transaction: { id: `txn_${intent.id}`, fee: 300 + intent.params.application_fee_amount, fee_details: [{ type: "stripe_fee", amount: 300 }, { type: "application_fee", amount: intent.params.application_fee_amount }] },
      payment_method_details: { type: "card_present", card_present: { brand: "visa", last4: "4242", generated_card: intent.generated } },
    } : null,
  };
}
/** The patient tapped: the phone's SDK confirmed the intent, leaving it authorized for capture. */
function tapped(id: string, options: { generated?: string | null } = {}): void {
  const intent = stripe.intents.get(id)!;
  intent.status = "requires_capture";
  intent.generated = options.generated ?? null;
}
function resetStripe() {
  stripe.intents.clear(); stripe.invoices_.clear(); stripe.subs.clear(); stripe.locations.clear(); stripe.totals.clear(); stripe.defaults.clear();
  stripe.rejectTerminal = false;
}

function seed(options: { address?: boolean; location?: string | null; charges?: boolean } = {}) {
  backend.tables.providers.push({
    provider_id: OFFICE, office_name: "Harbor Med Spa", provider_name: "Dr. Beacon", email: "office@example.com", phone: null,
    address_line_1: options.address === false ? null : "500 Congress Ave", address_line_2: "Suite 200", city: "Austin", state: "TX", postal_code: "78701",
  });
  backend.tables.billing_connected_accounts.push({
    provider_id: OFFICE, stripe_account_id: ACCT, charges_enabled: options.charges !== false, disconnected_at: null, tax_enabled: false, livemode: false,
    terminal_location_id: options.location ?? null, terminal_location_checked_at: options.location ? "2026-09-01T00:00:00.000Z" : null,
  });
  if (options.location) stripe.locations.set(options.location, { id: options.location, display_name: "Harbor Med Spa" });
  backend.tables.billing_settings.push({
    id: 1, shipping_charge_cents: 1000, shipping_cost_cents: 1000, card_fee_bps: 290, card_fee_fixed_cents: 30, version: 1,
    subscribe_save_enabled: true, subscribe_save_percent: 10,
  });
  backend.tables.billing_products.push(
    { id: PRODUCT, name: "Control", slug: "control", active: true, status: "active", floor_price_cents: 5999, hard_cost_cents: 433, stripe_tax_code: null, offered_cadences_weeks: [4, 8], default_cadence_weeks: 4, created_at: "2026-01-01T00:00:00.000Z" },
    { id: ADDON, name: "Boost", slug: "boost", active: true, status: "active", floor_price_cents: 2999, hard_cost_cents: 200, stripe_tax_code: null, offered_cadences_weeks: [4], default_cadence_weeks: 4, created_at: "2026-01-02T00:00:00.000Z" },
  );
  backend.tables.billing_office_prices.push(
    { provider_id: OFFICE, product_id: PRODUCT, sell_price_cents: 6999, subscription_enabled: true, stripe_product_id: "prod_1", stripe_price_id: "price_legacy", stripe_shipping_price_id: "price_ship_legacy", stripe_cadence_prices: {} },
    { provider_id: OFFICE, product_id: ADDON, sell_price_cents: 3499, subscription_enabled: false, stripe_product_id: "prod_2", stripe_price_id: "price_addon", stripe_shipping_price_id: "price_ship_addon", stripe_cadence_prices: {} },
  );
  backend.tables.patients.push({ id: PATIENT, provider_id: OFFICE, first_name: "Pat", last_name: "Patient", name: null, email: "pat@example.com", phone: null });
  for (const table of ["billing_connected_accounts", "billing_office_prices"]) {
    for (const row of backend.tables[table]) Object.assign(row, { stripe_mode: "test", stripe_platform_account_id: "acct_platform" });
  }
}
function orders(): Row[] { return backend.tables.billing_orders; }
function order(id: string): Row { return orders().find((row) => row.id === id)!; }
function ledger(kind: string): Row[] { return backend.tables.billing_ledger.filter((row) => row.kind === kind); }
const mixed = [
  { product_id: ADDON, quantity: 2, purchase: "one_time" as const },
  { product_id: PRODUCT, quantity: 1, purchase: "subscription" as const, cadence_weeks: 4 },
];

let terminal: typeof import("./terminal");
let sales: typeof import("./terminal-sales");
let cart: typeof import("./cart");

beforeAll(async () => {
  process.env.SUPABASE_URL = SUPABASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-test";
  process.env.BILLING_PUBLIC_ORIGIN = "https://pay.thinnr.test";
  delete process.env.RESEND_API_KEY;
  vi.stubGlobal("fetch", backend.fetchStub("terminal-sales.supabase.test"));
  const client = await import("./stripe-client");
  client.__setStripeForTests(stripe as any);
  client.__setCredentialsForTests({ secret: "sk_test_x", publishable: "pk_test_x", account_id: "acct_platform" });
  terminal = await import("./terminal");
  sales = await import("./terminal-sales");
  cart = await import("./cart");
});
afterAll(async () => {
  const client = await import("./stripe-client");
  client.__setStripeForTests(null);
  client.__setCredentialsForTests(null);
  vi.unstubAllGlobals();
});
beforeEach(() => { backend.reset(); resetStripe(); vi.clearAllMocks(); });

describe("terminal locations and connection tokens", () => {
  it("mints one location per office from its own address, on the office's account, and reuses it", async () => {
    seed();
    const first = await terminal.ensureTerminalLocation(OFFICE);
    const second = await terminal.ensureTerminalLocation(OFFICE);
    expect(first.locationId).toBe("tml_1");
    expect(second.locationId).toBe("tml_1");
    expect(stripe.terminal.locations.create).toHaveBeenCalledTimes(1);
    const [params, opts] = stripe.terminal.locations.create.mock.calls[0];
    expect(params.display_name).toBe("Harbor Med Spa");
    expect(params.address).toEqual({ line1: "500 Congress Ave", line2: "Suite 200", city: "Austin", state: "TX", postal_code: "78701", country: "US" });
    expect(opts.stripeAccount).toBe(ACCT);
    const account = backend.tables.billing_connected_accounts[0];
    expect(account.terminal_location_id).toBe("tml_1");
    expect(account.terminal_location_checked_at).toBeTruthy();
  });

  it("re-mints when the stored location is gone at Stripe, and never for a healthy one", async () => {
    seed({ location: "tml_old" });
    stripe.locations.delete("tml_old");
    const healed = await terminal.ensureTerminalLocation(OFFICE);
    expect(healed.locationId).toBe("tml_1");
    expect(backend.tables.billing_connected_accounts[0].terminal_location_id).toBe("tml_1");
    backend.reset(); resetStripe();
    seed({ location: "tml_kept" });
    expect((await terminal.ensureTerminalLocation(OFFICE)).locationId).toBe("tml_kept");
    expect(stripe.terminal.locations.create).toHaveBeenCalledTimes(1);
  });

  it("refuses to invent an address and names the fix", async () => {
    seed({ address: false });
    await expect(terminal.ensureTerminalLocation(OFFICE)).rejects.toMatchObject({ status: 409, reason: "no_office_address" });
    expect(stripe.terminal.locations.create).not.toHaveBeenCalled();
    expect(await terminal.tapToPayAvailability(OFFICE, backend.tables.billing_connected_accounts[0] as any)).toEqual({ available: false, reason: "no_office_address" });
  });

  it("reports Terminal-not-enabled accounts and disconnected offices distinctly", async () => {
    seed();
    stripe.rejectTerminal = true;
    await expect(terminal.createConnectionToken(OFFICE)).rejects.toMatchObject({ status: 409, reason: "terminal_unavailable" });
    backend.reset(); resetStripe();
    seed({ charges: false });
    await expect(terminal.createConnectionToken(OFFICE)).rejects.toMatchObject({ status: 409, reason: "not_connected" });
    expect(await terminal.tapToPayAvailability(OFFICE, backend.tables.billing_connected_accounts[0] as any)).toEqual({ available: false, reason: "not_connected" });
    expect(await terminal.tapToPayAvailability(OFFICE, null)).toEqual({ available: false, reason: "not_connected" });
  });

  it("issues connection tokens scoped to the office's account and location", async () => {
    seed();
    const token = await terminal.createConnectionToken(OFFICE);
    expect(token).toEqual({ secret: `pst_test_tml_1_${ACCT}`, location_id: "tml_1", stripe_account_id: ACCT });
    expect(stripe.terminal.connectionTokens.create).toHaveBeenCalledWith({ location: "tml_1" }, expect.objectContaining({ stripeAccount: ACCT }));
    expect(await terminal.tapToPayAvailability(OFFICE, backend.tables.billing_connected_accounts[0] as any)).toEqual({ available: true, reason: null });
  });
});

describe("staging a tap sale", () => {
  it("writes the same rows as a card sale and one manual-capture card-present intent per group", async () => {
    seed();
    const cartId = crypto.randomUUID();
    const result = await sales.startTapSale({ patientId: PATIENT, providerId: OFFICE, cartId, lines: mixed, shipping_address: ADDRESS });
    expect(result.stripe_account_id).toBe(ACCT);
    expect(result.location_id).toBe("tml_1");
    expect(result.items).toHaveLength(2);
    expect(result.items.every((item) => item.status === "ready" && item.client_secret && item.payment_intent_id)).toBe(true);
    const oneTime = result.items.find((item) => item.kind === "one_time")!;
    const subscription = result.items.find((item) => item.kind === "subscription")!;
    // Rows first, mirroring the card path: orders carry the tap source so replays and cancels know how they were started.
    expect(orders()).toHaveLength(2);
    expect(orders().every((row) => row.metadata.source === "tap_to_pay" && row.status === "pending")).toBe(true);
    expect(backend.tables.billing_carts[0]).toMatchObject({ id: cartId, status: "ready" });
    expect(backend.tables.billing_subscriptions[0]).toMatchObject({ id: subscription.subscription_id, status: "incomplete" });
    // One intent per group: the exact invoice total and the exact application fee, on the office's account.
    const oneTimeIntent = stripe.intents.get(oneTime.payment_intent_id!)!;
    expect(oneTimeIntent.params).toMatchObject({
      amount: 3499 * 2 + 1000, payment_method_types: ["card_present"], capture_method: "manual",
      application_fee_amount: order(oneTime.order_id).application_fee_cents,
      metadata: { thinnr_order_id: oneTime.order_id, thinnr_cart_id: cartId, thinnr_source: "tap_to_pay" },
    });
    expect(oneTimeIntent.params.setup_future_usage).toBeUndefined();
    expect(oneTimeIntent.opts).toMatchObject({ stripeAccount: ACCT, idempotencyKey: `order:${oneTime.order_id}:terminal` });
    const subIntent = stripe.intents.get(subscription.payment_intent_id!)!;
    expect(subIntent.params).toMatchObject({ amount: 6299 + 1000, setup_future_usage: "off_session", application_fee_amount: order(subscription.order_id).application_fee_cents });
    // The subscription is created without a card: its first invoice waits for the tap.
    expect(stripe.subscriptions.create.mock.calls[0][0].default_payment_method).toBeUndefined();
    expect(stripe.invoices.pay).not.toHaveBeenCalled();
    expect(oneTime.total_cents).toBe(7998);
    expect(subscription.total_cents).toBe(7299);
  });

  it("replays the same cart key without creating anything twice", async () => {
    seed();
    const cartId = crypto.randomUUID();
    const input = { patientId: PATIENT, providerId: OFFICE, cartId, lines: mixed, shipping_address: ADDRESS };
    const first = await sales.startTapSale(input);
    const again = await sales.startTapSale(input);
    expect(again.items.map((item) => [item.order_id, item.payment_intent_id, item.status])).toEqual(first.items.map((item) => [item.order_id, item.payment_intent_id, item.status]));
    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(2);
    expect(stripe.subscriptions.create).toHaveBeenCalledTimes(1);
    expect(orders()).toHaveLength(2);
  });

  it("holds the staged total to the quote the staff member saw and refuses a changed price before any row or intent exists", async () => {
    seed();
    const quoted = 7998 + 7299;
    await expect(sales.startTapSale({ patientId: PATIENT, providerId: OFFICE, cartId: crypto.randomUUID(), lines: mixed, shipping_address: ADDRESS, expected_total_cents: quoted - 100 }))
      .rejects.toMatchObject({ status: 409, field: "expected_total_cents", message: cart.QUOTE_CHANGED_MESSAGE });
    expect(orders()).toHaveLength(0);
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
    const result = await sales.startTapSale({ patientId: PATIENT, providerId: OFFICE, cartId: crypto.randomUUID(), lines: mixed, shipping_address: ADDRESS, expected_total_cents: quoted });
    expect(result.items.every((item) => item.status === "ready")).toBe(true);
  });

  it("never lets a tap cart resume a typed-card cart under the same key", async () => {
    seed();
    const cartId = crypto.randomUUID();
    await cart.checkoutCart({ patientId: PATIENT, providerId: OFFICE, cartId, lines: [mixed[0]], shipping_address: ADDRESS, payment_method_id: "pm_visa" }).catch(() => undefined);
    await expect(sales.startTapSale({ patientId: PATIENT, providerId: OFFICE, cartId, lines: [mixed[0]], shipping_address: ADDRESS }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("does not stage anything for an office without a Terminal location source", async () => {
    seed({ address: false });
    await expect(sales.startTapSale({ patientId: PATIENT, providerId: OFFICE, cartId: crypto.randomUUID(), lines: mixed, shipping_address: ADDRESS }))
      .rejects.toMatchObject({ reason: "no_office_address" });
    expect(orders()).toHaveLength(0);
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });
});

describe("capturing a tap", () => {
  async function staged() {
    seed();
    const cartId = crypto.randomUUID();
    const result = await sales.startTapSale({ patientId: PATIENT, providerId: OFFICE, cartId, lines: mixed, shipping_address: ADDRESS });
    return { cartId, oneTime: result.items.find((item) => item.kind === "one_time")!, subscription: result.items.find((item) => item.kind === "subscription")! };
  }

  it("refuses to capture before the patient tapped", async () => {
    const { cartId, oneTime } = await staged();
    await expect(sales.captureTapSale(OFFICE, cartId, oneTime.order_id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/not tapped yet/) });
    expect(stripe.paymentIntents.capture).not.toHaveBeenCalled();
    expect(order(oneTime.order_id).status).toBe("pending");
  });

  it("captures, settles the invoice out of band, and records the order exactly like a card sale", async () => {
    const { cartId, oneTime } = await staged();
    tapped(oneTime.payment_intent_id!);
    const result = await sales.captureTapSale(OFFICE, cartId, oneTime.order_id);
    expect(result.item).toMatchObject({ order_id: oneTime.order_id, status: "paid", total_cents: 7998 });
    expect(result.card_on_file).toBeNull();
    expect(stripe.paymentIntents.capture).toHaveBeenCalledWith(oneTime.payment_intent_id, expect.anything(), expect.objectContaining({ stripeAccount: ACCT, idempotencyKey: `order:${oneTime.order_id}:capture` }));
    expect(stripe.invoices.pay).toHaveBeenCalledWith(order(oneTime.order_id).stripe_invoice_id, expect.objectContaining({ paid_out_of_band: true }), expect.objectContaining({ idempotencyKey: `order:${oneTime.order_id}:paid-out-of-band` }));
    const paid = order(oneTime.order_id);
    const fee = paid.application_fee_cents;
    expect(paid).toMatchObject({
      status: "paid", stripe_charge_id: `ch_${oneTime.payment_intent_id}`, stripe_payment_intent_id: oneTime.payment_intent_id,
      application_fee_collected_cents: fee, stripe_fee_cents: 300, office_net_cents: 7998 - fee - 300,
    });
    const sale = ledger("sale").find((row) => row.order_id === oneTime.order_id)!;
    expect(sale).toMatchObject({ amount_cents: 7998 - fee - 300, application_fee_cents: fee, provider_id: OFFICE });
    expect(result.checkout.items.find((item) => item.order_id === oneTime.order_id)?.status).toBe("paid");
  });

  it("keeps a tapped physical card as the subscription's renewal card", async () => {
    const { cartId, subscription } = await staged();
    tapped(subscription.payment_intent_id!, { generated: "pm_generated_1" });
    const result = await sales.captureTapSale(OFFICE, cartId, subscription.order_id);
    expect(result.card_on_file).toBe("saved");
    const row = backend.tables.billing_subscriptions[0];
    expect(row.status).toBe("active");
    expect(stripe.subs.get(row.stripe_subscription_id)?.default_payment_method).toBe("pm_generated_1");
    expect(stripe.defaults.get(row.stripe_customer_id)).toBe("pm_generated_1");
    expect(order(subscription.order_id)).toMatchObject({ status: "paid", metadata: expect.objectContaining({ card_on_file: "saved" }) });
    expect(ledger("sale").some((line) => line.order_id === subscription.order_id)).toBe(true);
  });

  it("asks for a card on file when the tap (a wallet) yields no reusable card, then saves the typed one", async () => {
    const { cartId, subscription } = await staged();
    tapped(subscription.payment_intent_id!);
    const result = await sales.captureTapSale(OFFICE, cartId, subscription.order_id);
    expect(result.card_on_file).toBe("needed");
    expect(backend.tables.billing_subscriptions[0].status).toBe("active");
    expect(stripe.subscriptions.update).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ default_payment_method: expect.any(String) }), expect.anything());
    await sales.saveTapCardOnFile(OFFICE, cartId, subscription.subscription_id!, "pm_typed");
    const row = backend.tables.billing_subscriptions[0];
    expect(stripe.paymentMethods.attach).toHaveBeenCalledWith("pm_typed", { customer: row.stripe_customer_id }, expect.objectContaining({ stripeAccount: ACCT }));
    expect(stripe.subs.get(row.stripe_subscription_id)?.default_payment_method).toBe("pm_typed");
    expect(order(subscription.order_id).metadata.card_on_file).toBe("saved");
    // A repeat capture now reports the saved card instead of asking again.
    expect((await sales.captureTapSale(OFFICE, cartId, subscription.order_id)).card_on_file).toBe("saved");
  });

  it("is idempotent: a repeated capture neither re-captures nor re-posts the ledger", async () => {
    const { cartId, oneTime } = await staged();
    tapped(oneTime.payment_intent_id!);
    const first = await sales.captureTapSale(OFFICE, cartId, oneTime.order_id);
    const second = await sales.captureTapSale(OFFICE, cartId, oneTime.order_id);
    expect(second.item).toEqual(first.item);
    expect(stripe.paymentIntents.capture).toHaveBeenCalledTimes(1);
    expect(stripe.invoices.pay).toHaveBeenCalledTimes(1);
    expect(ledger("sale").filter((row) => row.order_id === oneTime.order_id)).toHaveLength(1);
  });

  it("heals a capture whose response was lost when the cart is replayed", async () => {
    const { cartId, oneTime } = await staged();
    tapped(oneTime.payment_intent_id!);
    stripe.intents.get(oneTime.payment_intent_id!)!.status = "succeeded"; // captured at Stripe, never recorded here
    const replay = await sales.startTapSale({ patientId: PATIENT, providerId: OFFICE, cartId, lines: mixed, shipping_address: ADDRESS });
    expect(replay.items.find((item) => item.order_id === oneTime.order_id)?.status).toBe("paid");
    expect(order(oneTime.order_id).status).toBe("paid");
    expect(stripe.paymentIntents.capture).not.toHaveBeenCalled();
    expect(stripe.invoices.pay).toHaveBeenCalledTimes(1);
  });

  it("rejects captures for orders that were not started with Tap to Pay or belong elsewhere", async () => {
    const { cartId, oneTime } = await staged();
    await expect(sales.captureTapSale("office-2", cartId, oneTime.order_id)).rejects.toMatchObject({ status: 404 });
    await expect(sales.captureTapSale(OFFICE, crypto.randomUUID(), oneTime.order_id)).rejects.toMatchObject({ status: 404 });
    order(oneTime.order_id).metadata = { ...order(oneTime.order_id).metadata, source: "patient_app" };
    await expect(sales.captureTapSale(OFFICE, cartId, oneTime.order_id)).rejects.toMatchObject({ status: 409 });
  });
});

describe("abandoning a tap", () => {
  async function staged() {
    seed();
    const cartId = crypto.randomUUID();
    const result = await sales.startTapSale({ patientId: PATIENT, providerId: OFFICE, cartId, lines: mixed, shipping_address: ADDRESS });
    return { cartId, oneTime: result.items.find((item) => item.kind === "one_time")!, subscription: result.items.find((item) => item.kind === "subscription")! };
  }

  it("fails every untapped order, voids its Stripe objects, and says why", async () => {
    const { cartId, oneTime, subscription } = await staged();
    const response = await sales.cancelTapSale(OFFICE, cartId, "declined", "Your card was declined.");
    expect(response.status).toBe("failed");
    expect(response.items.map((item) => item.error)).toEqual(["The card was declined. Your card was declined.", "The card was declined. Your card was declined."]);
    expect(orders().every((row) => row.status === "failed")).toBe(true);
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith(oneTime.payment_intent_id, expect.anything(), expect.objectContaining({ stripeAccount: ACCT }));
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith(subscription.payment_intent_id, expect.anything(), expect.objectContaining({ stripeAccount: ACCT }));
    expect(stripe.invoices.voidInvoice).toHaveBeenCalledWith(order(oneTime.order_id).stripe_invoice_id, expect.anything(), expect.anything());
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith(backend.tables.billing_subscriptions[0].stripe_subscription_id, expect.anything(), expect.objectContaining({ stripeAccount: ACCT }));
    expect(backend.tables.billing_subscriptions[0].status).toBe("canceled");
    // The provider starts over under a new key; the old one stays a failed record.
    const fresh = await sales.startTapSale({ patientId: PATIENT, providerId: OFFICE, cartId: crypto.randomUUID(), lines: mixed, shipping_address: ADDRESS });
    expect(fresh.items.every((item) => item.status === "ready")).toBe(true);
  });

  it("finishes an order whose tap authorized in the meantime instead of throwing the money away", async () => {
    const { cartId, oneTime, subscription } = await staged();
    tapped(oneTime.payment_intent_id!);
    const response = await sales.cancelTapSale(OFFICE, cartId, "fallback");
    expect(order(oneTime.order_id).status).toBe("paid");
    expect(order(subscription.order_id).status).toBe("failed");
    expect(response.items.find((item) => item.order_id === oneTime.order_id)?.status).toBe("paid");
    expect(response.items.find((item) => item.order_id === subscription.order_id)?.error).toBe("The sale was moved to another payment method.");
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledTimes(1);
  });

  it("never captures on a replaced Connect account: the authorization is released on the pinned account and the rows fail honestly", async () => {
    const { cartId, oneTime, subscription } = await staged();
    tapped(oneTime.payment_intent_id!);
    // The office reconnected a different account after the sale was staged.
    backend.tables.billing_connected_accounts[0].stripe_account_id = "acct_replacement";
    await expect(sales.captureTapSale(OFFICE, cartId, oneTime.order_id)).rejects.toMatchObject({ status: 409, message: sales.ACCOUNT_CHANGED_MESSAGE });
    expect(stripe.paymentIntents.capture).not.toHaveBeenCalled();
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith(oneTime.payment_intent_id, expect.anything(), expect.objectContaining({ stripeAccount: ACCT }));
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith(subscription.payment_intent_id, expect.anything(), expect.objectContaining({ stripeAccount: ACCT }));
    expect(orders().every((row) => row.status === "failed" && row.failure_message === sales.ACCOUNT_CHANGED_MESSAGE)).toBe(true);
    expect(ledger("sale")).toHaveLength(0);
  });

  it("takes the same no-capture path from the cancel endpoint, answers not_charged, and refuses a renewal card on a replaced account", async () => {
    const { cartId, oneTime, subscription } = await staged();
    tapped(oneTime.payment_intent_id!);
    backend.tables.billing_connected_accounts[0].stripe_account_id = "acct_replacement";
    const response = await sales.cancelTapSale(OFFICE, cartId, "fallback");
    // The release on the pinned account IS the definite answer: the phone may start over on the new account.
    expect(response.settlement).toBe("not_charged");
    expect(response.items.every((item) => item.status === "failed" && item.error === sales.ACCOUNT_CHANGED_MESSAGE)).toBe(true);
    expect(stripe.paymentIntents.capture).not.toHaveBeenCalled();
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith(oneTime.payment_intent_id, expect.anything(), expect.objectContaining({ stripeAccount: ACCT }));
    expect(order(oneTime.order_id).status).toBe("failed");
    await expect(sales.saveTapCardOnFile(OFFICE, cartId, subscription.subscription_id!, "pm_new")).rejects.toMatchObject({ status: 409 });
    expect(stripe.paymentMethods?.attach ?? vi.fn()).not.toHaveBeenCalled();
  });

  it("refuses loudly (manual_resolution), instead of failing the row, when an intent already captured on an account nobody reconciles", async () => {
    const { cartId, oneTime } = await staged();
    stripe.intents.get(oneTime.payment_intent_id!)!.status = "succeeded";
    backend.tables.billing_connected_accounts[0].stripe_account_id = "acct_replacement";
    await expect(sales.cancelTapSale(OFFICE, cartId, "fallback")).rejects.toMatchObject({ status: 409, reason: "manual_resolution", message: expect.stringMatching(/already went through/) });
    expect(order(oneTime.order_id).status).toBe("pending");
    expect(stripe.paymentIntents.capture).not.toHaveBeenCalled();
  });

  it("reports what was proven: not_charged, partial, or paid", async () => {
    const untouched = await staged();
    expect((await sales.cancelTapSale(OFFICE, untouched.cartId, "canceled")).settlement).toBe("not_charged");
    const half = await staged();
    tapped(half.oneTime.payment_intent_id!);
    expect((await sales.cancelTapSale(OFFICE, half.cartId, "fallback")).settlement).toBe("partial");
    const all = await staged();
    tapped(all.oneTime.payment_intent_id!);
    tapped(all.subscription.payment_intent_id!);
    const paid = await sales.cancelTapSale(OFFICE, all.cartId, "fallback");
    expect(paid.settlement).toBe("paid");
    expect(orders().filter((row) => row.cart_id === all.cartId).every((row) => row.status === "paid")).toBe(true);
  });

  it("stays unknown (503 settlement_unknown) and fails no row when Stripe cannot be read during a settle", async () => {
    const { cartId, oneTime } = await staged();
    const retrieve = stripe.paymentIntents.retrieve.getMockImplementation()!;
    stripe.paymentIntents.retrieve.mockImplementationOnce(async () => { throw new Stripe.errors.StripeConnectionError({ message: "socket hang up", type: "api_connection_error" } as any); });
    await expect(sales.cancelTapSale(OFFICE, cartId, "fallback")).rejects.toMatchObject({ status: 503, reason: "settlement_unknown" });
    expect(orders().every((row) => row.status === "pending")).toBe(true);
    expect(stripe.paymentIntents.cancel).not.toHaveBeenCalled();
    // A later settle, once Stripe answers, gives the definite result on the same cart.
    stripe.paymentIntents.retrieve.mockImplementation(retrieve);
    expect((await sales.cancelTapSale(OFFICE, cartId, "fallback")).settlement).toBe("not_charged");
    expect(order(oneTime.order_id).status).toBe("failed");
  });

  it("keeps the row pending when the void itself fails for a transient reason", async () => {
    const { cartId, oneTime } = await staged();
    stripe.paymentIntents.cancel.mockImplementationOnce(async () => { throw new Stripe.errors.StripeAPIError({ message: "upstream", type: "api_error" } as any); });
    await expect(sales.cancelTapSale(OFFICE, cartId, "fallback")).rejects.toMatchObject({ status: 503, reason: "settlement_unknown" });
    expect(order(oneTime.order_id).status).toBe("pending");
  });

  it("never buries a capture that raced ahead of the void: the refused cancel is re-read and answered manual_resolution", async () => {
    const { cartId, oneTime, subscription } = await staged();
    // The phone's capture lands between the settle's read (still untapped) and its void.
    stripe.paymentIntents.cancel.mockImplementationOnce(async (id: string) => {
      stripe.intents.get(id)!.status = "succeeded";
      throw new Stripe.errors.StripeInvalidRequestError({ message: "cannot cancel", type: "invalid_request_error", code: "payment_intent_unexpected_state" });
    });
    await expect(sales.cancelTapSale(OFFICE, cartId, "fallback")).rejects.toMatchObject({ status: 409, reason: "manual_resolution" });
    expect(order(oneTime.order_id).status).toBe("pending");
    expect(order(subscription.order_id).status).toBe("pending");
    // Nothing of the captured order was torn down: its invoice is still payable, so the money can still be recorded.
    expect(stripe.invoices_.get(order(oneTime.order_id).stripe_invoice_id)?.status).toBe("open");
    expect(stripe.invoices.voidInvoice).not.toHaveBeenCalled();
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(backend.tables.billing_subscriptions[0].status).toBe("incomplete");
    // Asking again finds the captured intent and records the sale instead of charging twice.
    const settled = await sales.cancelTapSale(OFFICE, cartId, "fallback");
    expect(settled.settlement).toBe("partial");
    expect(order(oneTime.order_id).status).toBe("paid");
    expect(stripe.invoices_.get(order(oneTime.order_id).stripe_invoice_id)?.status).toBe("paid");
    expect(order(subscription.order_id).status).toBe("failed");
    expect(ledger("sale")).toHaveLength(1);
  });

  it("leaves a subscription order fully intact when its void is ambiguous, so a later capture can still activate it", async () => {
    const { cartId, oneTime, subscription } = await staged();
    const cancel = stripe.paymentIntents.cancel.getMockImplementation()!;
    const retrieve = stripe.paymentIntents.retrieve.getMockImplementation()!;
    // The one-time void succeeds; the subscription's intent cannot be reached at all.
    stripe.paymentIntents.cancel.mockImplementation(async (id: string) => {
      if (id === subscription.payment_intent_id) throw new Stripe.errors.StripeAPIError({ message: "upstream", type: "api_error" } as any);
      return cancel(id);
    });
    stripe.paymentIntents.retrieve.mockImplementation(async (id: string) => {
      if (id === subscription.payment_intent_id) throw new Stripe.errors.StripeConnectionError({ message: "socket hang up", type: "api_connection_error" } as any);
      return retrieve(id);
    });
    try {
      await expect(sales.cancelTapSale(OFFICE, cartId, "fallback")).rejects.toMatchObject({ status: 503, reason: "settlement_unknown" });
    } finally {
      stripe.paymentIntents.cancel.mockImplementation(cancel);
      stripe.paymentIntents.retrieve.mockImplementation(retrieve);
    }
    // Rows are voided in cart order, so the one-time line may or may not have
    // been reached; the subscription line, whose proof failed, is untouched.
    expect(order(oneTime.order_id).status).not.toBe("paid");
    expect(order(subscription.order_id).status).toBe("pending");
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(backend.tables.billing_subscriptions[0].status).toBe("incomplete");
    expect(stripe.subs.get(backend.tables.billing_subscriptions[0].stripe_subscription_id)?.status).toBe("incomplete");
    // Stripe comes back and the patient HAD tapped: the subscription activates on the original tap, no second charge.
    tapped(subscription.payment_intent_id!);
    const settled = await sales.cancelTapSale(OFFICE, cartId, "fallback");
    expect(settled.settlement).toBe("partial");
    expect(order(oneTime.order_id).status).toBe("failed");
    expect(order(subscription.order_id).status).toBe("paid");
    expect(backend.tables.billing_subscriptions[0].status).toBe("active");
    expect(stripe.paymentIntents.capture).toHaveBeenCalledTimes(1);
  });

  it("still voids Stripe objects for an order the decline webhook failed first", async () => {
    const { cartId, oneTime } = await staged();
    Object.assign(order(oneTime.order_id), { status: "failed", failure_message: "Your card has insufficient funds." });
    const response = await sales.cancelTapSale(OFFICE, cartId, "declined");
    expect(response.items.find((item) => item.order_id === oneTime.order_id)?.error).toBe("Your card has insufficient funds.");
    expect(stripe.invoices.voidInvoice).toHaveBeenCalledWith(order(oneTime.order_id).stripe_invoice_id, expect.anything(), expect.anything());
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith(oneTime.payment_intent_id, expect.anything(), expect.anything());
  });
});
