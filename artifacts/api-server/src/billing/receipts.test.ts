import { afterEach, describe, expect, it, vi } from "vitest";
import { sendShippedNotice } from "./receipts";

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
  });
});