/**
 * Rate limits for the AI Support chat — the same limiter machinery as the
 * patient coach, with its OWN knobs so office traffic and patient traffic
 * never share a budget. SUPPORT_CHAT_BURST / SUPPORT_CHAT_DAILY_BUDGET
 * override the defaults for tests and break/heal staging, exactly like the
 * coach's COACH_CHAT_* knobs (read at server start; restart to change).
 */
import { createLimiter, envLimit } from "../coach/limits";

/** Support turns: one per message sent from the AI Support page. */
export const acquireSupportSlot = createLimiter({
  burst: envLimit("SUPPORT_CHAT_BURST", 10),
  refillPerMinute: 10,
  maxConcurrent: 4,
  dailyBudget: envLimit("SUPPORT_CHAT_DAILY_BUDGET", 300),
  dailyMessage: "AI Support has reached its daily limit. Please try again tomorrow.",
  busyMessage: "AI Support is busy right now. Please try again in a moment.",
  rapidMessage: "You are sending messages too quickly. Please wait a moment.",
});
