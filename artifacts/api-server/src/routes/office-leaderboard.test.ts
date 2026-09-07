/**
 * GET /office/leaderboard through the public HTTP surface.
 *
 * The fake backend emulates the PostgREST/GoTrue surface the route and the
 * office-scope resolver use (auth user, providers, team members, locks, HQ
 * memberships, patients, deletion requests and the leaderboard facts RPC),
 * so scoping is proven end to end: own-office staff, HQ drill-in, HQ
 * network-wide, and every refusal.
 */
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
});

import router from "./office-leaderboard";

type Row = Record<string, unknown>;
type RankedRow = { id: string; officeName: string | null; ranks: Record<string, number> };
const originalFetch = global.fetch;
let server: http.Server;
let baseUrl = "";

let authUsers: Record<string, string> = {};
let providers: Row[] = [];
let teamMembers: Row[] = [];
let patients: Row[] = [];
let facts: Row[] = [];
let deletionRequests: Row[] = [];
let hqMemberships: Row[] = [];
let locks: string[] = [];
let factRequests: Array<{ p_provider_id: string | null; p_at: string; p_window_days: number | null }> = [];
let patientRequests: string[] = [];
let factsFailWith: number | null = null;
/** Auth users who ALSO hold an active HQ admin membership on top of an office identity. */
let hybridHqUsers = new Set<string>();

function response(json: unknown, status = 200): Response {
  return new Response(json == null ? "" : JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
}

function bearerOf(init?: RequestInit): string {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return (headers.Authorization ?? "").replace("Bearer ", "");
}

function patientRow(overrides: Row & { id: string }): Row {
  return {
    provider_id: "office-1",
    first_name: "Casey",
    last_name: "Ortiz",
    name: null,
    email: null,
    phone: null,
    activation_status: "activated",
    auth_user_id: "u",
    created_at: "2026-06-01T00:00:00Z",
    program_id: "thinnr-core",
    program_start_date: "2026-06-01",
    starting_weight: 200,
    current_weight: 180,
    goal_weight: 160,
    timezone: "UTC",
    deletion_requested_at: null,
    ...overrides,
  };
}

function factFor(overrides: Row & { patient_id: string }): Row {
  return {
    provider_id: "office-1",
    as_of_date: "2026-09-07",
    period_start: "2026-06-01",
    eligible_days: 99,
    logged_days: 50,
    check_in_days: 25,
    water_goal_days: 10,
    weigh_in_count: 4,
    period_weigh_ins: 4,
    baseline_weight: null,
    baseline_weight_date: null,
    latest_weight: 180,
    latest_weight_date: "2026-09-06",
    ...overrides,
  };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  global.fetch = originalFetch;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

beforeEach(() => {
  authUsers = { "provider-token": "provider-user", "member-token": "member-user", "hq-token": "hq-user", "support-token": "support-user", "patient-token": "patient-user" };
  providers = [
    { provider_id: "office-1", provider_name: "Dr. Reyes", office_name: "Harbor Med Spa", onboarding_code: "483920", access_disabled: false, auth_user_id: "provider-user" },
    { provider_id: "office-2", provider_name: "Dr. Chen", office_name: "Lakeside Clinic", onboarding_code: "775501", access_disabled: false, auth_user_id: "other-provider-user" },
    { provider_id: "office-3", provider_name: "Dr. Gone", office_name: "Closed Office", onboarding_code: null, access_disabled: true, auth_user_id: "closed-user" },
  ];
  teamMembers = [{ id: "tm-1", provider_id: "office-1", auth_user_id: "member-user", activation_status: "activated", office_role: "staff" }];
  patients = [
    patientRow({ id: "own-a", first_name: "Casey", last_name: "Ortiz" }),
    patientRow({ id: "own-b", first_name: "Blake", last_name: "Nguyen", starting_weight: 250, current_weight: 225, goal_weight: 200 }),
    patientRow({ id: "own-paused", first_name: "Pat", last_name: "Paused", activation_status: "paused" }),
    patientRow({ id: "other-a", provider_id: "office-2", first_name: "Riley", last_name: "Park" }),
    patientRow({ id: "closed-a", provider_id: "office-3", first_name: "Nobody", last_name: "Here" }),
  ];
  facts = [
    factFor({ patient_id: "own-a", latest_weight: 180 }),
    factFor({ patient_id: "own-b", latest_weight: 225 }),
    factFor({ patient_id: "own-paused", latest_weight: 150 }),
    factFor({ patient_id: "other-a", provider_id: "office-2", latest_weight: 150 }),
    factFor({ patient_id: "closed-a", provider_id: "office-3", latest_weight: 100 }),
  ];
  deletionRequests = [];
  hqMemberships = [{ department_role: "admin", status: "active" }];
  locks = [];
  factRequests = [];
  patientRequests = [];
  factsFailWith = null;
  hybridHqUsers = new Set();

  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const eq = (key: string) => url.searchParams.get(key)?.replace("eq.", "") ?? null;
    if (url.pathname === "/auth/v1/user") {
      const userId = authUsers[bearerOf(init)];
      return userId ? response({ id: userId }) : response({ message: "bad token" }, 401);
    }
    if (url.pathname === "/rest/v1/providers") {
      const byAuth = eq("auth_user_id");
      const byId = eq("provider_id");
      let rows = providers;
      if (byAuth) rows = rows.filter((row) => row.auth_user_id === byAuth);
      if (byId) rows = rows.filter((row) => row.provider_id === byId);
      return response(rows);
    }
    if (url.pathname === "/rest/v1/team_members") {
      const byAuth = eq("auth_user_id");
      return response(teamMembers.filter((row) => !byAuth || row.auth_user_id === byAuth));
    }
    if (url.pathname === "/rest/v1/provider_account_locks") {
      const or = url.searchParams.get("or") ?? "";
      return response(locks.filter((id) => or.includes(`account_id.eq.${id}`)).map((id) => ({ account_id: id })));
    }
    if (url.pathname === "/rest/v1/hq_memberships") {
      const byAuth = eq("auth_user_id");
      if (byAuth === "hq-user") return response(hqMemberships);
      if (byAuth === "support-user") return response([{ department_role: "support", status: "active" }]);
      if (byAuth && hybridHqUsers.has(byAuth)) return response([{ department_role: "admin", status: "active" }]);
      return response([]);
    }
    if (url.pathname === "/rest/v1/profiles") return response([]);
    if (url.pathname === "/rest/v1/rpc/record_admin_audit_event") return response(null, 204);
    if (url.pathname === "/rest/v1/patients") {
      patientRequests.push(url.search);
      const byProvider = eq("provider_id");
      return response(patients.filter((row) => !byProvider || row.provider_id === byProvider));
    }
    if (url.pathname === "/rest/v1/patient_deletion_requests") {
      const byProvider = eq("provider_id");
      return response(deletionRequests.filter((row) => !byProvider || row.provider_id === byProvider));
    }
    if (url.pathname === "/rest/v1/rpc/provider_leaderboard_facts") {
      const body = JSON.parse(String(init?.body)) as { p_provider_id: string | null; p_at: string; p_window_days: number | null };
      factRequests.push(body);
      if (factsFailWith) return response({ message: "boom" }, factsFailWith);
      return response(facts.filter((row) => body.p_provider_id == null || row.provider_id === body.p_provider_id));
    }
    throw new Error(`unexpected fetch ${url.pathname}${url.search}`);
  }) as typeof fetch;
});

async function get(path: string, token: string | null) {
  const res = await originalFetch(`${baseUrl}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

describe("GET /office/leaderboard", () => {
  it("ranks the provider's own patients and counts the rest as not rankable", async () => {
    const { status, json } = await get("/office/leaderboard", "provider-token");
    expect(status).toBe(200);
    expect(json.office).toEqual({ providerId: "office-1", officeName: "Harbor Med Spa" });
    expect(json.period).toBe("program");
    expect(json.windowDays).toBeNull();
    // Tied on % lost (10% each) → shared rank 1, then alphabetical.
    expect(json.rows.map((row: RankedRow) => row.id)).toEqual(["own-b", "own-a"]);
    expect(json.rows[1]).toMatchObject({
      name: "Casey Ortiz",
      initials: "CO",
      officeName: "Harbor Med Spa",
      poundsLost: 20,
      percentLost: 10,
      goalCompletion: 50,
      ranks: { percent: 1, pounds: 2, goal: 1, adherence: 1 },
      program: { stage: "maintenance", startDate: "2026-06-01" },
    });
    expect(json.rows[0]).toMatchObject({ name: "Blake Nguyen", poundsLost: 25, percentLost: 10, ranks: { percent: 1, pounds: 1, goal: 1 } });
    expect(json.rows[1].adherence).toMatchObject({ score: 32, eligibleDays: 99, loggedDays: 50, checkInDays: 25, waterGoalDays: 10 });
    expect(json.notRankable).toEqual({ total: 1, reasons: [{ reason: "paused", label: "Paused", count: 1 }] });
    expect(json.definitions.adherence).toMatch(/40%/);
    expect(json.rows.some((row: Row) => row.id === "other-a")).toBe(false);
    // The office is scoped at the data layer, not just in the response.
    expect(patientRequests[0]).toContain("provider_id=eq.office-1");
    expect(factRequests[0]).toMatchObject({ p_provider_id: "office-1", p_window_days: null });
  });

  it("passes the period window to the aggregate and applies the in-period weigh-in rule", async () => {
    facts = facts.map((row) => (row.patient_id === "own-b" ? { ...row, period_weigh_ins: 0, baseline_weight: 230, baseline_weight_date: "2026-08-01" } : row));
    facts = facts.map((row) => (row.patient_id === "own-a" ? { ...row, baseline_weight: 185, baseline_weight_date: "2026-08-05" } : row));
    const { status, json } = await get("/office/leaderboard?period=30d", "provider-token");
    expect(status).toBe(200);
    expect(factRequests[0]).toMatchObject({ p_provider_id: "office-1", p_window_days: 30 });
    expect(json.windowDays).toBe(30);
    expect(json.rows.map((row: RankedRow) => row.id)).toEqual(["own-a"]);
    expect(json.rows[0]).toMatchObject({ baselineWeight: 185, baselineWeightDate: "2026-08-05", poundsLost: 5 });
    expect(json.notRankable.reasons).toEqual(expect.arrayContaining([
      { reason: "paused", label: "Paused", count: 1 },
      { reason: "no_weigh_in_in_period", label: "No weigh-in in this period", count: 1 },
    ]));
    expect(json.notRankable.total).toBe(2);
    const ninety = await get("/office/leaderboard?period=90d", "provider-token");
    expect(ninety.status).toBe(200);
    expect(factRequests[1].p_window_days).toBe(90);
  });

  it("ignores an explicit office for provider staff and team members alike", async () => {
    const provider = await get("/office/leaderboard?office=office-2", "provider-token");
    expect(provider.json.office.providerId).toBe("office-1");
    const member = await get("/office/leaderboard?office=all", "member-token");
    expect(member.status).toBe(200);
    expect(member.json.office.providerId).toBe("office-1");
    expect(member.json.rows.map((row: RankedRow) => row.id)).toEqual(["own-b", "own-a"]);
    expect(factRequests.every((request) => request.p_provider_id === "office-1")).toBe(true);
  });

  it("filters by stage before ranking and rejects unknown periods and stages", async () => {
    patients = patients.map((row) => (row.id === "own-b" ? { ...row, program_start_date: "2026-08-20" } : row));
    const { status, json } = await get("/office/leaderboard?stage=protocol", "provider-token");
    expect(status).toBe(200);
    expect(json.stage).toBe("protocol");
    expect(json.rows.map((row: RankedRow) => [row.id, row.ranks.pounds])).toEqual([["own-b", 1]]);
    expect(json.notRankable.total).toBe(0);
    expect((await get("/office/leaderboard?period=7d", "provider-token")).status).toBe(400);
    expect((await get("/office/leaderboard?stage=week-2", "provider-token")).status).toBe(400);
  });

  it("derives each patient's program day and stage on THEIR local day, not the request's UTC date", async () => {
    // 03:30 UTC on Sept 8: Los Angeles is still on Sept 7. Both patients
    // started 2026-07-27, so LA is on day 42 (last protocol day) while a UTC
    // patient is already on day 43 (maintenance). A single UTC as-of would
    // push the LA patient into maintenance and empty the protocol board.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T03:30:00Z"));
    try {
      patients = patients.map((row) =>
        row.id === "own-a"
          ? { ...row, timezone: "America/Los_Angeles", program_start_date: "2026-07-27" }
          : row.id === "own-b"
            ? { ...row, timezone: "UTC", program_start_date: "2026-07-27" }
            : row,
      );
      facts = facts.map((row) =>
        row.patient_id === "own-a"
          ? { ...row, as_of_date: "2026-09-07", period_start: "2026-07-27" }
          : row.patient_id === "own-b"
            ? { ...row, as_of_date: "2026-09-08", period_start: "2026-07-27" }
            : row,
      );
      const protocol = await get("/office/leaderboard?stage=protocol", "provider-token");
      expect(protocol.status).toBe(200);
      expect(protocol.json.asOf).toBe("2026-09-08");
      expect(protocol.json.rows.map((row: RankedRow & { program: { day: number; stage: string }; asOfDate: string }) => [row.id, row.program.day, row.program.stage, row.asOfDate]))
        .toEqual([["own-a", 42, "protocol", "2026-09-07"]]);
      const maintenance = await get("/office/leaderboard?stage=maintenance", "provider-token");
      expect(maintenance.json.rows.map((row: RankedRow & { program: { day: number; stage: string }; asOfDate: string }) => [row.id, row.program.day, row.program.stage, row.asOfDate]))
        .toEqual([["own-b", 43, "maintenance", "2026-09-08"]]);
      expect(factRequests.every((request) => request.p_at === "2026-09-08T03:30:00.000Z")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives legacy patients without a program start a day/stage from their creation local day, like the facts RPC", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T03:30:00Z"));
    try {
      // Created 2026-07-28T02:00Z = 2026-07-27 in Los Angeles; on LA's Sept 7 that is day 42 (protocol).
      // A UTC-clock reading of the same timestamp (Jul 28) would say day 41 — still protocol, so also
      // pin a second legacy patient right on the boundary: created 2026-07-27T02:00Z (= Jul 26 LA) → day 43 = maintenance.
      patients = patients.map((row) =>
        row.id === "own-a"
          ? { ...row, timezone: "America/Los_Angeles", program_start_date: null, created_at: "2026-07-28T02:00:00Z" }
          : row.id === "own-b"
            ? { ...row, timezone: "America/Los_Angeles", program_start_date: null, created_at: "2026-07-27T02:00:00Z" }
            : row,
      );
      facts = facts.map((row) =>
        row.patient_id === "own-a" || row.patient_id === "own-b" ? { ...row, as_of_date: "2026-09-07" } : row,
      );
      const all = await get("/office/leaderboard", "provider-token");
      expect(all.json.rows.map((row: RankedRow & { program: { day: number; stage: string } }) => [row.id, row.program.day, row.program.stage]))
        .toEqual([["own-b", 43, "maintenance"], ["own-a", 42, "protocol"]]);
      const protocol = await get("/office/leaderboard?stage=protocol", "provider-token");
      expect(protocol.json.rows.map((row: RankedRow) => row.id)).toEqual(["own-a"]);
      const maintenance = await get("/office/leaderboard?stage=maintenance", "provider-token");
      expect(maintenance.json.rows.map((row: RankedRow) => row.id)).toEqual(["own-b"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks pending deletion requests as not rankable even when the patient row lacks the flag", async () => {
    deletionRequests = [{ patient_id: "own-a", provider_id: "office-1", status: "pending" }];
    const { json } = await get("/office/leaderboard", "provider-token");
    expect(json.rows.map((row: RankedRow) => row.id)).toEqual(["own-b"]);
    expect(json.notRankable.reasons).toEqual(expect.arrayContaining([{ reason: "deletion_requested", label: "Deletion requested", count: 1 }]));
  });

  it("lets HQ pick an office and requires one otherwise", async () => {
    const drill = await get("/office/leaderboard?office=office-2", "hq-token");
    expect(drill.status).toBe(200);
    expect(drill.json.office).toEqual({ providerId: "office-2", officeName: "Lakeside Clinic" });
    expect(drill.json.rows.map((row: RankedRow) => row.id)).toEqual(["other-a"]);
    expect(factRequests[0].p_provider_id).toBe("office-2");
    const seeded = await get("/office/leaderboard?office=acct-office-2", "hq-token");
    expect(seeded.json.office.providerId).toBe("office-2");
    const missing = await get("/office/leaderboard", "hq-token");
    expect(missing.status).toBe(400);
    const closed = await get("/office/leaderboard?office=office-3", "hq-token");
    expect(closed.status).toBe(404);
  });

  it("ranks every enabled office for HQ with office=all", async () => {
    const { status, json } = await get("/office/leaderboard?office=all", "hq-token");
    expect(status).toBe(200);
    expect(json.office).toBeNull();
    expect(json.offices).toEqual([
      { providerId: "office-1", officeName: "Harbor Med Spa" },
      { providerId: "office-2", officeName: "Lakeside Clinic" },
    ]);
    expect(factRequests[0].p_provider_id).toBeNull();
    expect(patientRequests[0]).not.toContain("provider_id=eq.");
    // Cross-office ranks: other-a lost 50 (25%), own-b 25 (10%), own-a 20 (10%).
    expect(json.rows.map((row: RankedRow) => [row.id, row.officeName, row.ranks.percent])).toEqual([
      ["other-a", "Lakeside Clinic", 1],
      ["own-b", "Harbor Med Spa", 2],
      ["own-a", "Harbor Med Spa", 2],
    ]);
    // The disabled office's patient is neither ranked nor counted.
    expect(json.rows.some((row: Row) => row.id === "closed-a")).toBe(false);
    expect(json.notRankable.total).toBe(1);
  });

  it("refuses HQ roles without provider reads, patients, and anonymous callers", async () => {
    expect((await get("/office/leaderboard?office=all", "support-token")).status).toBe(403);
    expect((await get("/office/leaderboard?office=office-1", "support-token")).status).toBe(403);
    expect((await get("/office/leaderboard", "patient-token")).status).toBe(403);
    expect((await get("/office/leaderboard", null)).status).toBe(401);
    expect((await get("/office/leaderboard", "expired")).status).toBe(401);
    expect(factRequests).toHaveLength(0);
  });

  it("pins dual-role office identities to their own office on office=all, even with an HQ membership", async () => {
    // A provider owner or teammate who also has HQ admin never gets the
    // network-wide board through this route — the office rung wins, exactly
    // like every other office endpoint.
    hybridHqUsers = new Set(["provider-user", "member-user"]);
    const owner = await get("/office/leaderboard?office=all", "provider-token");
    expect(owner.status).toBe(200);
    expect(owner.json.office.providerId).toBe("office-1");
    expect(owner.json.offices.map((office: { providerId: string }) => office.providerId)).toEqual(["office-1"]);
    expect(owner.json.rows.every((row: RankedRow & { providerId: string }) => row.providerId === "office-1")).toBe(true);
    const member = await get("/office/leaderboard?office=all", "member-token");
    expect(member.status).toBe(200);
    expect(member.json.office.providerId).toBe("office-1");
    expect(factRequests.every((request) => request.p_provider_id === "office-1")).toBe(true);
    expect(patientRequests.every((search) => search.includes("provider_id=eq.office-1"))).toBe(true);

    // Lock / deactivation precedence holds too: the HQ membership never rescues them.
    teamMembers[0].activation_status = "disabled";
    expect((await get("/office/leaderboard?office=all", "member-token")).status).toBe(403);
    locks = ["office-1"];
    expect((await get("/office/leaderboard?office=all", "provider-token")).status).toBe(403);
    locks = [];
    providers[0].access_disabled = true;
    expect((await get("/office/leaderboard?office=all", "provider-token")).status).toBe(404);
  });

  it("fails closed for locked or disabled offices", async () => {
    locks = ["office-1"];
    expect((await get("/office/leaderboard", "provider-token")).status).toBe(403);
    // HQ reads survive a lock, like the roster.
    expect((await get("/office/leaderboard?office=office-1", "hq-token")).status).toBe(200);
    locks = [];
    providers[0].access_disabled = true;
    expect((await get("/office/leaderboard", "provider-token")).status).toBe(404);
  });

  it("answers a facts failure with 502 and no rows — never a seeded fallback", async () => {
    factsFailWith = 500;
    const { status, json } = await get("/office/leaderboard", "provider-token");
    expect(status).toBe(502);
    expect(json.rows).toBeUndefined();
    expect(typeof json.error).toBe("string");
  });

  it("reports an empty board honestly", async () => {
    patients = patients.map((row) => (row.provider_id === "office-1" ? { ...row, starting_weight: null } : row));
    const { status, json } = await get("/office/leaderboard", "provider-token");
    expect(status).toBe(200);
    expect(json.rows).toEqual([]);
    expect(json.notRankable).toEqual({ total: 3, reasons: expect.arrayContaining([
      { reason: "paused", label: "Paused", count: 1 },
      { reason: "no_starting_weight", label: "No starting weight", count: 2 },
    ]) });
  });
});
