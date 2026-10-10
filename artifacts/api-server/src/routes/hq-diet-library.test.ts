import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type http from "node:http";
import type { AddressInfo } from "node:net";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), audit: vi.fn() }));
const { admin, audit } = mocks;
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("../lib/admin-audit", () => ({ recordAdminAuditEvent: mocks.audit, requestIdOf: () => null }));
vi.mock("../lib/staff-auth", () => ({
  requireHqPermission: (permission: string) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (permission !== "content_manage") { res.status(500).json({ error: `unexpected permission ${permission}` }); return; }
    if (req.headers.authorization !== "Bearer content") { res.status(403).json({ error: "denied" }); return; }
    res.locals.staff = { userId: "hq-user-1" };
    next();
  },
}));
import router from "./hq-diet-library";

type Row = Record<string, unknown>;
let server: http.Server; let base = "";
beforeAll(async () => { const app = express(); app.use(express.json()); app.use(router); await new Promise<void>(r => { server = app.listen(0, () => r()); }); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
afterAll(() => server.close());

function entry(slug: string, over: Row = {}): Row {
  return {
    id: `id-${slug}`, slug, name: slug, summary: "Summary", complexity: "moderate", rule_sheet: ["Rule one"], sample_day: ["Breakfast"],
    oversight_note: false, pregnancy_blocked: false, screening_questions: [], fit_rules: { mode: "exclude", excludeTags: [] },
    evidence_strength: "moderate", supervision_level: "none", sources: ["AHA"], review_status: "draft", reviewed_by: null, reviewed_at: null,
    published_at: null, sort_order: 1, version: 1, updated_by: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", ...over,
  };
}

let entries: Row[] = [];
let versions: Row[] = [];
let settings: Row = { singleton: true, disclaimer: "Custom disclaimer", oversight_note_text: "Talk to your care team." };
const patches: Array<{ path: string; body: Row }> = [];

function response(json: unknown, status = 200) { return { status, json, contentRange: null }; }
function matches(row: Row, params: URLSearchParams): boolean {
  return [...params.entries()].every(([key, raw]) => {
    if (["select", "limit", "order"].includes(key)) return true;
    if (raw.startsWith("eq.")) return String(row[key]) === raw.slice(3);
    return true;
  });
}
const json = async (res: Response): Promise<any> => res.json();
async function call(path: string, method = "GET", body?: unknown, auth = "Bearer content") {
  return fetch(base + path, { method, headers: { "content-type": "application/json", authorization: auth }, body: body ? JSON.stringify(body) : undefined });
}

beforeEach(() => {
  admin.mockReset(); audit.mockReset().mockResolvedValue(1); patches.length = 0;
  entries = [entry("just_tracking", { sort_order: 0, review_status: "published", published_at: "2026-10-01T00:00:00Z" }), entry("keto", { version: 3, review_status: "published", published_at: "2026-10-02T00:00:00Z", reviewed_by: "r1", reviewed_at: "2026-10-01T12:00:00Z" }), entry("paleo")];
  versions = [{ entry_id: "id-keto", version: 3, changed_by: "hq-user-1", change_note: null, created_at: "2026-10-03T00:00:00Z" }, { entry_id: "id-keto", version: 2, changed_by: null, change_note: null, created_at: "2026-10-02T00:00:00Z" }];
  settings = { singleton: true, disclaimer: "Custom disclaimer", oversight_note_text: "Talk to your care team." };
  admin.mockImplementation(async (method: string, path: string, body?: unknown) => {
    const url = new URL(`http://x${path}`);
    const table = url.pathname.replace("/rest/v1/", "");
    if (method === "GET") {
      if (table === "diet_library_entries") return response(entries.filter((row) => matches(row, url.searchParams)).map((row) => ({ ...row })));
      if (table === "diet_library_versions") return response(versions.filter((row) => matches(row, url.searchParams)));
      if (table === "diet_library_settings") return response([settings]);
    }
    if (method === "PATCH") {
      patches.push({ path, body: body as Row });
      if (table === "diet_library_entries") {
        const hits = entries.filter((row) => matches(row, url.searchParams));
        for (const row of hits) { Object.assign(row, body as Row, { version: Number(row.version) + 1, updated_at: "2026-10-10T00:00:00Z" }); }
        return response(hits.map((row) => ({ ...row })));
      }
      if (table === "diet_library_settings") { Object.assign(settings, body as Row); return response(null, 204); }
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
});

describe("hq diet library routes", () => {
  it("requires the content permission on every route", async () => {
    expect((await call("/hq/diet-library", "GET", undefined, "Bearer nope")).status).toBe(403);
    expect((await call("/hq/diet-library/keto", "PUT", { expectedVersion: 3, name: "x" }, "Bearer nope")).status).toBe(403);
    expect((await call("/hq/diet-library-settings", "PUT", { disclaimer: "x" }, "Bearer nope")).status).toBe(403);
    expect(admin).not.toHaveBeenCalled();
  });

  it("lists every entry with staff-only fields and the settings", async () => {
    const res = await call("/hq/diet-library");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.settings).toEqual({ disclaimer: "Custom disclaimer", oversightNoteText: "Talk to your care team." });
    expect(body.entries.map((e: Row) => e.slug)).toEqual(["just_tracking", "keto", "paleo"]);
    const keto = body.entries.find((e: Row) => e.slug === "keto");
    expect(keto).toMatchObject({ reviewStatus: "published", version: 3, evidenceStrength: "moderate", supervisionLevel: "none", sources: ["AHA"], oversightNote: null });
  });

  it("reads one entry with its version trail and 404s unknown slugs", async () => {
    const res = await call("/hq/diet-library/keto");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.entry.slug).toBe("keto");
    expect(body.versions.map((v: Row) => v.version)).toEqual([3, 2]);
    expect((await call("/hq/diet-library/nope")).status).toBe(404);
    expect((await call("/hq/diet-library/Bad%20Slug")).status).toBe(404);
  });

  it("rejects edits without expectedVersion or with invalid fields", async () => {
    const missing = await call("/hq/diet-library/keto", "PUT", { name: "Keto" });
    expect(missing.status).toBe(400);
    expect((await json(missing)).field).toBe("expectedVersion");
    const bad = await call("/hq/diet-library/keto", "PUT", { expectedVersion: 3, complexity: "impossible" });
    expect(bad.status).toBe(400);
    expect((await json(bad)).field).toBe("complexity");
    const badQ = await call("/hq/diet-library/keto", "PUT", { expectedVersion: 3, screeningQuestions: ["medication", "astrology"] });
    expect((await json(badQ)).field).toBe("screeningQuestions");
    const empty = await call("/hq/diet-library/keto", "PUT", { expectedVersion: 3, changeNote: "nothing" });
    expect(empty.status).toBe(400);
    expect(patches).toHaveLength(0);
  });

  it("returns 409 RECORD_CHANGED when the editor's version is stale", async () => {
    const res = await call("/hq/diet-library/keto", "PUT", { expectedVersion: 2, name: "Keto" });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: "RECORD_CHANGED", version: 3 });
    expect(patches).toHaveLength(0);
  });

  it("sends a published entry back to draft on a content edit and audits it", async () => {
    const res = await call("/hq/diet-library/keto", "PUT", { expectedVersion: 3, name: "  Keto   plan ", oversightRecommended: true, sortOrder: 7 });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.unpublished).toBe(true);
    expect(body.entry).toMatchObject({ name: "Keto plan", reviewStatus: "draft", reviewedBy: null, oversightRecommended: true, oversightNote: "Talk to your care team.", sortOrder: 7, version: 4 });
    expect(patches[0]!.path).toContain("slug=eq.keto&version=eq.3");
    expect(patches[0]!.body).toMatchObject({ name: "Keto plan", oversight_note: true, sort_order: 7, review_status: "draft", reviewed_by: null, updated_by: "hq-user-1" });
    await vi.waitFor(() => expect(audit).toHaveBeenCalled());
    expect(audit.mock.calls[0]![0]).toMatchObject({ action: "diet_library_updated", actorUserId: "hq-user-1", actorKind: "hq", targetKind: "diet_library_entry", targetId: "id-keto", metadata: { dietSlug: "keto", reviewStatus: "draft" } });
  });

  it("keeps 'just tracking' published when its wording is edited", async () => {
    const res = await call("/hq/diet-library/just_tracking", "PUT", { expectedVersion: 1, summary: "Track meals without a framework." });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.unpublished).toBe(false);
    expect(body.entry.reviewStatus).toBe("published");
    expect(patches[0]!.body.review_status).toBeUndefined();
  });

  it("validates fit rules through the shared parser", async () => {
    const bad = await call("/hq/diet-library/paleo", "PUT", { expectedVersion: 1, fitRules: "exclude everything" });
    expect(bad.status).toBe(400);
    expect((await json(bad)).field).toBe("fitRules");
    const good = await call("/hq/diet-library/paleo", "PUT", { expectedVersion: 1, fitRules: { mode: "exclude", excludeTags: ["grain", "dairy"] } });
    expect(good.status).toBe(200);
    expect((await json(good)).entry.fitRules).toMatchObject({ mode: "exclude", excludeTags: ["grain", "dairy"] });
  });

  it("walks the review ladder: publish needs reviewed, repeats are no-ops", async () => {
    const early = await call("/hq/diet-library/paleo/review", "POST", { status: "published", expectedVersion: 1 });
    expect(early.status).toBe(409);
    expect((await json(early)).code).toBe("NOT_REVIEWED");
    const badStatus = await call("/hq/diet-library/paleo/review", "POST", { status: "approved", expectedVersion: 1 });
    expect(badStatus.status).toBe(400);

    const reviewed = await call("/hq/diet-library/paleo/review", "POST", { status: "reviewed", expectedVersion: 1 });
    expect(reviewed.status).toBe(200);
    expect((await json(reviewed)).entry).toMatchObject({ reviewStatus: "reviewed", reviewedBy: "hq-user-1", version: 2 });
    expect(patches.at(-1)!.body).toMatchObject({ review_status: "reviewed", reviewed_by: "hq-user-1" });

    const again = await call("/hq/diet-library/paleo/review", "POST", { status: "reviewed", expectedVersion: 2 });
    expect(again.status).toBe(409);
    expect((await json(again)).code).toBe("NO_CHANGE");

    const stale = await call("/hq/diet-library/paleo/review", "POST", { status: "published", expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect((await json(stale)).code).toBe("RECORD_CHANGED");

    const published = await call("/hq/diet-library/paleo/review", "POST", { status: "published", expectedVersion: 2 });
    expect(published.status).toBe(200);
    expect((await json(published)).entry.reviewStatus).toBe("published");
    await vi.waitFor(() => expect(audit.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(audit.mock.calls.at(-1)![0]).toMatchObject({ action: "diet_library_reviewed", metadata: { dietSlug: "paleo", reviewStatus: "published", previousReviewStatus: "reviewed" } });

    const back = await call("/hq/diet-library/paleo/review", "POST", { status: "draft", expectedVersion: 3 });
    expect(back.status).toBe(200);
    expect((await json(back)).entry).toMatchObject({ reviewStatus: "draft", reviewedBy: null, reviewedAt: null });
  });

  it("updates the shared disclaimer and oversight note", async () => {
    const empty = await call("/hq/diet-library-settings", "PUT", { disclaimer: "   " });
    expect(empty.status).toBe(400);
    const nothing = await call("/hq/diet-library-settings", "PUT", {});
    expect(nothing.status).toBe(400);
    const res = await call("/hq/diet-library-settings", "PUT", { disclaimer: "New disclaimer", oversightNoteText: "Please check with your provider." });
    expect(res.status).toBe(200);
    expect((await json(res)).settings).toEqual({ disclaimer: "New disclaimer", oversightNoteText: "Please check with your provider." });
    expect(patches.at(-1)!.path).toBe("/rest/v1/diet_library_settings?singleton=eq.true");
    expect(patches.at(-1)!.body).toMatchObject({ disclaimer: "New disclaimer", oversight_note_text: "Please check with your provider.", updated_by: "hq-user-1" });
  });

  it("surfaces upstream failures as 502", async () => {
    admin.mockImplementation(async () => response({ message: "boom" }, 500));
    expect((await call("/hq/diet-library")).status).toBe(502);
  });
});
