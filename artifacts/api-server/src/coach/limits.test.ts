/**
 * Denial-shape tests for the coach limiters: each denial kind carries its
 * own user-facing message plus the retryability contract the mobile client
 * keys on — daily-budget denials are final (retryable: false, waiting is the
 * only fix), while busy and rapid-fire denials are transient (retryable:
 * true, the Retry control can plausibly help).
 */
import { describe, expect, it } from "vitest";
import { createLimiter } from "./limits";

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
