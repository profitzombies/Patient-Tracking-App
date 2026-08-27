/**
 * The AI Support emoji guards. (The brand-spelling guard moved to the shared
 * module — see ../lib/brand-spelling.test.ts.)
 *
 * The support voice is emoji-free by contract — whole emoji sequences (ZWJ
 * families, flags, skin tones, keycaps) are removed on whole strings and
 * across any chunk boundary, while ™/©/® and non-emoji astral characters
 * survive.
 */
import { describe, expect, it } from "vitest";
import { EmojiSmoother, stripEmojis } from "./text-guards";

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
