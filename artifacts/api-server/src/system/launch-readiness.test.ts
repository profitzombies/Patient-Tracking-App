import { describe, expect, it, vi } from "vitest";
import { checkLaunchReadiness, REQUIRED_CONNECT_EVENTS, type ReadinessDeps } from "./launch-readiness";
import { BILLING_WEBHOOK_EVENTS, EXPECTED_STRIPE_API_VERSION } from "../billing/webhook-endpoints";
import { BillingConfigError } from "../billing/stripe-client";
import { warehouseCraftConfig } from "../shipping/warehousecraft";

const ORIGIN = "https://app.example.test";
const WAREHOUSE = "https://wc.example.test";
const WAREHOUSE_AUTH = "Basic d2hzZWNyZXQ=";
const TEST_LOGIN = { NOVEX_API_BASE_URL: "https://novex.example.test", NOVEX_API_USERNAME: "novex-user", NOVEX_API_PASSWORD: "novex-pass" };
const LIVE_LOGIN = { WAREHOUSECRAFT_API_BASE_URL: "https://live.example.test", WAREHOUSECRAFT_API_USERNAME: "live-user", WAREHOUSECRAFT_API_PASSWORD: "live-pass" };
const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

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
      // Destinations created for this server are pinned to its API version.
      api_version: EXPECTED_STRIPE_API_VERSION,
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
    warehouse: () => ({ orderApiBaseUrl: WAREHOUSE, authorization: WAREHOUSE_AUTH }),
    catalogGaps: async () => [],
    storeLinks: async () => ({ appStoreUrl: null, googlePlayUrl: null }),
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

  it("prefers HQ's store links over the Expo Go page once they are entered", async () => {
    const APP_STORE = "https://apps.apple.com/us/app/thinnr/id6740000001";
    const PLAY = "https://play.google.com/store/apps/details?id=com.thinnr.app";
    const both = byId(await checkLaunchReadiness(deps({ storeLinks: async () => ({ appStoreUrl: APP_STORE, googlePlayUrl: PLAY }) }).deps), "patient_app_url");
    expect(both).toMatchObject({ status: "pass", copyValue: APP_STORE });
    expect(both.detail).toContain(PLAY);
    expect(both.detail).not.toContain("testing link");

    // A TestFlight link counts as the interim App Store link; the missing Play
    // link falls back to the Expo Go page while it is configured.
    const interim = byId(await checkLaunchReadiness(deps({ storeLinks: async () => ({ appStoreUrl: "https://testflight.apple.com/join/AbCdEf12", googlePlayUrl: null }) }).deps), "patient_app_url");
    expect(interim.status).toBe("pass");
    expect(interim.detail).toContain("testing link");
    expect(interim.detail).toContain(`Expo Go page (${ORIGIN}/thinnr-mobile/)`);

    // Without an Expo Go page the other platform has no install path: a warning, never a dead link.
    const noExpo: NodeJS.ProcessEnv = { ...goodEnv() };
    delete noExpo.PATIENT_INVITE_URL;
    const oneOnly = byId(await checkLaunchReadiness(deps({ env: noExpo, storeLinks: async () => ({ appStoreUrl: APP_STORE, googlePlayUrl: null }) }).deps), "patient_app_url");
    expect(oneOnly.status).toBe("warn");
    expect(oneOnly.fix).toContain("Google Play");

    // Unreadable settings keep the Expo Go answer and say so.
    const unreadable = byId(await checkLaunchReadiness(deps({ storeLinks: async () => { throw new Error("down"); } }).deps), "patient_app_url");
    expect(unreadable.status).toBe("pass");
    expect(unreadable.detail).toContain("could not be read");
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
    for (const secret of ["re_test", "whsec_p", "whsec_c", "tok", WAREHOUSE_AUTH, "d2hzZWNyZXQ"]) expect(text).not.toContain(secret);
  });

  it("fails a platform endpoint without the office-access events and lists the exact events to add", async () => {
    const result = await checkLaunchReadiness(deps({ endpoints: {
      live: endpointsFor("live", { platform: { enabled_events: ["account.application.deauthorized"] }, connect: null }), test: endpointsFor("test"),
    } }).deps);
    const platform = byId(result, "live_webhook_platform");
    expect(platform.status).toBe("fail");
    expect(platform.detail).toContain("payment_intent.succeeded, payment_intent.payment_failed, charge.dispute.created, setup_intent.succeeded, setup_intent.setup_failed");
    const connect = byId(result, "live_webhook_connect");
    for (const event of [...BILLING_WEBHOOK_EVENTS.connect, "account.application.deauthorized"]) expect(connect.fix).toContain(event);
    expect(connect.fix).toContain(EXPECTED_STRIPE_API_VERSION);
  });

  it("fails an endpoint pinned to an older API version and explains the replacement", async () => {
    const result = await checkLaunchReadiness(deps({ endpoints: {
      live: endpointsFor("live", { platform: { api_version: "2025-08-27.basil" } }), test: endpointsFor("test"),
    } }).deps);
    const check = byId(result, "live_webhook_platform");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("2025-08-27.basil");
    expect(check.detail).not.toContain("account default");
    expect(check.fix).toContain(`API version ${EXPECTED_STRIPE_API_VERSION}`);
    expect(check.fix).toContain("STRIPE_LIVE_PLATFORM_WEBHOOK_SECRET");
    expect(check.fix).toContain("delete the old endpoint");
    expect(check.copyValue).toBe(`${ORIGIN}/api/billing/webhooks/live/platform`);
    expect(byId(result, "live_webhook_connect").status).toBe("pass");
  });

  it("judges unpinned endpoints by the account's own event version", async () => {
    const eventsList = vi.fn(async () => ({ data: [{ api_version: "2025-08-27.basil" }] }));
    const lists = { live: endpointsFor("live", { platform: { api_version: null }, connect: { api_version: null } }), test: endpointsFor("test") };
    const { deps: d } = deps({
      stripe: async (mode) => ({ webhookEndpoints: { list: async () => ({ data: lists[mode] }) }, events: { list: eventsList } }) as never,
    });
    const result = await checkLaunchReadiness(d);
    expect(byId(result, "live_webhook_connect")).toMatchObject({ status: "fail" });
    expect(byId(result, "live_webhook_connect").detail).toContain("(the account default)");
    expect(eventsList).toHaveBeenCalledWith({ limit: 1 });
  });

  it("asks for a manual check, never a pass, when an unpinned endpoint's version cannot be read", async () => {
    const eventsList = vi.fn(async () => ({ data: [] }));
    const lists = { live: endpointsFor("live", { connect: { api_version: null } }), test: endpointsFor("test") };
    const { deps: d } = deps({
      stripe: async (mode) => ({ webhookEndpoints: { list: async () => ({ data: lists[mode] }) }, events: { list: eventsList } }) as never,
    });
    const result = await checkLaunchReadiness(d);
    const check = byId(result, "live_webhook_connect");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain(`could not be compared with ${EXPECTED_STRIPE_API_VERSION}`);
    expect(check.fix).toContain(`confirm its API version is ${EXPECTED_STRIPE_API_VERSION}`);
    expect(check.fix).toContain("STRIPE_LIVE_CONNECT_WEBHOOK_SECRET");
    expect(check.copyValue).toBe(`${ORIGIN}/api/billing/webhooks/live/connect`);
    expect(byId(result, "live_webhook_platform").status).toBe("pass");
    // Without an events reader at all the result is the same.
    const noEvents = await checkLaunchReadiness(deps({ endpoints: { live: endpointsFor("live", { connect: { api_version: "" } }), test: endpointsFor("test") } }).deps);
    expect(byId(noEvents, "live_webhook_connect").status).toBe("warn");
  });

  describe("warehouse", () => {
    it("checks the connection with one read-only status lookup", async () => {
      const { deps: d, fetchMock } = deps();
      const result = await checkLaunchReadiness(d);
      expect(byId(result, "warehouse_connection")).toMatchObject({ section: "warehouse", status: "pass" });
      const call = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).find(([url]) => String(url).startsWith(WAREHOUSE));
      expect(call?.[0]).toBe(`${WAREHOUSE}/api/OrderStatusDatas?clientOrderId=THINNR-READINESS-PROBE`);
      expect(call?.[1].method ?? "GET").toBe("GET");
      expect((call?.[1].headers as Record<string, string>).Authorization).toBe(WAREHOUSE_AUTH);
    });

    it("fails missing or rejected credentials and unexpected answers", async () => {
      const missing = await checkLaunchReadiness(deps({ warehouse: () => ({ orderApiBaseUrl: WAREHOUSE, authorization: null }) }).deps);
      expect(byId(missing, "warehouse_connection")).toMatchObject({ status: "fail" });
      // Development is on the test tenant, so the fix names the test login.
      expect(byId(missing, "warehouse_connection").fix).toContain("NOVEX_API_USERNAME");
      expect(byId(missing, "warehouse_connection").fix).not.toContain("WAREHOUSECRAFT_API_USERNAME");
      const answer = (status: number) => vi.fn(async (input: string | URL | Request) => String(input).startsWith(WAREHOUSE)
        ? new Response("", { status }) : new Response(JSON.stringify({ data: [{ name: "mail.example.test", status: "verified" }] }), { status: 200 }));
      const rejected = await checkLaunchReadiness(deps({ fetch: answer(401) as unknown as typeof fetch }).deps);
      expect(byId(rejected, "warehouse_connection")).toMatchObject({ status: "fail", detail: "WarehouseCraft rejected the test login (NOVEX_API_*)." });
      const broken = await checkLaunchReadiness(deps({ fetch: answer(500) as unknown as typeof fetch }).deps);
      expect(byId(broken, "warehouse_connection")).toMatchObject({ status: "fail", detail: "WarehouseCraft answered the status lookup with HTTP 500." });
    });

    it("keeps development on the test tenant", async () => {
      expect(byId(await checkLaunchReadiness(deps().deps), "warehouse_tenant").status).toBe("pass");
      const env = { ...goodEnv(), WAREHOUSECRAFT_TENANT_MODE: "live" };
      const dev = byId(await checkLaunchReadiness(deps({ env }).deps), "warehouse_tenant");
      expect(dev.status).toBe("fail");
      expect(dev.fix).toContain("Remove WAREHOUSECRAFT_TENANT_MODE from the development environment");
      const devLive = byId(await checkLaunchReadiness(deps({ env: { ...env, ...LIVE_LOGIN } }).deps), "warehouse_tenant");
      expect(devLive).toMatchObject({ status: "fail", detail: "This development copy is set to the live warehouse tenant, so real orders could ship from development." });
    });

    it("sends real orders from the published app only once it is on the live tenant", async () => {
      const published = { ...goodEnv(), REPLIT_DEPLOYMENT: "1" };
      const liveTenant = { ...published, ...LIVE_LOGIN, WAREHOUSECRAFT_TENANT_MODE: "live" };
      expect(byId(await checkLaunchReadiness(deps({ env: liveTenant }).deps), "warehouse_tenant").status).toBe("pass");
      const heldLive = byId(await checkLaunchReadiness(deps({ env: published }).deps), "warehouse_tenant");
      expect(heldLive.status).toBe("fail");
      expect(heldLive.fix).toContain("WAREHOUSECRAFT_TENANT_MODE=live");
      const testMode = byId(await checkLaunchReadiness(deps({ env: published, billingMode: async () => ({ mode: "test" }) }).deps), "warehouse_tenant");
      expect(testMode.status).toBe("warn");
      const unreadable = byId(await checkLaunchReadiness(deps({ env: published, billingMode: async () => { throw new Error("db down"); } }).deps), "warehouse_tenant");
      expect(unreadable.status).toBe("warn");
    });

    it("is live only with the flag and the complete live login, and probes with exactly that tenant's login", async () => {
      const published = { ...goodEnv(), REPLIT_DEPLOYMENT: "1", ...TEST_LOGIN };
      const probeOf = (fetchMock: ReturnType<typeof deps>["fetchMock"]) =>
        (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).filter(([url]) => String(url).includes("/api/OrderStatusDatas"));

      // The flag with only the test login: real orders stay held, the missing names are listed, and the probe stays on the test tenant.
      const flagOnly = deps({ env: { ...published, WAREHOUSECRAFT_TENANT_MODE: "live" }, warehouse: warehouseCraftConfig });
      const flagResult = await checkLaunchReadiness(flagOnly.deps);
      const held = byId(flagResult, "warehouse_tenant");
      expect(held.status).toBe("fail");
      expect(held.detail).toContain("the live WarehouseCraft login is incomplete (WAREHOUSECRAFT_API_BASE_URL, WAREHOUSECRAFT_API_USERNAME, WAREHOUSECRAFT_API_PASSWORD not set)");
      expect(held.fix).toContain("Save WAREHOUSECRAFT_API_BASE_URL, WAREHOUSECRAFT_API_USERNAME, WAREHOUSECRAFT_API_PASSWORD for the published app");
      expect(byId(flagResult, "warehouse_connection")).toMatchObject({ status: "pass", detail: "Signed in to the test warehouse tenant with its test login (NOVEX_API_*) using a read-only status lookup." });
      expect(probeOf(flagOnly.fetchMock)).toHaveLength(1);
      expect(probeOf(flagOnly.fetchMock)[0][0]).toBe("https://novex.example.test/api/OrderStatusDatas?clientOrderId=THINNR-READINESS-PROBE");
      expect((probeOf(flagOnly.fetchMock)[0][1].headers as Record<string, string>).Authorization).toBe(basic("novex-user", "novex-pass"));
      // A partial live login is still incomplete and names only what is missing.
      const partial = await checkLaunchReadiness(deps({ env: { ...published, ...LIVE_LOGIN, WAREHOUSECRAFT_API_PASSWORD: "", WAREHOUSECRAFT_TENANT_MODE: "live" }, warehouse: warehouseCraftConfig }).deps);
      expect(byId(partial, "warehouse_tenant").detail).toContain("(WAREHOUSECRAFT_API_PASSWORD not set)");

      // The complete live login with the flag: live tenant, probed with the live login only.
      const complete = deps({ env: { ...published, ...LIVE_LOGIN, WAREHOUSECRAFT_TENANT_MODE: "live" }, warehouse: warehouseCraftConfig });
      const completeResult = await checkLaunchReadiness(complete.deps);
      expect(byId(completeResult, "warehouse_tenant").status).toBe("pass");
      expect(byId(completeResult, "warehouse_connection")).toMatchObject({ status: "pass", detail: "Signed in to the live warehouse tenant with its live login (WAREHOUSECRAFT_API_*) using a read-only status lookup." });
      expect(probeOf(complete.fetchMock)).toHaveLength(1);
      expect(probeOf(complete.fetchMock)[0][0]).toBe("https://live.example.test/api/OrderStatusDatas?clientOrderId=THINNR-READINESS-PROBE");
      expect((probeOf(complete.fetchMock)[0][1].headers as Record<string, string>).Authorization).toBe(basic("live-user", "live-pass"));

      // A saved live login without the flag is not used: the test tenant keeps its own login.
      const noFlag = deps({ env: { ...published, ...LIVE_LOGIN }, warehouse: warehouseCraftConfig });
      await checkLaunchReadiness(noFlag.deps);
      expect(probeOf(noFlag.fetchMock)[0][0]).toBe("https://novex.example.test/api/OrderStatusDatas?clientOrderId=THINNR-READINESS-PROBE");
      expect((probeOf(noFlag.fetchMock)[0][1].headers as Record<string, string>).Authorization).toBe(basic("novex-user", "novex-pass"));
    });

    it("fails products without a SKU and warns about missing weights, naming at most five", async () => {
      const names = ["A", "B", "C", "D", "E", "F", "G"];
      const noSku = await checkLaunchReadiness(deps({ catalogGaps: async () => names.map((name) => ({ name, missingSku: true, missingWeight: name === "A" })) }).deps);
      const catalog = byId(noSku, "warehouse_catalog");
      expect(catalog.status).toBe("fail");
      expect(catalog.detail).toBe("7 active products have no WarehouseCraft SKU, so their orders cannot be sent to the warehouse: A, B, C, D, E and 2 more. 1 also lacks a shipping weight.");
      const noWeight = await checkLaunchReadiness(deps({ catalogGaps: async () => [{ name: "Fiber", missingSku: false, missingWeight: true }] }).deps);
      expect(byId(noWeight, "warehouse_catalog")).toMatchObject({ status: "warn", detail: "1 active product has no shipping weight, so shipping falls back to the flat charge: Fiber." });
      const failed = await checkLaunchReadiness(deps({ catalogGaps: async () => { throw new Error("secret detail"); } }).deps);
      expect(byId(failed, "warehouse_catalog")).toMatchObject({ status: "fail", detail: "The product catalog could not be read." });
    });
  });
});
