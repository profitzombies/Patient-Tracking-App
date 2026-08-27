/**
 * Back-on-track turn: the grounded reset plan after the patient says yes to
 * the coach's proactive stall outreach.
 *
 * The outreach bubble itself is a fixed CLIENT-side string: the mobile app
 * seeds it into the thread when the shared stall-plus-off-plan trigger fires
 * (artifacts/thinnr-mobile/data/stall-nudge.ts owns the trigger math and the
 * offer constant). Its closing offer is duplicated here verbatim so the same
 * strict-adjacency contract every other follow-up uses works unchanged:
 * replayed history contains the offer text, and a one-tap affirmative
 * directly under it routes here. The mobile stall-nudge verify suite reads
 * this file and asserts the two copies stay byte-identical.
 *
 * The reply is ONE grounded non-streaming turn in program voice: the
 * patient's own trend framed as information rather than failure, a few days
 * of meals drawn only from the Approved Foods catalog, a recommitment to
 * daily logging, and the provider check-in as an open option. It
 * deliberately ends on a statement (no "?"), so the client's fallback chips
 * stay away and the conversation rests with the patient.
 */
import { openai } from "@workspace/integrations-openai-ai-server";
import { catalogPromptLines } from "./approved-catalog";
import type { Compartment } from "./compartments";
import { DEMO_STALL_TREND } from "./demo-patient";
import { isAffirmativeReply } from "./menu-chat";
import { cleanModelText } from "./model-json";
import {
  COACH_PERSONA_LINE,
  COACH_VOICE_RULES,
  patientContextLine,
  sourcesBlock,
  type PatientContext,
} from "./prompt";
import { ensureApprovedFoodsCompartment } from "./recipe";
import { stripDashes } from "./text-style";
import { createUpstreamDeadline, UpstreamTimeoutError } from "./upstream";

/**
 * The outreach offer's closing question, byte-identical to
 * BACK_ON_TRACK_OFFER in the mobile app's stall-nudge module (which seeds
 * the outreach bubble ending with it). The detector below keys on it in
 * replayed history, exactly like the meal-makeover and menu-recipe offers.
 */
export const BACK_ON_TRACK_OFFER =
  "Want me to set up a short reset, a few days of approved meals, daily logging, and a provider check-in if you want one?";

/**
 * The accept chip the outreach bubble offers, byte-identical to
 * OUTREACH_ACCEPT in the mobile chat context (same wire-contract rule as the
 * offer above; the mobile verify suite checks both). isAffirmativeReply
 * covers typed yeses; this covers the exact one-tap label, which reads as a
 * sentence rather than a bare yes.
 */
export const OUTREACH_ACCEPT_LABEL = "Yes, set me up";

/**
 * Honest decline when the model gave nothing usable even after a retry.
 * No "?" ending (the fallback chips fit nothing here) and no dashes.
 */
export const BACK_ON_TRACK_UNAVAILABLE =
  "I can't pull your reset plan together right this second. Give me a little while and ask me again, the offer stands.";

/** Same tier as the other non-streaming grounded coach turns. */
const BACK_ON_TRACK_MODEL = "gpt-5.6-terra";

const TRANSIENT_RETRY_LIMIT = 1;
const TRANSIENT_RETRY_DELAY_MS = 400;

interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
}

interface MinimalLog {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * True when the latest message is a bare yes to the outreach offer sitting
 * directly above it. Strict adjacency, like the other follow-up detectors:
 * anything richer than a one-tap affirmative ("what would the meals be?")
 * falls through to plain chat, which reads the same context anyway. If the
 * patient declined via the client-held chips, the client's fixed reply sits
 * between the offer and any later yes, so this correctly stays quiet.
 */
export function detectBackOnTrackFollowUp(history: HistoryEntry[]): boolean {
  if (history.length < 2) return false;
  const latest = history[history.length - 1];
  const previous = history[history.length - 2];
  if (latest.role !== "user" || previous.role !== "assistant") return false;
  const saidYes =
    isAffirmativeReply(latest.content) || latest.content.trim() === OUTREACH_ACCEPT_LABEL;
  if (!saidYes) return false;
  return previous.content.includes(BACK_ON_TRACK_OFFER);
}

export interface BackOnTrackTurn {
  reply: string;
}

/**
 * The reset plan after they said yes: model-written, grounded in the
 * catalog and the program materials riding the prompt, with the patient's
 * seeded trend numbers supplied server-side (the client is never trusted
 * for them). Plain text end to end — no card, no chips on this turn.
 */
export async function generateBackOnTrackTurn(args: {
  history: HistoryEntry[];
  /** Compartments already selected for this turn; approved-foods is forced in. */
  compartments: Compartment[];
  patient: PatientContext;
  signal: AbortSignal;
  log: MinimalLog;
}): Promise<BackOnTrackTurn> {
  const compartments = ensureApprovedFoodsCompartment(args.compartments);
  const messages = [
    {
      role: "system" as const,
      content: buildBackOnTrackSystemPrompt(args.patient, compartments),
    },
    ...args.history,
  ];
  const raw = await callBackOnTrackModel(messages, args.signal, args.log);
  const text = stripDashes(cleanModelText(raw)).trim();
  if (!text) {
    args.log.warn({}, "back-on-track model returned empty text; sending decline");
    return { reply: BACK_ON_TRACK_UNAVAILABLE };
  }
  return { reply: text };
}

function buildBackOnTrackSystemPrompt(
  patient: PatientContext,
  compartments: Compartment[],
): string {
  return `${COACH_PERSONA_LINE}

${patientContextLine(patient)}

${COACH_VOICE_RULES}

Task: you noticed this patient's weight holding flat while their food diary kept showing items that are not on the THINNR Approved Foods list, so you reached out first, and they just said yes to your offer of a short reset plan. Lay that plan out now, in this order:
- Open with their own numbers, framed as information and momentum, never as failure: they started at ${DEMO_STALL_TREND.startWeightLb} pounds, they have been holding near ${DEMO_STALL_TREND.currentWeightLb} pounds for about ${DEMO_STALL_TREND.stalledWeeks} weeks, and the goal on file is ${DEMO_STALL_TREND.goalWeightLb} pounds.
- Give them the next three days of eating drawn ONLY from the APPROVED FOODS CATALOG below: for each day a simple breakfast, lunch, and dinner built from catalog items, named the way the catalog names them (plain preparation words are fine). Keep it compact, one short block per day.
- Ask them to log every meal in the app each day of the reset, said as one simple ask, not a lecture.
- Close with the provider check-in as an open option: their provider can set one up whenever they want it.

Rules for the plan:
- Ground every food in the catalog: only foods that appear there. Program guidance only from the THINNR materials below. Never invent a rule, a food, or an amount that is not in the catalog or the materials.
- Answer in plain text, no JSON, no markdown, and no bullet characters: short blocks separated by blank lines, a few sentences each, in the same warm texting voice as the rest of the chat.
- Do NOT end with a question. End on the provider check-in option as a statement, so the conversation can rest with the patient.

APPROVED FOODS CATALOG (id — official name):
${catalogPromptLines()}

THINNR program materials for this question:

${sourcesBlock(compartments)}`;
}

async function callBackOnTrackModel(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  signal: AbortSignal,
  log: MinimalLog,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= TRANSIENT_RETRY_LIMIT; attempt++) {
    // Idle deadline per attempt, same posture as every non-streaming coach
    // call: a wedged upstream becomes a prompt, explainable failure.
    const deadline = createUpstreamDeadline(signal);
    const attemptStartedAt = Date.now();
    try {
      const completion = await openai.chat.completions.create(
        {
          model: BACK_ON_TRACK_MODEL,
          // Reasoning models spend part of this budget internally before
          // emitting text; smaller caps come back empty.
          max_completion_tokens: 8192,
          messages,
        },
        { signal: deadline.signal },
      );
      return completion.choices[0]?.message?.content ?? "";
    } catch (error) {
      if (deadline.expired) {
        throw new UpstreamTimeoutError("back-on-track model call", deadline.idleMs, {
          cause: error,
        });
      }
      lastError = error;
      if (signal.aborted || attempt >= TRANSIENT_RETRY_LIMIT) throw error;
      log.warn(
        { err: error, attempt, elapsedMs: Date.now() - attemptStartedAt },
        "back-on-track model call failed; retrying once",
      );
      await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));
      if (signal.aborted) throw error;
    } finally {
      deadline.finish();
    }
  }
  throw lastError;
}
