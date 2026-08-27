/**
 * Rate limits for training-media writes — the same limiter machinery as the
 * coach and the knowledge library, with its OWN knobs so training traffic
 * never shares a budget with either.
 *
 * Uploading, replacing, removing, thumbnails, and the AI pass are open in
 * the demo posture — no staff sign-in — so a modest per-IP budget stands in
 * for the retired gate. Reads (playback URLs, transcript) are NOT limited;
 * the lesson pages re-mint signed URLs while people watch. The burst
 * absorbs a legitimate upload session (upload-url + finalize per video,
 * plus thumbnail calls and an AI run). The SSE process route holds its slot
 * until the stream closes, so concurrent AI runs are bounded too.
 * TRAINING_WRITE_BURST / TRAINING_WRITE_DAILY_BUDGET stage denials for
 * tests, exactly like the chat knobs (read at server start; restart to
 * change).
 */
import { createLimiter, envLimit } from "../coach/limits";

export const acquireTrainingWriteSlot = createLimiter({
  burst: envLimit("TRAINING_WRITE_BURST", 20),
  refillPerMinute: 10,
  maxConcurrent: 8,
  dailyBudget: envLimit("TRAINING_WRITE_DAILY_BUDGET", 400),
  dailyMessage:
    "Training media has reached its daily change limit. Please try again tomorrow.",
  busyMessage: "Training media is busy right now. Please try again in a moment.",
  rapidMessage: "You are making changes too quickly. Please wait a moment.",
});
