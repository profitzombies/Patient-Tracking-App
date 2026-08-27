/**
 * Deterministic output guards for the AI Support stream.
 *
 * Brand spelling lives in the shared module ../lib/brand-spelling — every AI
 * surface (support, coach, training, knowledge summaries) uses that single
 * normalizer/smoother implementation; the support route wires its
 * BrandSpellingSmoother into the same chain as the guards below.
 *
 * Emojis: the support voice is strictly emoji-free. The prompt says so, but
 * prompts are style requests, not guarantees — stripEmojis/EmojiSmoother
 * make the rule structural on the way out, the same way the coach's
 * cleanModelText does for the patient chat.
 */

/**
 * Every character that participates in an emoji sequence: pictographs plus
 * the join/presentation machinery (regional-indicator flags, skin tones,
 * variation selectors, the ZWJ, the keycap combiner). Removing WHOLE RUNS of
 * these means a split sequence ("👩" + ZWJ + "👦") strips to nothing no
 * matter where chunk boundaries fall. ©, ® and ™ are Extended_Pictographic
 * but legitimate document text, so they are kept; a keycap like "1️⃣"
 * degrades to its plain digit.
 */
const EMOJI_RUN =
  /(?:(?![\u00A9\u00AE\u2122])\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\uFE0E\uFE0F\u200D\u20E3])+/gu;

/**
 * Removes all emojis from a complete string. Purely subtractive: spacing is
 * never rewritten (markdown rendering collapses any doubled space an inline
 * emoji leaves behind), so the guard can never corrupt surrounding text.
 */
export function stripEmojis(text: string): string {
  return text.replace(EMOJI_RUN, "");
}

/**
 * Streaming variant of stripEmojis for SSE deltas. Because whole runs of
 * emoji-participating characters are removed, stripping a run's prefix now
 * and its continuation later gives the same result — the ONLY split that
 * needs buffering is a surrogate pair broken across chunks, which would
 * otherwise reassemble into a visible emoji on the client. push() holds a
 * lone trailing high surrogate; flush() drops it (half a code point is
 * junk, never displayable text).
 */
export class EmojiSmoother {
  private carry = "";

  push(chunk: string): string {
    let text = this.carry + chunk;
    this.carry = "";
    if (text.length > 0) {
      const last = text.charCodeAt(text.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        this.carry = text.slice(-1);
        text = text.slice(0, -1);
      }
    }
    return stripEmojis(text);
  }

  flush(): string {
    // Only ever a lone high surrogate; emitting it would be malformed junk.
    this.carry = "";
    return "";
  }
}
