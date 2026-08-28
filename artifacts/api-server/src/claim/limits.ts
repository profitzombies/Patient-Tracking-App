/**
 * Per-IP abuse limits for the claim endpoints, riding the shared limiter
 * machinery. Denials are deliberately generic: rate-limit responses must not
 * hint at whether an account exists any more than normal responses do.
 *
 * Env knobs (CLAIM_*_BURST / CLAIM_*_DAILY_BUDGET) exist so tests can stage
 * denial states deterministically, mirroring the coach/support limiters.
 */
import { createLimiter, envLimit } from "../coach/limits";

const WAIT_MESSAGE = "Too many attempts from this connection. Please wait a moment and try again.";
const DAILY_MESSAGE = "Too many attempts today. Please try again tomorrow.";
const BUSY_MESSAGE = "We're a little busy right now. Please try again in a moment.";

export const acquireIdentifySlot = createLimiter({
  burst: envLimit("CLAIM_IDENTIFY_BURST", 6),
  refillPerMinute: 3,
  maxConcurrent: 8,
  dailyBudget: envLimit("CLAIM_IDENTIFY_DAILY_BUDGET", 500),
  dailyMessage: DAILY_MESSAGE,
  busyMessage: BUSY_MESSAGE,
  rapidMessage: WAIT_MESSAGE,
});

export const acquireVerifySlot = createLimiter({
  burst: envLimit("CLAIM_VERIFY_BURST", 10),
  refillPerMinute: 5,
  maxConcurrent: 8,
  dailyBudget: envLimit("CLAIM_VERIFY_DAILY_BUDGET", 1000),
  dailyMessage: DAILY_MESSAGE,
  busyMessage: BUSY_MESSAGE,
  rapidMessage: WAIT_MESSAGE,
});

export const acquireCompleteSlot = createLimiter({
  burst: envLimit("CLAIM_COMPLETE_BURST", 6),
  refillPerMinute: 3,
  maxConcurrent: 4,
  dailyBudget: envLimit("CLAIM_COMPLETE_DAILY_BUDGET", 300),
  dailyMessage: DAILY_MESSAGE,
  busyMessage: BUSY_MESSAGE,
  rapidMessage: WAIT_MESSAGE,
});
