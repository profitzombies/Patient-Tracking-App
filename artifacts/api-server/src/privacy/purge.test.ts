/**
 * The purge worker: step order (storage → rows → auth), failure recording
 * with exponential backoff and an HQ-only stop after the automatic budget,
 * idempotent re-runs, the missing-auth-user case, and the drain loop end to
 * end against the in-memory Supabase double (claim → purge → finish →
 * tombstone). Real row deletion is proven on PostgreSQL in purge.sql.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { createFakeSupabase, fakeUuid } from "./fake-supabase";
import { __setStripeForTests } from "../billing/stripe-client";

const mocks = vi.hoisted(() => ({
  supabase: null as unknown as ReturnType<typeof import("./fake-supabase").createFakeSupabase>,
  storage: new Map<string, Buffer>(),
  failStorage: null as Error | null,
}));
vi.mock("../lib/supabase-admin", () => ({
  supabaseAdmin: (method: string, path: string, body?: unknown, prefer?: string) => mocks.supabase.handler(method, path, body, prefer),
}));
vi.mock("../lib/objectStorage", () => ({
  objectStorage: {
    async deleteObjectStrict(path: string) {
      if (mocks.failStorage) throw mocks.failStorage;
      mocks.storage.delete(path);
    },
    async deletePrefixStrict(prefix: string) {
      if (mocks.failStorage) throw mocks.failStorage;
      let n = 0;
      for (const key of [...mocks.storage.keys()]) if (key.startsWith(prefix)) { mocks.storage.delete(key); n += 1; }
      return n;
    },
  },
}));
mocks.supabase = createFakeSupabase();

import {
  MAX_AUTOMATIC_ATTEMPTS,
  defaultPurgeDeps,
  drainDuePurges,
  patientBloodworkStoragePrefix,
  patientStoragePrefix,
  retryDelaySeconds,
  runPurge,
  runClosure,
  type DeletionRequestRow,
  type PurgeDeps,
} from "./purge";

const P1 = fakeUuid(1);
const P2 = fakeUuid(2);

function request(overrides: Partial<DeletionRequestRow> = {}): DeletionRequestRow {
  return {
    id: fakeUuid(100),
    patient_id: P1,
    provider_id: "office-1",
    auth_user_id: "auth-1",
    status: "purging",
    requested_at: "2026-09-01T00:00:00.000Z",
    purge_after: "2026-09-08T00:00:00.000Z",
    cancelled_at: null,
    started_at: "2026-09-08T00:00:01.000Z",
    purged_at: null,
    closed_at: null,
    retain_until: null,
    attempts: 1,
    next_attempt_at: null,
    lease_owner: "w",
    lease_until: "2026-09-08T00:10:00.000Z",
    last_error: null,
    steps: {},
    ...overrides,
  };
}

function deps(overrides: Partial<PurgeDeps> = {}) {
  const calls: string[] = [];
  const finish = vi.fn<PurgeDeps["finish"]>(async () => { calls.push("finish"); });
  const audit = vi.fn<PurgeDeps["audit"]>(async () => { calls.push("audit"); });
  const d: PurgeDeps = {
    prepareTombstone: vi.fn(async () => { calls.push("tombstone"); return true; }),
    cancelBillingSubscriptions: vi.fn(async () => { calls.push("billingSubscriptions"); return 2; }),
    scrubBillingCustomers: vi.fn(async () => { calls.push("billingCustomers"); return 1; }),
    deleteStoragePrefix: vi.fn(async () => { calls.push("storage"); return 3; }),
    deleteStorageObjects: vi.fn(async (paths) => { calls.push("storageObjects"); return paths.length; }),
    closeRows: vi.fn(async () => {
      calls.push("closeRows");
      return {
        tables: { patient_diary_entries: 2 },
        mediaPaths: ["/objects/patient-media/one/food-a"],
        authUserId: "auth-1",
        closedAt: "2026-09-08T00:00:05.000Z",
        retainUntil: "2033-09-06T00:00:05.000Z",
        alreadyClosed: false,
      };
    }),
    purgeRows: vi.fn(async () => { calls.push("rows"); return { patientRowDeleted: true, tombstone: true, analyticsDetached: 2, tables: { patient_diary_entries: 4, patient_media: 1 }, authUserId: "auth-1" }; }),
    deleteAuthUser: vi.fn(async () => { calls.push("auth"); return "deleted" as const; }),
    finish,
    audit,
    now: () => new Date("2026-09-08T00:00:05.000Z"),
    ...overrides,
  };
  return { d, calls, finish, audit };
}

describe("runPurge", () => {
  it("walks storage, rows, then the auth user, records each step, and audits the purge", async () => {
    const { d, calls, finish, audit } = deps();
    expect(await runPurge(request(), d)).toBe("purged");
    expect(calls).toEqual(["tombstone", "billingSubscriptions", "billingCustomers", "storage", "storage", "rows", "auth", "finish", "audit"]);
    expect(d.deleteStoragePrefix).toHaveBeenCalledWith(patientStoragePrefix(P1));
    expect(d.deleteStoragePrefix).toHaveBeenCalledWith(patientBloodworkStoragePrefix(P1));
    expect(patientStoragePrefix(P1)).toBe(`/objects/patient-media/${P1}/`);
    expect(patientBloodworkStoragePrefix(P1)).toBe(`/objects/patients/${P1}/bloodwork/`);
    expect(finish).toHaveBeenCalledWith({
      requestId: fakeUuid(100),
      status: "purged",
      steps: {
        tombstone: { ok: true, at: "2026-09-08T00:00:05.000Z" },
        billingSubscriptions: { ok: true, canceled: 2, at: "2026-09-08T00:00:05.000Z" },
        billingCustomers: { ok: true, scrubbed: 1, at: "2026-09-08T00:00:05.000Z" },
        storage: { ok: true, objects: 6, prefixes: 2, at: "2026-09-08T00:00:05.000Z" },
        rows: { ok: true, tables: 2, rows: 5, tombstone: true, patientRowDeleted: true, analyticsDetached: 2, at: "2026-09-08T00:00:05.000Z" },
        auth: { ok: true, outcome: "deleted", at: "2026-09-08T00:00:05.000Z" },
      },
    });
    expect(audit.mock.calls[0][0]).toMatchObject({ action: "patient_deletion_purged", actorKind: "system", actorUserId: null, providerId: "office-1", targetId: P1, metadata: { objects: 6, tables: 2, rows: 5 } });
  });

  it("cancels subscriptions and scrubs customers before destructive work", async () => {
    const { d } = deps();
    await runPurge(request(), d);
    expect(d.cancelBillingSubscriptions).toHaveBeenCalledWith(P1);
    expect(d.scrubBillingCustomers).toHaveBeenCalledWith(P1);
  });

  it("records a Stripe outage and does not run the row RPC", async () => {
    const outage = deps({
      scrubBillingCustomers: vi.fn(async () => {
        throw new Error("Stripe unavailable");
      }),
    });
    expect(await runPurge(request(), outage.d)).toBe("failed");
    expect(outage.d.purgeRows).not.toHaveBeenCalled();
    expect(outage.finish.mock.calls[0][0]).toMatchObject({
      error: "billingCustomers: Stripe unavailable",
    });
  });

  it("continues when Stripe reports a missing remote resource", async () => {
    const missing = deps({
      cancelBillingSubscriptions: vi.fn(async () => 0),
      scrubBillingCustomers: vi.fn(async () => 0),
    });
    expect(await runPurge(request(), missing.d)).toBe("purged");
    expect(missing.d.purgeRows).toHaveBeenCalled();
  });

  it("stops at the failing step, keeps earlier step results, and schedules an exponential retry", async () => {
    const { d, finish, audit } = deps({ purgeRows: vi.fn(async () => { throw new Error("row purge failed (500) https://db.internal/secret"); }) });
    expect(await runPurge(request({ attempts: 2, steps: { storage: { ok: true, objects: 3, at: "earlier" } } }), d)).toBe("failed");
    expect(d.deleteAuthUser).not.toHaveBeenCalled();
    const call = finish.mock.calls[0][0];
    expect(call.status).toBe("failed");
    expect(call.error).toBe("rows: row purge failed (500) [url]");
    expect(call.retryAfterSeconds).toBe(retryDelaySeconds(2));
    expect(call.steps.storage).toMatchObject({ ok: true });
    expect(call.steps.rows).toMatchObject({ ok: false, error: "row purge failed (500) [url]" });
    expect(audit.mock.calls[0][0]).toMatchObject({ action: "patient_deletion_failed", metadata: { step: "rows", attempt: 2 } });
  });

  it("backs off 5 min, 10, 20 … capped at 6 h, and stops retrying automatically after the budget", async () => {
    expect([1, 2, 3, 4, 5].map(retryDelaySeconds)).toEqual([300, 600, 1200, 2400, 4800]);
    expect(retryDelaySeconds(20)).toBe(6 * 3600);
    const { d, finish } = deps({ deleteAuthUser: vi.fn(async () => { throw new Error("auth user delete failed (503)"); }) });
    await runPurge(request({ attempts: MAX_AUTOMATIC_ATTEMPTS }), d);
    expect((finish.mock.calls[0][0]).retryAfterSeconds).toBeNull();
    const again = deps({ deleteAuthUser: vi.fn(async () => { throw new Error("auth user delete failed (503)"); }) });
    await runPurge(request({ attempts: MAX_AUTOMATIC_ATTEMPTS - 1 }), again.d);
    expect((again.finish.mock.calls[0][0]).retryAfterSeconds).toBe(retryDelaySeconds(MAX_AUTOMATIC_ATTEMPTS - 1));
  });

  it("treats a missing tombstone as a failure and an already-deleted auth user as success", async () => {
    const noTombstone = deps({ purgeRows: vi.fn(async () => ({ patientRowDeleted: false, tombstone: false, analyticsDetached: 0, tables: {}, authUserId: null })) });
    expect(await runPurge(request(), noTombstone.d)).toBe("failed");
    expect((noTombstone.finish.mock.calls[0][0]).error).toMatch(/rows: tombstone missing/);
    const absent = deps({ deleteAuthUser: vi.fn(async () => "absent" as const) });
    expect(await runPurge(request(), absent.d)).toBe("purged");
    expect((absent.finish.mock.calls[0][0]).steps.auth).toMatchObject({ outcome: "absent" });
    // No auth user anywhere (legacy row that never signed in): the step is skipped, not failed.
    const none = deps({ purgeRows: vi.fn(async () => ({ patientRowDeleted: true, tombstone: true, analyticsDetached: 0, tables: {}, authUserId: null })) });
    expect(await runPurge(request({ auth_user_id: null }), none.d)).toBe("purged");
    expect(none.d.deleteAuthUser).not.toHaveBeenCalled();
  });

  it("never throws when even the failure cannot be recorded", async () => {
    const { d } = deps({
      deleteStoragePrefix: vi.fn(async () => { throw new Error("bucket unreachable"); }),
      finish: vi.fn(async () => { throw new Error("db down"); }),
      audit: vi.fn(async () => { throw new Error("audit down"); }),
    });
    await expect(runPurge(request(), d)).resolves.toBe("failed");
  });
});

describe("runClosure", () => {
  it("cancels billing, closes rows, deletes only returned objects, then deletes auth", async () => {
    const { d, calls, finish, audit } = deps();
    expect(await runClosure(request({ status: "closing" }), d)).toBe("closed");
    expect(calls).toEqual([
      "billingSubscriptions",
      "billingCustomers",
      "closeRows",
      "storageObjects",
      "auth",
      "finish",
      "audit",
    ]);
    expect(d.deleteStorageObjects).toHaveBeenCalledWith(["/objects/patient-media/one/food-a"]);
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ status: "closed" }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "patient_account_closed" }));
  });

  it("records a pre-seal closure failure for retry without running later steps", async () => {
    const failed = deps({
      closeRows: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    });
    expect(await runClosure(request({ status: "closing", closed_at: null }), failed.d)).toBe("failed");
    expect(failed.d.deleteStorageObjects).not.toHaveBeenCalled();
    expect(failed.d.deleteAuthUser).not.toHaveBeenCalled();
    expect(failed.finish).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      error: "rows: database unavailable",
    }));
  });
});

describe("default billing purge steps", () => {
  beforeEach(() => {
    mocks.supabase.reset();
    __setStripeForTests(null);
  });

  it("cancels active subscriptions immediately on the connected account", async () => {
    const cancel = vi.fn(async () => ({
      id: "sub_1",
      status: "canceled",
      cancel_at_period_end: false,
      canceled_at: 1_791_158_400,
      current_period_end: 1_791_158_400,
    }));
    __setStripeForTests({ subscriptions: { cancel } } as any);
    mocks.supabase.tables.billing_connected_accounts.push({
      provider_id: "office-1", stripe_account_id: "acct_1", disconnected_at: null, charges_enabled: true,
    });
    mocks.supabase.tables.billing_subscriptions.push({
      id: fakeUuid(30), patient_id: P1, provider_id: "office-1", payer_id: fakeUuid(31),
      product_id: fakeUuid(32), stripe_subscription_id: "sub_1", status: "active",
    });
    await expect(defaultPurgeDeps.cancelBillingSubscriptions(P1)).resolves.toBe(1);
    expect(cancel).toHaveBeenCalledWith("sub_1", {}, { stripeAccount: "acct_1" });
    expect(mocks.supabase.tables.billing_subscriptions[0]).toMatchObject({ status: "canceled" });
  });

  it("fails loudly when a live subscription's office has no Stripe account", async () => {
    mocks.supabase.tables.billing_subscriptions.push({
      id: fakeUuid(30), patient_id: P1, provider_id: "office-1", payer_id: fakeUuid(31),
      product_id: fakeUuid(32), stripe_subscription_id: "sub_1", status: "active",
    });
    const missing = deps({ cancelBillingSubscriptions: defaultPurgeDeps.cancelBillingSubscriptions });
    expect(await runPurge(request(), missing.d)).toBe("failed");
    expect(missing.d.purgeRows).not.toHaveBeenCalled();
    expect(missing.finish.mock.calls[0][0]).toMatchObject({
      error: "billingSubscriptions: Billing purge blocked for office office-1: missing Stripe account for 1 live subscription(s).",
    });
  });

  it("cancels through a paused office account without a charges-enabled gate", async () => {
    const cancel = vi.fn(async () => ({ id: "sub_1", status: "canceled", canceled_at: 1_791_158_400 }));
    __setStripeForTests({ subscriptions: { cancel } } as any);
    mocks.supabase.tables.billing_connected_accounts.push({
      provider_id: "office-1", stripe_account_id: "acct_paused", disconnected_at: null, charges_enabled: false,
    });
    mocks.supabase.tables.billing_subscriptions.push({
      id: fakeUuid(30), patient_id: P1, provider_id: "office-1", payer_id: fakeUuid(31),
      product_id: fakeUuid(32), stripe_subscription_id: "sub_1", status: "active",
    });
    await expect(defaultPurgeDeps.cancelBillingSubscriptions(P1)).resolves.toBe(1);
    expect(cancel).toHaveBeenCalledWith("sub_1", {}, { stripeAccount: "acct_paused" });
  });

  it("marks a Stripe resource_missing subscription done and permits row purge", async () => {
    const cancel = vi.fn(async () => {
      throw new Stripe.errors.StripeInvalidRequestError({
        message: "No such subscription", code: "resource_missing", type: "invalid_request_error",
      });
    });
    __setStripeForTests({ subscriptions: { cancel } } as any);
    mocks.supabase.tables.billing_connected_accounts.push({
      provider_id: "office-1", stripe_account_id: "acct_1", disconnected_at: null, charges_enabled: true,
    });
    mocks.supabase.tables.billing_subscriptions.push({
      id: fakeUuid(30), patient_id: P1, provider_id: "office-1", payer_id: fakeUuid(31),
      product_id: fakeUuid(32), stripe_subscription_id: "sub_missing", status: "active",
    });
    await expect(defaultPurgeDeps.cancelBillingSubscriptions(P1)).resolves.toBe(1);
    expect(mocks.supabase.tables.billing_subscriptions[0]).toMatchObject({ status: "canceled" });
  });

  it("scrubs connected-account customer PII and tolerates resource_missing", async () => {
    const update = vi.fn(async () => ({ id: "cus_1" }));
    __setStripeForTests({ customers: { update } } as any);
    mocks.supabase.tables.billing_connected_accounts.push({
      provider_id: "office-1", stripe_account_id: "acct_1", disconnected_at: null,
    });
    mocks.supabase.tables.billing_payers.push({
      id: fakeUuid(40), patient_id: P1, provider_id: "office-1", stripe_customer_id: "cus_1",
    });
    await expect(defaultPurgeDeps.scrubBillingCustomers(P1)).resolves.toBe(1);
    expect(update).toHaveBeenCalledWith("cus_1", {
      name: "Deleted patient",
      email: `deleted+${fakeUuid(40)}@invalid.thinnr`,
      phone: "",
      address: null,
      shipping: null,
    }, { stripeAccount: "acct_1" });

    update.mockRejectedValue(new Stripe.errors.StripeInvalidRequestError({
      message: "No such customer", code: "resource_missing", type: "invalid_request_error",
    }));
    await expect(defaultPurgeDeps.scrubBillingCustomers(P1)).resolves.toBe(1);
  });
});

describe("drainDuePurges against the store double", () => {
  beforeEach(() => {
    mocks.supabase.reset();
    mocks.storage.clear();
    mocks.failStorage = null;
    mocks.supabase.tables.patients.push(
      { id: P1, provider_id: "office-1", auth_user_id: "auth-1", activation_status: "activated", program_id: "thinnr", program_start_date: "2026-06-01", first_name: "Pat" },
      { id: P2, provider_id: "office-1", auth_user_id: "auth-2", activation_status: "invited", program_id: "glp", first_name: "Other" },
    );
    mocks.supabase.tables.patient_diary_entries = [{ patient_id: P1, entry_id: "e1" }, { patient_id: P2, entry_id: "e2" }];
    mocks.supabase.tables.patient_data_exports = [{ id: fakeUuid(700), patient_id: P1, status: "ready", object_path: `/objects/patient-media/${P1}/export-x.zip` }];
    mocks.storage.set(`/objects/patient-media/${P1}/photo-1.jpg`, Buffer.from("a"));
    mocks.storage.set(`/objects/patient-media/${P1}/export-x.zip`, Buffer.from("b"));
    mocks.storage.set(`/objects/patients/${P1}/bloodwork/reports/r1/f1`, Buffer.from("lab"));
    mocks.storage.set(`/objects/patient-media/${P2}/photo-1.jpg`, Buffer.from("c"));
  });

  async function schedule(patientId: string, graceSeconds: number) {
    const res = await mocks.supabase.handler("POST", "/rest/v1/rpc/patient_deletion_request", { p_patient_id: patientId, p_grace_seconds: graceSeconds });
    return (res.json as Array<{ id: string }>)[0];
  }

  it("purges only due requests: storage prefix, every row, auth user, tombstone, and leaves other patients alone", async () => {
    const due = await schedule(P1, 0);
    await schedule(P2, 3600);
    expect(await drainDuePurges(5, defaultPurgeDeps)).toBe(1);
    const row = mocks.supabase.tables.patient_deletion_requests.find((r) => r.id === due.id)!;
    expect(row).toMatchObject({ status: "purged", attempts: 1, lease_owner: null });
    expect(row.purged_at).not.toBeNull();
    expect((row.steps as { storage: { objects: number } }).storage.objects).toBe(3);
    expect([...mocks.storage.keys()]).toEqual([`/objects/patient-media/${P2}/photo-1.jpg`]);
    expect(mocks.supabase.tables.patient_diary_entries).toEqual([{ patient_id: P2, entry_id: "e2" }]);
    expect(mocks.supabase.tables.patient_data_exports).toEqual([]);
    expect(mocks.supabase.tables.patients.map((p) => p.id)).toEqual([P2]);
    expect(mocks.supabase.authDeletes).toEqual(["auth-1"]);
    // The user's live session went on the server's revocation list before
    // the auth user was deleted, so a still-valid access token dies at once.
    expect(mocks.supabase.tables.auth_session_revocations).toEqual([
      expect.objectContaining({ user_id: "auth-1", reason: "purge" }),
    ]);
    expect(mocks.supabase.tables.patient_tombstones).toEqual([
      expect.objectContaining({ id: P1, provider_id: "office-1", was_activated: true, program_id: "thinnr", enrolled_on: "2026-06-01" }),
    ]);
    expect(JSON.stringify(mocks.supabase.tables.patient_tombstones)).not.toContain("Pat");
    expect(mocks.supabase.tables.patient_deletion_requests.find((r) => r.patient_id === P2)).toMatchObject({ status: "pending", attempts: 0 });
    expect(mocks.supabase.tables.admin_audit_events.map((e) => e.p_action)).toEqual(["patient_deletion_purged"]);
    // Nothing due now: the drain is a no-op.
    expect(await drainDuePurges(5, defaultPurgeDeps)).toBe(0);
  });

  it("records a storage failure with a retry time, then finishes cleanly on the next due run without redoing work", async () => {
    const due = await schedule(P1, 0);
    mocks.failStorage = new Error("bucket unreachable at https://storage.internal/x");
    expect(await drainDuePurges(5, defaultPurgeDeps)).toBe(1);
    let row = mocks.supabase.tables.patient_deletion_requests.find((r) => r.id === due.id)!;
    expect(row).toMatchObject({ status: "failed", attempts: 1, last_error: "storage: bucket unreachable at [url]" });
    expect(row.next_attempt_at).not.toBeNull();
    expect(mocks.supabase.tables.patients.map((p) => p.id)).toEqual([P1, P2]);
    expect(mocks.supabase.tables.admin_audit_events.map((e) => e.p_action)).toEqual(["patient_deletion_failed"]);
    // Not due yet → untouched.
    expect(await drainDuePurges(5, defaultPurgeDeps)).toBe(0);
    // HQ retry (or the backoff elapsing) makes it due again; storage is healthy now.
    row.next_attempt_at = new Date(Date.now() - 1000).toISOString();
    mocks.failStorage = null;
    expect(await drainDuePurges(5, defaultPurgeDeps)).toBe(1);
    row = mocks.supabase.tables.patient_deletion_requests.find((r) => r.id === due.id)!;
    expect(row).toMatchObject({ status: "purged", attempts: 2, last_error: null });
    expect(mocks.supabase.tables.patient_tombstones).toHaveLength(1);
    expect(mocks.supabase.authDeletes).toEqual(["auth-1"]);
    // A stale-lease re-run of a purged patient is harmless: auth user 404 → absent, tombstone stays single.
    row.status = "purging";
    row.lease_until = new Date(Date.now() - 1000).toISOString();
    expect(await drainDuePurges(5, defaultPurgeDeps)).toBe(1);
    row = mocks.supabase.tables.patient_deletion_requests.find((r) => r.id === due.id)!;
    expect(row.status).toBe("purged");
    expect((row.steps as { auth: { outcome: string } }).auth.outcome).toBe("absent");
    expect(mocks.supabase.tables.patient_tombstones).toHaveLength(1);
  });
});
