/**
 * Abuse and cost limits for the AI endpoints.
 *
 * Two layers live here:
 *
 * 1. `createLimiter` — the original process-local limiter (per-key token
 *    bucket + process-wide concurrency + daily budget). Cheap routes that
 *    spend no model credits (catalog search, barcode lookups, media
 *    uploads, the support chat) still ride it; process-local is fine as a
 *    spam guard there.
 *
 * 2. `createUsageLimiter` — the coach's paid surfaces (chat turns, photo
 *    reads, recipe images). Their concurrency and daily caps are RESERVED
 *    in the shared usage store (`./usage-store`: the coach_usage_* RPCs,
 *    or a memory twin when Supabase is absent), so they hold identically
 *    across every autoscaled server copy and every restart. Each request
 *    is keyed by the signed-in patient's account (`account:<id>`) and, for
 *    anonymous demo traffic only, by IP (`ip:<address>`); a per-office
 *    concurrency ceiling rides the same reservation so one busy practice
 *    cannot starve the others; and the organization-wide concurrency +
 *    daily budget bound the AI bill. Only the rapid-fire token bucket stays
 *    in memory — it exists to keep floods away from the database, and a
 *    process-local burst allowance is exactly what that job needs.
 *
 * Every cap comes from an environment knob (read at server start) so the
 * e2e tester can stage denials deterministically: COACH_CHAT_DAILY_BUDGET=0
 * answers every send with the final daily denial, COACH_CHAT_BURST=0 with
 * the transient rapid-fire one. Denials and slow reservations are logged
 * with their reason.
 */
import {
  type ReserveResult,
  type UsageCaps,
  type UsageKind,
  type UsageStore,
  usageStore,
} from "./usage-store";

/** Drop idle per-key buckets so the map cannot grow without bound. */
const BUCKET_IDLE_EVICT_MS = 10 * 60 * 1000;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export type ChatSlot =
  | { ok: true; release: () => void }
  | {
      ok: false;
      status: number;
      message: string;
      /**
       * Whether retrying soon can plausibly succeed. False only for the
       * daily budget (spent until UTC midnight); busy/rapid denials clear
       * within moments. Rides the JSON error body so clients can hide their
       * retry affordances when retrying cannot help.
       */
      retryable: boolean;
    };

interface LimiterOptions {
  burst: number;
  refillPerMinute: number;
  maxConcurrent: number;
  dailyBudget: number;
  dailyMessage: string;
  busyMessage: string;
  rapidMessage: string;
}

/**
 * Builds an acquire function. On success the caller MUST call `release()`
 * when the request finishes (success or failure).
 */
export function createLimiter(options: LimiterOptions): (ip: string) => ChatSlot {
  const buckets = new Map<string, Bucket>();
  let active = 0;
  let dailyCount = 0;
  let dailyKey = "";

  function refill(bucket: Bucket, now: number): void {
    const elapsedMinutes = (now - bucket.updatedAt) / 60_000;
    bucket.tokens = Math.min(
      options.burst,
      bucket.tokens + elapsedMinutes * options.refillPerMinute,
    );
    bucket.updatedAt = now;
  }

  function evictIdleBuckets(now: number): void {
    if (buckets.size < 1000) return;
    for (const [key, bucket] of buckets) {
      if (now - bucket.updatedAt > BUCKET_IDLE_EVICT_MS) buckets.delete(key);
    }
  }

  return function acquire(ip: string): ChatSlot {
    const now = Date.now();

    const today = new Date(now).toISOString().slice(0, 10);
    if (today !== dailyKey) {
      dailyKey = today;
      dailyCount = 0;
    }
    if (dailyCount >= options.dailyBudget) {
      return { ok: false, status: 429, message: options.dailyMessage, retryable: false };
    }

    if (active >= options.maxConcurrent) {
      return { ok: false, status: 429, message: options.busyMessage, retryable: true };
    }

    evictIdleBuckets(now);
    let bucket = buckets.get(ip);
    if (!bucket) {
      bucket = { tokens: options.burst, updatedAt: now };
      buckets.set(ip, bucket);
    } else {
      refill(bucket, now);
    }
    if (bucket.tokens < 1) {
      return { ok: false, status: 429, message: options.rapidMessage, retryable: true };
    }

    bucket.tokens -= 1;
    dailyCount += 1;
    active += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        active -= 1;
      },
    };
  };
}

/**
 * Test/staging hook: a non-negative integer in the named env var overrides a
 * limiter default, so e2e tests can stage denial states deterministically
 * (COACH_CHAT_DAILY_BUDGET=0 → every send answers with the daily-limit
 * message; COACH_CHAT_BURST=0 → every send answers rapid-fire). Unset or
 * blank leaves the default untouched — `Number("")` would read as 0 and
 * silently zero a cap. Shared with the AI Support limiter (SUPPORT_CHAT_*),
 * which rides the same machinery with its own knobs.
 */
export function envLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

// ── Shared-store usage limiter ──────────────────────────────────────────────

/** Who is asking: the route's resolved identity, or just its IP. */
export interface UsageSubject {
  ip: string | undefined;
  /** Signed-in patient id; null/undefined for anonymous demo traffic. */
  patientId?: string | null;
  /** The patient's practice (provider id) when known; gates the office tier. */
  officeId?: string | null;
}

/** The request logger (pino child) so denials land on the request's trace. */
export interface UsageLog {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

export type UsageSlot =
  | {
      ok: true;
      /** Frees the slot; safe to call more than once, never rejects. */
      release: () => Promise<void>;
    }
  | { ok: false; status: number; message: string; retryable: boolean };

export interface UsageLimiterOptions {
  kind: UsageKind;
  /** Rapid-fire token bucket (per scope key, this process only). */
  burst: number;
  refillPerMinute: number;
  caps: UsageCaps;
  dailyMessage: string;
  busyMessage: string;
  rapidMessage: string;
  /** Injection seams for tests; production uses the process store + clock. */
  store?: () => UsageStore;
  now?: () => number;
}

/** A reservation that took longer than this is logged as a slot wait. */
export const SLOW_RESERVE_MS = 250;

/**
 * Builds an async acquire function for one paid surface. On success the
 * caller MUST `release()` when the request finishes (success or failure);
 * an unreleased slot stops counting once its lease lapses.
 */
export function createUsageLimiter(
  options: UsageLimiterOptions,
): (subject: UsageSubject, log: UsageLog) => Promise<UsageSlot> {
  const buckets = new Map<string, Bucket>();
  const store = options.store ?? usageStore;
  const now = options.now ?? Date.now;

  function refill(bucket: Bucket, at: number): void {
    const elapsedMinutes = (at - bucket.updatedAt) / 60_000;
    bucket.tokens = Math.min(options.burst, bucket.tokens + elapsedMinutes * options.refillPerMinute);
    bucket.updatedAt = at;
  }

  function evictIdleBuckets(at: number): void {
    if (buckets.size < 1000) return;
    for (const [key, bucket] of buckets) {
      if (at - bucket.updatedAt > BUCKET_IDLE_EVICT_MS) buckets.delete(key);
    }
  }

  function bucketFor(key: string, at: number): Bucket {
    evictIdleBuckets(at);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: options.burst, updatedAt: at };
      buckets.set(key, bucket);
    } else {
      refill(bucket, at);
    }
    return bucket;
  }

  return async function acquire(subject, log) {
    const patientId = subject.patientId ?? null;
    const scopeKind = patientId ? "account" : "ip";
    const scope = patientId ? `account:${patientId}` : `ip:${subject.ip ?? "unknown"}`;
    const office = patientId ? (subject.officeId ?? null) : null;
    const at = now();
    const logBase = { kind: options.kind, scopeKind, office };

    // Rapid-fire first, and without a reservation: a flood must never turn
    // into a flood of database round trips. The token is claimed HERE,
    // synchronously, before the await below — so at most `burst` requests
    // per caller can ever be inside the store at once — and handed back
    // when the store refuses, which keeps the staged and busy denials free
    // of rapid-fire side effects exactly as the process-local limiter did.
    const bucket = bucketFor(scope, at);
    if (bucket.tokens < 1) {
      log.warn({ ...logBase, reason: "rapid" }, "coach usage denied");
      return { ok: false, status: 429, message: options.rapidMessage, retryable: true };
    }
    bucket.tokens -= 1;
    const refund = () => {
      bucket.tokens = Math.min(options.burst, bucket.tokens + 1);
    };

    let result: ReserveResult;
    const startedAt = now();
    try {
      result = await store().reserve({
        kind: options.kind,
        scope,
        office,
        day: new Date(at).toISOString().slice(0, 10),
        caps: options.caps,
      });
    } catch (error) {
      // The store is the cap. Failing open here would make every outage an
      // unmetered window, so the request is refused with the transient
      // busy answer and the failure is logged for the operator.
      refund();
      log.error({ ...logBase, err: error, reason: "store" }, "coach usage reservation failed; answering busy");
      return { ok: false, status: 503, message: options.busyMessage, retryable: true };
    }
    const waitedMs = now() - startedAt;
    if (waitedMs >= SLOW_RESERVE_MS) {
      log.info({ ...logBase, waitedMs, outcome: result.outcome }, "coach usage reservation waited");
    }

    if (result.outcome === "daily") {
      refund();
      log.warn({ ...logBase, reason: "daily", tier: result.tier, used: result.used }, "coach usage denied");
      return { ok: false, status: 429, message: options.dailyMessage, retryable: false };
    }
    if (result.outcome === "busy") {
      refund();
      log.warn({ ...logBase, reason: "busy", tier: result.tier, active: result.active }, "coach usage denied");
      return { ok: false, status: 429, message: options.busyMessage, retryable: true };
    }

    const lease = result.lease;
    let released = false;
    return {
      ok: true,
      release: async () => {
        if (released) return;
        released = true;
        try {
          await store().release(lease);
        } catch (error) {
          // The lease lapses on its own; the log keeps a leaking release
          // path visible.
          log.error({ ...logBase, err: error }, "coach usage release failed; lease will expire");
        }
      },
    };
  };
}

/**
 * Caps for one surface from its knob family. PREFIX_DAILY_BUDGET and
 * PREFIX_CONCURRENT are the organization-wide budget; PREFIX_ACCOUNT_* the
 * per-caller (account or demo IP) caps; PREFIX_OFFICE_CONCURRENT the
 * per-practice ceiling. COACH_SLOT_LEASE_SECONDS bounds how long a slot a
 * crashed server never released keeps counting.
 */
export interface UsageCapDefaults {
  globalDaily: number;
  globalConcurrent: number;
  scopeDaily: number;
  scopeConcurrent: number;
  officeConcurrent: number;
}

export function envCaps(prefix: string, defaults: UsageCapDefaults): UsageCaps {
  return {
    globalDaily: envLimit(`${prefix}_DAILY_BUDGET`, defaults.globalDaily),
    globalConcurrent: envLimit(`${prefix}_CONCURRENT`, defaults.globalConcurrent),
    scopeDaily: envLimit(`${prefix}_ACCOUNT_DAILY_BUDGET`, defaults.scopeDaily),
    scopeConcurrent: envLimit(`${prefix}_ACCOUNT_CONCURRENT`, defaults.scopeConcurrent),
    officeConcurrent: envLimit(`${prefix}_OFFICE_CONCURRENT`, defaults.officeConcurrent),
    leaseSeconds: envLimit("COACH_SLOT_LEASE_SECONDS", 600),
  };
}

/** Dish photos: pricier per call than chat turns, so a tighter budget. */
export const acquireImageSlot = createUsageLimiter({
  kind: "image",
  burst: envLimit("COACH_IMAGE_BURST", 6),
  refillPerMinute: 4,
  caps: envCaps("COACH_IMAGE", {
    globalDaily: 150,
    globalConcurrent: 2,
    scopeDaily: 40,
    scopeConcurrent: 2,
    officeConcurrent: 2,
  }),
  dailyMessage: "Photo generation has reached its daily limit. Please try again tomorrow.",
  busyMessage: "Photo generation is busy right now. Please try again in a moment.",
  rapidMessage: "You are requesting photos too quickly. Please wait a moment.",
});

/**
 * Photo reads: vision calls that carry a photo payload; priced like images.
 * One shared budget across every photo surface — the standalone menu scan,
 * chat photo turns (menu/meal/label), and the create-food label scan — so
 * the messages stay photo-generic rather than naming menus.
 */
export const acquireMenuScanSlot = createUsageLimiter({
  kind: "photo",
  burst: envLimit("COACH_PHOTO_BURST", 6),
  refillPerMinute: 4,
  caps: envCaps("COACH_PHOTO", {
    globalDaily: 150,
    globalConcurrent: 2,
    scopeDaily: 60,
    scopeConcurrent: 2,
    officeConcurrent: 2,
  }),
  dailyMessage: "Photo scanning has reached its daily limit. Please try again tomorrow.",
  busyMessage: "The photo scanner is busy right now. Please try again in a moment.",
  rapidMessage: "You are scanning photos too quickly. Please wait a moment.",
});

/** Chat turns: one per message sent from the coach screen. */
export const acquireChatSlot = createUsageLimiter({
  kind: "chat",
  burst: envLimit("COACH_CHAT_BURST", 10),
  refillPerMinute: 10,
  caps: envCaps("COACH_CHAT", {
    globalDaily: 500,
    globalConcurrent: 4,
    scopeDaily: 200,
    scopeConcurrent: 3,
    officeConcurrent: 3,
  }),
  dailyMessage: "The coach has reached its daily limit. Please try again tomorrow.",
  busyMessage: "The coach is busy right now. Please try again in a moment.",
  rapidMessage: "You are sending messages too quickly. Please wait a moment.",
});
