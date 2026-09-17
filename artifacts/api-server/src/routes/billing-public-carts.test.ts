import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  peek: vi.fn(), phone: vi.fn(), verify: vi.fn(), details: vi.fn(), checkout: vi.fn(), status: vi.fn(),
}));
vi.mock("../billing/prebuilt-carts", () => {
  class PrebuiltCartError extends Error {
    attempts_left?: number;
    constructor(message: string, readonly status = 400, readonly field?: string) { super(message); }
  }
  return {
    PrebuiltCartError,
    publicCartPeek: services.peek, startCartPhone: services.phone, verifyCartCode: services.verify,
    publicCartDetails: services.details, checkoutPrebuiltCart: services.checkout, publicCartCheckoutStatus: services.status,
  };
});
import router from "./billing-public-carts";

const requestId = "11111111-1111-4111-8111-111111111111";
const session = "cart-session";
const address = { name: "Pat", line1: "1 Main", line2: null, city: "Austin", state: "TX", postal_code: "78701", country: "US", phone: "5125550100" };
const checkoutResult = {
  cart_id: "22222222-2222-4222-8222-222222222222", status: "paid", items: [],
  stripe_account_id: "acct_1", publishable_key: "pk_test", sandbox: true,
};
let server: http.Server;
let base = "";
let wrongAttempts = 0;
let paid = false;
async function call(method: string, path: string, body?: unknown, cartSession?: string) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { "Content-Type": "application/json", ...(cartSession ? { "X-Cart-Session": cartSession } : {}) },
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
beforeEach(async () => {
  vi.clearAllMocks(); wrongAttempts = 0; paid = false;
  const { PrebuiltCartError } = await import("../billing/prebuilt-carts");
  services.peek.mockImplementation(async (token: string) => ({
    status: token === "used" ? "used" : token === "expired" ? "expired" : "open",
    office: { name: "Harbor" }, sandbox: true,
  }));
  services.phone.mockImplementation(async (token: string, phone: unknown) => {
    if (token === "expired" || token === "used") throw new PrebuiltCartError("This cart is no longer available.", 410);
    if (token === "locked") throw new PrebuiltCartError("This cart is locked.", 423);
    if (phone !== "5125550100") {
      wrongAttempts += 1;
      const error = new PrebuiltCartError(wrongAttempts >= 5 ? "This cart is locked." : "That number doesn't match the patient on file.", wrongAttempts >= 5 ? 423 : 400);
      if (wrongAttempts < 5) (error as typeof error & { attempts_left: number }).attempts_left = 5 - wrongAttempts;
      throw error;
    }
    return { request_id: requestId, devCode: "123456" };
  });
  services.verify.mockImplementation(async (_token: string, id: unknown, code: unknown) => {
    if (id !== requestId || code !== "123456") throw new PrebuiltCartError("That code didn't match or has expired.", 400);
    return { session };
  });
  const requireSession = (value: unknown) => {
    if (value !== session) throw new PrebuiltCartError("Verify your phone to continue.", 401);
  };
  services.details.mockImplementation(async (_token: string, value: unknown) => {
    requireSession(value);
    return {
      office: { name: "Harbor", city: "Austin", state: "TX" }, patient: { name: "Pat", email: "p@example.com", phone: "5125550100" },
      lines: [], quote: { lines: [], groups: [], subtotal_cents: 0, discount_cents: 0, shipping_charge_cents: 0, total_cents: 0 },
      products: [], default_address: address, shipping_charge_cents: 0, tax_enabled: false,
      stripe_account_id: "acct_1", publishable_key: "pk_test", sandbox: true, expires_at: "2099-01-01T00:00:00Z",
    };
  });
  services.checkout.mockImplementation(async (_token: string, value: unknown) => { requireSession(value); paid = true; return checkoutResult; });
  services.status.mockImplementation(async (_token: string, value: unknown) => {
    requireSession(value);
    return { status: paid ? "paid" : "checkout", partial: false, orders: [{ order_number: "TH-ONE", kind: "one_time", status: paid ? "paid" : "pending", total_cents: 1000 }], office_name: "Harbor", paid_at: paid ? "2026-01-01T00:00:00Z" : null };
  });
});

describe("public cart routes", () => {
  it("peek reveals only status, office, and sandbox", async () => {
    const response = await call("GET", "/billing/public/carts/open");
    expect(response).toMatchObject({ status: 200, json: { status: "open", office: { name: "Harbor" }, sandbox: true } });
    expect(Object.keys(response.json).sort()).toEqual(["office", "sandbox", "status"]);
    expect(response.json).not.toHaveProperty("lines");
    expect(response.json).not.toHaveProperty("patient");
  });

  it("counts wrong phones, locks on the fifth, and remains locked", async () => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await call("POST", "/billing/public/carts/open/phone", { phone: "0000000000" });
      expect(response).toMatchObject({ status: 400, json: { attempts_left: 5 - attempt } });
    }
    expect((await call("POST", "/billing/public/carts/open/phone", { phone: "0000000000" })).status).toBe(423);
    expect((await call("POST", "/billing/public/carts/locked/phone", { phone: "5125550100" })).status).toBe(423);
  });

  it("returns 410 for expired and used carts", async () => {
    expect((await call("POST", "/billing/public/carts/expired/phone", { phone: "5125550100" })).status).toBe(410);
    expect((await call("POST", "/billing/public/carts/used/phone", { phone: "5125550100" })).status).toBe(410);
  });

  it("runs the dev phone, verify, details, checkout, and paid status flow", async () => {
    const phone = await call("POST", "/billing/public/carts/open/phone", { phone: "5125550100" });
    expect(phone).toMatchObject({ status: 200, json: { request_id: requestId, devCode: "123456" } });
    const verified = await call("POST", "/billing/public/carts/open/verify", { request_id: requestId, code: phone.json.devCode });
    expect(verified).toMatchObject({ status: 200, json: { session } });
    expect((await call("GET", "/billing/public/carts/open/details", undefined, session)).status).toBe(200);
    const paid = await call("POST", "/billing/public/carts/open/checkout", { shipping_address: address, payment_method_id: "pm_1" }, session);
    expect(paid).toMatchObject({ status: 200, json: { status: "paid" } });
    expect(services.checkout).toHaveBeenCalledWith("open", session, expect.objectContaining({ payment_method_id: "pm_1" }));
    expect(await call("GET", "/billing/public/carts/open/status", undefined, session)).toMatchObject({
      status: 200, json: { status: "paid", orders: [{ status: "paid" }] },
    });
  });

  it.each([
    ["GET", "/billing/public/carts/open/details", undefined],
    ["POST", "/billing/public/carts/open/checkout", { shipping_address: address, payment_method_id: "pm_1" }],
    ["GET", "/billing/public/carts/open/status", undefined],
  ])("requires X-Cart-Session for %s %s", async (method, path, body) => {
    expect((await call(method, path, body)).status).toBe(401);
  });
});