import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type http from "node:http";
import type { AddressInfo } from "node:net";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), staff: vi.fn() }));
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("../lib/staff-auth", async () => {
  const actual = await vi.importActual<typeof import("../lib/staff-auth")>("../lib/staff-auth");
  return {
    ...actual,
    requireHqPermission: (permission: string) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const identity = mocks.staff(req.headers.authorization);
      if (!identity) { res.status(401).json({ error: "Sign in to continue." }); return; }
      if (!actual.hasHqPermission(identity, permission as never)) { res.status(403).json({ error: "no" }); return; }
      res.locals.staff = identity; next();
    },
  };
});
import router from "./hq-diet-reporting";
import { assembleDietRestrictions, dietFactsPayload, type DietRestrictionsResult } from "../diet/restrictions-report";
import { GENERATORS } from "../exports/generators";

let server: http.Server; let base = "";
beforeAll(async () => { const app = express(); app.use(express.json()); app.use(router); await new Promise<void>(r => { server = app.listen(0, () => r()); }); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
afterAll(() => server.close());
const response = (json: unknown, status = 200) => ({ status, json, contentRange: null });
const call = (path: string) => fetch(base + path, { headers: { authorization: "Bearer t" } });
const hq = (departmentRole = "admin") => ({ userId: "u-hq", role: "hq_admin", departmentRole });

const TODAY = "2026-10-10";
function patient(overrides: Record<string, unknown>) {
  return { patientId: "p", providerId: "live-a", programId: "thinnr", episodeStartedOn: "2026-10-01", dietSlug: "mediterranean", dietName: "Mediterranean", pendingBlock: false, severeAllergy: false, pregnancyConflict: false, ...overrides };
}
const PAYLOAD = {
  patients: [
    patient({ patientId: "p1" }),                                                   // day 10 → protocol
    patient({ patientId: "p2", episodeStartedOn: "2026-08-01", severeAllergy: true }), // day 71 → maintenance
    patient({ patientId: "p3", dietSlug: null, dietName: null, pendingBlock: true, programId: "glp1" }), // no diet, glp1 → maintenance
    patient({ patientId: "p4", providerId: "live-b", dietSlug: "keto", dietName: "Ketogenic", pregnancyConflict: true }),
    patient({ patientId: "p5", providerId: "live-b", dietSlug: "just_tracking", dietName: "Just tracking" }), // tracking-only: NOT on a diet
  ],
  items: [
    { list: "allergy", key: "peanut", label: "Peanut", severity: "severe", patients: 1 },
    { list: "allergy", key: "shellfish", label: "Shellfish", severity: "mild", patients: 2 },
    { list: "dislike", key: "cilantro", label: "Cilantro", severity: null, patients: 3 },
    { list: "bogus", key: "x", label: "X", severity: null, patients: 9 },
  ],
  changes: { patient: 3, staff: 2, system: 1 },
  blocks: { created: 4, pending: 1, overridden: 2, rejected: 1 },
  screening: [{ question: "medication", answer: "yes", count: 2 }, { question: "medication", answer: "no", count: 5 }, { question: "pregnancy", answer: "yes", count: 1 }],
  offices: [{ providerId: "live-a", name: "Alpha Clinic" }, { providerId: "live-b", name: "Bravo Clinic" }, { providerId: "live-c", name: "Charlie (no patients)" }],
};

beforeEach(() => { mocks.admin.mockReset(); mocks.staff.mockReset(); mocks.staff.mockReturnValue(hq()); });

describe("assembleDietRestrictions", () => {
  const result = assembleDietRestrictions({ range: { start: "2026-09-11", end: TODAY }, asOf: `${TODAY}T12:00:00Z`, todayKey: TODAY, office: null, payload: dietFactsPayload(PAYLOAD) });
  const c = result.counts!;

  it("counts frameworks, phases (shared program rule), lists, blocks, changes and screening", () => {
    expect(result.available).toBe(true);
    expect(c.patients).toBe(5);
    expect(c.onDiet).toBe(3);
    expect(c.justTracking).toBe(1);
    expect(c.noDiet).toBe(1);
    expect(c.byFramework).toEqual([
      { slug: "mediterranean", name: "Mediterranean", patients: 2 },
      { slug: "just_tracking", name: "Just tracking", patients: 1 },
      { slug: "keto", name: "Ketogenic", patients: 1 },
      { slug: "none", name: "No diet chosen", patients: 1 },
    ]);
    expect(c.phases).toEqual({ protocol: 3, maintenance: 2 });
    expect(c.lists).toEqual({ allergy: 3, sensitivity: 0, restriction: 0, dislike: 3 });
    expect(c.topItems.map((i) => i.key)).toEqual(["cilantro", "shellfish", "peanut"]);
    expect(c.topItems.find((i) => i.key === "peanut")?.severity).toBe("severe");
    expect(c.severeAllergyPatients).toBe(1);
    expect(c.pregnancyConflicts).toBe(1);
    // Keyed by the persisted selected_by_role values; a staff change is never lost as "provider".
    expect(c.changes).toEqual({ total: 6, byPatient: 3, byStaff: 2, bySystem: 1 });
    expect(c.blocks).toEqual({ opened: 4, pending: 1, overridden: 2, rejected: 1 });
    expect(c.screening).toEqual([
      { question: "medication", yes: 2, no: 5 },
      { question: "eating_disorder", yes: 0, no: 0 },
      { question: "pregnancy", yes: 1, no: 0 },
    ]);
  });

  it("breaks the same facts down per office and drops offices without patients", () => {
    expect(result.offices.map((o) => o.providerId)).toEqual(["live-a", "live-b"]);
    expect(result.offices[0]).toEqual({ providerId: "live-a", name: "Alpha Clinic", patients: 3, onDiet: 2, protocol: 1, maintenance: 2, severeAllergy: 1, pendingBlocks: 1, pregnancyConflicts: 0 });
    expect(result.offices[1]).toMatchObject({ patients: 2, onDiet: 1, pregnancyConflicts: 1 });
  });

  it("reports an empty scope as unavailable, never as zeros", () => {
    const empty = assembleDietRestrictions({ range: { start: "2026-09-11", end: TODAY }, asOf: "", todayKey: TODAY, office: null, payload: dietFactsPayload({ patients: [], items: [], changes: {}, blocks: null, screening: [], offices: [] }) });
    expect(empty).toMatchObject({ available: false, counts: null, offices: [] });
  });

  it("refuses a malformed RPC payload instead of counting it as empty", () => {
    expect(() => dietFactsPayload(null)).toThrow();
    expect(() => dietFactsPayload("nope")).toThrow();
  });
});

describe("GET /hq/diet-restrictions", () => {
  it("rejects bad ranges before touching the database and gates on analytics access", async () => {
    expect((await call("/hq/diet-restrictions?start=2026-09-01")).status).toBe(400);
    expect((await call("/hq/diet-restrictions?start=2026-09-18&end=2026-09-01")).status).toBe(400);
    expect((await call("/hq/diet-restrictions?start=2026-09-01&end=2026-09-18&office=%3Cbad%3E")).status).toBe(404);
    expect(mocks.admin).not.toHaveBeenCalled();
    mocks.staff.mockReturnValue(hq("support"));
    expect((await call("/hq/diet-restrictions?start=2026-09-01&end=2026-09-18")).status).toBe(403);
    mocks.staff.mockReturnValue(null);
    expect((await call("/hq/diet-restrictions?start=2026-09-01&end=2026-09-18")).status).toBe(401);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("calls the facts RPC with the range and returns the assembled report network-wide", async () => {
    mocks.admin.mockImplementation(async (_m: string, path: string, body: Record<string, unknown>) => {
      expect(path).toBe("/rest/v1/rpc/hq_diet_restrictions_facts");
      expect(body).toEqual({ p_from: "2026-09-01", p_to: "2026-09-18", p_provider_id: null });
      return response(PAYLOAD);
    });
    const res = await call("/hq/diet-restrictions?start=2026-09-01&end=2026-09-18");
    expect(res.status).toBe(200);
    const json = (await res.json()) as DietRestrictionsResult;
    expect(json.office).toBeNull();
    expect(json.available).toBe(true);
    expect(json.counts?.patients).toBe(5);
    expect(json.offices).toHaveLength(2);
    expect(JSON.stringify(json)).not.toContain('"patientId"');
  });

  it("narrows to one enabled office and 404s unknown or disabled ones", async () => {
    mocks.admin.mockImplementation(async (method: string, path: string, body?: Record<string, unknown>) => {
      if (method === "GET" && path.startsWith("/rest/v1/providers?")) {
        return response(path.includes("provider_id=eq.live-a") ? [{ provider_id: "live-a", office_name: "Alpha Clinic" }] : []);
      }
      expect(body?.p_provider_id).toBe("live-a");
      return response({ ...PAYLOAD, patients: PAYLOAD.patients.filter((p) => p.providerId === "live-a"), offices: PAYLOAD.offices.slice(0, 1) });
    });
    const res = await call("/hq/diet-restrictions?start=2026-09-01&end=2026-09-18&office=live-a");
    expect(res.status).toBe(200);
    const json = (await res.json()) as DietRestrictionsResult;
    expect(json.office).toEqual({ id: "live-a", name: "Alpha Clinic" });
    expect(json.counts?.patients).toBe(3);
    expect((await call("/hq/diet-restrictions?start=2026-09-01&end=2026-09-18&office=live-zzz")).status).toBe(404);
  });

  it("surfaces a failed RPC as 502, not as an empty report", async () => {
    mocks.admin.mockResolvedValue(response({ message: "boom" }, 500));
    expect((await call("/hq/diet-restrictions?start=2026-09-01&end=2026-09-18")).status).toBe(502);
  });
});

describe("diet_restrictions export", () => {
  it("renders the report as a long-format sheet with every section and no patient ids", async () => {
    mocks.admin.mockResolvedValue(response(PAYLOAD));
    const sheet = await GENERATORS.diet_restrictions({ providerId: null, officeName: null, requesterKind: "hq", requesterRole: "admin", range: { start: "2026-09-01", end: "2026-09-18" }, patient: null });
    expect(sheet.header[0]).toBe("Section");
    const sections = new Set(sheet.rows.map((r) => r[0]));
    expect([...sections]).toEqual(expect.arrayContaining(["Summary", "By framework", "Lists", "Top items", "Diet changes", "Safety blocks", "Screening", "By office"]));
    expect(sheet.rows.find((r) => r[0] === "Summary" && r[2] === "Patients")?.[4]).toBe(5);
    expect(sheet.rows.find((r) => r[0] === "Summary" && r[2] === "Just tracking")?.[4]).toBe(1);
    expect(sheet.rows.find((r) => r[0] === "Diet changes" && r[2] === "By office staff")?.[4]).toBe(2);
    expect(sheet.rows.filter((r) => r[0] === "By office" && r[1] === "Alpha Clinic")).toHaveLength(7);
    expect(JSON.stringify(sheet.rows)).not.toMatch(/"p[1-5]"/);
  });

  it("writes one unavailable row when the scope has no patients", async () => {
    mocks.admin.mockResolvedValue(response({ patients: [], items: [], changes: {}, blocks: null, screening: [], offices: [] }));
    const sheet = await GENERATORS.diet_restrictions({ providerId: "live-a", officeName: "Alpha Clinic", requesterKind: "hq", requesterRole: "admin", range: { start: "2026-09-01", end: "2026-09-18" }, patient: null });
    expect(sheet.rows).toEqual([["Summary", "Alpha Clinic", "Data available", "", "unavailable", "2026-09-01", "2026-09-18", expect.any(String)]]);
  });
});
