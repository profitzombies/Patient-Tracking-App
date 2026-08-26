/**
 * In-memory abuse limits for the coach endpoint.
 *
 * The coach calls a paid model, and this demo has no user accounts, so cost
 * exhaustion is bounded three ways:
 *
 * - per-IP token bucket (burst + steady rate),
 * - a global cap on concurrent streams,
 * - a global daily request budget (resets at UTC midnight).
 *
 * Single-process state is fine here: the API server runs as one instance in
 * dev and in the demo deployment.
 */

/** Drop idle per-IP buckets so the map cannot grow without bound. */
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

/** Dish photos: pricier per call than chat turns, so a tighter budget. */
export const acquireImageSlot = createLimiter({
  burst: 6,
  refillPerMinute: 4,
  maxConcurrent: 2,
  dailyBudget: 150,
  dailyMessage: "Photo generation has reached its daily limit. Please try again tomorrow.",
  busyMessage: "Photo generation is busy right now. Please try again in a moment.",
  rapidMessage: "You are requesting photos too quickly. Please wait a moment.",
});

/**
 * Photo scans: vision calls that carry a photo payload; priced like images.
 * One shared budget across every photo surface — the standalone menu scan,
 * chat photo turns (menu/meal/label), and the create-food label scan — so
 * the messages stay photo-generic rather than naming menus.
 */
export const acquireMenuScanSlot = createLimiter({
  burst: 6,
  refillPerMinute: 4,
  maxConcurrent: 2,
  dailyBudget: 150,
  dailyMessage: "Photo scanning has reached its daily limit. Please try again tomorrow.",
  busyMessage: "The photo scanner is busy right now. Please try again in a moment.",
  rapidMessage: "You are scanning photos too quickly. Please wait a moment.",
});

/**
 * Test/staging hook: a non-negative integer in the named env var overrides a
 * chat-limiter default, so e2e tests can stage denial states deterministically
 * (COACH_CHAT_DAILY_BUDGET=0 → every send answers with the daily-limit
 * message; COACH_CHAT_BURST=0 → every send answers rapid-fire). Unset in
 * normal runs, leaving the defaults untouched.
 */
function envLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** Chat turns: one per message sent from the coach screen. */
export const acquireChatSlot = createLimiter({
  burst: envLimit("COACH_CHAT_BURST", 10),
  refillPerMinute: 10,
  maxConcurrent: 4,
  dailyBudget: envLimit("COACH_CHAT_DAILY_BUDGET", 500),
  dailyMessage: "The coach has reached its daily limit. Please try again tomorrow.",
  busyMessage: "The coach is busy right now. Please try again in a moment.",
  rapidMessage: "You are sending messages too quickly. Please wait a moment.",
});
