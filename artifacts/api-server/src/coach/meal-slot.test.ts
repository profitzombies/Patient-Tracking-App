/**
 * Unit tests for the meal-slot module: lenient "HH:MM" parsing, the
 * time-of-day band table (boundaries included), and how the per-turn slot
 * context is built from a request body. Pure functions, fixed inputs — the
 * real clock is never read.
 */
import { describe, expect, it } from "vitest";
import {
  buildMealSlotContext,
  mealSlotForLocalTime,
  parseLocalTimeMinutes,
} from "./meal-slot";

describe("parseLocalTimeMinutes", () => {
  it("parses canonical HH:MM", () => {
    expect(parseLocalTimeMinutes("14:05")).toBe(14 * 60 + 5);
    expect(parseLocalTimeMinutes("00:00")).toBe(0);
    expect(parseLocalTimeMinutes("23:59")).toBe(23 * 60 + 59);
  });

  it("is lenient about a missing leading zero and stray whitespace", () => {
    expect(parseLocalTimeMinutes("9:05")).toBe(9 * 60 + 5);
    expect(parseLocalTimeMinutes(" 08:00 ")).toBe(8 * 60);
  });

  it("rejects junk with null, never throwing", () => {
    for (const junk of ["", "9am", "25:00", "12:60", "1230", "12-30", "9:5", "99:99"]) {
      expect(parseLocalTimeMinutes(junk)).toBeNull();
    }
    expect(parseLocalTimeMinutes(undefined)).toBeNull();
  });
});

describe("mealSlotForLocalTime", () => {
  it("maps each band, boundaries included", () => {
    const table: Array<[string, string]> = [
      ["04:00", "breakfast"],
      ["08:00", "breakfast"],
      ["10:59", "breakfast"],
      ["11:00", "lunch"],
      ["14:05", "lunch"],
      ["14:59", "lunch"],
      ["15:00", "snacks"],
      ["16:59", "snacks"],
      ["17:00", "dinner"],
      ["20:00", "dinner"],
      ["21:59", "dinner"],
      ["22:00", "snacks"],
      ["23:30", "snacks"],
      ["00:00", "snacks"],
      ["03:59", "snacks"],
    ];
    for (const [time, slot] of table) {
      expect(mealSlotForLocalTime(time), time).toBe(slot);
    }
  });

  it("returns undefined for junk or absent times", () => {
    expect(mealSlotForLocalTime(undefined)).toBeUndefined();
    expect(mealSlotForLocalTime("99:99")).toBeUndefined();
    expect(mealSlotForLocalTime("noonish")).toBeUndefined();
  });
});

describe("buildMealSlotContext", () => {
  it("is empty for an old client that sent nothing", () => {
    expect(buildMealSlotContext({})).toEqual({});
  });

  it("derives the time default and echoes the trimmed clock reading", () => {
    expect(buildMealSlotContext({ localTime: "14:05" })).toEqual({
      timeDefault: "lunch",
      localTime: "14:05",
    });
    expect(buildMealSlotContext({ localTime: " 8:30 " })).toEqual({
      timeDefault: "breakfast",
      localTime: "8:30",
    });
  });

  it("keeps an explicit pin, with or without a clock reading", () => {
    expect(buildMealSlotContext({ mealSlot: "dinner" })).toEqual({ explicit: "dinner" });
    expect(buildMealSlotContext({ mealSlot: "dinner", localTime: "14:05" })).toEqual({
      explicit: "dinner",
      timeDefault: "lunch",
      localTime: "14:05",
    });
  });

  it("silently drops an unparseable clock instead of failing the turn", () => {
    expect(buildMealSlotContext({ localTime: "99:99" })).toEqual({});
    expect(buildMealSlotContext({ localTime: "99:99", mealSlot: "snacks" })).toEqual({
      explicit: "snacks",
    });
  });
});
