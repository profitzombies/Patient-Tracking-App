/**
 * The coach usage store contract, exercised on the memory twin (the
 * reference implementation) and the database adapter's wire shape.
 *
 * The memory store must behave exactly like the coach_usage_reserve RPC:
 * daily before busy, scope → office → global, cap 0 denies, null disables,
 * leases expire, releases free slots, and — the part the mutation proof
 * pins — two concurrent reservations for the last slot cannot both win.
 * Delete the `serialized` gate in createMemoryUsageStore and the
 * concurrency test below fails (both callers read the same free slot
 * before either writes).
 */
import { describe, expect, it, vi } from "vitest";
import {
  clampLeaseSeconds,
  createDatabaseUsageStore,
  createMemoryUsageStore,
  resolveUsageStoreMode,
  type UsageCaps,
} from "./usage-store";

const CAPS: UsageCaps = {
  scopeConcurrent: 2,
  scopeDaily: 3,
  officeConcurrent: 3,
  globalConcurrent: 4,
  globalDaily: 6,
  leaseSeconds: 60,
};

const input = (over: Partial<Parameters<ReturnType<typeof createMemoryUsageStore>["reserve"]>[0]> = {}) => ({
  kind: "chat" as const,
  scope: "account:p1",
  office: "office-a",
  day: "2026-09-18",
  caps: CAPS,
  ...over,
});

describe("memory usage store", () => {
  it("reserves, counts daily units per scope and organization-wide, and denies the spent tier by name", async () => {
    const store = createMemoryUsageStore();
    const first = await store.reserve(input());
    expect(first.outcome).toBe("reserved");
    if (first.outcome === "reserved") expect(await store.release(first.lease)).toBe(true);
    for (let i = 0; i < 2; i++) {
      const r = await store.reserve(input());
      expect(r.outcome).toBe("reserved");
      if (r.outcome === "reserved") await store.release(r.lease);
    }
    // Scope daily (3) is spent; the organization-wide row (6) is not.
    expect(await store.reserve(input())).toEqual({ outcome: "daily", tier: "scope", used: 3 });
    // Another patient in the same office still gets through, up to the global day.
    for (let i = 0; i < 3; i++) {
      const r = await store.reserve(input({ scope: "account:p2" }));
      expect(r.outcome).toBe("reserved");
      if (r.outcome === "reserved") await store.release(r.lease);
    }
    expect(await store.reserve(input({ scope: "account:p3" }))).toEqual({ outcome: "daily", tier: "global", used: 6 });
    // A new day starts fresh.
    expect((await store.reserve(input({ day: "2026-09-19" }))).outcome).toBe("reserved");
  });

  it("checks concurrency scope → office → global and frees slots on release", async () => {
    const store = createMemoryUsageStore();
    const held = [] as string[];
    const take = async (scope: string, office: string | null) => {
      const r = await store.reserve(input({ scope, office, caps: { ...CAPS, scopeDaily: null, globalDaily: null } }));
      if (r.outcome === "reserved") held.push(r.lease);
      return r;
    };
    expect((await take("account:p1", "office-a")).outcome).toBe("reserved");
    expect((await take("account:p1", "office-a")).outcome).toBe("reserved");
    expect(await take("account:p1", "office-a")).toEqual({ outcome: "busy", tier: "scope", active: 2 });
    expect((await take("account:p2", "office-a")).outcome).toBe("reserved");
    // Office A holds 3: a third patient of that office is refused by the
    // office tier while the organization still has a free slot...
    expect(await take("account:p3", "office-a")).toEqual({ outcome: "busy", tier: "office", active: 3 });
    // ...which a patient of office B takes.
    expect((await take("account:p4", "office-b")).outcome).toBe("reserved");
    expect(await take("account:p5", "office-b")).toEqual({ outcome: "busy", tier: "global", active: 4 });
    // Anonymous demo traffic has no office: only scope and global apply.
    expect(await take("ip:1.2.3.4", null)).toEqual({ outcome: "busy", tier: "global", active: 4 });
    expect(await store.release(held[0]!)).toBe(true);
    expect(await store.release(held[0]!)).toBe(false);
    expect((await take("ip:1.2.3.4", null)).outcome).toBe("reserved");
  });

  it("puts a spent day ahead of a busy slot, denies on cap 0, and ignores null tiers", async () => {
    const store = createMemoryUsageStore();
    const holder = await store.reserve(input({ caps: { ...CAPS, scopeDaily: 1, scopeConcurrent: 1 } }));
    expect(holder.outcome).toBe("reserved");
    // Both the day and the slot are exhausted: the final answer wins.
    expect((await store.reserve(input({ caps: { ...CAPS, scopeDaily: 1, scopeConcurrent: 1 } }))).outcome).toBe("daily");
    const staged = createMemoryUsageStore();
    expect(await staged.reserve(input({ caps: { ...CAPS, globalDaily: 0 } }))).toEqual({ outcome: "daily", tier: "global", used: 0 });
    expect(await staged.reserve(input({ caps: { ...CAPS, globalConcurrent: 0 } }))).toEqual({ outcome: "busy", tier: "global", active: 0 });
    const unlimited = createMemoryUsageStore();
    const none: UsageCaps = { scopeConcurrent: null, scopeDaily: null, officeConcurrent: null, globalConcurrent: null, globalDaily: null, leaseSeconds: 60 };
    for (let i = 0; i < 20; i++) expect((await unlimited.reserve(input({ caps: none }))).outcome).toBe("reserved");
  });

  it("stops counting a slot once its lease lapses, so a crashed server frees itself", async () => {
    let now = 1_000_000;
    const store = createMemoryUsageStore(() => now);
    const caps = { ...CAPS, scopeDaily: null, globalDaily: null, scopeConcurrent: 1, leaseSeconds: 30 };
    expect((await store.reserve(input({ caps }))).outcome).toBe("reserved");
    expect((await store.reserve(input({ caps }))).outcome).toBe("busy");
    now += 29_000;
    expect((await store.reserve(input({ caps }))).outcome).toBe("busy");
    now += 2_000;
    expect((await store.reserve(input({ caps }))).outcome).toBe("reserved");
  });

  it("serializes concurrent reservations so two callers cannot both take the last slot", async () => {
    const store = createMemoryUsageStore();
    const caps = { ...CAPS, scopeDaily: null, globalDaily: null, scopeConcurrent: 1 };
    const results = await Promise.all([
      store.reserve(input({ caps })),
      store.reserve(input({ caps })),
      store.reserve(input({ caps })),
    ]);
    expect(results.filter((r) => r.outcome === "reserved")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "busy")).toHaveLength(2);
    // Same for the last daily unit.
    const day = createMemoryUsageStore();
    const dayCaps = { ...CAPS, scopeDaily: 1, scopeConcurrent: null };
    const dayResults = await Promise.all([day.reserve(input({ caps: dayCaps })), day.reserve(input({ caps: dayCaps }))]);
    expect(dayResults.map((r) => r.outcome).sort()).toEqual(["daily", "reserved"]);
  });
});

describe("database usage store", () => {
  it("calls the reserve RPC with every cap and parses each outcome", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    let next: { status: number; json: unknown } = { status: 200, json: { outcome: "reserved", lease: "L1", lease_until: "x" } };
    const rpc = vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return next;
    });
    const store = createDatabaseUsageStore(rpc as never);
    expect(store.mode).toBe("database");
    expect(await store.reserve(input({ caps: { ...CAPS, leaseSeconds: 5 } }))).toEqual({ outcome: "reserved", lease: "L1" });
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/rest/v1/rpc/coach_usage_reserve",
      body: {
        p_kind: "chat",
        p_scope: "account:p1",
        p_office: "office-a",
        p_day: "2026-09-18",
        p_scope_concurrent: 2,
        p_scope_daily: 3,
        p_office_concurrent: 3,
        p_global_concurrent: 4,
        p_global_daily: 6,
        // Clamped to the RPC's floor so a tiny knob cannot expire live slots.
        p_lease_seconds: 10,
      },
    });
    next = { status: 200, json: { outcome: "daily", tier: "global", used: 500 } };
    expect(await store.reserve(input())).toEqual({ outcome: "daily", tier: "global", used: 500 });
    next = { status: 200, json: { outcome: "busy", tier: "office", active: 3 } };
    expect(await store.reserve(input())).toEqual({ outcome: "busy", tier: "office", active: 3 });
    next = { status: 200, json: { outcome: "weird" } };
    await expect(store.reserve(input())).rejects.toThrow(/unexpected row/);
    next = { status: 404, json: { message: "no such function" } };
    await expect(store.reserve(input())).rejects.toThrow(/coach_usage_reserve failed \(404\)/);
    next = { status: 200, json: true };
    expect(await store.release("L1")).toBe(true);
    expect(calls.at(-1)).toEqual({ method: "POST", path: "/rest/v1/rpc/coach_usage_release", body: { p_lease: "L1" } });
    next = { status: 200, json: false };
    expect(await store.release("L1")).toBe(false);
  });

  it("clamps lease lengths the way the RPC does", () => {
    expect(clampLeaseSeconds(600)).toBe(600);
    expect(clampLeaseSeconds(1)).toBe(10);
    expect(clampLeaseSeconds(99_999)).toBe(3600);
    expect(clampLeaseSeconds(Number.NaN)).toBe(600);
  });
});

describe("resolveUsageStoreMode", () => {
  it("prefers the knob, then the database when service-role credentials exist, else memory", () => {
    expect(resolveUsageStoreMode({ COACH_LIMITS_STORE: "memory", SUPABASE_URL: "https://x", SUPABASE_SERVICE_ROLE_KEY: "k" })).toBe("memory");
    expect(resolveUsageStoreMode({ COACH_LIMITS_STORE: "database" })).toBe("database");
    expect(resolveUsageStoreMode({ SUPABASE_URL: "https://x", SUPABASE_SERVICE_ROLE_KEY: "k" })).toBe("database");
    expect(resolveUsageStoreMode({ SUPABASE_URL: "https://x" })).toBe("memory");
    expect(resolveUsageStoreMode({ COACH_LIMITS_STORE: " " })).toBe("memory");
    expect(() => resolveUsageStoreMode({ COACH_LIMITS_STORE: "redis" })).toThrow(/COACH_LIMITS_STORE/);
  });
});
