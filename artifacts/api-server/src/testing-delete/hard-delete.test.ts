/**
 * HQ testing hard delete — the orchestration around the SQL function:
 * Stripe outcomes (delete created accounts, deauthorize linked ones, detach
 * THINNR-plan payment methods, cancel patient subscriptions), the abort rule
 * (a failed subscription cancel deletes nothing), HQ-member protection, and
 * login + file clean-up. The SQL itself is proven in hard-delete.sql.test.ts.
 */
import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HardDeleteError,
  hardDeletePatient,
  hardDeleteProvider,
  namesMatch,
  previewPatient,
  previewProvider,
  type HardDeleteDeps,
} from "./hard-delete";

type Row = Record<string, unknown>;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PATIENT = uuid(1);
const PATIENT_2 = uuid(2);
const OWNER = uuid(101);
const STAFF_HQ = uuid(102);
const PATIENT_USER = uuid(103);

function matches(row: Row, params: URLSearchParams): boolean {
  for (const [key, raw] of params.entries()) {
    if (["select", "order", "limit", "offset"].includes(key)) continue;
    const value = row[key];
    if (raw.startsWith("eq.") && String(value ?? "") !== raw.slice(3)) return false;
    if (raw.startsWith("neq.") && String(value ?? "") === raw.slice(4)) return false;
    if (raw === "is.null" && value != null) return false;
    if (raw === "not.is.null" && value == null) return false;
    if (raw.startsWith("in.(") && !raw.slice(4, -1).split(",").map((v) => v.replace(/^"|"$/g, "")).includes(String(value))) return false;
  }
  return true;
}

function stripeError(code: string, message = code) {
  return new Stripe.errors.StripeInvalidRequestError({ message, code, type: "invalid_request_error", statusCode: 400 } as never);
}

function setup() {
  const tables: Record<string, Row[]> = {
    providers: [{ provider_id: "live-abc", office_name: "Harbor Test Spa", provider_name: "Dr. Harbor", auth_user_id: OWNER }],
    team_members: [{ provider_id: "live-abc", auth_user_id: STAFF_HQ }, { provider_id: "live-abc", auth_user_id: null }],
    profiles: [{ id: OWNER, provider_account_code: "live-abc" }],
    patients: [
      { id: PATIENT, first_name: "Pat", last_name: "Tester", email: "pat@example.com", provider_id: "live-abc", auth_user_id: PATIENT_USER },
      { id: PATIENT_2, first_name: "Quinn", last_name: null, email: null, provider_id: "live-abc", auth_user_id: null },
    ],
    hq_memberships: [{ auth_user_id: STAFF_HQ, status: "active" }],
    billing_connected_accounts: [{ provider_id: "live-abc", stripe_account_id: "acct_created", origin: "created", stripe_mode: "test", stripe_platform_account_id: "acct_platform", disconnected_at: null }],
    billing_connect_archive: [{ provider_id: "live-abc", stripe_mode: "test", platform_account_id: "acct_platform", account_snapshot: { stripe_account_id: "acct_linked", origin: "oauth" } }],
    billing_office_access_subscriptions: [{ id: "plan-1", provider_id: "live-abc", state: "active", stripe_customer_id: "cus_office", stripe_mode: "test", stripe_platform_account_id: "acct_platform" }],
    billing_office_access_instruments: [
      { id: "i1", subscription_id: "plan-1", provider_id: "live-abc", stripe_payment_method_id: "pm_card", detached_at: null, stripe_mode: "test", stripe_platform_account_id: "acct_platform" },
      { id: "i2", subscription_id: "plan-1", provider_id: "live-abc", stripe_payment_method_id: "pm_old", detached_at: "2026-09-01T00:00:00Z", stripe_mode: "test", stripe_platform_account_id: "acct_platform" },
    ],
    billing_subscriptions: [{ id: "sub-row", provider_id: "live-abc", patient_id: PATIENT, status: "active", stripe_subscription_id: "sub_1", stripe_mode: "test", stripe_platform_account_id: "acct_platform" }],
    billing_payers: [{ provider_id: "live-abc", patient_id: PATIENT, stripe_customer_id: "cus_patient", stripe_mode: "test", stripe_platform_account_id: "acct_platform" }],
  };
  let rpcResult: { status: number; json: unknown } = {
    status: 200,
    json: {
      patientIds: [PATIENT, PATIENT_2], authUserIds: [OWNER, PATIENT_USER], preservedUserIds: [STAFF_HQ],
      objectPaths: [`/objects/patient-media/${PATIENT}/a.jpg`, "/objects/exports/exp-1/part.zip", "/objects/elsewhere/x.png"],
      exportIds: ["exp-1"], tables: { patients: 2, providers: 1 },
    },
  };
  const stripe = {
    accounts: { del: vi.fn(async (_id: string) => ({ deleted: true })) },
    oauth: { deauthorize: vi.fn(async (_input: unknown) => ({})) },
    subscriptions: { cancel: vi.fn(async (..._args: unknown[]) => ({})) },
    customers: { del: vi.fn(async (..._args: unknown[]) => ({ deleted: true })) },
    paymentMethods: { detach: vi.fn(async (_id: string) => ({})) },
  };
  const calls = { rpc: [] as unknown[], identities: [] as string[], authDeletes: [] as string[], prefixes: [] as string[], objects: [] as string[] };
  const deps: HardDeleteDeps = {
    async rest(method, path, body) {
      const url = new URL(path, "http://fake");
      if (url.pathname === "/rest/v1/rpc/hq_testing_hard_delete") {
        calls.rpc.push(body);
        return rpcResult;
      }
      const table = url.pathname.replace("/rest/v1/", "");
      if (method !== "GET") throw new Error(`unexpected ${method} ${path}`);
      return { status: 200, json: (tables[table] ?? []).filter((row) => matches(row, url.searchParams)) };
    },
    async withStripe(identity, fn) {
      calls.identities.push(`${identity.mode}:${identity.platformAccountId}`);
      return fn(stripe as never);
    },
    connectClientId: () => "ca_test123",
    defaultPlatform: async () => "acct_platform",
    async deleteAuthUser(userId) { calls.authDeletes.push(userId); return "deleted"; },
    async deletePrefix(prefix) { calls.prefixes.push(prefix); return 2; },
    async deleteObject(path) { calls.objects.push(path); },
  };
  return { tables, stripe, calls, deps, setRpc: (value: typeof rpcResult) => { rpcResult = value; } };
}

let t: ReturnType<typeof setup>;
beforeEach(() => { t = setup(); });

describe("testing hard delete — previews", () => {
  it("counts staff logins (excluding HQ members), patients, and Stripe accounts", async () => {
    const preview = await previewProvider("live-abc", t.deps);
    expect(preview).toMatchObject({
      name: "Harbor Test Spa", staffLogins: 1, hqMembersKept: 1, patients: 2, patientLogins: 1,
      accessPlan: { state: "active", savedPaymentMethods: 1 },
    });
    expect(preview.stripeAccounts).toEqual([
      { accountId: "acct_created", origin: "created", mode: "test", archived: false },
      { accountId: "acct_linked", origin: "oauth", mode: "test", archived: true },
    ]);
  });

  it("names a patient from first + last name and 404s unknown targets", async () => {
    expect((await previewPatient(PATIENT, t.deps)).name).toBe("Pat Tester");
    expect((await previewPatient(PATIENT_2, t.deps)).name).toBe("Quinn");
    await expect(previewProvider("live-missing", t.deps)).rejects.toMatchObject({ status: 404 });
    await expect(previewPatient(uuid(99), t.deps)).rejects.toBeInstanceOf(HardDeleteError);
  });

  it("matches typed names ignoring case and spacing, never blank", () => {
    expect(namesMatch("  harbor   test SPA ", "Harbor Test Spa")).toBe(true);
    expect(namesMatch("Harbor Test", "Harbor Test Spa")).toBe(false);
    expect(namesMatch("", "")).toBe(false);
    expect(namesMatch(undefined, "x")).toBe(false);
  });
});

describe("testing hard delete — provider", () => {
  it("deletes the created account, disconnects the linked one, clears the THINNR plan, then rows, logins, files", async () => {
    const result = await hardDeleteProvider("live-abc", t.deps);
    expect(t.stripe.subscriptions.cancel).toHaveBeenCalledWith("sub_1", {}, { stripeAccount: "acct_created" });
    expect(t.stripe.accounts.del).toHaveBeenCalledWith("acct_created");
    expect(t.stripe.oauth.deauthorize).toHaveBeenCalledWith({ client_id: "ca_test123", stripe_user_id: "acct_linked" });
    expect(t.stripe.paymentMethods.detach).toHaveBeenCalledTimes(1);
    expect(t.stripe.paymentMethods.detach).toHaveBeenCalledWith("pm_card");
    expect(t.stripe.customers.del).toHaveBeenCalledWith("cus_office");
    expect(new Set(t.calls.identities)).toEqual(new Set(["test:acct_platform"]));
    expect(t.calls.rpc).toEqual([{ p_provider_id: "live-abc", p_patient_id: null }]);
    expect(result.stripe).toEqual(expect.arrayContaining([
      { kind: "patient_subscriptions", result: "cancelled", count: 1 },
      { kind: "connected_account", accountId: "acct_created", origin: "created", archived: false, result: "deleted" },
      { kind: "connected_account", accountId: "acct_linked", origin: "oauth", archived: true, result: "disconnected" },
      { kind: "access_payment_method", paymentMethodId: "pm_card", result: "removed" },
      { kind: "access_customer", customerId: "cus_office", result: "deleted" },
      { kind: "access_plan", result: "cancelled", state: "active" },
    ]));
    // HQ member STAFF_HQ is never deleted; only the ids the SQL returned.
    expect(t.calls.authDeletes).toEqual([OWNER, PATIENT_USER]);
    expect(result.logins).toEqual({ deleted: 2, alreadyGone: 0, keptHqMembers: 1, failed: [] });
    expect(t.calls.prefixes).toEqual([
      `/objects/patient-media/${PATIENT}/`, `/objects/patients/${PATIENT}/`,
      `/objects/patient-media/${PATIENT_2}/`, `/objects/patients/${PATIENT_2}/`,
      "/objects/exports/exp-1/",
    ]);
    expect(t.calls.objects).toEqual(["/objects/elsewhere/x.png"]);
    expect(result.files.failed).toEqual([]);
  });

  it("reports a Stripe refusal and already-gone objects without stopping the delete", async () => {
    t.stripe.accounts.del.mockRejectedValueOnce(stripeError("account_invalid", "Account has a balance"));
    t.stripe.oauth.deauthorize.mockRejectedValueOnce(stripeError("resource_missing"));
    t.stripe.paymentMethods.detach.mockRejectedValueOnce(stripeError("resource_missing"));
    const result = await hardDeleteProvider("live-abc", t.deps);
    expect(result.stripe).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: "acct_created", result: "refused", message: expect.stringContaining("Account has a balance") }),
      expect.objectContaining({ accountId: "acct_linked", result: "already_gone" }),
      { kind: "access_payment_method", paymentMethodId: "pm_card", result: "already_gone" },
    ]));
    expect(t.calls.rpc).toHaveLength(1);
  });

  it("deletes nothing when Stripe cannot cancel a live patient subscription", async () => {
    t.stripe.subscriptions.cancel.mockRejectedValueOnce(stripeError("api_error", "Stripe is down"));
    await expect(hardDeleteProvider("live-abc", t.deps)).rejects.toMatchObject({ status: 502 });
    expect(t.stripe.accounts.del).not.toHaveBeenCalled();
    expect(t.calls.rpc).toHaveLength(0);
    expect(t.calls.authDeletes).toHaveLength(0);
  });

  it("reports a disconnected office account as unreachable instead of blocking", async () => {
    t.tables.billing_connected_accounts[0].disconnected_at = "2026-09-01T00:00:00Z";
    const result = await hardDeleteProvider("live-abc", t.deps);
    expect(t.stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(result.stripe).toContainEqual(expect.objectContaining({ kind: "patient_subscriptions", result: "not_reachable", count: 1 }));
  });

  it("surfaces a database failure with the Stripe outcomes and removes no logins or files", async () => {
    t.setRpc({ status: 400, json: { message: "hard delete blocked by foreign keys on x" } });
    const error = await hardDeleteProvider("live-abc", t.deps).catch((e) => e);
    expect(error).toBeInstanceOf(HardDeleteError);
    expect(error.status).toBe(500);
    expect(error.message).toContain("blocked by foreign keys");
    expect(error.detail.stripe.length).toBeGreaterThan(0);
    expect(t.calls.authDeletes).toHaveLength(0);
    expect(t.calls.prefixes).toHaveLength(0);
  });

  it("collects login and file failures instead of hiding them", async () => {
    t.deps.deleteAuthUser = async (id) => { if (id === OWNER) throw new Error("login delete failed (500)"); return "absent"; };
    t.deps.deletePrefix = async (prefix) => { if (prefix.includes("exports")) throw new Error("storage down"); return 1; };
    const result = await hardDeleteProvider("live-abc", t.deps);
    expect(result.logins).toMatchObject({ deleted: 0, alreadyGone: 1 });
    expect(result.logins.failed[0]).toContain(OWNER);
    expect(result.files.failed[0]).toContain("/objects/exports/exp-1/");
  });
});

describe("testing hard delete — patient", () => {
  it("cancels the patient's subscription, deletes their Stripe customer, and never touches office Stripe", async () => {
    t.setRpc({ status: 200, json: { patientIds: [PATIENT], authUserIds: [PATIENT_USER], preservedUserIds: [], objectPaths: [], exportIds: [], tables: { patients: 1 } } });
    const result = await hardDeletePatient(PATIENT, t.deps);
    expect(t.stripe.subscriptions.cancel).toHaveBeenCalledWith("sub_1", {}, { stripeAccount: "acct_created" });
    expect(t.stripe.customers.del).toHaveBeenCalledWith("cus_patient", {}, { stripeAccount: "acct_created" });
    expect(t.stripe.accounts.del).not.toHaveBeenCalled();
    expect(t.stripe.paymentMethods.detach).not.toHaveBeenCalled();
    expect(t.calls.rpc).toEqual([{ p_provider_id: null, p_patient_id: PATIENT }]);
    expect(t.calls.authDeletes).toEqual([PATIENT_USER]);
    expect(result).toMatchObject({ kind: "patient", name: "Pat Tester", rows: { patients: 1 } });
  });

  it("keeps an HQ member's login when the patient is also on the HQ team", async () => {
    t.tables.hq_memberships.push({ auth_user_id: PATIENT_USER, status: "active" });
    expect((await previewPatient(PATIENT, t.deps)).hqMemberKept).toBe(true);
    t.setRpc({ status: 200, json: { patientIds: [PATIENT], authUserIds: [], preservedUserIds: [PATIENT_USER], objectPaths: [], exportIds: [], tables: {} } });
    const result = await hardDeletePatient(PATIENT, t.deps);
    expect(t.calls.authDeletes).toEqual([]);
    expect(result.logins.keptHqMembers).toBe(1);
  });
});
