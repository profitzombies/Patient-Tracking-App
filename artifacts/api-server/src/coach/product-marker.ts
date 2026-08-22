/**
 * Streaming filter for coach product markers.
 *
 * The model recommends a product by ending its reply with `[[product:ID]]`.
 * That marker is a control signal, not prose: this filter removes every
 * marker from the streamed text (markers can be split across SSE chunks at
 * any byte) and records the ids it saw, so the route can decide — from the
 * catalog, never from model text — whether a card event is allowed.
 */

const MARKER_HEAD = "[[product:";
const MARKER_PATTERN = /\[\[product:([a-z0-9_-]{1,40})\]\]/i;
/** Longest text run that could still become a marker (head + id + "]]"). */
const MAX_MARKER_LENGTH = MARKER_HEAD.length + 40 + 2;

/**
 * True when `tail` could be the beginning of a marker that has not finished
 * arriving yet ("[", "[[pro", "[[product:prod7", "[[product:prod7]", ...).
 */
function couldBeMarkerPrefix(tail: string): boolean {
  if (tail.length === 0) return false;
  if (tail.length <= MARKER_HEAD.length) {
    return MARKER_HEAD.startsWith(tail.toLowerCase());
  }
  if (!tail.toLowerCase().startsWith(MARKER_HEAD)) return false;
  const afterHead = tail.slice(MARKER_HEAD.length);
  // Id characters, optionally followed by the first of the two closing
  // brackets. Anything else can no longer complete into a marker.
  return /^[a-z0-9_-]{0,40}\]?$/i.test(afterHead);
}

/** Index from which the end of `text` must be held back as a possible marker. */
function holdbackIndex(text: string): number {
  const scanFrom = Math.max(0, text.length - MAX_MARKER_LENGTH);
  for (let i = scanFrom; i < text.length; i++) {
    if (text[i] === "[" && couldBeMarkerPrefix(text.slice(i))) return i;
  }
  return text.length;
}

export class ProductMarkerFilter {
  private pending = "";
  /** Ids of every complete marker seen, in stream order (lowercased). */
  readonly ids: string[] = [];

  /** Feeds one stream delta; returns the text that is safe to surface. */
  push(delta: string): string {
    let rest = this.pending + delta;
    let out = "";
    for (;;) {
      const match = MARKER_PATTERN.exec(rest);
      if (!match) break;
      out += rest.slice(0, match.index);
      this.ids.push(match[1].toLowerCase());
      rest = rest.slice(match.index + match[0].length);
    }
    const holdFrom = holdbackIndex(rest);
    out += rest.slice(0, holdFrom);
    this.pending = rest.slice(holdFrom);
    return out;
  }

  /**
   * Ends the stream. A dangling partial marker (the model stopped mid-marker)
   * is dropped rather than surfaced as visible junk; any other held text is
   * returned.
   */
  flush(): string {
    const rest = this.pending;
    this.pending = "";
    return couldBeMarkerPrefix(rest) ? "" : rest;
  }
}
