/**
 * Streaming filter for coach control markers.
 *
 * The model attaches machine-readable signals to a reply by ending it with
 * bracketed markers like `[[product:ID]]` (recommend a product card) or
 * `[[replies:ID]]` (pick a one-tap answer set). Markers are control signals,
 * never prose: this filter strips every marker of the kinds it was built
 * with from the streamed text (markers can be split across SSE chunks at any
 * byte) and records kind + id, so the route can decide — from curated server
 * data, never from model text — which side-channel events are allowed.
 */

const ID_CHARS = /^[a-z0-9_-]{0,40}\]?$/i;
const MAX_ID_LENGTH = 40;

export interface Marker {
  kind: string;
  id: string;
}

export class MarkerFilter {
  /** Lowercased marker openings, e.g. "[[product:". */
  private readonly heads: string[];
  private readonly pattern: RegExp;
  /** Longest text run that could still become a marker (head + id + "]]"). */
  private readonly maxMarkerLength: number;
  private pending = "";
  /** Every complete marker seen, in stream order (kind and id lowercased). */
  readonly markers: Marker[] = [];

  /** `kinds` are internal constants like "product" — never user input. */
  constructor(kinds: readonly string[]) {
    this.heads = kinds.map((kind) => `[[${kind.toLowerCase()}:`);
    this.pattern = new RegExp(
      `\\[\\[(${kinds.join("|")}):([a-z0-9_-]{1,${MAX_ID_LENGTH}})\\]\\]`,
      "i",
    );
    this.maxMarkerLength =
      Math.max(...this.heads.map((head) => head.length)) + MAX_ID_LENGTH + 2;
  }

  /** Ids of every complete marker of `kind`, in stream order. */
  idsFor(kind: string): string[] {
    return this.markers.filter((m) => m.kind === kind).map((m) => m.id);
  }

  /**
   * True when `tail` could be the beginning of a marker that has not
   * finished arriving yet ("[", "[[pro", "[[replies:yes_no]", ...).
   */
  private couldBeMarkerPrefix(tail: string): boolean {
    if (tail.length === 0) return false;
    const lower = tail.toLowerCase();
    return this.heads.some((head) => {
      if (lower.length <= head.length) return head.startsWith(lower);
      if (!lower.startsWith(head)) return false;
      // Id characters, optionally followed by the first of the two closing
      // brackets. Anything else can no longer complete into a marker.
      return ID_CHARS.test(tail.slice(head.length));
    });
  }

  /** Index from which the end of `text` must be held back as a possible marker. */
  private holdbackIndex(text: string): number {
    const scanFrom = Math.max(0, text.length - this.maxMarkerLength);
    for (let i = scanFrom; i < text.length; i++) {
      if (text[i] === "[" && this.couldBeMarkerPrefix(text.slice(i))) return i;
    }
    return text.length;
  }

  /** Feeds one stream delta; returns the text that is safe to surface. */
  push(delta: string): string {
    let rest = this.pending + delta;
    let out = "";
    for (;;) {
      const match = this.pattern.exec(rest);
      if (!match) break;
      out += rest.slice(0, match.index);
      this.markers.push({ kind: match[1].toLowerCase(), id: match[2].toLowerCase() });
      rest = rest.slice(match.index + match[0].length);
    }
    const holdFrom = this.holdbackIndex(rest);
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
    return this.couldBeMarkerPrefix(rest) ? "" : rest;
  }
}
