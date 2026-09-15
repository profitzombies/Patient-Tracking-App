import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobContext } from "../types";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  providers: [] as Row[], patients: [] as Row[], members: [] as Row[], digests: [] as Row[], notifications: [] as Row[],
  mode: "all" as "all" | "owners_admins" | "selected", selected: [] as string[], sendTime: "08:00", zone: "America/New_York",
  items: [] as Row[],
}));
vi.mock("../../lib/org-policy", async (original) => {
  const actual = await original<typeof import("../../lib/org-policy")>();
  return {
    ...actual,
    loadOrgPolicy: vi.fn(async () => ({ ...actual.DEFAULT_ORG_POLICY, defaultTimezone: "America/New_York" })),
    loadOfficeOverrides: vi.fn(async (providerId: string) => ({
      ...actual.NO_OVERRIDES(providerId), alertRecipientMode: db.mode,
      alertRecipientMemberIds: db.selected, alertSendTime: db.sendTime, alertTimeZone: db.zone,
    })),
  };
});
vi.mock("../../lib/office-attention", () => ({
  loadOfficeAttention: vi.fn(async () => ({ asOf: "2026-10-11", items: db.items })),
}));
vi.mock("../../lib/supabase-admin", () => ({
  supabaseAdmin: vi.fn(async (method: string, path: string, body?: unknown) => {
    const url = new URL(`http://fake${path}`);
    if (url.pathname.endsWith("/providers")) return { status: 200, json: db.providers };
    if (url.pathname.endsWith("/patients")) return { status: 200, json: db.patients };
    if (url.pathname.endsWith("/team_members")) return { status: 200, json: db.members.filter((r) => r.activation_status !== "disabled" && r.auth_user_id) };
    if (url.pathname.endsWith("/office_attention_digests")) {
      if (method === "GET") return { status: 200, json: db.digests.filter((r) => path.includes(String(r.digest_date))) };
      const incoming = (body as Row[])[0]!;
      if (db.digests.some((r) => r.provider_id === incoming.provider_id && r.digest_date === incoming.digest_date)) return { status: 201, json: [] };
      db.digests.push(incoming); return { status: 201, json: [incoming] };
    }
    if (url.pathname.endsWith("/staff_notifications")) {
      for (const row of body as Row[]) if (!db.notifications.some((old) => old.dedupe_key === row.dedupe_key)) db.notifications.push(row);
      return { status: 201, json: body };
    }
    throw new Error(`unexpected ${method} ${path}`);
  }),
}));
import { runStaffAttentionDigest } from "./staff-attention-digest";

function context(at = "2026-10-11T13:00:00.000Z", dryRun = false): JobContext & { counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  return {
    dryRun, now: new Date(at), counts, leaseLost: false,
    tally(key, by = 1) { counts[key] = (counts[key] ?? 0) + by; },
    failItem(item, error) { throw new Error(`${item}: ${String(error)}`); },
    log() {}, checkpoint() {},
  };
}
beforeEach(() => {
  Object.assign(db, {
    providers: [{ provider_id: "office-1", provider_name: "Office", email: "owner@example.com", auth_user_id: "owner-user" }],
    patients: [{ provider_id: "office-1" }],
    members: [
      { id: "admin", auth_user_id: "admin-user", email: "admin@example.com", office_role: "admin", activation_status: "active" },
      { id: "staff", auth_user_id: "staff-user", email: "staff@example.com", office_role: "staff", activation_status: "active" },
      { id: "disabled", auth_user_id: "disabled-user", email: "disabled@example.com", office_role: "staff", activation_status: "disabled" },
      { id: "unclaimed", auth_user_id: null, email: "new@example.com", office_role: "staff", activation_status: "active" },
    ],
    digests: [], notifications: [], mode: "all", selected: [], sendTime: "08:00", zone: "America/New_York",
    items: [{ patientId: "patient-1", name: "Pat", reasons: [], signature: "no_meals" }],
  });
});
describe("staff attention digest job", () => {
  it("gates on office-local send time", async () => {
    await runStaffAttentionDigest(context("2026-10-11T11:59:00.000Z"));
    expect(db.digests).toHaveLength(0);
    await runStaffAttentionDigest(context("2026-10-11T12:01:00.000Z"));
    expect(db.digests).toHaveLength(1);
  });
  it("is idempotent per office/day and uses recipient/channel dedupe keys", async () => {
    const ctx = context(); await runStaffAttentionDigest(ctx); await runStaffAttentionDigest(context());
    expect(db.digests).toHaveLength(1); expect(db.notifications).toHaveLength(6);
    expect(new Set(db.notifications.map((r) => r.dedupe_key)).size).toBe(6);
    expect(db.notifications[0]?.dedupe_key).toMatch(/^staff_attention:office-1:2026-10-11:owner-user:(email|push)$/);
    expect((db.notifications[0]?.data as Row).patients).toEqual([{ patientId: "patient-1", name: "Pat", reasons: [] }]);
  });
  it.each([
    ["all", [], ["owner-user", "admin-user", "staff-user"]],
    ["owners_admins", [], ["owner-user", "admin-user"]],
    ["selected", ["owner", "staff"], ["owner-user", "staff-user"]],
  ] as const)("resolves %s recipients", async (mode, selected, expected) => {
    db.mode = mode; db.selected = [...selected]; await runStaffAttentionDigest(context());
    expect([...new Set(db.notifications.map((r) => String(r.auth_user_id)))]).toEqual(expected);
  });
  it("writes a zero-item digest and no notifications", async () => {
    db.items = []; await runStaffAttentionDigest(context());
    expect(db.digests[0]).toMatchObject({ flagged_count: 0, items: [] }); expect(db.notifications).toEqual([]);
  });
  it("keeps dry runs write-neutral", async () => {
    const ctx = context("2026-10-11T13:00:00.000Z", true); await runStaffAttentionDigest(ctx);
    expect(ctx.counts.officesDue).toBe(1); expect(db.digests).toEqual([]); expect(db.notifications).toEqual([]);
  });
  it("does not apply teammate opt-outs while enqueueing", async () => {
    await runStaffAttentionDigest(context());
    expect(db.notifications.filter((r) => r.auth_user_id === "staff-user").map((r) => r.channel).sort()).toEqual(["email", "push"]);
  });
});