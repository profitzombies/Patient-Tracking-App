import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveOfficeScope = vi.hoisted(() => vi.fn());
vi.mock("../auth/office-scope", () => ({
  resolveOfficeScope,
  canManageOffice: (scope: { officeRole: string }) => scope.officeRole !== "staff",
  respondOfficeScopeDenied: (_req: unknown, res: { status: (status: number) => { json: (body: unknown) => void } }, denied: { status: number; message: string }) =>
    res.status(denied.status).json({ error: denied.message }),
}));
import { requireOfficeBillingScope } from "./auth";

function response() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { status, json } as any;
}
const request = { body: {}, query: {}, headers: { authorization: "Bearer token" } } as any;
const staff = {
  kind: "ok", scope: {
    providerId: "office-1", officeName: "Harbor", actorUserId: "user-1", actorKind: "team_member",
    officeRole: "staff", canManage: false,
  },
};

beforeEach(() => resolveOfficeScope.mockReset());

describe("office billing sell scope", () => {
  it("allows active staff only when sell is requested and leaves HQ permissions unchanged", async () => {
    resolveOfficeScope.mockResolvedValue(staff);
    await expect(requireOfficeBillingScope(request, response(), { write: true, sell: true })).resolves.toMatchObject({ officeRole: "staff" });

    const denied = response();
    await expect(requireOfficeBillingScope(request, denied, { write: true })).resolves.toBeNull();
    expect(denied.status).toHaveBeenCalledWith(403);

    resolveOfficeScope.mockResolvedValueOnce({ ...staff, scope: { ...staff.scope, actorKind: "hq" } });
    await expect(requireOfficeBillingScope(request, response(), { write: true, sell: true })).resolves.toMatchObject({ isHq: true });
    expect(resolveOfficeScope).toHaveBeenLastCalledWith(expect.objectContaining({ hqPermission: "provider_manage", requireUnlocked: true }));
  });
});