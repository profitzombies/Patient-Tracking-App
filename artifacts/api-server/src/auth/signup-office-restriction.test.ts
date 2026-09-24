/**
 * A restricted office enrolls no one new.
 *
 * Every route a patient could use to join an office resolves the office
 * through the signup directory first — the code a patient types, and the
 * provider id a half-finished signup carries. Both must refuse while the
 * office is narrowed for nonpayment, and both must say only that the code
 * does not work: a patient is never told about the office's billing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), restricted: vi.fn(), locked: vi.fn() }));

vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("../lib/office-restriction", () => ({ officeRestrictedForNonpayment: mocks.restricted }));

import { resolveSignupOffice, resolveSignupOfficeById } from "./directory";

const OFFICE = {
  provider_id: "12345",
  provider_name: "Beacon Hill",
  office_name: "Beacon Hill Aesthetics",
  email: "front@beacon.example",
  access_disabled: false,
  offboarding_status: null,
  auth_user_id: "user-1",
};

beforeEach(() => {
  mocks.restricted.mockReset().mockResolvedValue(false);
  mocks.locked.mockReset().mockResolvedValue(false);
  mocks.admin.mockReset().mockImplementation(async (_method: string, path: string) => {
    if (path.startsWith("/rest/v1/provider_account_locks")) {
      return { status: 200, json: (await mocks.locked()) ? [{ account_id: "12345" }] : [] };
    }
    if (path.startsWith("/rest/v1/providers")) return { status: 200, json: [OFFICE] };
    return { status: 200, json: [] };
  });
});

describe("enrollment into a restricted office", () => {
  it("resolves a paid office by code and by id", async () => {
    expect(await resolveSignupOffice("123456")).toEqual({
      providerId: "12345", officeName: "Beacon Hill Aesthetics",
    });
    expect(await resolveSignupOffice("12345")).toMatchObject({ providerId: "12345" });
    expect(await resolveSignupOfficeById("12345")).toMatchObject({ providerId: "12345" });
  });

  it("refuses the code while the office is restricted, and says nothing about billing", async () => {
    mocks.restricted.mockResolvedValue(true);
    expect(await resolveSignupOffice("123456")).toBeNull();
    expect(await resolveSignupOffice("12345")).toBeNull();
    // A signup already under way cannot be finished into the office either:
    // completion looks the office up by the id its ledger row recorded.
    expect(await resolveSignupOfficeById("12345")).toBeNull();
    expect(mocks.restricted).toHaveBeenCalledWith("12345");
  });

  it("enrolls again the moment the office pays, with no HQ action", async () => {
    mocks.restricted.mockResolvedValueOnce(true).mockResolvedValue(false);
    expect(await resolveSignupOffice("123456")).toBeNull();
    expect(await resolveSignupOffice("123456")).toMatchObject({ providerId: "12345" });
  });

  it("keeps the older states exactly as they were", async () => {
    mocks.locked.mockResolvedValue(true);
    expect(await resolveSignupOffice("123456")).toBeNull();
    mocks.locked.mockResolvedValue(false);
    mocks.admin.mockImplementation(async (_method: string, path: string) =>
      path.startsWith("/rest/v1/providers")
        ? { status: 200, json: [{ ...OFFICE, access_disabled: true }] }
        : { status: 200, json: [] });
    expect(await resolveSignupOffice("123456")).toBeNull();
    // A disabled office is refused before the restriction is ever consulted.
    expect(mocks.restricted).not.toHaveBeenCalled();
  });
});
