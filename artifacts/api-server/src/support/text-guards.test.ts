/**
 * The AI Support output guards.
 *
 * Brand spelling: capitalized Thinner/THINNER become THINNR
 * deterministically, on whole strings and across arbitrary SSE chunk splits,
 * while ordinary words, mid-word runs, and the support email pass through
 * untouched.
 *
 * Emojis: the support voice is emoji-free by contract — whole emoji
 * sequences (ZWJ families, flags, skin tones, keycaps) are removed on whole
 * strings and across any chunk boundary, while ™/©/® and non-emoji astral
 * characters survive.
 */
import { describe, expect, it } from "vitest";
import {
  BrandSpellingSmoother,
  EmojiSmoother,
  normalizeBrandSpelling,
  stripEmojis,
} from "./text-guards";

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

describe("stripEmojis", () => {
  it("removes plain pictographs, leaving surrounding spacing alone", () => {
    expect(stripEmojis("Great news! 🎉 Boost helps.")).toBe("Great news!  Boost helps.");
  });

  it("removes a whole ZWJ family sequence", () => {
    expect(stripEmojis("Team 👩\u200D👩\u200D👦 effort")).toBe("Team  effort");
  });

  it("removes flags and skin-toned emojis", () => {
    expect(stripEmojis("Made in 🇺🇸 with 👍🏽 care")).toBe("Made in  with  care");
  });

  it("degrades a keycap to its plain digit", () => {
    expect(stripEmojis("Step 1\uFE0F\u20E3 first")).toBe("Step 1 first");
  });

  it("strips text-presentation selectors and their base pictograph", () => {
    expect(stripEmojis("Call ☎\uFE0E us")).toBe("Call  us");
  });

  it("keeps trademark, copyright, and registered marks", () => {
    expect(stripEmojis("THINNR Boost™ © 2026 Thinnr® program")).toBe(
      "THINNR Boost™ © 2026 Thinnr® program",
    );
  });

  it("leaves accents, CJK, and ordinary symbols untouched", () => {
    expect(stripEmojis("Café 食欲 α + 5% > $3")).toBe("Café 食欲 α + 5% > $3");
  });
});

/** Runs the emoji smoother over a chunking and returns the drained output. */
function smoothEmojis(chunks: string[]): string {
  const smoother = new EmojiSmoother();
  let out = "";
  for (const chunk of chunks) out += smoother.push(chunk);
  return out + smoother.flush();
}

describe("EmojiSmoother", () => {
  it("passes plain chunks through unchanged", () => {
    expect(smoothEmojis(["Drink water ", "every day."])).toBe("Drink water every day.");
  });

  it("strips an emoji whose surrogate pair is split across chunks", () => {
    const thumb = "👍";
    expect(smoothEmojis([`Take Boost ${thumb.charAt(0)}`, `${thumb.charAt(1)} daily.`])).toBe(
      "Take Boost  daily.",
    );
  });

  it("strips a ZWJ sequence split between chunks", () => {
    expect(smoothEmojis(["👩\u200D", "👦 tips"])).toBe(" tips");
  });

  it("reassembles a non-emoji astral character split across chunks", () => {
    const alpha = "\u{1D6FC}"; // mathematical italic small alpha — astral, not an emoji
    expect(smoothEmojis([`x = ${alpha.charAt(0)}`, `${alpha.charAt(1)} works`])).toBe(
      `x = ${alpha} works`,
    );
  });

  it("drops a lone trailing high surrogate at flush", () => {
    expect(smoothEmojis(["All done ", "👍".charAt(0)])).toBe("All done ");
  });

  it("keeps ™ across chunks", () => {
    expect(smoothEmojis(["Boost™", " rocks"])).toBe("Boost™ rocks");
  });
});
