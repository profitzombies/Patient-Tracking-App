import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __setEmailClientForTests,
  brandedFromAddress,
  createResendEmailClient,
  EmailNotConfiguredError,
  EmailPhiViolationError,
  EmailSendError,
  isEmailConfigured,
  RESEND_SEND_URL,
  sendTemplatedEmail,
  type OutboundEmail,
} from "./transport";

const originalFetch = global.fetch;
const shipped = { name: "Riley", orderNumber: "TH-1", officeName: "Harbor", carrier: "UPS", trackingNumber: "1Z", trackingLink: "https://track.example.test/1Z" };
const originalKey = process.env.RESEND_API_KEY;
const originalFrom = process.env.CLAIM_EMAIL_FROM;

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test";
  process.env.CLAIM_EMAIL_FROM = "THINNR <mail@example.test>";
});
afterEach(() => {
  global.fetch = originalFetch;
  process.env.RESEND_API_KEY = originalKey;
  process.env.CLAIM_EMAIL_FROM = originalFrom;
  __setEmailClientForTests(null);
  vi.restoreAllMocks();
});

describe("email transport", () => {
  it("is the single vendor path: renders through the templates library and posts one Resend request", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const result = await sendTemplatedEmail({ to: "riley@example.test", templateId: "verification-code", variables: { code: "123456" }, sender: "configured" });
    expect(result).toEqual({ messageId: "email-1", phiClass: "security", subject: "123456 is your THINNR verification code" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(RESEND_SEND_URL);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_test");
    const body = JSON.parse(String(init.body)) as OutboundEmail & { to: string[] };
    expect(body.from).toBe("THINNR <mail@example.test>");
    expect(body.to).toEqual(["riley@example.test"]);
    expect(body.subject).toContain("123456");
    expect(body.html).toContain("<!doctype html>");
    expect(body.text).toContain("123456");
  });

  it("brands billing and staff mail while sign-in mail keeps the configured sender verbatim", async () => {
    const sent: OutboundEmail[] = [];
    __setEmailClientForTests({ async send(message) { sent.push(message); return { id: null }; } });
    await sendTemplatedEmail({ to: "a@example.test", templateId: "order-shipped", variables: shipped });
    await sendTemplatedEmail({ to: "a@example.test", templateId: "password-changed", variables: { name: "Riley", when: "now", reportLink: "https://x" }, sender: "configured" });
    expect(sent.map((message) => message.from)).toEqual(["THINNR Weight Loss <mail@example.test>", "THINNR <mail@example.test>"]);
    expect(brandedFromAddress("bare@example.test")).toBe("THINNR Weight Loss <bare@example.test>");
  });

  it("fails loudly when credentials are missing and never touches the vendor", async () => {
    delete process.env.RESEND_API_KEY;
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    expect(isEmailConfigured()).toBe(false);
    await expect(sendTemplatedEmail({ to: "a@example.test", templateId: "verification-code", variables: { code: "1" } })).rejects.toBeInstanceOf(EmailNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses clinical variables and full patient names outside identity templates before rendering", async () => {
    const client = { send: vi.fn(async () => ({ id: "x" })) };
    __setEmailClientForTests(client);
    await expect(sendTemplatedEmail({
      to: "a@example.test", templateId: "order-shipped",
      variables: { ...shipped, medicationName: "Semaglutide" },
    })).rejects.toBeInstanceOf(EmailPhiViolationError);
    await expect(sendTemplatedEmail({
      to: "a@example.test", templateId: "staff-attention-digest",
      variables: { officeName: "Harbor", digestDate: "d", flaggedCount: "1", reasons: "x · 1 patient", alertsLink: "x", patientName: "Emma Smith" },
    })).rejects.toMatchObject({ name: "EmailPhiViolationError", variables: ["patientName"] });
    await expect(sendTemplatedEmail({
      to: "a@example.test", templateId: "verification-code", variables: { code: "1", currentWeight: "182" },
    })).rejects.toMatchObject({ variables: ["currentWeight"] });
    expect(client.send).not.toHaveBeenCalled();
    // The claim/invitation family may carry a full name: that is what it exists to deliver.
    await sendTemplatedEmail({
      to: "a@example.test", templateId: "patient-invitation", sender: "configured",
      variables: { name: "Riley", patientName: "Riley Example", providerName: "Avery", officeName: "Harbor", providerCode: "731942", phone: "(555) 014-2890", appLink: "https://x" },
    });
    expect(client.send).toHaveBeenCalledOnce();
  });

  it("surfaces vendor rejections as EmailSendError with the status", async () => {
    global.fetch = vi.fn(async () => new Response("nope", { status: 422 })) as unknown as typeof fetch;
    await expect(sendTemplatedEmail({ to: "a@example.test", templateId: "verification-code", variables: { code: "1" } })).rejects.toMatchObject({ name: "EmailSendError", status: 422 });
    const client = createResendEmailClient(() => "k");
    global.fetch = vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    await expect(client.send({ from: "a", to: "b", subject: "s", html: "h", text: "t" })).rejects.toBeInstanceOf(EmailSendError);
  });
});
