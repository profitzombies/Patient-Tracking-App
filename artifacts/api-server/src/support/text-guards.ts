/**
 * Deterministic output guards for the AI Support stream.
 *
 * Brand spelling: the persona rules say the product name is THINNR, never
 * "Thinner" — but some knowledge documents themselves spell it "THINNER",
 * so the model can echo the misspelling no matter what the prompt says.
 * This guard rewrites capitalized Thinner/THINNER to THINNR on the way out.
 *
 * Lowercase "thinner" is left alone: it is an ordinary English word ("a
 * thinner soup") and never a brand mention. The support email address is
 * unaffected because it spells the brand "Thinnr" (no second N).
 *
 * Emojis: the support voice is strictly emoji-free. The prompt says so, but
 * prompts are style requests, not guarantees — stripEmojis/EmojiSmoother
 * make the rule structural on the way out, the same way the coach's
 * cleanModelText does for the patient chat.
 */

/** Rewrites brand misspellings in a complete string. */
export function normalizeBrandSpelling(text: string): string {
  return text.replace(/\bTHINNER\b/g, "THINNR").replace(/\bThinner\b/g, "THINNR");
}

/**
 * `blocked` = the character just before `text` (already emitted) was a
 * letter, so a match starting at position 0 would cross into an earlier
 * word ("...listic" + "Thinner"). A leading sentinel letter suppresses the
 * false word boundary; it is sliced back off after rewriting.
 */
function normalizeGuarded(text: string, blocked: boolean): string {
  if (!blocked) return normalizeBrandSpelling(text);
  return normalizeBrandSpelling(`A${text}`).slice(1);
}

const HELD_RUN = /[A-Za-z]+$/;

/**
 * Longest trailing letter run held back between chunks. "Thinner" is 7
 * characters, so 12 gives margin; a longer run is emitted immediately (with
 * `midWord` remembering that the next chunk continues a word) because
 * "Thinner" can never be a whole word inside a 13+ letter run.
 */
const MAX_HELD_CHARS = 12;

/**
 * Streaming variant for SSE deltas: push() returns text safe to emit now,
 * flush() drains what was held when the stream ends. Holding the trailing
 * letter run keeps \b matches truthful across chunk splits — "Thin" + "ner"
 * still rewrites, "AntiThin" + "ner" never does.
 */
export class BrandSpellingSmoother {
  private carry = "";
  /** True when the character before the next text to process is a letter. */
  private midWord = false;

  push(chunk: string): string {
    const blocked = this.midWord;
    let text = this.carry + chunk;
    this.carry = "";
    const held = text.match(HELD_RUN);
    if (held && held[0].length <= MAX_HELD_CHARS) {
      this.carry = held[0];
      text = text.slice(0, text.length - held[0].length);
      // The held run is maximal, so the character before it is a non-letter
      // — unless nothing is being emitted, which keeps the prior context.
      this.midWord = text.length === 0 ? blocked : false;
    } else {
      this.midWord = /[A-Za-z]$/.test(text);
    }
    return normalizeGuarded(text, blocked);
  }

  flush(): string {
    const text = this.carry;
    this.carry = "";
    return normalizeGuarded(text, this.midWord);
  }
}

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
