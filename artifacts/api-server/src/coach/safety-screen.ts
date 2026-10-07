/**
 * Coach chat safety screen.
 *
 * Every message a real patient sends to the AI coach is read once more, in
 * the background, by a small model with one job: notice the handful of
 * things a provider must hear about today. The list is deliberately short
 * and urgent-only — a patient venting about a hard week is not on it; a
 * patient describing chest pain is. A hit becomes a `coach_chat_flags` row
 * and a PHI-free staff alert (see ../alerts/coach-chat-flags.ts).
 *
 * The screen never shapes the coach's reply and never blocks the turn: it
 * runs after the request is authorized, off the response path, with its own
 * timeout. Any failure — model outage, nonsense output, timeout — resolves to
 * "nothing found" and a warning log that carries no message text.
 */

import { z } from "zod";
import { openai } from "@workspace/integrations-openai-ai-server";
import { withModelUsageSurface } from "@workspace/integrations-openai-ai-server/usage";
import { extractModelJson } from "./model-json";
import { DEFAULT_MODELS, modelFor } from "../ai/models";

export const SAFETY_SCREEN_MODEL = DEFAULT_MODELS["coach.safety_screen"];

/** The urgent concerns the screen reports; nothing else is flagged. */
export const COACH_SAFETY_CATEGORIES = [
  "severe_symptoms",
  "medication_problem",
  "pregnancy",
  "self_harm",
  "eating_disorder",
] as const;
export type CoachSafetyCategory = (typeof COACH_SAFETY_CATEGORIES)[number];

export const COACH_SAFETY_CATEGORY_LABELS: Record<CoachSafetyCategory, string> = {
  severe_symptoms: "Severe symptoms",
  medication_problem: "Medication problem",
  pregnancy: "Pregnancy",
  self_harm: "Thoughts of self-harm",
  eating_disorder: "Eating-disorder signs",
};

export interface CoachSafetyFinding {
  category: CoachSafetyCategory;
  /** One clinical-register line, written by the model, ≤ 300 chars. */
  reason: string;
}

const ScreenSchema = z.object({
  concern: z.enum(["none", ...COACH_SAFETY_CATEGORIES]),
  reason: z.string().optional().nullable(),
});

/** Exported so route tests can recognize a screen call by its system prompt. */
export const COACH_SAFETY_SCREEN_PROMPT = `You are a safety screen inside the THINNR patient app, a medically supervised weight-loss program run by provider offices. You read ONE message a patient just sent to their AI nutrition coach and decide whether the provider's office must be alerted today.

Respond with a single JSON object and nothing else, no markdown:
{"concern": "none" | "severe_symptoms" | "medication_problem" | "pregnancy" | "self_harm" | "eating_disorder", "reason": "<one short clinical line, max 160 characters>"}

Flag ONLY these, and only when the patient is describing their own current situation:
- "severe_symptoms": chest pain or pressure, fainting or near-fainting, trouble breathing, signs of a serious allergic reaction, severe or persistent vomiting, severe abdominal pain, signs of dehydration that worry them, heart racing or irregular, confusion, a fall or injury.
- "medication_problem": took too much of a medication, a doubled or wrong dose, a bad reaction to a medication or injection, an infected or badly reacting injection site, stopping or changing a prescribed medication on their own, mixing medications or alcohol in a way that alarms them.
- "pregnancy": they are pregnant, think they may be pregnant, are trying to conceive, or are breastfeeding.
- "self_harm": thoughts of hurting or killing themselves, not wanting to be alive, hopelessness paired with intent, or recent self-harm.
- "eating_disorder": purging, laxative or diuretic misuse to lose weight, fasting for days, extreme restriction below what the program allows, binge-purge cycles, intense fear of eating, or describing a past eating disorder returning.

Answer "none" for everything else: ordinary hunger, cravings, plateaus, mild nausea or headaches that come with the program, routine questions about foods, figures of speech ("I could die for a cookie", "I'm starving"), questions asked on behalf of someone else, and general curiosity ("can pregnant people do this program?" from someone not pregnant).

When unsure between "none" and a flag, prefer "none" unless a reasonable nurse reading the message would want the provider told today. The reason must describe what the patient reported in neutral clinical words, never advice and never a diagnosis. For "none", reason may be empty.`;

interface MinimalLog {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

/** Hard cap on how long one screen may run; nothing waits on it. */
const SCREEN_TIMEOUT_MS = 20_000;

/**
 * Screens one patient message. Resolves to a finding or null; it never
 * throws, and it never logs the message.
 */
export async function screenCoachMessage(args: {
  text: string;
  log: MinimalLog;
  signal?: AbortSignal;
}): Promise<CoachSafetyFinding | null> {
  const text = args.text.trim();
  if (!text) return null;
  const timeout = AbortSignal.timeout(SCREEN_TIMEOUT_MS);
  const signal = args.signal ? AbortSignal.any([args.signal, timeout]) : timeout;
  try {
    const completion = await withModelUsageSurface("coach.safety_screen", () => openai.chat.completions.create(
      {
        model: modelFor("coach.safety_screen"),
        // Reasoning models spend part of this budget internally before
        // emitting text; smaller caps come back empty.
        max_completion_tokens: 4096,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: COACH_SAFETY_SCREEN_PROMPT },
          { role: "user", content: `Patient message:\n"""\n${text.slice(0, 4000)}\n"""\n\nReply with the single JSON object.` },
        ],
      },
      { signal },
    ));
    const raw = completion.choices[0]?.message?.content ?? "";
    const parsed = ScreenSchema.safeParse(extractModelJson(raw));
    if (!parsed.success) {
      args.log.warn({ rawLength: raw.length }, "coach safety screen output invalid; treating as no concern");
      return null;
    }
    if (parsed.data.concern === "none") return null;
    const label = COACH_SAFETY_CATEGORY_LABELS[parsed.data.concern];
    const reason = (parsed.data.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || `${label} reported in coach chat`;
    return { category: parsed.data.concern, reason };
  } catch (error) {
    args.log.warn({ err: error, timedOut: timeout.aborted }, "coach safety screen call failed; treating as no concern");
    return null;
  }
}
