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
import router from "./staff-conversations";

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