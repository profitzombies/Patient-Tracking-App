/**
 * Rate limits for progress-photo writes — the same limiter machinery as
 * coach/training/knowledge, with its OWN knobs so a patient saving photos
 * never shares a budget with training uploads or chat.
 *
 * The routes are open in the demo posture (no patient sign-in), so a
 * modest per-IP budget stands in for a gate. A full guided session costs
 * six write calls (upload-url + finalize × three angles); the burst
 * absorbs a session plus a retry or two. PROGRESS_WRITE_BURST /
 * PROGRESS_WRITE_DAILY_BUDGET stage denials for tests, exactly like the
 * training knobs (read at server start; restart to change).
 */
import { createLimiter, envLimit } from "../coach/limits";

export const acquireProgressWriteSlot = createLimiter({
  burst: envLimit("PROGRESS_WRITE_BURST", 30),
  refillPerMinute: 12,
  maxConcurrent: 8,
  dailyBudget: envLimit("PROGRESS_WRITE_DAILY_BUDGET", 600),
  dailyMessage:
    "Progress photo uploads have reached their daily limit. Please try again tomorrow.",
  busyMessage: "Progress photo uploads are busy right now. Please try again in a moment.",
  rapidMessage: "You are uploading too quickly. Please wait a moment.",
});
