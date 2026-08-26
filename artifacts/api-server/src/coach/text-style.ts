/**
 * Coach text styling: the coach's texting voice never uses em or en dashes.
 *
 * The prompts ask for comma-and-period punctuation, but prompts are style
 * requests, not guarantees — models love the em dash. These helpers make the
 * rule structural on the way out, the same way cleanModelText makes the
 * no-emoji rule structural:
 *
 * - stripDashes() rewrites a complete string: digit ranges keep a plain
 *   hyphen ("2—3 eggs" → "2-3 eggs"), joining en dashes become hyphens
 *   ("Monday–Friday"), and every remaining em/en dash reads as the pause it
 *   is — a comma. Used on the structured pipelines' user-facing fields.
 *
 * - DashSmoother does the same for the plain streaming pipeline, where a
 *   "word — word" bridge can arrive split across chunks. It holds back a
 *   short trailing run of dash-bridge characters (spaces, digits, dashes)
 *   until the next chunk resolves them; the client's paced reveal buffers
 *   deltas anyway, so the hold is invisible.
 *
 * Scope: coach surfaces only. Training transcripts and verbatim program
 * quotes elsewhere keep their original punctuation — never route them
 * through here except where they surface inside a coach chat reply.
 */

/** Characters that can participate in a dash bridge spanning two chunks. */
const HELD_TAIL = /[0-9 \t\u2013\u2014]{1,16}$/;

/**
 * Dash rewriting shared by the whole-string and streaming paths. Safe on
 * partial text: no rule here anchors to the start or end of the string.
 */
function rewriteDashes(text: string): string {
  return (
    text
      // A digit range survives as a plain hyphen: "2—3 eggs" → "2-3 eggs".
      .replace(/(\d)[ \t]?[\u2013\u2014][ \t]?(?=\d)/g, "$1-")
      // An unspaced en dash joins words ("Monday–Friday"): keep a hyphen.
      .replace(/([^\s\u2013\u2014])\u2013(?=[^\s\u2013\u2014])/g, "$1-")
      // Every remaining em/en dash reads as a pause: swap for a comma.
      .replace(/[ \t]*[\u2013\u2014]+[ \t]*/g, ", ")
      // A pause cannot open a line…
      .replace(/\n, /g, "\n")
      // …or stack onto punctuation the sentence already has ("done., " → "done. ").
      .replace(/([,.;:!?]),(?= )/g, "$1")
  );
}

/** Rewrites all em/en dashes in a complete string (see module docs). */
export function stripDashes(text: string): string {
  return rewriteDashes(text).replace(/^, /, "").replace(/,[ \t]*$/, "");
}

/**
 * Streaming variant of stripDashes for SSE deltas. push() returns the text
 * safe to emit now; flush() drains whatever was still held back when the
 * stream ends.
 */
export class DashSmoother {
  private carry = "";

  push(chunk: string): string {
    let text = this.carry + chunk;
    this.carry = "";
    // Hold back a short trailing run that a later chunk could turn into a
    // dash bridge ("word " + "— word", "2" + "–3"). Capped so a long digit
    // run cannot buffer unbounded text.
    const held = text.match(HELD_TAIL);
    if (held) {
      this.carry = held[0];
      text = text.slice(0, text.length - held[0].length);
    }
    return rewriteDashes(text);
  }

  flush(): string {
    const tail = rewriteDashes(this.carry);
    this.carry = "";
    // A reply cannot end on the comma a trailing dash left behind.
    return tail.replace(/,[ \t]*$/, "");
  }
}
