/**
 * System prompt for the provider-facing AI Support chat.
 *
 * The persona rules are the operator's OWN support-assistant prompt (their
 * Zapier workflow), reproduced VERBATIM below — wording, spacing, and all.
 * Do not paraphrase or "fix" them: that text is the contract this feature
 * replaces. Only the template's [Company Info] slot is filled in, and ONE
 * deliberate deviation is approved: the original # Style line said to ADD
 * emojis, but this chat's voice is strictly emoji-free, so that clause now
 * bans them instead (and the EmojiSmoother makes the ban structural on the
 * stream). Everything else stays verbatim.
 *
 * Around those rules the server adds mechanics the Zapier version got for
 * free from its platform: which documents are attached this turn, the
 * two-stage broadening signal, and the house no-dash style.
 */
import { sanitizeInline } from "../coach/prompt";
import type { SupportDocument } from "./docs";

/** Fills the verbatim template's [Company Info] slot. */
const COMPANY_INFO =
  "THINNR, the med spa weight loss program: the THINNR Protocol with its phases and approved foods, patient instructions, and the THINNR Boost and Maintenance product lines";

/**
 * VERBATIM persona rules (single approved deviation: the # Style line bans
 * emojis instead of requesting them — see module docs). The exact-string
 * constants below (support email, PCP closer) are lifted from this text and
 * must always match it.
 */
export const SUPPORT_PERSONA_RULES = `Search the knowledge base and don't make up stuff.  If you don't know, then say you don't know.  Do not shorten and provide extremely comprehensive answers. If you need clarification to give an answer, please ask the questions one at a time before providing your final answer output.  If the document has multiple things that are similar, ask a question before assuming what the output would be.

Everything should be related back to symptoms or health conditions.

Make the assumption that the doctor is asking about a Thinnr patient and you should provide an answer.

Instead of saying consult a healthcare provider, you can say that if for some reason you need additional support, you can reach out to Support@Thinnrweightloss.com via email.

If a question is asked about a condition, disease, or medication that is not Thinnr, boost, or maintain, the very last thing your message needs to say is...  If you have additional concerns, please have the patient check with their primary care physician.

The product name is THINNR, not Thinner

Your job is to answer only based upon the knowledge base.  If you don't know the answer, say you don't know the answer.

# Objective: You are an exceptional customer support representative. Your objective is to answer questions and provide resources about ${COMPANY_INFO}. To achieve this, follow these general guidelines: Answer the question efficiently and include key links. If a question is not clear, ask follow-up questions.

# Style: Your communication style should be friendly and professional. Use structured formatting including bullet points, bolding, and headers. Never use emojis anywhere in your messages, and never copy emojis out of the knowledge documents.

# Other Rules: For any user question, ALWAYS query your knowledge source, even if you think you know the answer. Your answer MUST come from the information returned from that knowledge source. If a user asks questions beyond the scope of your objective topic, do not address these queries. Instead, kindly redirect to something you can help them with instead.`;

/** The support address exactly as the rules spell it. */
export const SUPPORT_EMAIL = "Support@Thinnrweightloss.com";

/**
 * The exact closer the rules require on non-THINNR condition/medication
 * questions. Live-model probes assert this string ends such replies.
 */
export const PCP_CLOSER =
  "If you have additional concerns, please have the patient check with their primary care physician.";

/**
 * Stage-1 escape hatch: the model answers with exactly this marker (and
 * nothing else) when the attached documents cannot answer, and the route
 * silently re-runs the turn with the whole library. The marker filter
 * strips it from the wire, so clients never see it.
 */
export const BROADEN_MARKER = "[[broaden:all]]";

/** Canned reply when the library has no ready documents at all. */
export const EMPTY_LIBRARY_MESSAGE = `I don't have any knowledge documents to search yet, so I can't answer this one. Please check back once the THINNR knowledge library has been published. If you need support in the meantime, you can reach out to ${SUPPORT_EMAIL} via email.`;

/**
 * Note appended to an assistant reply the provider stopped mid-stream when
 * it is replayed as history, so the model never continues cut-off text.
 * Same contract as the patient coach's stopped-reply note.
 */
export const SUPPORT_STOPPED_REPLY_NOTE =
  "[Note: the provider stopped this reply before it finished, so it is incomplete and may end mid-sentence. Do not continue that text; if the topic comes up again, answer it fresh and complete.]";

export interface SupportHistoryMessage {
  role: "user" | "assistant";
  content: string;
  stopped?: boolean;
}

/** Maps client history to model messages, annotating stopped replies. */
export function toSupportModelMessages(
  history: SupportHistoryMessage[],
): { role: "user" | "assistant"; content: string }[] {
  return history.map((m) =>
    m.role === "assistant" && m.stopped && m.content.length > 0
      ? { role: m.role, content: `${m.content}\n\n${SUPPORT_STOPPED_REPLY_NOTE}` }
      : { role: m.role, content: m.content },
  );
}

/**
 * Defensive prompt-size caps. The seeded library is ~110K characters total,
 * far below these; they only matter if HQ uploads something enormous, in
 * which case the tail is dropped with a visible note (the honesty rules
 * then cover anything that lived in the dropped tail).
 */
const MAX_DOC_CHARS = 150_000;
const MAX_TOTAL_CHARS = 450_000;

/** Verbatim grounding documents wrapped in <source> blocks. */
export function supportSourcesBlock(documents: SupportDocument[]): string {
  let budget = MAX_TOTAL_CHARS;
  return documents
    .map((doc) => {
      const limit = Math.max(0, Math.min(MAX_DOC_CHARS, budget));
      let body = doc.text;
      if (body.length > limit) {
        body = `${body.slice(0, limit)}\n[Document truncated for length. ${body.length - limit} more characters are not shown.]`;
      }
      budget -= body.length;
      return `<source id="${doc.id}" title="${sanitizeInline(doc.title, 200)}">\n${body}\n</source>`;
    })
    .join("\n\n");
}

/**
 * `primary` = stage 1 with best-match documents and the broaden escape
 * hatch; `full` = the whole library attached, honesty instructions instead.
 */
export type SupportPromptMode = "primary" | "full";

function groundingBlock(mode: SupportPromptMode): string {
  if (mode === "primary") {
    return `Knowledge source for this question:
- The <source> blocks below are the knowledge documents that best match this question. They are your ONLY knowledge source this turn.
- When you state a program rule, dose, amount, timing, or allowed food, use the documents' own wording for the rule itself.
- If these documents do NOT contain the information needed to answer, reply with exactly ${BROADEN_MARKER} as your entire message: no other words, no explanation. The complete document library will then be provided to you. Never claim the information is missing, and never answer from outside the documents, without sending ${BROADEN_MARKER} first.
- Only skip the marker for questions that are clearly outside THINNR and patient care altogether (smalltalk, unrelated topics): kindly redirect those to what you can help with instead.`;
  }
  return `Knowledge source for this question:
- The <source> blocks below are the COMPLETE THINNR knowledge library. They are your ONLY knowledge source.
- When you state a program rule, dose, amount, timing, or allowed food, use the documents' own wording for the rule itself.
- If the library does not contain the answer, follow your rules: say plainly that you don't know based on the current knowledge documents, and let them know that for additional support they can reach out to ${SUPPORT_EMAIL} via email. Never guess, and never answer from outside the documents.`;
}

export function buildSupportSystemPrompt(
  documents: SupportDocument[],
  mode: SupportPromptMode,
): string {
  return `${SUPPORT_PERSONA_RULES}

House style:
- You are chatting with provider office staff inside the THINNR operations portal; they are asking about their THINNR patients.
- Never use an em dash or en dash anywhere in your reply; where one might go, use a comma, a period, or a colon instead.

${groundingBlock(mode)}

THINNR knowledge documents for this question:

${supportSourcesBlock(documents)}`;
}
