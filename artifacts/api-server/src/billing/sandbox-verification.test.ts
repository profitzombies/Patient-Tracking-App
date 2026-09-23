import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  status: 200,
  throwOnRead: false,
  reads: [] as string[],
  scopeRuns: [] as string[],
}));

vi.mock("../lib/supabase-admin", () => ({
  supabaseAdmin: vi.fn(async (_method: string, path: string) => {
    state.reads.push(path);
    if (state.throwOnRead) throw new Error("store down");
    return { status: state.status, json: state.status === 200 ? state.rows : { message: "nope" } };
  }),
}));
vi.mock("./lifecycle-scopes", () => ({
  forEachBillingScope: vi.fn(async (work: () => Promise<void>, modes: string[]) => {
    state.scopeRuns.push(modes.join(","));
    await work();
  }),
}));

import { runWithBillingIdentity } from "./stripe-environment";
import {
  activeSandboxVerificationOrderIds, forEachSandboxVerificationScope, orderIdFilter, sandboxVerificationFor, sandboxVerificationPossible,
} from "./sandbox-verification";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const ORDER = "11111111-1111-4111-8111-111111111111";
const row = (over: Record<string, unknown> = {}) => ({
  order_id: ORDER, designated_inbox: "qa-inbox@example.test", authorized_by: "tester", note: null,
  created_at: "2026-09-23T11:00:00.000Z", expires_at: "2026-09-23T13:00:00.000Z", ...over,
});

beforeEach(() => {
  state.rows = [row()]; state.status = 200; state.throwOnRead = false; state.reads = []; state.scopeRuns = [];
  vi.stubEnv("WAREHOUSECRAFT_TENANT_MODE", "test");
});
afterEach(() => vi.unstubAllEnvs());

describe("sandboxVerificationFor", () => {
  it("returns the active row for a flagged sandbox order under the sandbox tenant", async () => {
    await expect(sandboxVerificationFor({ id: ORDER, livemode: false }, { now: NOW })).resolves.toMatchObject({ designated_inbox: "qa-inbox@example.test" });
    expect(state.reads[0]).toContain(`order_id=eq.${ORDER}`);
  });
  it("never opens for a real (live-mode) order, without even reading the store", async () => {
    await expect(sandboxVerificationFor({ id: ORDER, livemode: true }, { now: NOW })).resolves.toBeNull();
    expect(state.reads).toEqual([]);
  });
  it("is closed under a live warehouse tenant, whether from the environment or the caller", async () => {
    vi.stubEnv("WAREHOUSECRAFT_TENANT_MODE", "live");
    await expect(sandboxVerificationFor({ id: ORDER, livemode: false }, { now: NOW })).resolves.toBeNull();
    vi.stubEnv("WAREHOUSECRAFT_TENANT_MODE", "test");
    await expect(sandboxVerificationFor({ id: ORDER, livemode: false }, { now: NOW, tenantMode: "live" })).resolves.toBeNull();
    expect(state.reads).toEqual([]);
    expect(sandboxVerificationPossible("live")).toBe(false);
  });
  it("is closed inside a LIVE billing identity even with the sandbox tenant", async () => {
    await runWithBillingIdentity({ mode: "live", platformAccountId: "acct_live" }, async () => {
      expect(sandboxVerificationPossible()).toBe(false);
      await expect(sandboxVerificationFor({ id: ORDER, livemode: false }, { now: NOW })).resolves.toBeNull();
    });
    await runWithBillingIdentity({ mode: "test", platformAccountId: "acct_test" }, async () => {
      await expect(sandboxVerificationFor({ id: ORDER, livemode: false }, { now: NOW })).resolves.not.toBeNull();
    });
  });
  it("ignores expired, malformed, and other orders' rows", async () => {
    state.rows = [row({ expires_at: "2026-09-23T11:59:59.000Z" })];
    await expect(sandboxVerificationFor({ id: ORDER, livemode: false }, { now: NOW })).resolves.toBeNull();
    state.rows = [row({ designated_inbox: "not-an-address" })];
    await expect(sandboxVerificationFor({ id: ORDER, livemode: false }, { now: NOW })).resolves.toBeNull();
    state.rows = [row({ order_id: "22222222-2222-4222-8222-222222222222" })];
    await expect(sandboxVerificationFor({ id: ORDER, livemode: false }, { now: NOW })).resolves.toBeNull();
  });
  it("fails closed when the store errors or answers with anything but rows", async () => {
    state.status = 500;
    await expect(sandboxVerificationFor({ id: ORDER, livemode: false }, { now: NOW })).resolves.toBeNull();
    state.status = 200; state.throwOnRead = true;
    await expect(sandboxVerificationFor({ id: ORDER, livemode: false }, { now: NOW })).resolves.toBeNull();
  });
});

describe("verification pass", () => {
  it("lists only open allowances and runs the work once in the TEST scope with those ids", async () => {
    state.rows = [row(), row({ order_id: "22222222-2222-4222-8222-222222222222", expires_at: "2026-09-23T11:00:00.000Z" })];
    await expect(activeSandboxVerificationOrderIds(NOW)).resolves.toEqual([ORDER]);
    const seen: string[][] = [];
    await forEachSandboxVerificationScope(async (ids) => { seen.push(ids); }, NOW);
    expect(seen).toEqual([[ORDER]]);
    expect(state.scopeRuns).toEqual(["test"]);
  });
  it("is a no-op with no open allowance or under a live tenant: no scope is entered", async () => {
    state.rows = [];
    const work = vi.fn(async () => undefined);
    await forEachSandboxVerificationScope(work, NOW);
    state.rows = [row()];
    vi.stubEnv("WAREHOUSECRAFT_TENANT_MODE", "live");
    await forEachSandboxVerificationScope(work, NOW);
    expect(work).not.toHaveBeenCalled();
    expect(state.scopeRuns).toEqual([]);
  });
  it("builds a quoted PostgREST in-list, or nothing", () => {
    expect(orderIdFilter("order_id", undefined)).toBe("");
    expect(orderIdFilter("order_id", [])).toBe("");
    expect(orderIdFilter("order_id", ["a", "b"])).toBe("&order_id=in.(%22a%22,%22b%22)");
  });
});
