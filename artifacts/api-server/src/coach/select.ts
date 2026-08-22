import { COMPARTMENTS, type Compartment } from "./compartments";

/**
 * Picks 1-3 knowledge compartments for a chat turn.
 *
 * Scoring is plain keyword matching: the latest user message counts most, the
 * two user messages before it count a little (so follow-ups like "what about
 * lunch?" keep the thread's topic). The whole manual is never sent.
 */

const LATEST_WEIGHT = 3;
const HISTORY_WEIGHT = 1;
const MAX_COMPARTMENTS = 3;

/** Used when nothing matches; broad program context is the safest ground. */
const DEFAULT_IDS = ["program-phases", "qa-program"];

function scoreText(compartment: Compartment, text: string): number {
  let score = 0;
  for (const keyword of compartment.keywords) {
    if (keyword.test(text)) score += 1;
  }
  return score;
}

export interface CompartmentSelection {
  compartments: Compartment[];
  ids: string[];
}

export function selectCompartments(
  latestUserMessage: string,
  earlierUserMessages: string[],
): CompartmentSelection {
  const recentHistory = earlierUserMessages.slice(-2);
  const scored = COMPARTMENTS.map((compartment, index) => {
    let score = scoreText(compartment, latestUserMessage) * LATEST_WEIGHT;
    for (const message of recentHistory) {
      score += scoreText(compartment, message) * HISTORY_WEIGHT;
    }
    return { compartment, score, index };
  });

  const matched = scored
    .filter((entry) => entry.score > 0)
    // Stable order: highest score first, then declaration order.
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_COMPARTMENTS)
    .map((entry) => entry.compartment);

  const compartments =
    matched.length > 0
      ? matched
      : COMPARTMENTS.filter((c) => DEFAULT_IDS.includes(c.id));

  return { compartments, ids: compartments.map((c) => c.id) };
}
