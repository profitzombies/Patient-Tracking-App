import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ admin: vi.fn(), send: vi.fn(), audit: vi.fn() }));
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: m.admin }));
vi.mock("../claim/delivery", () => ({ sendProviderClaimInvitation: m.send }));
vi.mock("../lib/admin-audit", () => ({ recordAdminAuditEvent: m.audit }));
vi.mock("../lib/staff-auth", () => ({
  requireHqPermission: (permission: string) => (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (permission !== "provider_manage") { res.status(403).json({ error: "wrong permission" }); return; }
    res.locals.staff = { userId: "hq-admin" };
    next();
  },
}));
import router, { providerSignInUrl } from "./provider-accounts";

let server: http.Server;
let base = "";
let provider: Record<string, unknown> | null;
let locks: unknown[];

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let officeSeq = 0;
function nextOffice(): string {
  officeSeq += 1;
  return `office-${officeSeq}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPERATIONS_APP_URL", "https://ops.example.test/");
  provider = {
    provider_id: "x", provider_name: "Avery Owner", office_name: "Harbor Wellness", email: "Owner@Example.test",
    onboarding_code: "731942", auth_user_id: null, access_disabled: false, offboarding_status: "active",
  };
  locks = [];
  m.admin.mockImplementation(async (_method: string, path: string) => {
    if (path.startsWith("/rest/v1/providers?")) return { status: 200, json: provider ? [provider] : [] };
    if (path.startsWith("/rest/v1/provider_account_locks?")) return { status: 200, json: locks };
    return { status: 500, json: null };
  });
  m.send.mockResolvedValue(undefined);
  m.audit.mockResolvedValue(undefined);
});

const resend = (id: string) => fetch(`${base}/provider-accounts/${id}/welcome/resend`, { method: "POST" });

describe("HQ re-send of the owner welcome email", () => {
  it("links the operations sign-in page", () => {
    expect(providerSignInUrl()).toBe("https://ops.example.test/");
  });

  it("re-sends to an unclaimed owner with the sign-in link and audits it", async () => {
    const id = nextOffice();
    const res = await resend(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ invitation: "sent" });
    expect(m.send).toHaveBeenCalledWith("owner@example.test", {
      officeName: "Harbor Wellness", providerName: "Avery Owner", providerCode: "731942", signInUrl: "https://ops.example.test/",
    });
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "provider_welcome_resent", actorUserId: "hq-admin", providerId: id, metadata: { invitation: "sent" },
    }));
  });

  it("reports not_configured and failed truthfully", async () => {
    const notConfigured = Object.assign(new Error("no email"), { name: "DeliveryNotConfiguredError" });
    m.send.mockRejectedValueOnce(notConfigured);
    expect(await (await resend(nextOffice())).json()).toEqual({ invitation: "not_configured" });
    m.send.mockRejectedValueOnce(new Error("resend 500"));
    expect(await (await resend(nextOffice())).json()).toEqual({ invitation: "failed" });
  });

  it("fails without sending when there is no operations address to link", async () => {
    vi.stubEnv("OPERATIONS_APP_URL", "");
    vi.stubEnv("REPLIT_DEV_DOMAIN", "");
    expect(await (await resend(nextOffice())).json()).toEqual({ invitation: "failed" });
    expect(m.send).not.toHaveBeenCalled();
  });

  it.each([
    ["an owner who already signed in", () => { provider!.auth_user_id = "user-1"; }, 409],
    ["an offboarding office", () => { provider!.offboarding_status = "offboarding"; }, 409],
    ["a disabled office", () => { provider!.access_disabled = true; }, 409],
    ["a locked office", () => { locks = [{ account_id: "acct-x" }]; }, 409],
    ["a missing owner email", () => { provider!.email = null; }, 409],
    ["an unknown office", () => { provider = null; }, 404],
  ])("refuses %s without sending", async (_label, arrange, status) => {
    arrange();
    const res = await resend(nextOffice());
    expect(res.status).toBe(status);
    expect(m.send).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("answers 502 when the account cannot be read", async () => {
    m.admin.mockResolvedValue({ status: 500, json: null });
    expect((await resend(nextOffice())).status).toBe(502);
    expect(m.send).not.toHaveBeenCalled();
  });

  it("rate-limits repeated re-sends for the same office", async () => {
    const id = nextOffice();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await resend(id)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(m.send).toHaveBeenCalledTimes(3);
    // A different office has its own allowance.
    expect((await resend(nextOffice())).status).toBe(200);
  });
});
