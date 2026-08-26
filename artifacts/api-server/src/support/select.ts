/**
 * Two-stage document routing for the AI Support chat, mirroring the patient
 * coach's compartment router but over the knowledge library's live rows.
 *
 * Stage 1 sends the best-matching documents (by keyword / title / summary
 * scoring against the question). If the model signals it cannot answer from
 * those, the route broadens to the whole library (stage 2) before the
 * assistant is ever allowed to say it doesn't know. When nothing matches at
 * all, relevance is too weak to trust — stage 1 IS the whole library.
 */
import type { SupportDocument } from "./docs";

const LATEST_WEIGHT = 3;
const HISTORY_WEIGHT = 1;
/** Documents sent in stage 1 when scoring found matches. */
const MAX_PRIMARY_DOCS = 2;

const KEYWORD_POINTS = 3;
const TITLE_POINTS = 2;
const SUMMARY_POINTS = 1;

/** Generic words that would make every title/summary match every question. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "has", "are",
  "was", "were", "will", "would", "should", "could", "can", "not", "you",
  "your", "they", "their", "them", "what", "when", "where", "which", "who",
  "how", "why", "does", "about", "into", "over", "under", "than", "then",
  "there", "here", "also", "each", "every", "some", "any", "all", "its",
  "document", "documents", "info", "information", "guide", "base",
]);

function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

function wordsOf(normalized: string, minLength: number): Set<string> {
  const words = new Set<string>();
  for (const word of normalized.trim().split(" ")) {
    if (word.length >= minLength && !STOPWORDS.has(word)) words.add(word);
  }
  return words;
}

/** Score one document against one message (already normalized + tokenized). */
function scoreAgainst(
  doc: SupportDocument,
  normalizedMessage: string,
  messageWords: Set<string>,
): number {
  let score = 0;

  // Curated keyword phrases, matched whole-word inside the message.
  for (const keyword of doc.keywords) {
    const phrase = normalize(keyword).slice(1, -1);
    if (phrase && normalizedMessage.includes(` ${phrase} `)) score += KEYWORD_POINTS;
  }

  // Title words the message mentions.
  for (const word of wordsOf(normalize(doc.title), 4)) {
    if (messageWords.has(word)) score += TITLE_POINTS;
  }

  // Message words the summary mentions (direction matters: questions are
  // short, summaries are dense — iterating the question keeps this bounded).
  const summary = normalize(doc.summary);
  for (const word of messageWords) {
    if (word.length >= 5 && summary.includes(` ${word} `)) score += SUMMARY_POINTS;
  }

  return score;
}

export interface SupportSelection {
  /** Stage-1 grounding documents. */
  primary: SupportDocument[];
  /** Everything else — appended for the stage-2 broadened call. */
  remaining: SupportDocument[];
  /** True when stage 1 already carries the whole library (no stage 2 left). */
  broadened: boolean;
  /** Ids for logs. */
  primaryIds: string[];
}

export function selectSupportDocuments(
  documents: SupportDocument[],
  latestUserMessage: string,
  earlierUserMessages: string[],
): SupportSelection {
  const recent = earlierUserMessages.slice(-2);
  const latestNormalized = normalize(latestUserMessage);
  const latestWords = wordsOf(latestNormalized, 4);
  const history = recent.map((message) => {
    const normalized = normalize(message);
    return { normalized, words: wordsOf(normalized, 4) };
  });

  const scored = documents.map((doc, index) => {
    let score = scoreAgainst(doc, latestNormalized, latestWords) * LATEST_WEIGHT;
    for (const entry of history) {
      score += scoreAgainst(doc, entry.normalized, entry.words) * HISTORY_WEIGHT;
    }
    return { doc, score, index };
  });

  const matched = scored
    .filter((entry) => entry.score > 0)
    // Stable order: highest score first, then library order.
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_PRIMARY_DOCS)
    .map((entry) => entry.doc);

  if (matched.length === 0) {
    // Nothing matched — relevance is too weak to gamble a stage on.
    return {
      primary: documents,
      remaining: [],
      broadened: true,
      primaryIds: documents.map((d) => d.id),
    };
  }

  const chosen = new Set(matched.map((d) => d.id));
  const remaining = documents.filter((d) => !chosen.has(d.id));
  return {
    primary: matched,
    remaining,
    broadened: remaining.length === 0,
    primaryIds: matched.map((d) => d.id),
  };
}
