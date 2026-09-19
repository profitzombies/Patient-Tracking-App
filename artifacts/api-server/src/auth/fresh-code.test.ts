/**
 * Fresh-code gate helpers and the staff session bootstrap route, against a
 * mocked ledger read. security.test.ts proves the gate end to end through
 * the real sign-in rails; this suite pins the window arithmetic, the
 * fail-closed outage answer, and the bootstrap's idle-timeout choice.
 */
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  identify: vi.fn(),
  describe: vi.fn(),
  policy: vi.fn(),
  overrides: vi.fn(),
}));

vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("./identify", async () => {
  const actual = await vi.importActual<typeof import("./identify")>("./identify");
  return { ...actual, identifyRequest: mocks.identify };
});
vi.mock("../security/actor", () => ({ describeAccount: mocks.describe }));
vi.mock("../lib/org-policy", async () => {
  const actual = await vi.importActual<typeof import("../lib/org-policy")>("../lib/org-policy");
  return { ...actual, loadOrgPolicy: mocks.policy, loadOfficeOverrides: mocks.overrides };
});

import { FRESH_CODE_WINDOW_MS, isFresh, lastCodeVerifiedAt, requireFreshCode, stampCodeVerified } from "./fresh-code";
import { DEFAULT_ORG_POLICY } from "../lib/org-policy";
import staffSessionRouter from "../routes/staff-session";

/** A JWT-shaped bearer whose payload carries the session id the gate reads. */
function tokenFor(userId: string, sessionId: string | null): string {
  const payload = Buffer.from(JSON.stringify(sessionId ? { sub: userId, session_id: sessionId } : { sub: userId })).toString("base64url");
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
}

function fakeRes() {
  const out: { status: number | null; body: unknown } = { status: null, body: null };
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(body: unknown) {
      out.body = body;
      return res;
    },
  };
  return { res: res as unknown as express.Response, out };
}

const iso = (ageMs: number) => new Date(Date.now() - ageMs).toISOString();
/** Session ids are GoTrue UUIDs; anything else is ignored by the claim reader. */
const SESSION = "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

beforeEach(() => {
  mocks.admin.mockReset();
  mocks.identify.mockReset();
  mocks.describe.mockReset();
  mocks.policy.mockReset().mockResolvedValue({ ...DEFAULT_ORG_POLICY, staffIdleTimeoutMinutes: 20, hqIdleTimeoutMinutes: 45 });
  mocks.overrides.mockReset().mockResolvedValue({ idleTimeoutMinutes: null });
});

describe("isFresh", () => {
  it("accepts a proof inside the ten-minute window, including the boundary, and nothing older or unparseable", () => {
    const now = Date.now();
    expect(isFresh(new Date(now).toISOString(), now)).toBe(true);
    expect(isFresh(new Date(now - FRESH_CODE_WINDOW_MS).toISOString(), now)).toBe(true);
    expect(isFresh(new Date(now - FRESH_CODE_WINDOW_MS - 1).toISOString(), now)).toBe(false);
    expect(isFresh(null, now)).toBe(false);
    expect(isFresh("not a date", now)).toBe(false);
  });
});

describe("lastCodeVerifiedAt", () => {
  it("skips the ledger entirely when the bearer has no session id", async () => {
    expect(await lastCodeVerifiedAt("u1", null)).toBeNull();
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("reads the newest proof on the live ledger row backing exactly this session", async () => {
    mocks.admin.mockResolvedValue({ status: 200, json: [{ code_verified_at: "2026-09-19T10:00:00.000Z" }], contentRange: null });
    expect(await lastCodeVerifiedAt("u1", "s1")).toBe("2026-09-19T10:00:00.000Z");
    const [method, path] = mocks.admin.mock.calls[0];
    expect(method).toBe("GET");
    expect(path).toContain("/rest/v1/auth_sign_ins?user_id=eq.u1&session_id=eq.s1&revoked_at=is.null");
    expect(path).toContain("order=code_verified_at.desc.nullslast&limit=1");
  });

  it("treats a row that never proved a code as no proof", async () => {
    mocks.admin.mockResolvedValue({ status: 200, json: [{ code_verified_at: null }], contentRange: null });
    expect(await lastCodeVerifiedAt("u1", "s1")).toBeNull();
  });
});

describe("requireFreshCode", () => {
  const reqFor = (token: string) => ({ headers: { authorization: `Bearer ${token}` }, log: { error: vi.fn() } }) as unknown as express.Request;

  it("lets a fresh session through without writing a response", async () => {
    mocks.admin.mockResolvedValue({ status: 200, json: [{ code_verified_at: iso(60_000) }], contentRange: null });
    const { res, out } = fakeRes();
    expect(await requireFreshCode(reqFor(tokenFor("u1", SESSION)), res, "u1")).toBe(true);
    expect(out.status).toBeNull();
  });

  it("answers 401 reauth_required for a stale proof and for a bearer with no session claim", async () => {
    mocks.admin.mockResolvedValue({ status: 200, json: [{ code_verified_at: iso(FRESH_CODE_WINDOW_MS + 5_000) }], contentRange: null });
    const stale = fakeRes();
    expect(await requireFreshCode(reqFor(tokenFor("u1", SESSION)), stale.res, "u1")).toBe(false);
    expect(stale.out.status).toBe(401);
    expect(stale.out.body).toMatchObject({ code: "reauth_required", windowMinutes: 10 });

    const noSession = fakeRes();
    expect(await requireFreshCode(reqFor(tokenFor("u1", null)), noSession.res, "u1")).toBe(false);
    expect(noSession.out.status).toBe(401);
  });

  it("fails closed with a retryable 503 when the ledger cannot be read", async () => {
    mocks.admin.mockResolvedValue({ status: 500, json: { message: "down" }, contentRange: null });
    const { res, out } = fakeRes();
    expect(await requireFreshCode(reqFor(tokenFor("u1", SESSION)), res, "u1")).toBe(false);
    expect(out.status).toBe(503);
    expect(out.body).toMatchObject({ retryable: true });
  });
});

describe("stampCodeVerified", () => {
  it("patches the live row for this session and reports whether one existed", async () => {
    mocks.admin.mockResolvedValueOnce({ status: 200, json: [{ id: "row" }], contentRange: null });
    expect(await stampCodeVerified("u1", "s1", "2026-09-19T10:00:00.000Z")).toBe(true);
    const [method, path, body, prefer] = mocks.admin.mock.calls[0];
    expect(method).toBe("PATCH");
    expect(path).toBe("/rest/v1/auth_sign_ins?user_id=eq.u1&session_id=eq.s1&revoked_at=is.null");
    expect(body).toEqual({ code_verified_at: "2026-09-19T10:00:00.000Z", last_seen_at: "2026-09-19T10:00:00.000Z" });
    expect(prefer).toBe("return=representation");
    mocks.admin.mockResolvedValueOnce({ status: 200, json: [], contentRange: null });
    expect(await stampCodeVerified("u1", "s1")).toBe(false);
  });
});

describe("GET /staff-session", () => {
  let server: http.Server;
  let base = "";
  beforeAll(async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as unknown as { log: unknown }).log = { error: () => {}, warn: () => {} };
      next();
    });
    app.use("/api", staffSessionRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const get = async () => {
    const response = await fetch(`${base}/api/staff-session`, { headers: { authorization: "Bearer t" } });
    return { status: response.status, json: (await response.json()) as Record<string, any>, headers: response.headers };
  };

  it("401 without a session, 403 for a signed-in patient", async () => {
    mocks.identify.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(401);
    mocks.identify.mockResolvedValueOnce({ id: "p1", sessionId: "s1" });
    mocks.describe.mockResolvedValueOnce({ realm: "patient", userId: "p1" });
    expect((await get()).status).toBe(403);
  });

  it("gives office staff the staff timeout shortened by their office override, with the session's code freshness", async () => {
    mocks.identify.mockResolvedValue({ id: "u1", sessionId: "s1" });
    mocks.describe.mockResolvedValue({ realm: "staff", staffKind: "team_member", userId: "u1", providerId: "20002" });
    mocks.overrides.mockResolvedValue({ idleTimeoutMinutes: 10 });
    mocks.admin.mockResolvedValue({ status: 200, json: [{ code_verified_at: iso(30_000) }], contentRange: null });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.json).toMatchObject({ staffKind: "team_member", providerId: "20002", idleTimeoutMinutes: 10, idleTimeoutSource: "office", freshCode: { fresh: true, windowMinutes: 10 } });
    expect(mocks.overrides).toHaveBeenCalledWith("20002");

    // An override longer than HQ's value is ignored: the office can only shorten.
    mocks.overrides.mockResolvedValue({ idleTimeoutMinutes: 90 });
    expect((await get()).json).toMatchObject({ idleTimeoutMinutes: 20, idleTimeoutSource: "hq" });
  });

  it("gives HQ members the HQ timeout and reports a stale proof honestly", async () => {
    mocks.identify.mockResolvedValue({ id: "h1", sessionId: "s9" });
    mocks.describe.mockResolvedValue({ realm: "staff", staffKind: "hq", userId: "h1", providerId: null });
    mocks.admin.mockResolvedValue({ status: 200, json: [], contentRange: null });
    const res = await get();
    expect(res.json).toMatchObject({ staffKind: "hq", idleTimeoutMinutes: 45, idleTimeoutSource: "hq", freshCode: { codeVerifiedAt: null, fresh: false } });
    expect(mocks.overrides).not.toHaveBeenCalled();
  });

  it("answers 503 instead of a default when the ledger read fails", async () => {
    mocks.identify.mockResolvedValue({ id: "h1", sessionId: "s9" });
    mocks.describe.mockResolvedValue({ realm: "staff", staffKind: "hq", userId: "h1", providerId: null });
    mocks.admin.mockResolvedValue({ status: 500, json: {}, contentRange: null });
    expect((await get()).status).toBe(503);
  });
});
