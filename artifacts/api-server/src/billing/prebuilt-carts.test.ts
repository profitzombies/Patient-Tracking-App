import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  selectOne: vi.fn(), selectMany: vi.fn(), update: vi.fn(), insert: vi.fn(),
}));
const checkoutCart = vi.hoisted(() => vi.fn());
const assertQuoteCurrent = vi.hoisted(() => vi.fn(async () => ({ quote: {}, groups: [], settings: {} })));
const auth = vi.hoisted(() => ({ checkCode: vi.fn(), registerSend: vi.fn(), deliverSmsRegistered: vi.fn() }));
const admin = vi.hoisted(() => vi.fn());
vi.mock("./store", () => db);
vi.mock("./stripe-client", () => ({ isSandbox: vi.fn(async () => true), getPublishableKey: vi.fn(async () => "pk_test") }));
vi.mock("./store-orders", () => ({ getProvider: vi.fn(async () => ({ office_name: "Harbor" })), officeName: vi.fn(() => "Harbor") }));
vi.mock("./catalog", () => ({ officeOffering: vi.fn(async () => []) }));
vi.mock("./app-origin", () => ({ publicOrigin: vi.fn(() => "https://pay.example") }));
vi.mock("../routes/auth", () => auth);
vi.mock("./cart", () => ({
  BillingCartError: class BillingCartError extends Error { constructor(message: string, readonly status = 400, readonly field?: string) { super(message); } },
  checkoutCart, assertQuoteCurrent,
}));
vi.mock("./links", () => ({ resolvePayer: vi.fn() }));
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: admin }));

import {
  checkoutPrebuiltCart, effectiveStatus, publicCartCheckoutStatus, publicCartDetails, requireCartSession, revokePrebuiltCart, toPrebuiltCart, verifyCartCode,
} from "./prebuilt-carts";
import { BillingCartError } from "./cart";
import { sha256 } from "../auth/ledger";

const row = {
  id: "11111111-1111-4111-8111-111111111111", token: "abcdefghijklmnopqrstuvwxyz123456",
  provider_id: "office-1", patient_id: null, created_by_user_id: "user-1", label: null,
  lines: [], quote: { groups: [] }, status: "open" as const, expires_at: "2099-01-01T00:00:00Z",
  phone_attempts: 0, verification_id: null, verified_at: null, session_hash: null,
  checkout_attempt: 0, cart_id: null, paid_at: null, created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  db.selectMany.mockResolvedValue([]);
  db.update.mockImplementation(async (_table, _query, patch) => ({ ...row, ...patch }));
  db.insert.mockImplementation(async (_table, value) => ({ id: "payer-new", created_at: "2026-01-01T00:00:00Z", ...value }));
  admin.mockReset();
  auth.checkCode.mockReset();
  checkoutCart.mockReset();
  assertQuoteCurrent.mockReset();
  assertQuoteCurrent.mockResolvedValue({ quote: {}, groups: [], settings: {} } as never);
});

describe("prebuilt cart lifecycle", () => {
  it("expires an open cart on read", async () => {
    expect(await effectiveStatus({ ...row, expires_at: "2020-01-01T00:00:00Z" })).toBe("expired");
    expect(db.update).toHaveBeenCalledWith("billing_prebuilt_carts", expect.stringContaining("status=eq.open"), { status: "expired", session_hash: null });
  });

  it("detects a paid order as single-use", async () => {
    db.selectMany.mockResolvedValueOnce([{ status: "paid", paid_at: "2026-01-02T00:00:00Z" }]);
    expect(await effectiveStatus({
      ...row, quote: { groups: [{}] }, status: "checkout", cart_id: "22222222-2222-4222-8222-222222222222",
    })).toBe("paid");
    expect(db.update).toHaveBeenCalledWith("billing_prebuilt_carts", expect.stringContaining("status=eq.checkout"),
      expect.not.objectContaining({ session_hash: null }));
  });

  it("gates private data with the hashed session", async () => {
    db.selectOne.mockResolvedValue({ ...row, session_hash: sha256("session") });
    await expect(requireCartSession(row.token, "wrong")).rejects.toMatchObject({ status: 401 });
    await expect(requireCartSession(row.token, "session")).resolves.toMatchObject({ id: row.id });
    db.selectOne.mockResolvedValue({ ...row, status: "revoked", session_hash: null });
    await expect(requireCartSession(row.token, "session")).rejects.toMatchObject({ status: 410 });
  });

  it("stops serving a cart parked in checkout once it has expired", async () => {
    // A stalled checkout is never flipped to expired by effectiveStatus, so the
    // session gate must apply expires_at itself or contact details leak on.
    db.selectOne.mockResolvedValue({ ...row, status: "checkout", cart_id: "22222222-2222-4222-8222-222222222222", expires_at: "2020-01-01T00:00:00Z", session_hash: sha256("session") });
    await expect(requireCartSession(row.token, "session")).rejects.toMatchObject({ status: 410 });
    await expect(publicCartDetails(row.token, "session")).rejects.toMatchObject({ status: 410 });
    expect(checkoutCart).not.toHaveBeenCalled();
  });

  it("refuses checkout when today's price no longer matches the quoted total", async () => {
    const verified = { ...row, patient_id: "patient-1", status: "verified" as const, session_hash: sha256("session"), quote: { total_cents: 5000, groups: [{}] } };
    db.selectOne.mockImplementation(async (table: string) => table === "billing_prebuilt_carts" ? verified : null);
    assertQuoteCurrent.mockRejectedValueOnce(new BillingCartError("The total changed.", 409, "expected_total_cents"));
    await expect(checkoutPrebuiltCart(verified.token, "session", { shipping_address: {} as any, payment_method_id: "pm_1" }))
      .rejects.toMatchObject({ status: 409, field: "expected_total_cents" });
    expect(assertQuoteCurrent).toHaveBeenCalledWith(verified.provider_id, verified.lines, 5000);
    // Nothing moved: the cart was not marked checkout and no charge was attempted.
    expect(db.update).not.toHaveBeenCalledWith("billing_prebuilt_carts", expect.anything(), expect.objectContaining({ status: "checkout" }));
    expect(checkoutCart).not.toHaveBeenCalled();
  });

  it("binds the charge to the quoted total on a fresh checkout", async () => {
    const verified = { ...row, patient_id: "patient-1", status: "verified" as const, session_hash: sha256("session"), quote: { total_cents: 5000, groups: [{}] } };
    db.selectOne.mockImplementation(async (table: string) => table === "billing_prebuilt_carts" ? verified : null);
    checkoutCart.mockResolvedValue({ status: "paid", cart_id: "c", items: [] });
    await checkoutPrebuiltCart(verified.token, "session", { shipping_address: {} as any, payment_method_id: "pm_1" });
    expect(checkoutCart).toHaveBeenCalledWith(expect.objectContaining({ expected_total_cents: 5000 }));
  });

  it("keeps a valid session for paid status polling but expires it at expires_at", async () => {
    const paid = {
      ...row, status: "paid" as const, session_hash: sha256("session"), paid_at: "2026-01-02T00:00:00Z",
      cart_id: "22222222-2222-4222-8222-222222222222",
    };
    db.selectOne.mockResolvedValue(paid);
    db.selectMany.mockResolvedValue([{ order_number: "TH-ONE", kind: "one_time", status: "paid", total_cents: 1000 }]);
    await expect(publicCartCheckoutStatus(paid.token, "session")).resolves.toMatchObject({ status: "paid", orders: [{ status: "paid" }] });
    db.selectOne.mockResolvedValue({ ...paid, expires_at: "2020-01-01T00:00:00Z" });
    await expect(publicCartCheckoutStatus(paid.token, "session")).rejects.toMatchObject({ status: 410 });
  });

  it("revokes an unpaid cart and clears its session", async () => {
    db.selectOne.mockResolvedValue(row);
    const result = await revokePrebuiltCart("office-1", row.id);
    expect(result.status).toBe("revoked");
    expect(db.update).toHaveBeenCalledWith("billing_prebuilt_carts", expect.any(String), { status: "revoked", session_hash: null });
  });

  it("does not mark a mixed-result cart paid and exposes partial", async () => {
    const mixed = [
      { id: "order-1", status: "paid", paid_at: "2026-01-02T00:00:00Z", order_number: "TH-ONE", kind: "one_time" },
      { id: "order-2", status: "failed", paid_at: null, order_number: "TH-TWO", kind: "subscription_initial" },
    ];
    db.selectMany.mockResolvedValue(mixed);
    const value = await toPrebuiltCart({
      ...row, status: "checkout", quote: { groups: [{}, {}] }, cart_id: "22222222-2222-4222-8222-222222222222",
    });
    expect(value).toMatchObject({ status: "checkout", partial: true });
    expect(db.update).not.toHaveBeenCalledWith("billing_prebuilt_carts", expect.anything(), expect.objectContaining({ status: "paid" }));
  });

  it("lets revoke win a race with verify", async () => {
    const open = { ...row, verification_id: "33333333-3333-4333-8333-333333333333" };
    db.selectOne.mockResolvedValueOnce(open).mockResolvedValueOnce({ ...open, status: "revoked", session_hash: null });
    db.update.mockResolvedValueOnce(null);
    auth.checkCode.mockResolvedValue(true);
    await expect(verifyCartCode(open.token, open.verification_id, "123456")).rejects.toMatchObject({ status: 410 });
    expect(db.update).toHaveBeenCalledWith("billing_prebuilt_carts", expect.stringContaining("status=eq.open"), expect.objectContaining({ status: "verified" }));
  });

  it("lets revoke win a race with checkout", async () => {
    const verified = { ...row, patient_id: "patient-1", status: "verified" as const, session_hash: sha256("session") };
    db.selectOne.mockResolvedValueOnce(verified).mockResolvedValueOnce({ ...verified, status: "revoked", session_hash: null });
    db.update.mockResolvedValueOnce(null);
    await expect(checkoutPrebuiltCart(verified.token, "session", {
      shipping_address: {} as any, payment_method_id: "pm_1",
    })).rejects.toMatchObject({ status: 410 });
    expect(checkoutCart).not.toHaveBeenCalled();
  });

  it("bumps only definite card failures when no order paid", async () => {
    const verified = { ...row, patient_id: "patient-1", status: "verified" as const, session_hash: sha256("session") };
    db.selectOne.mockImplementation(async (table: string) => table === "billing_prebuilt_carts" ? verified : null);
    checkoutCart.mockRejectedValue(new BillingCartError("Bad card.", 400, "payment_method_id"));
    await expect(checkoutPrebuiltCart(verified.token, "session", {
      shipping_address: {} as any, payment_method_id: "pm_bad",
    })).rejects.toThrow("Bad card.");
    expect(db.update).toHaveBeenCalledWith("billing_prebuilt_carts",
      expect.stringContaining("status=eq.checkout&checkout_attempt=eq.0"),
      expect.objectContaining({ status: "verified", checkout_attempt: 1, cart_id: null }));

    vi.clearAllMocks();
    db.selectMany.mockResolvedValue([]);
    db.selectOne.mockImplementation(async (table: string) => table === "billing_prebuilt_carts" ? verified : null);
    db.update.mockImplementation(async (_table, _query, patch) => ({ ...verified, ...patch }));
    checkoutCart.mockRejectedValue(new Error("socket hang up"));
    await expect(checkoutPrebuiltCart(verified.token, "session", {
      shipping_address: {} as any, payment_method_id: "pm_1",
    })).rejects.toThrow("socket hang up");
    expect(db.update).not.toHaveBeenCalledWith("billing_prebuilt_carts",
      expect.stringContaining("checkout_attempt=eq.0"), expect.objectContaining({ checkout_attempt: 1 }));
  });

  it("keeps the same attempt after a definite failure when any order paid", async () => {
    const verified = { ...row, patient_id: "patient-1", status: "verified" as const, session_hash: sha256("session") };
    db.selectOne.mockImplementation(async (table: string) => table === "billing_prebuilt_carts"
      ? verified : { status: "paid" });
    checkoutCart.mockResolvedValue({ status: "failed", cart_id: "cart-1", items: [], stripe_account_id: "acct", publishable_key: "pk", sandbox: true });
    await checkoutPrebuiltCart(verified.token, "session", { shipping_address: {} as any, payment_method_id: "pm_bad" });
    expect(db.update).not.toHaveBeenCalledWith("billing_prebuilt_carts",
      expect.stringContaining("checkout_attempt=eq.0"), expect.objectContaining({ checkout_attempt: 1 }));
  });

  it("binds a patient-less cart to verified phone, never a patient payer sharing the email", async () => {
    const verified = {
      ...row, status: "verified" as const, session_hash: sha256("session"),
      verification_id: "33333333-3333-4333-8333-333333333333",
    };
    db.selectOne.mockImplementation(async (table: string) => table === "billing_prebuilt_carts" ? verified : null);
    admin.mockResolvedValue({
      status: 200, contentRange: null, json: [{
        id: verified.verification_id, purpose: "cart_pay", identifier_kind: "phone", identifier: "+15125550100",
        verified_at: "2026-01-01T00:00:00Z",
      }],
    });
    checkoutCart.mockResolvedValue({ status: "requires_action", cart_id: "cart-1", items: [], stripe_account_id: "acct", publishable_key: "pk", sandbox: true });
    await checkoutPrebuiltCart(verified.token, "session", {
      shipping_address: {} as any, payment_method_id: "pm_1",
      payer: { name: "Guest", email: "patient-b@example.com", phone: "ignored" },
    });
    expect(db.selectOne).toHaveBeenCalledWith("billing_payers", expect.stringContaining("patient_id=is.null&phone=eq.%2B15125550100"));
    expect(db.selectOne).not.toHaveBeenCalledWith("billing_payers", expect.stringContaining("email=eq."));
    expect(db.insert).toHaveBeenCalledWith("billing_payers", expect.objectContaining({
      patient_id: null, email: "patient-b@example.com", phone: "+15125550100",
    }));
    expect(checkoutCart).toHaveBeenCalledWith(expect.objectContaining({
      patientId: null, resolvedPayer: expect.objectContaining({ id: "payer-new", patient_id: null }),
    }));
  });
});