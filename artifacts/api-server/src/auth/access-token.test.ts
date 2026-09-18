import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSigner, type FakeSigner } from "./testing/fake-jwt";
import { resetAccessTokenVerifierForTests, verifyAccessTokenLocally } from "./access-token";

const SUPABASE_URL = "https://fake.supabase.local";
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const USER = "8f3a0a8e-2a7e-4d2e-9b1e-0f0a7a2d1c11";
const SESSION = "3a5f2c1e-8d4b-4f2a-9c6e-1b2d3e4f5a6b";

let signer: FakeSigner;
let rotated: FakeSigner;
/** What the fake JWKS endpoint currently publishes. */
let published: () => { keys: Array<Record<string, unknown>> };
let jwksStatus = 200;
let jwksFetches = 0;
const realFetch = globalThis.fetch;

beforeAll(() => {
  process.env.SUPABASE_URL = SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  delete process.env.SUPABASE_JWT_ISSUER;
  signer = createFakeSigner({ kid: "kid-a", issuer: ISSUER });
  rotated = createFakeSigner({ kid: "kid-b", issuer: ISSUER });
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (href === `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`) {
      jwksFetches += 1;
      if (jwksStatus !== 200) return new Response("nope", { status: jwksStatus });
      return new Response(JSON.stringify(published()), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${href}`);
  });
});

afterAll(() => {
  vi.stubGlobal("fetch", realFetch);
});

beforeEach(() => {
  resetAccessTokenVerifierForTests();
  published = () => signer.jwks();
  jwksStatus = 200;
  jwksFetches = 0;
});

describe("verifyAccessTokenLocally", () => {
  it("accepts a genuine token and yields the user, session, and expiry", async () => {
    const token = signer.sign({ sub: USER, session_id: SESSION, email: "pat@example.com", phone: "" });
    const result = await verifyAccessTokenLocally(token);
    expect(result).toMatchObject({
      outcome: "verified",
      user: { id: USER, email: "pat@example.com", phone: null },
      sessionId: SESSION,
    });
    expect(jwksFetches).toBe(1);
    // Second verification rides the cache — no extra JWKS fetch.
    await verifyAccessTokenLocally(token);
    expect(jwksFetches).toBe(1);
  });

  it("rejects an expired token without any remote fallback", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signer.sign({ sub: USER, session_id: SESSION }, { nowSeconds: now - 7200, ttlSeconds: 3600 });
    expect(await verifyAccessTokenLocally(token)).toEqual({ outcome: "rejected", reason: "expired" });
    // Inside the clock-skew allowance it is still fine.
    const fresh = signer.sign({ sub: USER, session_id: SESSION }, { nowSeconds: now - 3610, ttlSeconds: 3600 });
    expect((await verifyAccessTokenLocally(fresh)).outcome).toBe("verified");
  });

  it("rejects a tampered payload and a signature from another key", async () => {
    const token = signer.sign({ sub: USER, session_id: SESSION });
    const [header, , signature] = token.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()), sub: "11111111-1111-4111-8111-111111111111" })).toString("base64url");
    expect(await verifyAccessTokenLocally(`${header}.${forgedPayload}.${signature}`)).toEqual({ outcome: "rejected", reason: "bad_signature" });

    const foreign = createFakeSigner({ kid: "kid-a", issuer: ISSUER }); // same kid, different key
    expect(await verifyAccessTokenLocally(foreign.sign({ sub: USER, session_id: SESSION }))).toEqual({ outcome: "rejected", reason: "bad_signature" });
  });

  it("refreshes the key set once for an unknown kid and then verifies (rotation)", async () => {
    // Warm the cache with the old key only.
    expect((await verifyAccessTokenLocally(signer.sign({ sub: USER, session_id: SESSION }))).outcome).toBe("verified");
    expect(jwksFetches).toBe(1);
    // Keys rotate a minute later: the endpoint now publishes both.
    published = () => ({ keys: [signer.publicJwk(), rotated.publicJwk()] });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 60_000);
      const result = await verifyAccessTokenLocally(rotated.sign({ sub: USER, session_id: SESSION }));
      expect(result.outcome).toBe("verified");
      expect(jwksFetches).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports an unknown kid as unverifiable and does not hammer the endpoint inside the cooldown", async () => {
    expect((await verifyAccessTokenLocally(signer.sign({ sub: USER, session_id: SESSION }))).outcome).toBe("verified");
    const stranger = createFakeSigner({ kid: "kid-zzz", issuer: ISSUER });
    expect(await verifyAccessTokenLocally(stranger.sign({ sub: USER, session_id: SESSION }))).toEqual({ outcome: "unverifiable", reason: "unknown_key" });
    expect(jwksFetches).toBe(1); // the refresh moments after the initial fetch is skipped (cooldown)
    resetAccessTokenVerifierForTests();
    jwksFetches = 0;
    // A cold cache: one fetch for the load, no second one for the same unknown kid.
    expect(await verifyAccessTokenLocally(stranger.sign({ sub: USER, session_id: SESSION }))).toEqual({ outcome: "unverifiable", reason: "unknown_key" });
    expect(jwksFetches).toBe(1);
  });

  it("rejects another project's issuer and a foreign audience", async () => {
    expect(await verifyAccessTokenLocally(signer.sign({ sub: USER, session_id: SESSION }, { issuer: "https://other.supabase.co/auth/v1" }))).toEqual({
      outcome: "rejected",
      reason: "wrong_issuer",
    });
    expect(await verifyAccessTokenLocally(signer.sign({ sub: USER, session_id: SESSION, aud: "anon" }))).toEqual({ outcome: "rejected", reason: "wrong_audience" });
    expect(await verifyAccessTokenLocally(signer.sign({ sub: "not-a-uuid", session_id: SESSION }))).toEqual({ outcome: "rejected", reason: "no_subject" });
  });

  it("leaves symmetric tokens, non-JWTs, and an unreachable JWKS to the remote lookup", async () => {
    expect(await verifyAccessTokenLocally("tok-legacy-opaque")).toEqual({ outcome: "unverifiable", reason: "not_a_jwt" });
    const hs = `${Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: USER })).toString("base64url")}.sig`;
    expect(await verifyAccessTokenLocally(hs)).toEqual({ outcome: "unverifiable", reason: "symmetric_key" });
    expect(jwksFetches).toBe(0);
    jwksStatus = 503;
    expect(await verifyAccessTokenLocally(signer.sign({ sub: USER, session_id: SESSION }))).toEqual({ outcome: "unverifiable", reason: "jwks_unavailable" });
  });
});
