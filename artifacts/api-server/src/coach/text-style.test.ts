/**
 * Unit tests for the coach's no-dash voice enforcement: stripDashes on
 * complete strings, DashSmoother across streamed chunk boundaries, and a
 * guard that the canned coach strings themselves obey the rule.
 */
import { describe, expect, it } from "vitest";
import { DashSmoother, stripDashes } from "./text-style";
import { MEAL_CARD_CLOSER, MEAL_TRY_ANOTHER_PHOTO } from "./meal-chat";
import { MENU_RECIPE_OFFER, MENU_RECIPE_OFFER_EMPTY } from "./menu-chat";
import { COACH_VOICE_RULES } from "./prompt";

describe("stripDashes", () => {
  it("swaps a spaced em dash for a comma", () => {
    expect(stripDashes("Good call — protein first.")).toBe("Good call, protein first.");
  });

  it("swaps an unspaced em dash for a comma", () => {
    expect(stripDashes("Good call—protein first.")).toBe("Good call, protein first.");
  });

  it("treats a spaced en dash as the same pause", () => {
    expect(stripDashes("One step – then the next.")).toBe("One step, then the next.");
  });

  it("keeps digit ranges as plain hyphens", () => {
    expect(stripDashes("Aim for 2–3 eggs.")).toBe("Aim for 2-3 eggs.");
    expect(stripDashes("Rest 10 — 12 minutes.")).toBe("Rest 10-12 minutes.");
  });

  it("joins words linked by an unspaced en dash with a hyphen", () => {
    expect(stripDashes("Track it Monday–Friday.")).toBe("Track it Monday-Friday.");
  });

  it("collapses a dash run into a single comma", () => {
    expect(stripDashes("Sure —— go ahead.")).toBe("Sure, go ahead.");
  });

  it("never stacks the comma onto existing punctuation", () => {
    expect(stripDashes("Done. — Next up, water.")).toBe("Done. Next up, water.");
    expect(stripDashes("Nice, — keep going.")).toBe("Nice, keep going.");
  });

  it("drops the comma at a line start and at the ends of the string", () => {
    expect(stripDashes("— protein first")).toBe("protein first");
    expect(stripDashes("Plan:\n— eggs")).toBe("Plan:\neggs");
    expect(stripDashes("You're on track —")).toBe("You're on track");
  });

  it("leaves dash-free text byte-identical", () => {
    const text = "Hey Emma, good to see you. What's on your mind today?";
    expect(stripDashes(text)).toBe(text);
  });
});

describe("DashSmoother", () => {
  function run(chunks: string[]): string {
    const smoother = new DashSmoother();
    let out = "";
    for (const chunk of chunks) out += smoother.push(chunk);
    return out + smoother.flush();
  }

  it("rewrites a dash bridge split across chunks", () => {
    expect(run(["Great start ", "— keep it up."])).toBe("Great start, keep it up.");
  });

  it("rewrites a digit range split across chunks", () => {
    expect(run(["Aim for 2", "–3 eggs."])).toBe("Aim for 2-3 eggs.");
  });

  it("handles the dash arriving alone in its own chunk", () => {
    expect(run(["Solid plan ", "—", " water first."])).toBe("Solid plan, water first.");
  });

  it("drops a trailing dash left hanging at stream end", () => {
    expect(run(["Nice work —"])).toBe("Nice work");
  });

  it("passes dash-free streams through with identical joined text", () => {
    expect(run(["Hello ", "Emma.", " Two eggs, then water."])).toBe(
      "Hello Emma. Two eggs, then water.",
    );
  });

  it("never buffers unbounded digit runs", () => {
    const smoother = new DashSmoother();
    const emitted = smoother.push("Call 123456789012345678901234567890");
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted + smoother.flush()).toBe("Call 123456789012345678901234567890");
  });
});

describe("canned coach strings obey the no-dash voice rule", () => {
  it.each([
    ["MEAL_CARD_CLOSER", MEAL_CARD_CLOSER],
    ["MEAL_TRY_ANOTHER_PHOTO", MEAL_TRY_ANOTHER_PHOTO],
    ["MENU_RECIPE_OFFER", MENU_RECIPE_OFFER],
    ["MENU_RECIPE_OFFER_EMPTY", MENU_RECIPE_OFFER_EMPTY],
  ])("%s carries no em or en dash", (_name, text) => {
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });

  it("the shared voice rules ban the em dash by name", () => {
    expect(COACH_VOICE_RULES).toContain("em dash");
  });
});
