/**
 * Shared helpers for the coach's structured-JSON model turns (recipe
 * generation, menu scanning).
 */

/**
 * Tolerant JSON extraction from a raw model reply: strips code fences, then
 * falls back to the outermost brace pair. Returns null when nothing parses.
 */
export function extractModelJson(raw: string): unknown {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** Style insurance: the prompts forbid emojis, this makes it structural. */
export function cleanModelText(text: string): string {
  return text.replace(/\p{Extended_Pictographic}/gu, "").trim();
}
