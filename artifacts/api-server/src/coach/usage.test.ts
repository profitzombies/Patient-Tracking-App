/**
 * Unit tests for the photo-turn usage log: per-stage summing across retries,
 * the reasoning-token breakout, tolerance for upstreams that report no usage
 * (mocked tests, exotic gateways), and snapshot isolation — a discarded
 * speculative read settling AFTER the completion line was logged must not
 * mutate the already-logged snapshot.
 */
import { describe, expect, it } from "vitest";
import { createPhotoUsageLog } from "./usage";

describe("createPhotoUsageLog", () => {
  it("snapshots undefined until something is recorded (pino drops the key)", () => {
    const log = createPhotoUsageLog();
    expect(log.snapshot()).toBeUndefined();
    // Handing usage=undefined to a recorder (mock upstream) records nothing.
    log.recorder("classify")(undefined);
    expect(log.snapshot()).toBeUndefined();
  });

  it("sums per stage across calls and breaks out reasoning tokens", () => {
    const log = createPhotoUsageLog();
    const meal = log.recorder("meal");
    meal({
      prompt_tokens: 1000,
      completion_tokens: 400,
      completion_tokens_details: { reasoning_tokens: 250 },
    });
    // Corrective retry in the same stage sums into the same bucket.
    meal({
      prompt_tokens: 1100,
      completion_tokens: 300,
      completion_tokens_details: { reasoning_tokens: 150 },
    });
    expect(log.snapshot()).toEqual({
      meal: { calls: 2, prompt: 2100, completion: 700, reasoning: 400 },
    });
  });

  it("tolerates reports with missing fields or detail blocks", () => {
    const log = createPhotoUsageLog();
    const classify = log.recorder("classify");
    classify({ prompt_tokens: 500, completion_tokens: 20 });
    classify({ completion_tokens_details: null });
    expect(log.snapshot()).toEqual({
      classify: { calls: 2, prompt: 500, completion: 20, reasoning: 0 },
    });
  });

  it("keeps stages separate and isolates snapshots from later recording", () => {
    const log = createPhotoUsageLog();
    log.recorder("classify")({ prompt_tokens: 300, completion_tokens: 10 });
    log.recorder("menu")({ prompt_tokens: 900, completion_tokens: 200 });
    const logged = log.snapshot();
    expect(Object.keys(logged ?? {}).sort()).toEqual(["classify", "menu"]);

    // A straggler (e.g. the discarded speculative meal read finishing late)
    // must not reach back into the snapshot the route already logged.
    log.recorder("meal")({ prompt_tokens: 5000, completion_tokens: 700 });
    log.recorder("menu")({ prompt_tokens: 1, completion_tokens: 1 });
    expect(logged).toEqual({
      classify: { calls: 1, prompt: 300, completion: 10, reasoning: 0 },
      menu: { calls: 1, prompt: 900, completion: 200, reasoning: 0 },
    });
    expect(log.snapshot()?.meal).toEqual({ calls: 1, prompt: 5000, completion: 700, reasoning: 0 });
  });
});
