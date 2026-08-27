/**
 * Shared helpers for the coach's structured-JSON model turns (recipe
 * generation, menu scanning).
 */
import { normalizeBrandSpelling } from "../lib/brand-spelling";

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

/**
 * Style and brand insurance: the prompts forbid emojis and require the
 * THINNR spelling; this makes both structural. Every structured coach
 * pipeline (recipe, meal/label/menu scans) and the training pipeline
 * (transcripts, descriptions, chapter titles) cleans its user-facing model
 * text here, so the brand guarantee is inherited at ONE choke point.
 * Capitalized-only contract: lowercase "thinner" is ordinary English and
 * passes through (spoken transcripts get their own contextual rewrite in
 * the training pipeline).
 */
export function cleanModelText(text: string): string {
  return normalizeBrandSpelling(text.replace(/\p{Extended_Pictographic}/gu, "")).trim();
}
