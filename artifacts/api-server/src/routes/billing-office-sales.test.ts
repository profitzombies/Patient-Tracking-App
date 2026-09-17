import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  guard: vi.fn(), planCart: vi.fn(), checkoutCart: vi.fn(), cartPatient: vi.fn(),
  createCart: vi.fn(), getCart: vi.fn(), listCarts: vi.fn(), revokeCart: vi.fn(), audit: vi.fn(),
  connectionToken: vi.fn(), availability: vi.fn(), startTap: vi.fn(), captureTap: vi.fn(), cancelTap: vi.fn(), saveTapCard: vi.fn(),
  selectOne: vi.fn(),
}));
vi.mock("../billing/auth", () => ({
  requireOfficeBillingScope: mocks.guard,
}));
vi.mock("../billing/cart", () => ({
  BillingCartError: class BillingCartError extends Error { constructor(message: string, readonly status = 400, readonly field?: string) { super(message); } },
  planCart: mocks.planCart, checkoutCart: mocks.checkoutCart,
}));
vi.mock("../billing/prebuilt-carts", () => ({
  PrebuiltCartError: class PrebuiltCartError extends Error { constructor(message: string, readonly status = 400, readonly field?: string) { super(message); } },
  cartPatient: mocks.cartPatient, createPrebuiltCart: mocks.createCart, getPrebuiltCart: mocks.getCart,
  listPrebuiltCarts: mocks.listCarts, revokePrebuiltCart: mocks.revokeCart,
}));
vi.mock("../billing/catalog", () => ({ officeOffering: vi.fn(async () => []), subscribeSavePercent: vi.fn(() => 0) }));
vi.mock("../billing/stripe-client", () => ({ getPublishableKey: vi.fn(async () => "pk_test"), isSandbox: vi.fn(async () => true) }));
vi.mock("../billing/store", () => ({ selectOne: mocks.selectOne }));
vi.mock("../billing/terminal", () => ({
  BillingTerminalError: class BillingTerminalError extends Error { constructor(message: string, readonly status = 400, readonly reason: string | null = null) { super(message); } },
  createConnectionToken: mocks.connectionToken, tapToPayAvailability: mocks.availability,
}));
vi.mock("../billing/terminal-sales", () => ({
  startTapSale: mocks.startTap, captureTapSale: mocks.captureTap, cancelTapSale: mocks.cancelTap, saveTapCardOnFile: mocks.saveTapCard,
}));
vi.mock("../lib/admin-audit", () => ({
  recordAdminAuditEvent: mocks.audit, requestIdOf: vi.fn(() => "request-1"),
}));
import router from "./billing-office-sales";

const patientId = "11111111-1111-4111-8111-111111111111";
const productId = "22222222-2222-4222-8222-222222222222";
const bodyCartId = "33333333-3333-4333-8333-333333333333";
const headerCartId = "44444444-4444-4444-8444-444444444444";
const lines = [{ product_id: productId, quantity: 1, purchase: "one_time" }];
const address = { name: "Pat", line1: "1 Main", line2: null, city: "Austin", state: "TX", postal_code: "78701", country: "US", phone: "5125550100" };
const scope = { providerId: "office-1", officeName: "Harbor", actorUserId: "user-1", isHq: false, officeRole: "staff", canManage: false };
const quote = { lines: [], groups: [], subtotal_cents: 1000, discount_cents: 0, shipping_charge_cents: 0, total_cents: 1000 };
const checkout = { cart_id: headerCartId, status: "paid", items: [], stripe_account_id: "acct_1", publishable_key: "pk_test", sandbox: true };
const cart = {
  id: bodyCartId, token: "token-abcdefghijklmnopqrstuvwxyz", url: "https://pay.example/pay/cart/token-abcdefghijklmnopqrstuvwxyz",
  status: "open", patient: null, lines, quote, label: null, expires_at: "2099-01-01T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z", paid_at: null, orders: [],
};
const orderId = "55555555-5555-4555-8555-555555555555";
const subscriptionId = "66666666-6666-4666-8666-666666666666";
const tapItem = {
  kind: "one_time", order_id: orderId, order_number: "THR-1", subscription_id: null, payment_intent_id: "pi_tap_1",
  client_secret: "pi_tap_1_secret", status: "ready", error: null, total_cents: 1000,
};
const tapSale = { cart_id: headerCartId, items: [tapItem], stripe_account_id: "acct_1", location_id: "tml_1", sandbox: true };
let server: http.Server;
let base = "";
async function call(method: string, path: string, token?: string, body?: unknown, headers?: Record<string, string>) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as any };
}
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use(router);
  server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.guard.mockImplementation(async (req, res, options) => {
    expect(options).toEqual({ write: true, sell: true });
    const token = String(req.headers.authorization ?? "");
    if (!token) { res.status(401).json({ error: "Sign in to continue." }); return null; }
    if (token === "Bearer disabled" || token === "Bearer other") { res.status(403).json({ error: "Office access denied." }); return null; }
    if (token === "Bearer hq" && !req.query.office) { res.status(400).json({ error: "Choose an office.", reason: "office_required" }); return null; }
    return { ...scope, isHq: token === "Bearer hq", providerId: token === "Bearer hq" ? String(req.query.office) : "office-1" };
  });
  mocks.cartPatient.mockImplementation(async (provider: string) => provider === "office-1" ? { id: patientId, name: "Pat", email: "p@example.com", phone: "5125550100" } : null);
  mocks.planCart.mockResolvedValue({ quote });
  mocks.checkoutCart.mockResolvedValue(checkout);
  mocks.createCart.mockResolvedValue(cart);
  mocks.getCart.mockResolvedValue(cart);
  mocks.listCarts.mockResolvedValue([cart]);
  mocks.revokeCart.mockResolvedValue({ ...cart, status: "paid", paid_at: "2026-01-02T00:00:00Z" });
  mocks.audit.mockResolvedValue(undefined);
  mocks.selectOne.mockResolvedValue(null);
  mocks.availability.mockResolvedValue({ available: true, reason: null });
  mocks.connectionToken.mockResolvedValue({ secret: "pst_test_1", location_id: "tml_1", stripe_account_id: "acct_1" });
  mocks.startTap.mockResolvedValue(tapSale);
  mocks.captureTap.mockResolvedValue({ item: { ...tapItem, status: "paid", client_secret: null }, card_on_file: "needed", checkout });
  mocks.cancelTap.mockResolvedValue({ ...checkout, status: "failed" });
  mocks.saveTapCard.mockResolvedValue({ saved: true });
});

describe("office sales routes", () => {
  it("enforces anonymous, disabled, and other-office denials while allowing staff", async () => {
    expect((await call("POST", "/billing/office/sales/quote", undefined, { patient_id: patientId, lines })).status).toBe(401);
    expect((await call("POST", "/billing/office/sales/quote", "disabled", { patient_id: patientId, lines })).status).toBe(403);
    expect((await call("POST", "/billing/office/sales/quote", "other", { patient_id: patientId, lines })).status).toBe(403);
    expect((await call("POST", "/billing/office/sales/quote", "staff", { patient_id: patientId, lines })).status).toBe(200);
  });

  it("returns 404 when the scoped office does not own the patient", async () => {
    mocks.cartPatient.mockResolvedValueOnce(null);
    expect((await call("POST", "/billing/office/sales/quote", "staff", { patient_id: patientId, lines })).status).toBe(404);
  });

  it("requires an office for HQ and accepts HQ drill-in", async () => {
    const missing = await call("POST", "/billing/office/sales/quote", "hq", { patient_id: patientId, lines });
    expect(missing).toMatchObject({ status: 400, json: { reason: "office_required" } });
    expect((await call("POST", "/billing/office/sales/quote?office=office-1", "hq", { patient_id: patientId, lines })).status).toBe(200);
  });

  it("passes quote and checkout inputs through with scoped provider and header cart id, then audits", async () => {
    await call("POST", "/billing/office/sales/quote", "staff", { patient_id: patientId, lines });
    expect(mocks.planCart).toHaveBeenCalledWith("office-1", lines);
    const result = await call("POST", "/billing/office/sales", "staff", {
      patient_id: patientId, lines, shipping_address: address, payment_method_id: "pm_1", cart_id: bodyCartId,
    }, { "Idempotency-Key": headerCartId });
    expect(result.status).toBe(200);
    expect(mocks.checkoutCart).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "office-1", patientId, cartId: headerCartId, lines, payment_method_id: "pm_1",
    }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "billing_office_sale_created", targetId: headerCartId }));
  });

  it("creates a public cart URL and returns paid unchanged on revoke", async () => {
    const created = await call("POST", "/billing/office/carts", "staff", { patient_id: patientId, lines });
    expect(created).toMatchObject({ status: 201, json: { url: expect.stringContaining("/pay/cart/") } });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "billing_prebuilt_cart_created" }));
    const revoked = await call("POST", `/billing/office/carts/${bodyCartId}/revoke`, "staff");
    expect(revoked.json).toMatchObject({ status: "paid" });
  });

  it("only offers Tap to Pay in the sale context when the office can take card payments at all", async () => {
    const offline = await call("GET", `/billing/office/sales/context?patient_id=${patientId}`, "staff");
    expect(offline.json.tap_to_pay).toEqual({ available: false, reason: "not_connected" });
    expect(mocks.availability).not.toHaveBeenCalled();
    mocks.selectOne.mockImplementation(async (table: string) => table === "billing_connected_accounts" ? { stripe_account_id: "acct_1", charges_enabled: true } : null);
    const { officeOffering } = await import("../billing/catalog");
    vi.mocked(officeOffering).mockResolvedValueOnce([{ id: productId } as any]);
    mocks.availability.mockResolvedValueOnce({ available: false, reason: "no_office_address" });
    const online = await call("GET", `/billing/office/sales/context?patient_id=${patientId}`, "staff");
    expect(online.json).toMatchObject({ available: true, tap_to_pay: { available: false, reason: "no_office_address" } });
    expect(mocks.availability).toHaveBeenCalledWith("office-1", expect.objectContaining({ stripe_account_id: "acct_1" }));
  });

  it("mints connection tokens for the scoped office and relays Terminal refusals with their reason", async () => {
    expect((await call("POST", "/billing/office/terminal/connection-token", undefined)).status).toBe(401);
    const token = await call("POST", "/billing/office/terminal/connection-token", "staff");
    expect(token).toMatchObject({ status: 200, json: { secret: "pst_test_1", location_id: "tml_1" } });
    expect(mocks.connectionToken).toHaveBeenCalledWith("office-1");
    const { BillingTerminalError } = await import("../billing/terminal");
    mocks.connectionToken.mockRejectedValueOnce(new BillingTerminalError("Tap to Pay is not enabled on your office's Stripe account yet.", 409, "terminal_unavailable"));
    const refused = await call("POST", "/billing/office/terminal/connection-token?office=office-1", "hq");
    expect(refused).toMatchObject({ status: 409, json: { reason: "terminal_unavailable" } });
    expect(mocks.connectionToken).toHaveBeenLastCalledWith("office-1");
  });

  it("stages a tap sale without a card id under the header cart key, then audits", async () => {
    const result = await call("POST", "/billing/office/sales/tap", "staff", {
      patient_id: patientId, lines, shipping_address: address, cart_id: bodyCartId, expected_total_cents: 7998,
    }, { "Idempotency-Key": headerCartId });
    expect(result).toMatchObject({ status: 200, json: { cart_id: headerCartId, items: [{ status: "ready", client_secret: "pi_tap_1_secret" }] } });
    // The quoted total the staff member confirmed rides through so a price change is refused, exactly like a card sale.
    expect(mocks.startTap).toHaveBeenCalledWith({ providerId: "office-1", patientId, cartId: headerCartId, lines, shipping_address: address, expected_total_cents: 7998 });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "billing_office_tap_sale_started", targetId: headerCartId, metadata: { patient_id: patientId, ready: 1 } }));
    mocks.startTap.mockResolvedValueOnce({ ...tapSale, items: [{ ...tapItem, status: "failed", error: "Payment could not be started." }] });
    expect((await call("POST", "/billing/office/sales/tap", "staff", { patient_id: patientId, lines, shipping_address: address, cart_id: bodyCartId })).status).toBe(402);
    expect((await call("POST", "/billing/office/sales/tap", "staff", { patient_id: patientId, lines, shipping_address: address, cart_id: "not-a-uuid" })).status).toBe(400);
    mocks.cartPatient.mockResolvedValueOnce(null);
    expect((await call("POST", "/billing/office/sales/tap", "staff", { patient_id: patientId, lines, shipping_address: address, cart_id: bodyCartId })).status).toBe(404);
  });

  it("captures, cancels, and saves a card on file for a tap cart with validated bodies and audits", async () => {
    const captured = await call("POST", `/billing/office/sales/tap/${headerCartId}/capture`, "staff", { order_id: orderId });
    expect(captured).toMatchObject({ status: 200, json: { item: { status: "paid" }, card_on_file: "needed" } });
    expect(mocks.captureTap).toHaveBeenCalledWith("office-1", headerCartId, orderId);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "billing_office_tap_sale_captured", metadata: { order_id: orderId, card_on_file: "needed" } }));
    expect((await call("POST", `/billing/office/sales/tap/${headerCartId}/capture`, "staff", {})).status).toBe(400);
    const { BillingTerminalError } = await import("../billing/terminal");
    mocks.captureTap.mockRejectedValueOnce(new BillingTerminalError("The patient has not tapped yet. Finish the tap on the phone first.", 409));
    expect(await call("POST", `/billing/office/sales/tap/${headerCartId}/capture`, "staff", { order_id: orderId })).toMatchObject({ status: 409, json: { error: expect.stringMatching(/not tapped yet/) } });

    const canceled = await call("POST", `/billing/office/sales/tap/${headerCartId}/cancel`, "staff", { reason: "declined", message: "Card declined." });
    expect(canceled).toMatchObject({ status: 200, json: { status: "failed" } });
    expect(mocks.cancelTap).toHaveBeenCalledWith("office-1", headerCartId, "declined", "Card declined.");
    expect((await call("POST", `/billing/office/sales/tap/${headerCartId}/cancel`, "staff", { reason: "shrug" })).status).toBe(400);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "billing_office_tap_sale_canceled", metadata: { reason: "declined", status: "failed" } }));

    const saved = await call("POST", `/billing/office/sales/tap/${headerCartId}/card-on-file`, "staff", { subscription_id: subscriptionId, payment_method_id: "pm_typed" });
    expect(saved).toMatchObject({ status: 200, json: { saved: true } });
    expect(mocks.saveTapCard).toHaveBeenCalledWith("office-1", headerCartId, subscriptionId, "pm_typed");
    expect((await call("POST", `/billing/office/sales/tap/${headerCartId}/card-on-file`, "staff", { subscription_id: subscriptionId })).status).toBe(400);
    expect((await call("POST", `/billing/office/sales/tap/${headerCartId}/card-on-file`, "other", { subscription_id: subscriptionId, payment_method_id: "pm_typed" })).status).toBe(403);
  });
});
