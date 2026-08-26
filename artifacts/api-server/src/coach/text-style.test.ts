/**
 * Unit tests for the coach's no-dash voice enforcement: stripDashes on
 * complete strings, DashSmoother across streamed chunk boundaries, and a
 * guard that the canned coach strings themselves obey the rule.
 */
import { describe, expect, it } from "vitest";
import { DashSmoother, stripDashes, toTitleCase } from "./text-style";
import { MEAL_CARD_CLOSER, MEAL_TRY_ANOTHER_PHOTO } from "./meal-chat";
import { LABEL_CHECK_NOTE, LABEL_NAME_ASK, LABEL_TRY_ANOTHER_PHOTO } from "./label-chat";
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
    ["LABEL_NAME_ASK", LABEL_NAME_ASK],
    ["LABEL_TRY_ANOTHER_PHOTO", LABEL_TRY_ANOTHER_PHOTO],
    ["LABEL_CHECK_NOTE", LABEL_CHECK_NOTE],
  ])("%s carries no em or en dash", (_name, text) => {
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });

  it("the shared voice rules ban the em dash by name", () => {
    expect(COACH_VOICE_RULES).toContain("em dash");
  });
});

describe("toTitleCase", () => {
  it("capitalizes plain lowercase names", () => {
    expect(toTitleCase("grilled chicken with sweet potatoes")).toBe(
      "Grilled Chicken with Sweet Potatoes",
    );
  });

  it("keeps small connector words lowercase mid-name", () => {
    expect(toTitleCase("bowl of oats and berries")).toBe("Bowl of Oats and Berries");
  });

  it("capitalizes a small word at the start and at the end", () => {
    expect(toTitleCase("on the go trail mix")).toBe("On the Go Trail Mix");
    expect(toTitleCase("smoothie to go")).toBe("Smoothie to Go");
  });

  it("capitalizes each hyphen segment", () => {
    expect(toTitleCase("sugar-free vanilla pudding")).toBe("Sugar-Free Vanilla Pudding");
  });

  it("leaves acronyms and brand spellings untouched", () => {
    expect(toTitleCase("PB&J energy bites")).toBe("PB&J Energy Bites");
    expect(toTitleCase("McCann's steel cut oats")).toBe("McCann's Steel Cut Oats");
    expect(toTitleCase("THINNR shake")).toBe("THINNR Shake");
  });

  it("normalizes shouty single-case words but preserves digits and punctuation", () => {
    expect(toTitleCase("greek yogurt (2%)")).toBe("Greek Yogurt (2%)");
    expect(toTitleCase("7-grain bread")).toBe("7-Grain Bread");
  });

  it("collapses stray whitespace", () => {
    expect(toTitleCase("  overnight   oats ")).toBe("Overnight Oats");
  });

  it("returns already Title Case names byte-identical", () => {
    expect(toTitleCase("Baked Salmon Bowl")).toBe("Baked Salmon Bowl");
    expect(toTitleCase("Grilled Chicken with Sweet Potatoes")).toBe(
      "Grilled Chicken with Sweet Potatoes",
    );
  });
});
