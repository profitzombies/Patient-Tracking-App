import { afterEach, describe, expect, it, vi } from "vitest";
import { billingFromAddress, formatReceiptTimestamp, sendPaymentFailed, sendReceipt, sendShippedNotice } from "./receipts";

const originalFetch = global.fetch;
const originalKey = process.env.RESEND_API_KEY;
const originalFrom = process.env.CLAIM_EMAIL_FROM;

afterEach(() => {
  global.fetch = originalFetch;
  process.env.RESEND_API_KEY = originalKey;
  process.env.CLAIM_EMAIL_FROM = originalFrom;
});

describe("billing receipts", () => {
  it("does not fail fulfillment when email is not configured", async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.CLAIM_EMAIL_FROM;
    await expect(sendShippedNotice({
      order: { order_number: "TH-ABC123", carrier: "UPS", tracking_number: "1Z999" } as never,
      payer: { email: "patient@example.com" } as never,
      office: { office_name: "Harbor Health" } as never,
    })).resolves.toBeUndefined();
  });

  it("includes a recognized carrier tracking link", async () => {
    process.env.RESEND_API_KEY = "test";
    process.env.CLAIM_EMAIL_FROM = "THINNR <test@example.com>";
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response("{}", { status: 200 }));
    global.fetch = fetchMock as typeof fetch;
    await sendShippedNotice({
      order: { order_number: "TH-ABC123", carrier: "FedEx", tracking_number: "123456" } as never,
      payer: { email: "patient@example.com" } as never,
      office: { office_name: "Harbor Health" } as never,
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.text).toContain("fedex.com/fedextrack");
    expect(body.text).toContain("123456");
    expect(body.from).toBe("THINNR Weight Loss <test@example.com>");
    expect(body.subject).toBe("THINNR Order (TH-ABC123) has shipped");
    expect(body.html).toContain("<!doctype html>");
    expect(body.html).toContain("Track your package");
  });

  it("sends receipts from THINNR Weight Loss with the RECEIPT subject and an itemized styled body", async () => {
    process.env.RESEND_API_KEY = "test";
    process.env.CLAIM_EMAIL_FROM = "bare@example.com";
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response("{}", { status: 200 }));
    global.fetch = fetchMock as typeof fetch;
    await sendReceipt({
      order: {
        order_number: "TH-7K2Q9M", paid_at: "2026-09-14T19:24:00Z", created_at: "2026-09-14T19:23:00Z",
        subtotal_cents: 17997, shipping_charge_cents: 900, tax_cents: 0, total_cents: 18897,
        shipping_address: { name: "Riley Example", line1: "12 Harbor Lane", city: "Austin", state: "TX", postal_code: "78701", country: "US" },
      } as never,
      items: [
        { product_name_snapshot: "Control", quantity: 2, unit_price_cents: 5999 },
        { product_name_snapshot: "Balance", quantity: 1, unit_price_cents: 5999 },
      ] as never,
      payer: { name: "Riley Example", email: "patient@example.com" } as never,
      office: { office_name: "Harbor Health", email: "care@harbor.test" } as never,
      subscription: { cancel_token: "tok123" } as never,
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.from).toBe("THINNR Weight Loss <bare@example.com>");
    expect(body.subject).toBe("RECEIPT THINNR Order (TH-7K2Q9M) - Sep 14, 2026, 3:24 PM EDT");
    expect(body.html).toContain("Hello Riley,");
    expect(body.html).toContain("Control × 2");
    expect(body.html).toContain("$119.98");
    expect(body.html).toContain("$188.97");
    expect(body.html).toContain("/pay/cancel/tok123");
    expect(body.text).toContain("Ship to: Riley Example, 12 Harbor Lane, Austin, TX 78701, US");
    expect(body.text).toContain("care@harbor.test");
  });

  it("still sends a subscription receipt when the public origin is not configured", async () => {
    process.env.RESEND_API_KEY = "test";
    process.env.CLAIM_EMAIL_FROM = "bare@example.com";
    const origin = process.env.BILLING_PUBLIC_ORIGIN;
    const domains = process.env.REPLIT_DOMAINS;
    delete process.env.BILLING_PUBLIC_ORIGIN;
    delete process.env.REPLIT_DOMAINS;
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      await expect(sendReceipt({
        order: {
          order_number: "TH-7K2Q9M", paid_at: "2026-09-14T19:24:00Z", created_at: "2026-09-14T19:23:00Z",
          subtotal_cents: 5999, shipping_charge_cents: 0, tax_cents: 0, total_cents: 5999, shipping_address: {},
        } as never,
        items: [{ product_name_snapshot: "Control", quantity: 1, unit_price_cents: 5999 }] as never,
        payer: { name: "Riley Example", email: "patient@example.com" } as never,
        office: { office_name: "Harbor Health", email: "care@harbor.test" } as never,
        subscription: { cancel_token: "tok123" } as never,
      })).resolves.toBeUndefined();
      const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]?.body));
      expect(body.html).not.toContain("/pay/cancel/");
    } finally {
      if (origin !== undefined) process.env.BILLING_PUBLIC_ORIGIN = origin;
      if (domains !== undefined) process.env.REPLIT_DOMAINS = domains;
    }
  });
  it("sends a failed renewal link and automatic retry note", async () => {
    process.env.RESEND_API_KEY = "test";
    process.env.CLAIM_EMAIL_FROM = "bare@example.com";
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    await sendPaymentFailed({
      subscription: { id: "sub-1", cancel_token: "cancel-1" } as never,
      payer: { name: "Riley Example", email: "patient@example.com" } as never,
      productName: "Control",
      office: { office_name: "Harbor Health" } as never,
      amountCents: 6999,
      hostedInvoiceUrl: "https://invoice.stripe.com/i/test",
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]?.body));
    expect(body.subject).toBe("Your THINNR order payment did not go through");
    expect(body.html).toContain("Update card and pay");
    expect(body.text).toContain("Stripe will retry the payment automatically.");
    expect(body.text).toContain("https://invoice.stripe.com/i/test");
  });
  it("derives the from header and timestamp deterministically", () => {
    expect(billingFromAddress("THINNR Dashboard <hello@example.com>")).toBe("THINNR Weight Loss <hello@example.com>");
    expect(billingFromAddress("hello@example.com")).toBe("THINNR Weight Loss <hello@example.com>");
    expect(formatReceiptTimestamp("2026-01-05T15:05:00Z")).toBe("Jan 5, 2026, 10:05 AM EST");
    expect(formatReceiptTimestamp("garbage", new Date("2026-09-14T19:24:00Z"))).toBe("Sep 14, 2026, 3:24 PM EDT");
  });
});