import { describe, expect, it } from "vitest";
import { MarkerFilter } from "./markers";

/** Feeds each chunk through the filter and flushes; returns visible output. */
function run(filter: MarkerFilter, chunks: string[]): string {
  let out = "";
  for (const chunk of chunks) out += filter.push(chunk);
  out += filter.flush();
  return out;
}

const BOTH_KINDS = ["product", "replies"] as const;

describe("MarkerFilter", () => {
  it("strips a complete marker and records its kind and id", () => {
    const filter = new MarkerFilter(BOTH_KINDS);
    const out = run(filter, ["Creatine+ can help.\n[[product:prod7]]"]);
    expect(out).toBe("Creatine+ can help.\n");
    expect(filter.markers).toEqual([{ kind: "product", id: "prod7" }]);
    expect(filter.idsFor("product")).toEqual(["prod7"]);
    expect(filter.idsFor("replies")).toEqual([]);
  });

  it("strips a replies marker and records it under its own kind", () => {
    const filter = new MarkerFilter(BOTH_KINDS);
    const out = run(filter, ["What sounds good tonight?\n[[replies:meal_preference]]"]);
    expect(out).toBe("What sounds good tonight?\n");
    expect(filter.idsFor("replies")).toEqual(["meal_preference"]);
    expect(filter.idsFor("product")).toEqual([]);
  });

  it("strips markers split across chunks at every byte", () => {
    const text = "Great choice for training days. [[product:prod7]]\n[[replies:yes_no]]";
    const filter = new MarkerFilter(BOTH_KINDS);
    const out = run(filter, text.split(""));
    expect(out).toBe("Great choice for training days. \n");
    expect(filter.idsFor("product")).toEqual(["prod7"]);
    expect(filter.idsFor("replies")).toEqual(["yes_no"]);
  });

  it("lowercases kinds and ids and matches markers case-insensitively", () => {
    const filter = new MarkerFilter(BOTH_KINDS);
    const out = run(filter, ["Sure. [[PRODUCT:PROD7]] [[Replies:Yes_No]]"]);
    expect(out).toBe("Sure.  ");
    expect(filter.markers).toEqual([
      { kind: "product", id: "prod7" },
      { kind: "replies", id: "yes_no" },
    ]);
  });

  it("records every marker in stream order", () => {
    const filter = new MarkerFilter(BOTH_KINDS);
    run(filter, ["[[replies:check_in]]", " and ", "[[replies:yes_no]]"]);
    expect(filter.idsFor("replies")).toEqual(["check_in", "yes_no"]);
  });

  it("passes ordinary bracketed text through untouched", () => {
    const filter = new MarkerFilter(BOTH_KINDS);
    const text = "Use [brackets] normally, even [[double ones]] like these.";
    const out = run(filter, [text]);
    expect(out).toBe(text);
    expect(filter.markers).toEqual([]);
  });

  it("leaves markers of unregistered kinds visible", () => {
    const filter = new MarkerFilter(["product"]);
    const text = "Done. [[replies:yes_no]]";
    const out = run(filter, [text]);
    expect(out).toBe(text);
    expect(filter.markers).toEqual([]);
  });

  it("drops a dangling partial marker at end of stream", () => {
    const filter = new MarkerFilter(BOTH_KINDS);
    let out = filter.push("Sounds good. [[replies:meal_pre");
    out += filter.flush();
    expect(out).toBe("Sounds good. ");
    expect(filter.markers).toEqual([]);
  });

  it("holds back and drops a lone trailing bracket at end of stream", () => {
    const filter = new MarkerFilter(BOTH_KINDS);
    let out = filter.push("a [");
    out += filter.flush();
    expect(out).toBe("a ");
  });

  it("releases held text once it can no longer become a marker", () => {
    const filter = new MarkerFilter(BOTH_KINDS);
    const out1 = filter.push("see [[prod");
    const out2 = filter.push("uce section]] for details");
    expect(out1 + out2).toBe("see [[produce section]] for details");
    expect(filter.markers).toEqual([]);
  });
});
