/**
 * Deterministic brand-spelling guard shared by EVERY AI surface.
 *
 * The product name is THINNR, but the spoken name sounds exactly like the
 * English word "thinner", and some archived program documents themselves
 * spell it "THINNER" — so a prompt rule alone cannot stop model output from
 * echoing the misspelling. These helpers make the spelling structural on the
 * way out. One implementation, no per-surface copies: the AI Support and
 * patient coach streams wire in BrandSpellingSmoother, and complete-string
 * surfaces (coach structured pipelines via cleanModelText, training
 * transcripts/descriptions/chapters, knowledge routing summaries) run
 * normalizeBrandSpelling.
 *
 * Capitalized-only contract: lowercase "thinner" is ordinary English ("a
 * thinner soup", "blood thinner") and is never rewritten by the normalizer
 * or the smoother. The support email address is unaffected because it spells
 * the brand "Thinnr" (no second N). Training transcripts get one extra,
 * tightly scoped rewrite for SPOKEN brand mentions that arrive lowercase —
 * see normalizeSpokenBrandMentions.
 */

/** Rewrites capitalized brand misspellings in a complete string. */
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
 * Words that only the brand pairs with in program speech: "the thinner
 * program", "your thinner coach", "the thinner metabolic thinning phase"
 * are brand mentions, while comparative English ("a thinner soup", "want
 * to be thinner") never runs into these nouns.
 */
const SPOKEN_BRAND_PAIRINGS =
  "app|boost|coach|coaching|community|metabolic|method|plan|program|protocol";

const SPOKEN_BRAND_MENTION = new RegExp(
  `\\bthinner\\b(?=\\s+(?:${SPOKEN_BRAND_PAIRINGS})\\b)`,
  "g",
);

/** Heads that make lowercase "thinner" a genuine noun, never the brand. */
const GENUINE_THINNER_HEADS = new Set(["blood", "paint"]);

/**
 * Transcript-only contextual rewrite for spoken brand mentions.
 *
 * A training video says the brand OUT LOUD, so transcription hears the
 * English word and writes "the thinner program" — lowercase, which the
 * capitalized-only normalizer above deliberately ignores. This fixes exactly
 * that shape: lowercase "thinner" immediately followed by a word only the
 * brand pairs with, unless the word before it makes the phrase a genuine
 * noun ("blood thinner plan" stays untouched). Everything else — "blood
 * thinner medications", "a thinner soup", "patients want to be thinner" —
 * never matches in the first place.
 *
 * Scope: transcription output ONLY. Prose surfaces keep the capitalized-only
 * contract; do not route chat replies or summaries through here.
 */
export function normalizeSpokenBrandMentions(text: string): string {
  return text.replace(SPOKEN_BRAND_MENTION, (match: string, offset: number) => {
    const before = text.slice(0, offset);
    const head = /([A-Za-z']+)[\s-]*$/.exec(before)?.[1]?.toLowerCase();
    return head !== undefined && GENUINE_THINNER_HEADS.has(head) ? match : "THINNR";
  });
}
