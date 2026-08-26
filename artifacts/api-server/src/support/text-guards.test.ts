/**
 * The AI Support brand-spelling guard: capitalized Thinner/THINNER become
 * THINNR deterministically, on whole strings and across arbitrary SSE chunk
 * splits, while ordinary words, mid-word runs, and the support email pass
 * through untouched.
 */
import { describe, expect, it } from "vitest";
import { BrandSpellingSmoother, normalizeBrandSpelling } from "./text-guards";

describe("normalizeBrandSpelling", () => {
  it("rewrites both capitalized misspellings", () => {
    expect(normalizeBrandSpelling("THINNER helps; Thinner too.")).toBe(
      "THINNR helps; THINNR too.",
    );
  });

  it("leaves the lowercase English word alone", () => {
    expect(normalizeBrandSpelling("use a thinner layer")).toBe("use a thinner layer");
  });

  it("only matches whole words", () => {
    expect(normalizeBrandSpelling("AntiThinner Thinners ThinnerX")).toBe(
      "AntiThinner Thinners ThinnerX",
    );
  });

  it("keeps the support email exact", () => {
    expect(normalizeBrandSpelling("Support@Thinnrweightloss.com")).toBe(
      "Support@Thinnrweightloss.com",
    );
  });

  it("handles punctuation and possessives around the word", () => {
    expect(normalizeBrandSpelling("(Thinner) Thinner's THINNER!")).toBe(
      "(THINNR) THINNR's THINNR!",
    );
  });
});

/** Runs the smoother over a chunking and returns the fully drained output. */
function smooth(chunks: string[]): string {
  const smoother = new BrandSpellingSmoother();
  let out = "";
  for (const chunk of chunks) out += smoother.push(chunk);
  return out + smoother.flush();
}

describe("BrandSpellingSmoother", () => {
  it("passes plain text through unchanged", () => {
    expect(smooth(["The patient ", "asked about foods."])).toBe(
      "The patient asked about foods.",
    );
  });

  it("rewrites a misspelling split across chunks", () => {
    expect(smooth(["The THIN", "NER program helps."])).toBe("The THINNR program helps.");
    expect(smooth(["Ask about Thin", "ner today."])).toBe("Ask about THINNR today.");
  });

  it("rewrites a misspelling held at end of stream", () => {
    expect(smooth(["The brand is Thinner"])).toBe("The brand is THINNR");
  });

  it("never rewrites a run that only LOOKS like a word start after a split", () => {
    // "AntiThinner" split anywhere must stay untouched.
    expect(smooth(["AntiThin", "ner"])).toBe("AntiThinner");
    expect(smooth(["Anti", "Thinner"])).toBe("AntiThinner");
  });

  it("keeps word context across a long-run emit (13+ letters)", () => {
    // The 20-letter run is emitted immediately; the next chunk continues the
    // same word, so its "Thinner" is mid-word and must not rewrite.
    expect(smooth(["supercalifragilistic", "Thinner x"])).toBe(
      "supercalifragilisticThinner x",
    );
  });

  it("still rewrites after a long run that ended with a boundary", () => {
    expect(smooth(["supercalifragilistic ", "Thinner is the old name."])).toBe(
      "supercalifragilistic THINNR is the old name.",
    );
  });

  it("leaves lowercase thinner alone across splits", () => {
    expect(smooth(["a thin", "ner broth"])).toBe("a thinner broth");
  });
});
