import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type http from "node:http";
import type { AddressInfo } from "node:net";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), audit: vi.fn(), scope: vi.fn() }));
const { admin, audit, scope } = mocks;
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("../auth/office-scope", async () => {
  const actual = await vi.importActual<typeof import("../auth/office-scope")>("../auth/office-scope");
  return { ...actual, resolveOfficeScope: mocks.scope };
});
vi.mock("../lib/admin-audit", () => ({ recordAdminAuditEvent: mocks.audit, recordAccessDenied: vi.fn(), requestIdOf: () => null }));
import router from "./office-patient-groups";

type Row = Record<string, unknown>;
let server: http.Server; let base = "";
beforeAll(async () => { const app = express(); app.use(express.json()); app.use(router); await new Promise<void>(r => { server = app.listen(0, () => r()); }); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
afterAll(() => server.close());

const G1 = "11111111-1111-4111-8111-111111111111";
const G2 = "22222222-2222-4222-8222-222222222222";
const G_OTHER = "33333333-3333-4333-8333-333333333333";
const ownerScope = { kind: "ok", scope: { providerId: "p1", officeName: "One", actorUserId: "a1", actorKind: "provider", officeRole: "owner" } };
const staffScope = { kind: "ok", scope: { providerId: "p1", officeName: "One", actorUserId: "t1", actorKind: "team_member", officeRole: "staff" } };
const hqScope = { kind: "ok", scope: { providerId: "p1", officeName: "One", actorUserId: "hq1", actorKind: "hq", officeRole: "owner" } };
const lockedDenied = { kind: "denied", status: 403, message: "This office is locked.", reason: "office_locked", actorUserId: "t1", providerId: "p1" };

let groups: Row[] = [];
let members: Row[] = [];
let patients: Row[] = [];
let insertConflict = false;

function response(json: unknown, status = 200) { return { status, json, contentRange: null }; }
function eq(params: URLSearchParams, key: string): string | null {
  const raw = params.get(key); return raw && raw.startsWith("eq.") ? raw.slice(3) : null;
}
function matches(row: Row, params: URLSearchParams): boolean {
  return [...params.entries()].every(([key, raw]) => {
    if (key === "select" || key === "limit" || key === "order") return true;
    if (raw.startsWith("eq.")) return String(row[key]) === raw.slice(3);
    if (raw === "is.null") return row[key] == null;
    return true;
  });
}
async function call(path: string, method = "GET", body?: unknown) {
  return fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
}

beforeEach(() => {
  scope.mockReset(); admin.mockReset(); audit.mockReset().mockResolvedValue(1);
  insertConflict = false;
  groups = [
    { id: G1, provider_id: "p1", name: "MJH", description: "Employer cohort", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", created_by: "a1" },
    { id: G2, provider_id: "p1", name: "Tuesday clinic", description: null, created_at: "2026-01-02T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", created_by: "a1" },
    { id: G_OTHER, provider_id: "p2", name: "MJH", description: null, created_at: "2026-01-02T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", created_by: null },
  ];
  members = [
    { group_id: G1, patient_id: "pat-1", provider_id: "p1" },
    { group_id: G1, patient_id: "pat-2", provider_id: "p1" },
    { group_id: G_OTHER, patient_id: "pat-x", provider_id: "p2" },
  ];
  patients = [
    { id: "pat-1", provider_id: "p1", archived_at: null },
    { id: "pat-2", provider_id: "p1", archived_at: null },
    { id: "pat-3", provider_id: "p1", archived_at: null },
    { id: "pat-gone", provider_id: "p1", archived_at: "2026-01-01T00:00:00Z" },
    { id: "pat-x", provider_id: "p2", archived_at: null },
  ];
  admin.mockImplementation(async (method: string, path: string, body?: unknown) => {
    const url = new URL(`http://x${path}`);
    const table = url.pathname.replace("/rest/v1/", "");
    const store = table === "patient_groups" ? groups : table === "patient_group_members" ? members : table === "patients" ? patients : null;
    if (!store) throw new Error(`unexpected ${method} ${path}`);
    if (method === "GET") return response(store.filter((row) => matches(row, url.searchParams)));
    if (method === "POST") {
      const row = body as Row;
      if (table === "patient_groups") {
        if (insertConflict || groups.some((g) => g.provider_id === row.provider_id && String(g.name).toLowerCase() === String(row.name).toLowerCase())) {
          return response({ message: 'duplicate key value violates unique constraint "patient_groups_provider_name_ci_idx"' }, 409);
        }
        const created = { id: "44444444-4444-4444-8444-444444444444", created_at: "2026-02-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z", ...row };
        groups.push(created); return response([created], 201);
      }
      if (members.some((m) => m.group_id === row.group_id && m.patient_id === row.patient_id)) return response({ message: "duplicate key" }, 409);
      members.push(row); return response([row], 201);
    }
    if (method === "PATCH") {
      const hit = store.filter((row) => matches(row, url.searchParams));
      for (const row of hit) Object.assign(row, body as Row);
      return response(hit);
    }
    if (method === "DELETE") {
      const hit = store.filter((row) => matches(row, url.searchParams));
      if (table === "patient_groups") {
        groups = groups.filter((row) => !hit.includes(row));
        members = members.filter((row) => !hit.some((g) => g.id === row.group_id));
      } else members = members.filter((row) => !hit.includes(row));
      return response(hit);
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
});

describe("listing office patient groups", () => {
  it("returns the office's groups with member counts, alphabetically, and never another office's", async () => {
    scope.mockResolvedValue(ownerScope);
    const res = await call("/office/patient-groups");
    expect(res.status).toBe(200);
    const body = await res.json() as { canEdit: boolean; groups: Array<Row> };
    expect(body.canEdit).toBe(true);
    expect(body.groups).toEqual([
      expect.objectContaining({ id: G1, name: "MJH", description: "Employer cohort", memberCount: 2 }),
      expect.objectContaining({ id: G2, name: "Tuesday clinic", description: null, memberCount: 0 }),
    ]);
    expect(scope.mock.calls[0][0]).toMatchObject({ hqPermission: "provider_read", requireUnlocked: false });
  });
  it("tells HQ drill-in it cannot edit and passes the explicit office through", async () => {
    scope.mockResolvedValue(hqScope);
    const body = await (await call("/office/patient-groups?office=p1")).json() as { canEdit: boolean };
    expect(body.canEdit).toBe(false);
    expect(scope.mock.calls[0][0].explicitOfficeId).toBe("p1");
  });
  it("surfaces scope refusals and database failures loudly", async () => {
    scope.mockResolvedValue(lockedDenied);
    expect((await call("/office/patient-groups")).status).toBe(403);
    scope.mockResolvedValue(ownerScope);
    admin.mockResolvedValue(response({ message: "down" }, 500));
    expect((await call("/office/patient-groups")).status).toBe(502);
  });
});

describe("creating, renaming and deleting groups", () => {
  it("creates a group for any office role, trims the name, and audits it", async () => {
    scope.mockResolvedValue(staffScope);
    const res = await call("/office/patient-groups", "POST", { name: "  Evening cohort ", description: "" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ group: expect.objectContaining({ name: "Evening cohort", description: null, memberCount: 0 }) });
    expect(scope.mock.calls[0][0]).toMatchObject({ hqPermission: "provider_manage", requireUnlocked: true });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "patient_group_created", actorKind: "team_member", providerId: "p1", targetKind: "patient_group" }));
  });
  it("answers 409 for a case-insensitive duplicate name, from the pre-check and from the index race", async () => {
    scope.mockResolvedValue(ownerScope);
    const res = await call("/office/patient-groups", "POST", { name: "mjh" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "A group with that name already exists." });
    insertConflict = true;
    expect((await call("/office/patient-groups", "POST", { name: "Brand new" })).status).toBe(409);
    expect(audit).not.toHaveBeenCalled();
  });
  it("validates the name and description before any scope lookup", async () => {
    expect((await call("/office/patient-groups", "POST", { name: "   " })).status).toBe(400);
    expect((await call("/office/patient-groups", "POST", { name: "x".repeat(61) })).status).toBe(400);
    expect((await call("/office/patient-groups", "POST", { name: "ok", description: "d".repeat(201) })).status).toBe(400);
    expect((await call(`/office/patient-groups/${G1}`, "PATCH", {})).status).toBe(400);
    expect(scope).not.toHaveBeenCalled();
  });
  it("renames and re-describes a group, refusing a clash with a sibling but not with itself", async () => {
    scope.mockResolvedValue(ownerScope);
    expect((await call(`/office/patient-groups/${G2}`, "PATCH", { name: "MJH" })).status).toBe(409);
    const same = await call(`/office/patient-groups/${G1}`, "PATCH", { name: "mjh", description: "Updated" });
    expect(same.status).toBe(200);
    expect(await same.json()).toEqual({ group: expect.objectContaining({ id: G1, name: "mjh", description: "Updated", memberCount: 2 }) });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "patient_group_renamed", targetId: G1, metadata: expect.objectContaining({ fields: "name,description" }) }));
  });
  it("deletes a group with its member count and audits how many patients it held", async () => {
    scope.mockResolvedValue(ownerScope);
    const res = await call(`/office/patient-groups/${G1}`, "DELETE");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, memberCount: 2 });
    expect(groups.some((g) => g.id === G1)).toBe(false);
    expect(members.some((m) => m.group_id === G1)).toBe(false);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "patient_group_deleted", metadata: expect.objectContaining({ patients: 2 }) }));
  });
  it("answers a neutral 404 for an unknown group, a malformed id, and another office's group", async () => {
    scope.mockResolvedValue(ownerScope);
    for (const id of ["99999999-9999-4999-8999-999999999999", "not-a-uuid", G_OTHER]) {
      expect((await call(`/office/patient-groups/${id}`, "PATCH", { name: "x" })).status, id).toBe(404);
      expect((await call(`/office/patient-groups/${id}`, "DELETE")).status, id).toBe(404);
    }
    expect(groups).toHaveLength(3);
    expect(audit).not.toHaveBeenCalled();
  });
  it("refuses every write for HQ drill-in and for locked offices", async () => {
    scope.mockResolvedValue(hqScope);
    const writes: Array<[string, string, unknown?]> = [
      ["/office/patient-groups?office=p1", "POST", { name: "New" }],
      [`/office/patient-groups/${G1}?office=p1`, "PATCH", { name: "New" }],
      [`/office/patient-groups/${G1}?office=p1`, "DELETE"],
      [`/office/patient-groups/${G1}/members/pat-3?office=p1`, "PUT"],
      [`/office/patient-groups/${G1}/members/pat-1?office=p1`, "DELETE"],
    ];
    for (const [path, method, body] of writes) {
      const res = await call(path, method, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json()).toEqual({ error: "HQ can view office groups but not change them." });
    }
    scope.mockResolvedValue(lockedDenied);
    for (const [path, method, body] of writes) expect((await call(path, method, body)).status, `${method} ${path}`).toBe(403);
    expect(admin).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(members).toHaveLength(3);
  });
});

describe("group membership", () => {
  it("adds an office patient to a group once, audits the add, and is idempotent", async () => {
    scope.mockResolvedValue(staffScope);
    const first = await call(`/office/patient-groups/${G2}/members/pat-3`, "PUT");
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ membership: { groupId: G2, patientId: "pat-3", added: true } });
    expect(members.find((m) => m.group_id === G2)).toMatchObject({ patient_id: "pat-3", provider_id: "p1", added_by: "t1" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "patient_group_member_added", targetId: G2, metadata: { groupId: G2, patientId: "pat-3" } }));
    audit.mockClear();
    const again = await call(`/office/patient-groups/${G2}/members/pat-3`, "PUT");
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ membership: { groupId: G2, patientId: "pat-3", added: false } });
    expect(audit).not.toHaveBeenCalled();
    expect(members.filter((m) => m.group_id === G2)).toHaveLength(1);
  });
  it("gives another office's patient, an archived patient, and an unknown group the neutral 404", async () => {
    scope.mockResolvedValue(ownerScope);
    expect((await call(`/office/patient-groups/${G1}/members/pat-x`, "PUT")).status).toBe(404);
    expect((await call(`/office/patient-groups/${G1}/members/pat-gone`, "PUT")).status).toBe(404);
    expect((await call(`/office/patient-groups/${G1}/members/nobody`, "PUT")).status).toBe(404);
    expect((await call(`/office/patient-groups/${G_OTHER}/members/pat-1`, "PUT")).status).toBe(404);
    expect(members).toHaveLength(3);
    expect(audit).not.toHaveBeenCalled();
  });
  it("removes a member, audits the removal, and stays quiet when there was nothing to remove", async () => {
    scope.mockResolvedValue(ownerScope);
    const res = await call(`/office/patient-groups/${G1}/members/pat-2`, "DELETE");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ membership: { groupId: G1, patientId: "pat-2", removed: true } });
    expect(members.filter((m) => m.group_id === G1)).toHaveLength(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "patient_group_member_removed", metadata: { groupId: G1, patientId: "pat-2" } }));
    audit.mockClear();
    const again = await call(`/office/patient-groups/${G1}/members/pat-2`, "DELETE");
    expect(await again.json()).toEqual({ membership: { groupId: G1, patientId: "pat-2", removed: false } });
    expect(audit).not.toHaveBeenCalled();
    // Another office's group is unknown here even when the patient id is real.
    expect((await call(`/office/patient-groups/${G_OTHER}/members/pat-x`, "DELETE")).status).toBe(404);
    expect(members.some((m) => m.group_id === G_OTHER)).toBe(true);
  });
});
