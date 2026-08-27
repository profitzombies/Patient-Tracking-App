/**
 * Typed meal-correction detection — the client's copy of the server's rules
 * (api-server/src/coach/meal-correction.ts). The two files differ only in
 * comment and quote style (per-package lint conventions); their RULES must
 * stay identical. After a meal-card
 * reply, the patient can FIX a misread plate by typing what it really is:
 * the chat context re-attaches the held photo when (and only when) the text
 * reads as a correction, and the server runs the same detector to treat the
 * words as ground truth for what the foods are. The verify suite imports
 * BOTH copies and asserts they agree on a phrase table, the established
 * dual-implementation pattern for shared rules.
 *
 * Deliberately conservative, cue-based: a miss just means a normal chat turn
 * (the patient can rephrase or retake), while a false positive would force a
 * re-analysis onto an unrelated message. Two hard guarantees:
 * - A message ending in "?" is never a correction (questions are questions).
 * - The fixed photo replay lines ("I sent a photo of my meal.") never read
 *   as corrections, so retakes and retries stay fresh, uncorrected reads.
 */

/** Confirmation/reaction openers after "that's ..." — not corrections. */
const SENTIMENT_AFTER_ASSERTION =
  /^(right|correct|perfect|great|good|fine|ok\b|okay|awesome|amazing|spot on|close|helpful|delicious|tasty|yummy|wonderful|lovely|nice|cool|fair|accurate|impressive|exactly|it\b|all\b|everything|what\b|so\b|really\s+(right|correct|perfect|great|good|fine|close|helpful|delicious|tasty|nice|accurate))/;

/** "nothing wrong with that" praise — keeps the \bwrong\b cue honest. */
const WRONG_AS_PRAISE = /\b(nothing wrong|can'?t go wrong|cannot go wrong|can not go wrong)\b/;

/**
 * True when a patient message typed right after a meal-card reply reads as
 * a correction of what the food IS. Pure text heuristics — adjacency (was
 * the previous reply a meal card, is the held photo still around) is the
 * caller's job.
 */
export function isMealCorrectionText(raw: string): boolean {
  const text = raw.trim().toLowerCase();
  if (!text || text.endsWith('?')) return false;
  // A bare polite decline ("no thanks", "no thank you") carries no food
  // identity, so it is never a correction — it is how patients wave off a
  // one-tap offer that can ride a meal-card reply (the THINNR-approved
  // makeover offer). Bare "no" and "no, that's..." keep reading as
  // corrections; only the nothing-but-thanks shape is exempt.
  if (/^(no|nope|nah)[\s,.!]*(thanks|thank you|thankyou|thank u|ty)[\s.!]*$/.test(text)) {
    return false;
  }
  // Leading correction openers: "no, that's...", "wrong, it's...",
  // "actually it's...".
  if (/^(no|nope|nah|wrong|incorrect|correction|actually)\b/.test(text)) return true;
  // Misread complaints anywhere in the message.
  if (
    /\b(misread|misidentified|mistook|mislabeled|mixed .{0,16}up|you missed|not right|not correct|way off)\b/.test(
      text,
    )
  ) {
    return true;
  }
  if (/\bwrong\b/.test(text) && !WRONG_AS_PRAISE.test(text)) return true;
  // Identity negations: "that's not brisket", "there is no salmon",
  // "it isn't pork", "I don't see any salmon".
  if (/\b(is|are|was|were|it'?s|that'?s|there'?s|they'?re)\s+not\b/.test(text)) return true;
  if (/\b(isn'?t|aren'?t|wasn'?t|weren'?t)\b/.test(text)) return true;
  if (/\bthere('?s| is| are) no\b/.test(text)) return true;
  if (/\b(don'?t|do not) see (any|a|an)\b/.test(text)) return true;
  // Re-identifications: "it should be...", "that was supposed to be...",
  // "more like...".
  if (/\b(should be|supposed to be|more like)\b/.test(text)) return true;
  // Identity assertions: "that's steak and sweet potatoes", "it was pork" —
  // minus confirmations like "that's right" or "that's it".
  const assertion =
    /^(that'?s|that is|that was|it'?s|it is|it was|this is|these are|those are|they'?re|they are)\s+(.+)$/.exec(
      text,
    );
  if (assertion && !SENTIMENT_AFTER_ASSERTION.test(assertion[2])) return true;
  return false;
}
