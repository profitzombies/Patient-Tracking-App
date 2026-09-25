import { describe, expect, it, vi } from "vitest";
import { checkLaunchReadiness, REQUIRED_CONNECT_EVENTS, type ReadinessDeps } from "./launch-readiness";
import { BILLING_WEBHOOK_EVENTS } from "../billing/webhook-endpoints";
import { BillingConfigError } from "../billing/stripe-client";

const ORIGIN = "https://app.example.test";

function goodEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    OPERATIONS_APP_URL: ORIGIN,
    PATIENT_INVITE_URL: `${ORIGIN}/thinnr-mobile/`,
    RESEND_API_KEY: "re_test",
    CLAIM_EMAIL_FROM: "THINNR <no-reply@mail.example.test>",
    CLAIM_EMAIL_DELIVERY_MODE: "live",
    CLAIM_SMS_DELIVERY_MODE: "live",
    TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok", TWILIO_VERIFY_SERVICE_SID: "VA1",
  };
  for (const mode of ["LIVE", "TEST"]) {
    env[`STRIPE_${mode}_CONNECT_CLIENT_ID`] = "ca_abc123";
    env[`STRIPE_${mode}_PLATFORM_WEBHOOK_SECRET`] = "whsec_p";
    env[`STRIPE_${mode}_CONNECT_WEBHOOK_SECRET`] = "whsec_c";
  }
  return env;
}

function endpointsFor(mode: "live" | "test", overrides: Partial<Record<"platform" | "connect", Record<string, unknown> | null>> = {}) {
  return (["platform", "connect"] as const).flatMap((kind) => {
    if (overrides[kind] === null) return [];
    return [{
      url: `${ORIGIN}/api/billing/webhooks/${mode}/${kind}`, status: "enabled", application: kind === "connect" ? "ca_test" : null,
      enabled_events: [...BILLING_WEBHOOK_EVENTS[kind], ...(kind === "connect" ? ["account.application.deauthorized"] : [])],
      ...overrides[kind],
    }];
  });
}

function deps(over: Partial<ReadinessDeps> & { endpoints?: Record<"live" | "test", unknown[]> } = {}) {
  const endpoints = over.endpoints ?? { live: endpointsFor("live"), test: endpointsFor("test") };
  const list = { live: vi.fn(async () => ({ data: endpoints.live })), test: vi.fn(async () => ({ data: endpoints.test })) };
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://api.resend.com/domains")) {
      return new Response(JSON.stringify({ data: [{ name: "mail.example.test", status: "verified" }] }), { status: 200 });
    }
    if (url.startsWith("https://verify.twilio.com/")) return new Response("{}", { status: 200 });
    return new Response("", { status: 404 });
  });
  const base: ReadinessDeps = {
    env: goodEnv(),
    fetch: fetchMock as unknown as typeof fetch,
    billingMode: async () => ({ mode: "live" }),
    credentials: async () => ({}),
    stripe: async (mode) => ({ webhookEndpoints: { list: list[mode] } }) as never,
    origin: () => ORIGIN,
    now: () => new Date("2026-09-25T12:00:00Z"),
  };
  return { deps: { ...base, ...over }, fetchMock, list };
}

const byId = (result: Awaited<ReturnType<typeof checkLaunchReadiness>>, id: string) => {
  const check = result.checks.find((row) => row.id === id);
  if (!check) throw new Error(`missing check ${id}`);
  return check;
};

describe("provider launch readiness", () => {
  it("passes a fully configured live setup, leaving only the manual OAuth confirmation", async () => {
    const { deps: d } = deps();
    const result = await checkLaunchReadiness(d);
    const notPass = result.checks.filter((check) => check.status !== "pass").map((check) => `${check.id}:${check.status}`);
    expect(notPass).toEqual(["live_oauth_redirect:manual", "test_oauth_redirect:manual"]);
    expect(byId(result, "live_oauth_redirect").copyValue).toBe(`${ORIGIN}/api/billing/oauth/callback`);
    expect(result.mode).toBe("live");
  });

  it("checks the patient invitation app link the way the published site reads it", async () => {
    const pass = byId(await checkLaunchReadiness(deps().deps), "patient_app_url");
    expect(pass).toMatchObject({ section: "app", status: "pass", copyValue: `${ORIGIN}/thinnr-mobile/` });

    // Missing: the workspace's Expo preview does not count, and the fix offers the Expo Go page.
    const missingEnv: NodeJS.ProcessEnv = { ...goodEnv(), REPLIT_EXPO_DEV_DOMAIN: "abc.expo.worf.replit.dev" };
    delete missingEnv.PATIENT_INVITE_URL;
    const missing = byId(await checkLaunchReadiness(deps({ env: missingEnv }).deps), "patient_app_url");
    expect(missing.status).toBe("fail");
    expect(missing.fix).toContain("PATIENT_INVITE_URL");
    expect(missing.copyValue).toBe(`${ORIGIN}/thinnr-mobile/`);

    const devEnv = { ...goodEnv(), PATIENT_INVITE_URL: "https://abc.expo.worf.replit.dev" };
    const dev = byId(await checkLaunchReadiness(deps({ env: devEnv }).deps), "patient_app_url");
    expect(dev.status).toBe("fail");
    expect(dev.detail).toContain("development preview");

    const badEnv = { ...goodEnv(), PATIENT_INVITE_URL: "http://app.example.test/thinnr-mobile/" };
    expect(byId(await checkLaunchReadiness(deps({ env: badEnv }).deps), "patient_app_url").status).toBe("fail");
  });

  it("only reads vendor state: webhook lists and GET requests, never writes", async () => {
    const { deps: d, fetchMock, list } = deps();
    await checkLaunchReadiness(d);
    expect(list.live).toHaveBeenCalledWith({ limit: 100 });
    for (const call of fetchMock.mock.calls as unknown as Array<[unknown, RequestInit | undefined]>) {
      expect(call[1]?.method ?? "GET").toBe("GET");
      expect(call[1]?.body).toBeUndefined();
    }
  });

  it("warns in test mode and flags missing app URL and mismatched origins", async () => {
    const env = goodEnv();
    delete env.OPERATIONS_APP_URL;
    const { deps: d } = deps({ env, billingMode: async () => ({ mode: "test" }) });
    const result = await checkLaunchReadiness(d);
    expect(byId(result, "billing_mode").status).toBe("warn");
    expect(byId(result, "app_url").status).toBe("fail");

    const env2 = goodEnv();
    env2.OPERATIONS_APP_URL = "https://other.example.test";
    const mismatch = await checkLaunchReadiness(deps({ env: env2 }).deps);
    expect(byId(mismatch, "billing_origin").status).toBe("fail");
    const dev = { ...goodEnv(), OPERATIONS_APP_URL: "https://abc.worf.replit.dev" };
    expect(byId(await checkLaunchReadiness(deps({ env: dev }).deps), "app_url").status).toBe("fail");
  });

  it("fails a missing live Connect webhook with the URL to register", async () => {
    const { deps: d } = deps({ endpoints: { live: endpointsFor("live", { connect: null }), test: endpointsFor("test") } });
    const check = byId(await checkLaunchReadiness(d), "live_webhook_connect");
    expect(check.status).toBe("fail");
    expect(check.copyValue).toBe(`${ORIGIN}/api/billing/webhooks/live/connect`);
    expect(check.fix).toContain("STRIPE_LIVE_CONNECT_WEBHOOK_SECRET");
  });

  it.each(REQUIRED_CONNECT_EVENTS)("fails a Connect endpoint missing %s", async (event) => {
    const events = [...BILLING_WEBHOOK_EVENTS.connect, "account.application.deauthorized"].filter((name) => name !== event);
    const { deps: d } = deps({ endpoints: { live: endpointsFor("live", { connect: { enabled_events: events } }), test: endpointsFor("test") } });
    const check = byId(await checkLaunchReadiness(d), "live_webhook_connect");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain(event);
  });

  it("accepts wildcard endpoints, flags disabled ones, and warns on missing recommended events", async () => {
    const wildcard = await checkLaunchReadiness(deps({ endpoints: { live: endpointsFor("live", { connect: { enabled_events: ["*"] } }), test: endpointsFor("test") } }).deps);
    expect(byId(wildcard, "live_webhook_connect").status).toBe("pass");
    const disabled = await checkLaunchReadiness(deps({ endpoints: { live: endpointsFor("live", { platform: { status: "disabled" } }), test: endpointsFor("test") } }).deps);
    expect(byId(disabled, "live_webhook_platform").status).toBe("fail");
    const partial = await checkLaunchReadiness(deps({ endpoints: { live: endpointsFor("live", { connect: { enabled_events: [...REQUIRED_CONNECT_EVENTS] } }), test: endpointsFor("test") } }).deps);
    expect(byId(partial, "live_webhook_connect").status).toBe("warn");
  });

  it("fails when keys cannot be verified and does not list endpoints", async () => {
    const { deps: d, list } = deps({ stripe: async () => { throw new BillingConfigError("STRIPE_LIVE_PLATFORM_ACCOUNT_ID is invalid."); } });
    const result = await checkLaunchReadiness(d);
    expect(byId(result, "live_keys")).toMatchObject({ status: "fail", detail: "STRIPE_LIVE_PLATFORM_ACCOUNT_ID is invalid." });
    expect(byId(result, "live_webhook_connect").status).toBe("fail");
    expect(list.live).not.toHaveBeenCalled();
  });

  it("checks Connect client ID presence and format", async () => {
    const env = { ...goodEnv(), STRIPE_LIVE_CONNECT_CLIENT_ID: "", STRIPE_TEST_CONNECT_CLIENT_ID: "sk_nope" };
    const result = await checkLaunchReadiness(deps({ env }).deps);
    expect(byId(result, "live_connect_client").status).toBe("fail");
    expect(byId(result, "test_connect_client").status).toBe("fail");
  });

  it("reports email domain and SMS problems in plain language", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("resend")) return new Response(JSON.stringify({ data: [{ name: "mail.example.test", status: "pending" }] }), { status: 200 });
      return new Response("{}", { status: 404 });
    });
    const result = await checkLaunchReadiness(deps({ fetch: fetchMock as unknown as typeof fetch }).deps);
    expect(byId(result, "email_domain")).toMatchObject({ status: "fail" });
    expect(byId(result, "sms_verify").detail).toContain("no Verify service");

    const restricted = vi.fn(async (input: string | URL | Request) =>
      String(input).includes("resend") ? new Response(JSON.stringify({ name: "restricted_api_key" }), { status: 401 }) : new Response("{}", { status: 200 }));
    expect(byId(await checkLaunchReadiness(deps({ fetch: restricted as unknown as typeof fetch }).deps), "email_domain").status).toBe("manual");
  });

  it("never echoes vendor error text or a malformed app URL", async () => {
    const leak = "sk_live_LEAKED123 https://user:pass@host";
    const env = { ...goodEnv(), OPERATIONS_APP_URL: "http://user:pass@bad host" };
    const vendorFail = vi.fn(async () => { throw Object.assign(new Error(leak), { code: "ECONNRESET" }); });
    const { deps: d } = deps({
      env,
      stripe: async () => { throw Object.assign(new Error(leak), { type: "StripeAuthenticationError" }); },
      fetch: vendorFail as unknown as typeof fetch,
    });
    const result = await checkLaunchReadiness(d);
    const text = JSON.stringify(result);
    expect(text).not.toContain("LEAKED");
    expect(text).not.toContain("user:pass");
    expect(byId(result, "live_keys").detail).toBe("Stripe keys could not be verified. (StripeAuthenticationError)");
    expect(byId(result, "email_domain").detail).toContain("(ECONNRESET)");
  });

  it("fails a webhook endpoint registered for the wrong event source", async () => {
    const swapped = await checkLaunchReadiness(deps({ endpoints: {
      live: endpointsFor("live", { connect: { application: null }, platform: { application: "ca_123" } }), test: endpointsFor("test"),
    } }).deps);
    expect(byId(swapped, "live_webhook_connect")).toMatchObject({ status: "fail" });
    expect(byId(swapped, "live_webhook_connect").detail).toContain("platform's own events");
    expect(byId(swapped, "live_webhook_platform").status).toBe("fail");
  });

  it("fails an invalid Resend key but only asks to confirm by hand for a send-only key", async () => {
    const invalid = vi.fn(async (input: string | URL | Request) =>
      String(input).includes("resend") ? new Response(JSON.stringify({ name: "validation_error" }), { status: 403 }) : new Response("{}", { status: 200 }));
    expect(byId(await checkLaunchReadiness(deps({ fetch: invalid as unknown as typeof fetch }).deps), "email_domain").status).toBe("fail");
  });

  it("never echoes secret values", async () => {
    const { deps: d } = deps();
    const text = JSON.stringify(await checkLaunchReadiness(d));
    for (const secret of ["re_test", "whsec_p", "whsec_c", "tok"]) expect(text).not.toContain(secret);
  });
});
