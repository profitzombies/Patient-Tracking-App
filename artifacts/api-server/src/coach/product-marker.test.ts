import { describe, expect, it } from "vitest";
import { ProductMarkerFilter } from "./product-marker";

/** Feeds `text` split into `sizes`-length chunks; returns visible output. */
function run(filter: ProductMarkerFilter, chunks: string[]): string {
  let out = "";
  for (const chunk of chunks) out += filter.push(chunk);
  out += filter.flush();
  return out;
}

describe("ProductMarkerFilter", () => {
  it("strips a complete marker and records its id", () => {
    const filter = new ProductMarkerFilter();
    const out = run(filter, ["Creatine+ can help.\n[[product:prod7]]"]);
    expect(out).toBe("Creatine+ can help.\n");
    expect(filter.ids).toEqual(["prod7"]);
  });

  it("strips a marker split across chunks at every byte", () => {
    const text = "Great choice for training days. [[product:prod7]]";
    const filter = new ProductMarkerFilter();
    const out = run(filter, text.split(""));
    expect(out).toBe("Great choice for training days. ");
    expect(filter.ids).toEqual(["prod7"]);
  });

  it("lowercases ids and matches markers case-insensitively", () => {
    const filter = new ProductMarkerFilter();
    const out = run(filter, ["Sure. [[PRODUCT:PROD7]]"]);
    expect(out).toBe("Sure. ");
    expect(filter.ids).toEqual(["prod7"]);
  });

  it("records every marker in stream order", () => {
    const filter = new ProductMarkerFilter();
    run(filter, ["[[product:prod5]]", " and ", "[[product:prod7]]"]);
    expect(filter.ids).toEqual(["prod5", "prod7"]);
  });

  it("passes ordinary bracketed text through untouched", () => {
    const filter = new ProductMarkerFilter();
    const text = "Use [brackets] normally, even [[double ones]] like these.";
    const out = run(filter, [text]);
    expect(out).toBe(text);
    expect(filter.ids).toEqual([]);
  });

  it("drops a dangling partial marker at end of stream", () => {
    const filter = new ProductMarkerFilter();
    let out = filter.push("Sounds good. [[product:pro");
    out += filter.flush();
    expect(out).toBe("Sounds good. ");
    expect(filter.ids).toEqual([]);
  });

  it("holds back and drops a lone trailing bracket at end of stream", () => {
    const filter = new ProductMarkerFilter();
    let out = filter.push("a [");
    out += filter.flush();
    expect(out).toBe("a ");
  });

  it("releases held text once it can no longer become a marker", () => {
    const filter = new ProductMarkerFilter();
    const out1 = filter.push("see [[prod");
    const out2 = filter.push("uce section]] for details");
    expect(out1 + out2).toBe("see [[produce section]] for details");
    expect(filter.ids).toEqual([]);
  });
});
