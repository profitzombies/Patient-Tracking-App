/**
 * Deterministic brand-spelling enforcement for the AI Support stream.
 *
 * The persona rules say the product name is THINNR, never "Thinner" — but
 * some knowledge documents themselves spell it "THINNER", so the model can
 * echo the misspelling no matter what the prompt says. This guard rewrites
 * capitalized Thinner/THINNER to THINNR on the way out.
 *
 * Lowercase "thinner" is left alone: it is an ordinary English word ("a
 * thinner soup") and never a brand mention. The support email address is
 * unaffected because it spells the brand "Thinnr" (no second N).
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
