import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  provider: { provider_id: "office-1", provider_name: "Riverside Wellness", email: "owner@example.com", auth_user_id: "owner-user", access_disabled: false, offboarding_status: "active" } as Row | null,
  members: [{ id: "member-1", name: "Sam Staff", email: "sam@example.com", office_role: "staff", auth_user_id: "staff-user" }] as Row[],
  flags: [] as Row[],
  notifications: [] as Row[],
  mode: "all" as string,
  selected: [] as string[],
  zone: null as string | null,
}));
vi.mock("../lib/supabase-admin", () => ({
  supabaseAdmin: vi.fn(async (method: string, path: string, body?: unknown) => {
    const url = new URL(`http://fake${path}`); const table = url.pathname.split("/").pop();
    if (table === "providers") return { status: 200, json: db.provider ? [db.provider] : [] };
    if (table === "team_members") return { status: 200, json: db.members };
    if (table === "coach_chat_flags") {
      if (method === "GET") {
        const category = url.searchParams.get("category")?.replace("eq.", "");
        const since = url.searchParams.get("created_at")?.replace("gte.", "") ?? "";
        return { status: 200, json: db.flags.filter((row) => row.category === category && row.status === "open" && String(row.created_at) >= since) };
      }
      const rows = (body as Row[]).map((row, index) => ({ ...row, id: `flag-${db.flags.length + index + 1}` }));
      db.flags.push(...rows); return { status: 201, json: rows };
    }
    if (table === "staff_notifications") {
      const fresh = (body as Row[]).filter((row) => !db.notifications.some((old) => old.dedupe_key === row.dedupe_key));
      db.notifications.push(...fresh); return { status: 201, json: fresh };
    }
    throw new Error(`unexpected ${method} ${path}`);
  }),
}));
vi.mock("../lib/org-policy", async (original) => {
  const actual = await original<typeof import("../lib/org-policy")>();
  return {
    ...actual,
    loadOrgPolicy: vi.fn(async () => ({ ...actual.DEFAULT_ORG_POLICY, defaultTimezone: "America/New_York" })),
    loadOfficeOverrides: vi.fn(async (providerId: string) => ({ ...actual.NO_OVERRIDES(providerId), alertRecipientMode: db.mode, alertRecipientMemberIds: db.selected, alertTimeZone: db.zone })),
  };
});

import { recordCoachChatFlag } from "./coach-chat-flags";

// 23:30 New York on Oct 11 (03:30Z Oct 12): the office-local day must win.
const NOW = new Date("2026-10-12T03:30:00.000Z");
const input = { patientId: "patient-1", providerId: "office-1", conversationId: "conv-1", finding: { category: "self_harm" as const, reason: "Expressed a wish to not wake up." }, messageText: "  honestly I   wish I just wouldn't wake up tomorrow  ", now: NOW };

beforeEach(() => {
  db.provider = { provider_id: "office-1", provider_name: "Riverside Wellness", email: "owner@example.com", auth_user_id: "owner-user", access_disabled: false, offboarding_status: "active" };
  db.flags = []; db.notifications = []; db.mode = "all"; db.selected = []; db.zone = null;
});

describe("recordCoachChatFlag", () => {
  it("stores the flag with its excerpt and queues PHI-free email + push for every alert recipient", async () => {
    const result = await recordCoachChatFlag(input);
    expect(result).toEqual({ outcome: "recorded", flagId: "flag-1", deliveriesQueued: 4 });
    expect(db.flags[0]).toMatchObject({ patient_id: "patient-1", provider_id: "office-1", conversation_id: "conv-1", category: "self_harm", status: "open", message_excerpt: "honestly I wish I just wouldn't wake up tomorrow", created_at: NOW.toISOString() });
    expect(db.notifications.map((row) => `${row.auth_user_id}:${row.channel}`).sort()).toEqual(["owner-user:email", "owner-user:push", "staff-user:email", "staff-user:push"]);
    const email = db.notifications.find((row) => row.auth_user_id === "staff-user" && row.channel === "email")!;
    expect(email).toMatchObject({ kind: "coach_chat_flag", category: "staff_alerts", email: "sam@example.com", dedupe_key: "coach_chat_flag:office-1:patient-1:2026-10-11:staff-user:email" });
    expect(email.data).toEqual({ flagId: "flag-1", providerId: "office-1", officeName: "Riverside Wellness", recipientName: "Sam Staff", day: "2026-10-11" });
    // Only title, body and data leave the server; none of them may say who or what.
    for (const row of db.notifications) {
      const outbound = JSON.stringify({ title: row.title, body: row.body, data: row.data }).toLowerCase();
      for (const fragment of ["patient-1", "self_harm", "wake up", "wish", "conv-1", "pat "]) expect(outbound).not.toContain(fragment);
    }
    expect(db.notifications.find((row) => row.auth_user_id === "owner-user" && row.channel === "push")).toMatchObject({ email: null, title: "A patient's chat needs review" });
  });
  it("skips a repeat of the same open category inside a day but records a new category", async () => {
    await recordCoachChatFlag(input);
    expect(await recordCoachChatFlag({ ...input, now: new Date(NOW.getTime() + 60_000), messageText: "still feel that way" })).toEqual({ outcome: "skipped_duplicate" });
    const other = await recordCoachChatFlag({ ...input, now: new Date(NOW.getTime() + 60_000), finding: { category: "medication_problem", reason: "Doubled a dose." } });
    expect(other).toMatchObject({ outcome: "recorded", flagId: "flag-2", deliveriesQueued: 0 });
    expect(db.flags).toHaveLength(2);
    expect(db.notifications).toHaveLength(4);
  });
  it("records again once the earlier flag is reviewed or a day has passed", async () => {
    await recordCoachChatFlag(input);
    db.flags[0]!.status = "reviewed";
    expect(await recordCoachChatFlag({ ...input, now: new Date(NOW.getTime() + 60_000) })).toMatchObject({ outcome: "recorded", flagId: "flag-2" });
    expect(await recordCoachChatFlag({ ...input, now: new Date(NOW.getTime() + 25 * 60 * 60_000) })).toMatchObject({ outcome: "recorded", flagId: "flag-3", deliveriesQueued: 4 });
  });
  it("narrows recipients by the office's digest recipient mode", async () => {
    db.mode = "owners_admins";
    expect(await recordCoachChatFlag(input)).toMatchObject({ deliveriesQueued: 2 });
    expect(db.notifications.every((row) => row.auth_user_id === "owner-user")).toBe(true);
    db.flags = []; db.notifications = []; db.mode = "selected"; db.selected = ["member-1"];
    expect(await recordCoachChatFlag(input)).toMatchObject({ deliveriesQueued: 2 });
    expect(db.notifications.every((row) => row.auth_user_id === "staff-user")).toBe(true);
  });
  it("records nothing for an office that is offboarding or disabled", async () => {
    db.provider = { ...db.provider!, offboarding_status: "offboarding" };
    expect(await recordCoachChatFlag(input)).toEqual({ outcome: "skipped_office_inactive" });
    db.provider = { ...db.provider!, offboarding_status: "active", access_disabled: true };
    expect(await recordCoachChatFlag(input)).toEqual({ outcome: "skipped_office_inactive" });
    expect(db.flags).toHaveLength(0);
    expect(db.notifications).toHaveLength(0);
  });
  it("uses the office's own alert time zone for the day key when set", async () => {
    db.zone = "UTC";
    await recordCoachChatFlag(input);
    expect(db.notifications[0]!.dedupe_key).toContain(":2026-10-12:");
  });
});
