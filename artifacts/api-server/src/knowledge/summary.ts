/**
 * Routing aids for knowledge documents: a short summary plus keywords the
 * AI Support chat later uses to pick which documents can answer a question.
 *
 * The model writes them when it can; a deterministic heuristic takes over on
 * any model problem, so extraction NEVER fails because the AI was down —
 * the extracted text is the product, the aids are conveniences.
 */
import { openai } from "@workspace/integrations-openai-ai-server";
import { extractModelJson } from "../coach/model-json";
import { upstreamTimeoutMs } from "../coach/upstream";
import { logger } from "../lib/logger";

const TEXT_MODEL = "gpt-5-nano";

/** How much document text rides along in the prompt. */
const HEAD_CHARS = 7000;
const TAIL_CHARS = 2000;

const MAX_SUMMARY_CHARS = 600;
const MAX_KEYWORDS = 12;
const MAX_KEYWORD_CHARS = 40;

export interface RoutingAids {
  summary: string;
  keywords: string[];
}

function excerptOf(text: string): { excerpt: string; truncated: boolean } {
  if (text.length <= HEAD_CHARS + TAIL_CHARS) return { excerpt: text, truncated: false };
  return {
    excerpt: `${text.slice(0, HEAD_CHARS)}\n…\n${text.slice(-TAIL_CHARS)}`,
    truncated: true,
  };
}

function cleanKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const keyword = entry.trim().toLowerCase().slice(0, MAX_KEYWORD_CHARS);
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    keywords.push(keyword);
    if (keywords.length >= MAX_KEYWORDS) break;
  }
  return keywords;
}

async function aiRoutingAids(title: string, text: string): Promise<RoutingAids> {
  const { excerpt, truncated } = excerptOf(text);
  const response = await openai.chat.completions.create(
    {
      model: TEXT_MODEL,
      // Reasoning models spend part of this budget internally; the AI
      // integration requires >= 8192 to avoid empty replies.
      max_completion_tokens: 8192,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You index documents for the THINNR med-spa program's AI support assistant. " +
            'Reply with JSON only: {"summary": string, "keywords": string[]}. ' +
            "The summary is two or three plain sentences describing what questions this document answers. " +
            "Keywords are 5 to 12 short lowercase search terms office staff might type; no duplicates.",
        },
        {
          role: "user",
          content: `Document title: ${title}\n\nDocument text${truncated ? " (excerpted)" : ""}:\n${excerpt}`,
        },
      ],
    },
    { signal: AbortSignal.timeout(upstreamTimeoutMs()) },
  );
  const raw = response.choices[0]?.message?.content ?? "";
  const parsed = extractModelJson(raw) as { summary?: unknown; keywords?: unknown } | null;
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("The AI reply wasn't readable JSON");
  }
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, MAX_SUMMARY_CHARS) : "";
  if (!summary) throw new Error("The AI reply had no summary");
  return { summary, keywords: cleanKeywords(parsed.keywords) };
}

const STOPWORDS = new Set([
  "a", "about", "after", "all", "also", "an", "and", "any", "are", "as", "at",
  "be", "been", "before", "but", "by", "can", "could", "day", "days", "do",
  "does", "each", "for", "from", "had", "has", "have", "her", "his", "how",
  "if", "in", "into", "is", "it", "its", "may", "more", "most", "not", "of",
  "on", "one", "only", "or", "other", "our", "out", "over", "page", "per",
  "please", "should", "so", "some", "such", "than", "that", "the", "their",
  "them", "then", "there", "these", "they", "this", "those", "to", "under",
  "up", "use", "was", "we", "well", "were", "what", "when", "which", "while",
  "who", "will", "with", "would", "you", "your",
]);

/** Deterministic fallback: leading sentences + frequent distinctive words. */
export function heuristicRoutingAids(title: string, text: string): RoutingAids {
  const flat = text.replace(/\s+/g, " ").trim();
  const sentences = flat.split(/(?<=[.!?])\s+/);
  let summary = "";
  for (const sentence of sentences) {
    if (!sentence) continue;
    const next = summary ? `${summary} ${sentence}` : sentence;
    if (summary && next.length > 260) break;
    summary = next;
    if (summary.length > 160) break;
  }
  if (!summary) summary = flat.slice(0, 240);
  if (summary.length > MAX_SUMMARY_CHARS) summary = `${summary.slice(0, MAX_SUMMARY_CHARS - 1)}…`;

  const counts = new Map<string, number>();
  for (const match of flat.toLowerCase().matchAll(/[a-z][a-z'-]{3,}/g)) {
    const word = match[0];
    if (STOPWORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const frequent = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([word]) => word);
  const fromTitle = title
    .toLowerCase()
    .split(/[^a-z0-9'-]+/)
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word));
  return { summary, keywords: cleanKeywords([...fromTitle, ...frequent]) };
}

/** Total by construction: the model's aids when possible, heuristic otherwise. */
export async function writeRoutingAids(title: string, text: string): Promise<RoutingAids> {
  try {
    return await aiRoutingAids(title, text);
  } catch (error) {
    logger.warn({ err: error }, "knowledge routing aids fell back to heuristic");
    return heuristicRoutingAids(title, text);
  }
}
