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

const PER_IP_BURST = 10;
const PER_IP_REFILL_PER_MINUTE = 10;
const MAX_CONCURRENT_STREAMS = 4;
const DAILY_REQUEST_BUDGET = 500;
/** Drop idle per-IP buckets so the map cannot grow without bound. */
const BUCKET_IDLE_EVICT_MS = 10 * 60 * 1000;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();
let activeStreams = 0;
let dailyCount = 0;
let dailyKey = "";

function refill(bucket: Bucket, now: number): void {
  const elapsedMinutes = (now - bucket.updatedAt) / 60_000;
  bucket.tokens = Math.min(PER_IP_BURST, bucket.tokens + elapsedMinutes * PER_IP_REFILL_PER_MINUTE);
  bucket.updatedAt = now;
}

function evictIdleBuckets(now: number): void {
  if (buckets.size < 1000) return;
  for (const [key, bucket] of buckets) {
    if (now - bucket.updatedAt > BUCKET_IDLE_EVICT_MS) buckets.delete(key);
  }
}

export type ChatSlot =
  | { ok: true; release: () => void }
  | { ok: false; status: number; message: string };

/**
 * Reserves capacity for one chat turn. On success the caller MUST call
 * `release()` when the stream finishes (success or failure).
 */
export function acquireChatSlot(ip: string): ChatSlot {
  const now = Date.now();

  const today = new Date(now).toISOString().slice(0, 10);
  if (today !== dailyKey) {
    dailyKey = today;
    dailyCount = 0;
  }
  if (dailyCount >= DAILY_REQUEST_BUDGET) {
    return {
      ok: false,
      status: 429,
      message: "The coach has reached its daily limit. Please try again tomorrow.",
    };
  }

  if (activeStreams >= MAX_CONCURRENT_STREAMS) {
    return {
      ok: false,
      status: 429,
      message: "The coach is busy right now. Please try again in a moment.",
    };
  }

  evictIdleBuckets(now);
  let bucket = buckets.get(ip);
  if (!bucket) {
    bucket = { tokens: PER_IP_BURST, updatedAt: now };
    buckets.set(ip, bucket);
  } else {
    refill(bucket, now);
  }
  if (bucket.tokens < 1) {
    return {
      ok: false,
      status: 429,
      message: "You are sending messages too quickly. Please wait a moment.",
    };
  }

  bucket.tokens -= 1;
  dailyCount += 1;
  activeStreams += 1;
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      activeStreams -= 1;
    },
  };
}
