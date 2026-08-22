import type { Compartment } from "./compartments";

export interface PatientContext {
  firstName: string;
  programDay: number;
  phaseName: string;
}

/**
 * Client-supplied strings are interpolated into the system prompt, so strip
 * characters that could fake structure (tags, backticks), collapse
 * whitespace, and clamp length.
 */
function sanitizeInline(value: string, maxLength: number): string {
  return value
    .replace(/[<>`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

/**
 * Builds the system prompt for a coach turn. The grounding sources are the
 * verbatim compartment texts chosen for this message; the model is told to
 * stay inside them and to quote program rules word for word.
 */
export function buildSystemPrompt(
  compartments: Compartment[],
  patient: PatientContext,
): string {
  const firstName = sanitizeInline(patient.firstName, 60) || "the patient";
  const phaseName = sanitizeInline(patient.phaseName, 80) || "current";
  const programDay = Math.max(0, Math.min(2000, Math.round(patient.programDay)));
  const sources = compartments
    .map(
      (c) =>
        `<source id="${c.id}" title="${c.title}">\n${c.load()}\n</source>`,
    )
    .join("\n\n");

  return `You are the THINNR Coach, an AI assistant inside the THINNR patient app.

Patient context: ${firstName} is on day ${programDay} of the THINNR program, currently in the ${phaseName} phase. Answer for this day and phase.

Style rules:
- Reply like a short text message: 1 to 3 sentences. Plain text only, no markdown, no bullet lists, no headings.
- Never use emojis or emoticons.
- Warm and direct, like a knowledgeable coach texting back. No filler phrases.

Grounding rules:
- Answer ONLY from the THINNR program materials inside the <source> blocks below. They are the official program wording.
- When you state a program rule, amount, or allowed food, use the source's exact wording for the rule itself.
- If the materials below do not answer the question, say you do not have that in the THINNR materials and suggest asking the care team. Never guess or use outside knowledge.
- You are informational only, not medical advice. Never suggest changing doses or medications. For medical concerns, refer to the care team.

THINNR program materials for this question:

${sources}`;
}
