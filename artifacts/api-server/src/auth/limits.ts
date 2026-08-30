/**
 * Per-IP abuse limits for the passwordless login/signup endpoints, riding the
 * shared limiter machinery. Denials are deliberately generic: rate-limit
 * responses must not hint at whether an account exists any more than normal
 * responses do.
 *
 * Env knobs (AUTH_*_BURST / AUTH_*_DAILY_BUDGET) exist so tests can stage
 * denial states deterministically, mirroring the claim limiters.
 */
import { createLimiter, envLimit } from "../coach/limits";

const WAIT_MESSAGE = "Too many attempts from this connection. Please wait a moment and try again.";
const DAILY_MESSAGE = "Too many attempts today. Please try again tomorrow.";
const BUSY_MESSAGE = "We're a little busy right now. Please try again in a moment.";

/** Code-send requests: login start, signup start. */
export const acquireSendSlot = createLimiter({
  burst: envLimit("AUTH_SEND_BURST", 6),
  refillPerMinute: 3,
  maxConcurrent: 8,
  dailyBudget: envLimit("AUTH_SEND_DAILY_BUDGET", 500),
  dailyMessage: DAILY_MESSAGE,
  busyMessage: BUSY_MESSAGE,
  rapidMessage: WAIT_MESSAGE,
});

/** Code checks: login verify, signup verify. */
export const acquireCheckSlot = createLimiter({
  burst: envLimit("AUTH_CHECK_BURST", 10),
  refillPerMinute: 5,
  maxConcurrent: 8,
  dailyBudget: envLimit("AUTH_CHECK_DAILY_BUDGET", 1000),
  dailyMessage: DAILY_MESSAGE,
  busyMessage: BUSY_MESSAGE,
  rapidMessage: WAIT_MESSAGE,
});

/** Provider-code checks during signup — the code is semi-public, so probing is capped. */
export const acquireOfficeSlot = createLimiter({
  burst: envLimit("AUTH_OFFICE_BURST", 8),
  refillPerMinute: 4,
  maxConcurrent: 8,
  dailyBudget: envLimit("AUTH_OFFICE_DAILY_BUDGET", 300),
  dailyMessage: DAILY_MESSAGE,
  busyMessage: BUSY_MESSAGE,
  rapidMessage: WAIT_MESSAGE,
});

/** Signup completion — creates accounts, so the tightest budget of the set. */
export const acquireFinishSlot = createLimiter({
  burst: envLimit("AUTH_FINISH_BURST", 6),
  refillPerMinute: 3,
  maxConcurrent: 4,
  dailyBudget: envLimit("AUTH_FINISH_DAILY_BUDGET", 200),
  dailyMessage: DAILY_MESSAGE,
  busyMessage: BUSY_MESSAGE,
  rapidMessage: WAIT_MESSAGE,
});
