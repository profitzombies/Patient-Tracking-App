import { describe, expect, it } from "vitest";
import { localDayWindow, resolveTimeZone } from "./reporting";

describe("local day window", () => {
  it("spans local midnight to local midnight, including 23- and 25-hour DST days", () => {
    const springForward = localDayWindow("America/New_York", new Date("2026-03-08T12:00:00Z"));
    expect(springForward.date).toBe("2026-03-08");
    expect(springForward.start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(springForward.end.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(springForward.currentHour).toBe(8);
    const fallBack = localDayWindow("America/New_York", new Date("2026-11-01T12:00:00Z"));
    expect(fallBack.start.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(fallBack.end.toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });
  it("uses the local calendar date, not the UTC one, late in the evening", () => {
    const late = localDayWindow("America/New_York", new Date("2026-09-15T02:30:00Z"));
    expect(late.date).toBe("2026-09-14");
    expect(late.currentHour).toBe(22);
  });
  it("accepts real IANA zones and refuses made-up ones", () => {
    expect(resolveTimeZone(undefined)).toBe("America/New_York");
    expect(resolveTimeZone("Europe/London")).toBe("Europe/London");
    expect(() => resolveTimeZone("Nowhere/Land")).toThrow(/time zone/);
  });
});
