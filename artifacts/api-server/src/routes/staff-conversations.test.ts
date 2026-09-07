import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ scope: vi.fn(), admin: vi.fn(), audit: vi.fn() }));
vi.mock("../auth/office-scope", () => ({ resolveOfficeScope: mocks.scope }));
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("../lib/admin-audit", () => ({ recordAdminAuditEvent: mocks.audit }));
vi.mock("../lib/staff-auth", () => ({
  hasHqPermission: vi.fn(() => true),
  verifyStaffToken: vi.fn(),
}));
import router, { autoCloseCutoff, conversationStatus } from "./staff-conversations";
import { invalidateOrgPolicyCache } from "../lib/org-policy";

let server: http.Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use(router);
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  mocks.scope.mockReset().mockResolvedValue({
    kind: "ok",
    scope: { providerId: "office-a", officeName: "Office A", actorUserId: "u", actorKind: "hq" },
  });
  mocks.admin.mockReset();
});

describe("inbox auto-close policy", () => {
  const settingsRow = (days: number) => ({ conversation_auto_close_days: days, version: 1 });
  const conversationRow = (id: string, updatedAt: string) => ({
    id, patient_id: "p", thread: "coach", created_at: "2026-08-01T00:00:00Z", updated_at: updatedAt,
    patients: { provider_id: "office-a", first_name: "Dana", last_name: "Lee", name: null },
    patient_chat_messages: [{ count: 3 }],
  });
  const script = (days: number, rows: unknown[]) =>
    mocks.admin.mockImplementation(async (_method: string, path: string) => {
      if (path.startsWith("/rest/v1/hq_organization_settings")) return { status: 200, json: [settingsRow(days)], contentRange: null };
      if (path.startsWith("/rest/v1/patient_chat_conversations")) return { status: 200, json: rows, contentRange: `0-${rows.length - 1}/${rows.length}` };
      throw new Error(`unexpected ${path}`);
    });
  const list = async (query = "") => {
    const response = await fetch(`${base}/office/conversations?office=office-a${query}`, { headers: { authorization: "Bearer hq" } });
    return { status: response.status, json: (await response.json()) as { conversations: Array<{ id: string; status: string }>; autoCloseDays: number } };
  };

  it("derives open/closed from the organization's auto-close window", () => {
    const now = new Date("2026-09-07T12:00:00Z");
    expect(conversationStatus("2026-09-01T12:00:00Z", now, 14)).toBe("open");
    expect(conversationStatus("2026-08-24T12:00:00Z", now, 14)).toBe("closed");
    expect(conversationStatus("2026-08-24T12:00:01Z", now, 14)).toBe("open");
    expect(conversationStatus("2026-09-01T12:00:00Z", now, 3)).toBe("closed");
    expect(conversationStatus(null, now, 14)).toBe("open");
    expect(autoCloseCutoff(now, 3)).toBe("2026-09-04T12:00:00.000Z");
  });

  it("labels rows with the HQ window and reports the window to the inbox", async () => {
    invalidateOrgPolicyCache();
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const stale = new Date(Date.now() - 10 * 86_400_000).toISOString();
    script(7, [conversationRow("11111111-1111-4111-8111-111111111111", recent), conversationRow("22222222-2222-4222-8222-222222222222", stale)]);
    const { status, json } = await list();
    expect(status).toBe(200);
    expect(json.autoCloseDays).toBe(7);
    expect(json.conversations.map((c) => c.status)).toEqual(["open", "closed"]);
    // No status filter: nothing added to the query.
    const query = mocks.admin.mock.calls.find(([, path]) => String(path).startsWith("/rest/v1/patient_chat_conversations"))![1] as string;
    expect(query).not.toContain("updated_at=");
  });

  it("filters open/closed server-side against the policy cutoff", async () => {
    invalidateOrgPolicyCache();
    script(3, []);
    await list("&status=open");
    let query = mocks.admin.mock.calls.find(([, path]) => String(path).startsWith("/rest/v1/patient_chat_conversations"))![1] as string;
    expect(query).toContain("updated_at=gte.");
    const cutoff = decodeURIComponent(query.match(/updated_at=gte\.([^&]+)/)![1]);
    expect(Date.now() - Date.parse(cutoff)).toBeGreaterThanOrEqual(3 * 86_400_000 - 5_000);
    expect(Date.now() - Date.parse(cutoff)).toBeLessThan(3 * 86_400_000 + 60_000);
    mocks.admin.mockClear();
    await list("&status=closed");
    query = mocks.admin.mock.calls.find(([, path]) => String(path).startsWith("/rest/v1/patient_chat_conversations"))![1] as string;
    expect(query).toContain("updated_at=lt.");
    expect((await list("&status=sometimes")).status).toBe(400);
  });
});

describe("staff conversation office isolation", () => {
  it("returns a neutral 404 for a conversation outside the resolved office", async () => {
    mocks.admin.mockResolvedValue({ status: 200, json: [] });
    const response = await fetch(
      `${base}/office/conversations/00000000-0000-4000-8000-000000000002/events?office=office-a`,
      { headers: { authorization: "Bearer hq" } },
    );
    expect(response.status).toBe(404);
    expect(mocks.admin.mock.calls[0][1]).toContain("patients.provider_id=eq.office-a");
  });
});