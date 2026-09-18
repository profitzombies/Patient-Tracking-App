import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSigner, type FakeSigner } from "./testing/fake-jwt";
import { resetAccessTokenVerifierForTests } from "./access-token";
import { identifyBearer } from "./identify";
import { setAuthLookupRetryDelayForTests } from "../lib/supabase-admin";

const SUPABASE_URL = "https://fake.supabase.local";
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const USER = "8f3a0a8e-2a7e-4d2e-9b1e-0f0a7a2d1c11";
const SESSION = "3a5f2c1e-8d4b-4f2a-9c6e-1b2d3e4f5a6b";

let signer: FakeSigner;
const calls: string[] = [];
const revoked = new Set<string>();
let revocationsStatus = 200;
/** Scripted answers for /auth/v1/user, consumed in order. */
let authUserScript: Array<number | "timeout"> = [];
const realFetch = globalThis.fetch;

beforeAll(() => {
  process.env.SUPABASE_URL = SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  signer = createFakeSigner({ kid: "kid-a", issuer: ISSUER });
  setAuthLookupRetryDelayForTests(async () => {});
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    calls.push(url.pathname);
    if (url.pathname === "/auth/v1/.well-known/jwks.json") return Response.json(signer.jwks());
    if (url.pathname === "/rest/v1/auth_session_revocations") {
      if (revocationsStatus !== 200) return new Response("down", { status: revocationsStatus });
      const id = (url.searchParams.get("session_id") ?? "").replace(/^eq\./, "");
      return Response.json(revoked.has(id) ? [{ session_id: id }] : []);
    }
    if (url.pathname === "/auth/v1/user") {
      const next = authUserScript.shift() ?? 200;
      if (next === "timeout") throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      if (next !== 200) return new Response("{}", { status: next });
      return Response.json({ id: USER, email: "pat@example.com", phone: null });
    }
    throw new Error(`unexpected fetch ${href}`);
  });
});

afterAll(() => {
  vi.stubGlobal("fetch", realFetch);
  setAuthLookupRetryDelayForTests(null);
});

beforeEach(() => {
  resetAccessTokenVerifierForTests();
  calls.length = 0;
  revoked.clear();
  revocationsStatus = 200;
  authUserScript = [];
});

const authUserCalls = () => calls.filter((path) => path === "/auth/v1/user").length;

describe("identifyBearer", () => {
  it("identifies a genuine token locally: JWKS + revocation lookup, no /auth/v1/user", async () => {
    const user = await identifyBearer(signer.sign({ sub: USER, session_id: SESSION, email: "pat@example.com" }), "local");
    expect(user).toEqual({ id: USER, email: "pat@example.com", phone: null, sessionId: SESSION, verifiedBy: "local" });
    expect(authUserCalls()).toBe(0);
    expect(calls.filter((path) => path === "/rest/v1/auth_session_revocations")).toHaveLength(1);
  });

  it("refuses a revoked session immediately and never asks GoTrue about a provably bad token", async () => {
    revoked.add(SESSION);
    expect(await identifyBearer(signer.sign({ sub: USER, session_id: SESSION }), "local")).toBeNull();
    const expired = signer.sign({ sub: USER, session_id: SESSION }, { nowSeconds: Math.floor(Date.now() / 1000) - 9000 });
    expect(await identifyBearer(expired, "local")).toBeNull();
    expect(authUserCalls()).toBe(0);
  });

  it("treats a revocation-list outage as 'cannot tell', not as signed out", async () => {
    revocationsStatus = 503;
    await expect(identifyBearer(signer.sign({ sub: USER, session_id: SESSION }), "local")).rejects.toThrow(/revocation lookup failed/);
  });

  it("goes remote for the remote mode, for unverifiable tokens, and for tokens without a session id", async () => {
    const token = signer.sign({ sub: USER, session_id: SESSION });
    expect((await identifyBearer(token, "remote"))?.verifiedBy).toBe("remote");
    expect(authUserCalls()).toBe(1);
    // The list is authoritative on the remote path too (GoTrue vouched for the session claim).
    expect(calls.filter((path) => path === "/rest/v1/auth_session_revocations")).toHaveLength(1);
    revoked.add(SESSION);
    expect(await identifyBearer(token, "remote")).toBeNull();
    revoked.clear();

    expect((await identifyBearer("tok-opaque-legacy", "local"))?.verifiedBy).toBe("remote");
    expect((await identifyBearer(signer.sign({ sub: USER }), "local"))?.verifiedBy).toBe("remote");
    expect(authUserCalls()).toBe(4);
  });

  it("retries the remote lookup once on timeouts and 5xx, never on 401", async () => {
    authUserScript = ["timeout", 200];
    expect((await identifyBearer("tok-a", "remote"))?.id).toBe(USER);
    expect(authUserCalls()).toBe(2);

    calls.length = 0;
    authUserScript = [503, 200];
    expect((await identifyBearer("tok-b", "remote"))?.id).toBe(USER);
    expect(authUserCalls()).toBe(2);

    calls.length = 0;
    authUserScript = [503, 503];
    await expect(identifyBearer("tok-c", "remote")).rejects.toThrow(/auth lookup failed \(503\)/);
    expect(authUserCalls()).toBe(2);

    calls.length = 0;
    authUserScript = [401, 200];
    expect(await identifyBearer("tok-d", "remote")).toBeNull();
    expect(authUserCalls()).toBe(1);
  });
});
