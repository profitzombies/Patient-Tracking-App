/**
 * Denial-shape tests for the coach limiters: each denial kind carries its
 * own user-facing message plus the retryability contract the mobile client
 * keys on — daily-budget denials are final (retryable: false, waiting is the
 * only fix), while busy and rapid-fire denials are transient (retryable:
 * true, the Retry control can plausibly help).
 */
import { describe, expect, it, vi } from "vitest";
import { SLOW_RESERVE_MS, createLimiter, createUsageLimiter, envCaps } from "./limits";
import { createMemoryUsageStore, type UsageCaps, type UsageStore } from "./usage-store";

const OPTIONS = {
  burst: 1,
  refillPerMinute: 60,
  maxConcurrent: 1,
  dailyBudget: 2,
  dailyMessage: "Daily budget spent. Try again tomorrow.",
  busyMessage: "Busy right now. Try again in a moment.",
  rapidMessage: "Too quickly. Wait a moment.",
};

describe("createLimiter denial shapes", () => {
  it("rapid-fire denial carries its message and stays retryable", () => {
    const acquire = createLimiter(OPTIONS);
    const first = acquire("ip-a");
    expect(first.ok).toBe(true);
    // Release before re-acquiring so the concurrency cap cannot trip; the
    // burst-1 bucket is now empty, leaving only the rapid-fire check.
    if (first.ok) first.release();
    const denied = acquire("ip-a");
    expect(denied).toEqual({
      ok: false,
      status: 429,
      message: OPTIONS.rapidMessage,
      retryable: true,
    });
  });

  it("busy denial carries its message and stays retryable", () => {
    const acquire = createLimiter(OPTIONS);
    const holder = acquire("ip-a");
    expect(holder.ok).toBe(true);
    // Different IP: that fresh bucket is full, so only the concurrency cap
    // can trip here.
    const denied = acquire("ip-b");
    expect(denied).toEqual({
      ok: false,
      status: 429,
      message: OPTIONS.busyMessage,
      retryable: true,
    });
    if (holder.ok) holder.release();
  });

  it("daily-budget denial is final: retryable false", () => {
    const acquire = createLimiter({ ...OPTIONS, burst: 5, maxConcurrent: 5 });
    const first = acquire("ip-a");
    const second = acquire("ip-a");
    expect(first.ok && second.ok).toBe(true);
    if (first.ok) first.release();
    if (second.ok) second.release();
    const denied = acquire("ip-a");
    expect(denied).toEqual({
      ok: false,
      status: 429,
      message: OPTIONS.dailyMessage,
      retryable: false,
    });
  });

  it("the daily denial wins over busy/rapid, so patients read the final message", () => {
    const acquire = createLimiter({ ...OPTIONS, dailyBudget: 1 });
    const first = acquire("ip-a");
    expect(first.ok).toBe(true);
    // Slot still held AND the bucket empty: the daily check must answer
    // first — a "wait a moment" message would misread as transient.
    const denied = acquire("ip-a");
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.message).toBe(OPTIONS.dailyMessage);
      expect(denied.retryable).toBe(false);
    }
    if (first.ok) first.release();
  });
});

// ── Shared-store usage limiter ──────────────────────────────────────────────

const CAPS: UsageCaps = {
  scopeConcurrent: 2,
  scopeDaily: 5,
  officeConcurrent: 3,
  globalConcurrent: 4,
  globalDaily: 10,
  leaseSeconds: 60,
};

function fakeLog() {
  const lines: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = [];
  const push = (level: string) => (obj: object, msg: string) => lines.push({ level, obj: obj as Record<string, unknown>, msg });
  return { lines, info: push("info"), warn: push("warn"), error: push("error") };
}

function usageLimiter(over: Partial<Parameters<typeof createUsageLimiter>[0]> = {}, store: UsageStore = createMemoryUsageStore()) {
  return createUsageLimiter({
    kind: "chat",
    burst: 5,
    refillPerMinute: 60,
    caps: CAPS,
    dailyMessage: OPTIONS.dailyMessage,
    busyMessage: OPTIONS.busyMessage,
    rapidMessage: OPTIONS.rapidMessage,
    store: () => store,
    ...over,
  });
}

describe("createUsageLimiter", () => {
  it("keys signed-in patients by account (with their office) and anonymous traffic by IP", async () => {
    const store = createMemoryUsageStore();
    const reserve = vi.spyOn(store, "reserve");
    const acquire = usageLimiter({}, store);
    const log = fakeLog();
    const signedIn = await acquire({ ip: "9.9.9.9", patientId: "p1", officeId: "office-a" }, log);
    const anonymous = await acquire({ ip: "9.9.9.9", patientId: null, officeId: "office-a" }, log);
    expect(signedIn.ok && anonymous.ok).toBe(true);
    expect(reserve.mock.calls[0]![0]).toMatchObject({ kind: "chat", scope: "account:p1", office: "office-a", caps: CAPS });
    // Anonymous callers never carry an office, even if a caller passed one.
    expect(reserve.mock.calls[1]![0]).toMatchObject({ scope: "ip:9.9.9.9", office: null });
    expect(reserve.mock.calls[0]![0].day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    if (signedIn.ok) await signedIn.release();
    if (anonymous.ok) await anonymous.release();
  });

  it("maps store outcomes to the denial contract and logs each with its reason", async () => {
    const log = fakeLog();
    const acquire = usageLimiter({ caps: { ...CAPS, scopeConcurrent: 1, scopeDaily: 2 } });
    const held = await acquire({ ip: "1.1.1.1", patientId: "p1", officeId: "o" }, log);
    expect(held.ok).toBe(true);
    const busy = await acquire({ ip: "1.1.1.1", patientId: "p1", officeId: "o" }, log);
    expect(busy).toEqual({ ok: false, status: 429, message: OPTIONS.busyMessage, retryable: true });
    if (held.ok) await held.release();
    const second = await acquire({ ip: "1.1.1.1", patientId: "p1", officeId: "o" }, log);
    expect(second.ok).toBe(true);
    if (second.ok) await second.release();
    const daily = await acquire({ ip: "1.1.1.1", patientId: "p1", officeId: "o" }, log);
    expect(daily).toEqual({ ok: false, status: 429, message: OPTIONS.dailyMessage, retryable: false });
    const denials = log.lines.filter((l) => l.msg === "coach usage denied");
    expect(denials.map((l) => [l.level, l.obj.reason, l.obj.tier, l.obj.scopeKind])).toEqual([
      ["warn", "busy", "scope", "account"],
      ["warn", "daily", "scope", "account"],
    ]);
  });

  it("caps concurrent store calls at the burst allowance: tokens are claimed before the store is awaited", async () => {
    // A store that never answers until told: every caller that got past the
    // bucket is parked inside it, which is exactly the window the race lived in.
    let inflight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const parked: UsageStore = {
      mode: "database",
      reserve: () =>
        new Promise((resolve) => {
          inflight += 1;
          peak = Math.max(peak, inflight);
          releases.push(() => {
            inflight -= 1;
            resolve({ outcome: "busy", tier: "global", active: 9 });
          });
        }),
      release: async () => true,
    };
    const log = fakeLog();
    const acquire = usageLimiter({ burst: 3, refillPerMinute: 0 }, parked);
    const subject = { ip: "6.6.6.6" };
    const pending = Array.from({ length: 10 }, () => acquire(subject, log));
    // Only three reached the store; the other seven were answered rapid-fire
    // synchronously, before any store call settled.
    expect(peak).toBe(3);
    expect(log.lines.filter((l) => l.obj.reason === "rapid")).toHaveLength(7);
    for (const done of releases) done();
    const results = await Promise.all(pending);
    expect(results.filter((r) => !r.ok && r.message === OPTIONS.rapidMessage)).toHaveLength(7);
    expect(results.filter((r) => !r.ok && r.message === OPTIONS.busyMessage)).toHaveLength(3);
    // Refused reservations hand their tokens back, so the caller is not
    // locked out by a busy answer it never benefited from.
    const again = Array.from({ length: 4 }, () => acquire(subject, log));
    expect(peak).toBe(3);
    expect(releases).toHaveLength(6);
    for (const done of releases.slice(3)) done();
    await Promise.all(again);
  });

  it("answers rapid-fire from the process bucket without touching the store, and only spends a token on a granted slot", async () => {
    const store = createMemoryUsageStore();
    const reserve = vi.spyOn(store, "reserve");
    const log = fakeLog();
    const acquire = usageLimiter({ burst: 2, refillPerMinute: 0, caps: { ...CAPS, scopeConcurrent: 1 } }, store);
    const subject = { ip: "2.2.2.2", patientId: null };
    const first = await acquire(subject, log);
    expect(first.ok).toBe(true);
    // Busy denial: the bucket must NOT lose a token for a slot it never got.
    expect((await acquire(subject, log)).ok).toBe(false);
    if (first.ok) await first.release();
    expect((await acquire(subject, log)).ok).toBe(true);
    expect(reserve).toHaveBeenCalledTimes(3);
    // Bucket empty now (two granted): rapid denial, and no store call.
    const rapid = await acquire(subject, log);
    expect(rapid).toEqual({ ok: false, status: 429, message: OPTIONS.rapidMessage, retryable: true });
    expect(reserve).toHaveBeenCalledTimes(3);
    expect(log.lines.at(-1)).toMatchObject({ level: "warn", obj: { reason: "rapid", scopeKind: "ip" } });
  });

  it("stages denials from zeroed caps: daily budget 0 is final, burst 0 is rapid-fire", async () => {
    const log = fakeLog();
    const dailyStaged = usageLimiter({ caps: { ...CAPS, globalDaily: 0 } });
    expect(await dailyStaged({ ip: "3.3.3.3" }, log)).toEqual({ ok: false, status: 429, message: OPTIONS.dailyMessage, retryable: false });
    const burstStaged = usageLimiter({ burst: 0 });
    expect(await burstStaged({ ip: "3.3.3.3" }, log)).toEqual({ ok: false, status: 429, message: OPTIONS.rapidMessage, retryable: true });
  });

  it("fails closed with the busy answer when the store is unreachable, and survives a failed release", async () => {
    const log = fakeLog();
    const broken: UsageStore = {
      mode: "database",
      reserve: async () => {
        throw new Error("connection refused");
      },
      release: async () => {
        throw new Error("connection refused");
      },
    };
    const acquire = usageLimiter({}, broken);
    expect(await acquire({ ip: "4.4.4.4" }, log)).toEqual({ ok: false, status: 503, message: OPTIONS.busyMessage, retryable: true });
    expect(log.lines.at(-1)).toMatchObject({ level: "error", obj: { reason: "store" } });

    let releaseFails = false;
    const flaky: UsageStore = {
      mode: "database",
      reserve: async () => ({ outcome: "reserved", lease: "L" }),
      release: async () => {
        if (releaseFails) throw new Error("gone");
        return true;
      },
    };
    const slot = await usageLimiter({}, flaky)({ ip: "4.4.4.4" }, log);
    expect(slot.ok).toBe(true);
    releaseFails = true;
    if (slot.ok) {
      await expect(slot.release()).resolves.toBeUndefined();
      await expect(slot.release()).resolves.toBeUndefined();
    }
    expect(log.lines.at(-1)?.msg).toMatch(/release failed/);
  });

  it("logs a slot wait when the reservation blocked", async () => {
    let clock = 0;
    const slow: UsageStore = {
      mode: "database",
      reserve: async () => {
        clock += SLOW_RESERVE_MS;
        return { outcome: "reserved", lease: "L" };
      },
      release: async () => true,
    };
    const log = fakeLog();
    const slot = await usageLimiter({ now: () => clock }, slow)({ ip: "5.5.5.5" }, log);
    expect(slot.ok).toBe(true);
    expect(log.lines).toContainEqual(expect.objectContaining({ level: "info", msg: "coach usage reservation waited" }));
    expect(log.lines[0]!.obj.waitedMs).toBe(SLOW_RESERVE_MS);
  });
});

describe("envCaps", () => {
  const defaults = { globalDaily: 500, globalConcurrent: 4, scopeDaily: 200, scopeConcurrent: 3, officeConcurrent: 3 };

  it("reads the whole knob family, blank-safe, with the shared lease length", () => {
    vi.stubEnv("TEST_CAPS_DAILY_BUDGET", "0");
    vi.stubEnv("TEST_CAPS_CONCURRENT", "");
    vi.stubEnv("TEST_CAPS_ACCOUNT_DAILY_BUDGET", " ");
    vi.stubEnv("TEST_CAPS_ACCOUNT_CONCURRENT", "7");
    vi.stubEnv("TEST_CAPS_OFFICE_CONCURRENT", "nope");
    vi.stubEnv("COACH_SLOT_LEASE_SECONDS", "120");
    try {
      expect(envCaps("TEST_CAPS", defaults)).toEqual({
        globalDaily: 0,
        globalConcurrent: 4,
        scopeDaily: 200,
        scopeConcurrent: 7,
        officeConcurrent: 3,
        leaseSeconds: 120,
      });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(envCaps("TEST_CAPS", defaults)).toEqual({ ...defaults, leaseSeconds: 600 });
  });
});
