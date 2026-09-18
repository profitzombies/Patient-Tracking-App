import { describe, expect, it } from "vitest";
import { newOrderNumber } from "./store";

/** Order numbers double as WarehouseCraft ClientOrderIds: the format is a wire contract. */
describe("newOrderNumber", () => {
  it("matches TH- plus six unambiguous characters and never contains #", () => {
    for (let i = 0; i < 2000; i += 1) {
      const value = newOrderNumber();
      expect(value).toMatch(/^TH-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
      expect(value).not.toContain("#");
    }
  });
  it("does not repeat across a large sample", () => {
    const seen = new Set(Array.from({ length: 20_000 }, () => newOrderNumber()));
    expect(seen.size).toBe(20_000);
  });
});
