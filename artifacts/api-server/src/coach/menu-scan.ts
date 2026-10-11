/**
 * Menu photo scan — "what can I order here?" for a patient at a restaurant.
 *
 * The route hands one photo over as a data URI; the vision model reads the
 * menu and answers with a single JSON object: dishes on that menu that can
 * work (each with the exact modification to request), dishes to steer clear
 * of, or a signal that the photo is not a readable menu. Grounding is the
 * verbatim Approved Foods list plus the restaurant guide's dining-out rules,
 * including its "Before you order" preparation rules — but the output is AI
 * guidance in the model's own words, never quoted program copy.
 *
 * Follows the recipe flow's JSON-validation-with-corrective-retry pattern:
 * invalid output gets one corrective retry, then the caller reports an honest
 * failure instead of inventing guidance. The photo lives only in this
 * request's memory; it is never logged, written to disk, or stored.
 */

import { z } from "zod";
import { openai } from "@workspace/integrations-openai-ai-server";
import { BEFORE_YOU_ORDER_COMPARTMENT, getCompartmentById } from "./compartments";
import { cleanModelText, extractModelJson } from "./model-json";
import { stripDashes } from "./text-style";

/** Coach-surface cleaning: emoji strip + trim, then the no-dash voice rule. */
function cleanCoachText(text: string): string {
  return stripDashes(cleanModelText(text)).trim();
}
import { patientContextLine, sourcesBlock, type PatientContext } from "./prompt";
import { guardMenuPayload } from "./diet-guard";
import { UpstreamTimeoutError, createUpstreamDeadline } from "./upstream";
import type { UsageRecorder } from "./usage";
import { withModelUsageSurface } from "@workspace/integrations-openai-ai-server/usage";
import { DEFAULT_MODELS, modelFor } from "../ai/models";

export const MENU_SCAN_MODEL = DEFAULT_MODELS["coach.menu_scan"];

/** One corrective retry when the model's JSON fails validation. */
const RETRY_LIMIT = 1;

/** One extra attempt per model call for transient upstream failures. */
const TRANSIENT_RETRY_LIMIT = 1;
const TRANSIENT_RETRY_DELAY_MS = 400;

// ─── Output contract ─────────────────────────────────────────────────────────

const OrderItemSchema = z.object({
  name: z.string().min(1).max(80),
  howToOrder: z.string().min(1).max(280),
  note: z.string().max(200).nullish(),
});

const AvoidItemSchema = z.object({
  name: z.string().min(1).max(80),
  reason: z.string().min(1).max(200),
});

const ModelOutputSchema = z.object({
  result: z.enum(["ok", "not_menu", "unreadable"]),
  message: z.string().min(1).max(500),
  menuTitle: z.string().max(80).nullish(),
  order: z.array(OrderItemSchema).max(10).default([]),
  avoid: z.array(AvoidItemSchema).max(10).default([]),
});

/** Mirrors the CoachMenuScanResult schema in the API spec. */
export interface MenuScanPayload {
  result: "ok" | "not_menu" | "unreadable";
  message: string;
  menuTitle?: string;
  order: Array<{ name: string; howToOrder: string; note?: string }>;
  avoid: Array<{ name: string; reason: string }>;
}

/** The model kept returning invalid output; the route answers 502. */
export class MenuScanModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MenuScanModelError";
  }
}

interface MinimalLog {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

function buildSystemPrompt(patient: PatientContext): string {
  const compartments = [
    getCompartmentById("approved-foods"),
    getCompartmentById("restaurant-guide"),
    BEFORE_YOU_ORDER_COMPARTMENT,
  ];

  return `You are the THINNR menu scanner, an AI helper inside the THINNR patient app. The patient is at a restaurant and photographed the menu. Work out what they can order under the THINNR program and exactly how to ask for it.

Respond with a single JSON object and nothing else — no markdown, no code fences:
{
  "result": "ok" | "not_menu" | "unreadable",
  "message": string,
  "menuTitle": string or null,
  "order": [ { "name": string, "howToOrder": string, "note": string or null } ],
  "avoid": [ { "name": string, "reason": string } ]
}

Reading the photo:
- "not_menu": the photo is not a restaurant menu (no readable list of dishes or drinks for sale). In "message", say warmly and without any blame what the photo shows instead — keep it light, like a friend noticing — and leave "order" and "avoid" empty.
- "unreadable": it does look like a menu, but it is too blurry, dark, small, or cropped to read dish names reliably. Say so in "message" the way a coach would — no fault, just a quick suggestion to retake it closer or with more light — and leave both lists empty. Never guess at dishes you cannot clearly read.
- "ok": you can read the menu. Set "menuTitle" to the restaurant or menu name if printed in the photo, otherwise null.

Choosing dishes (when "result" is "ok"):
- Judge every dish only against the THINNR program materials in the <source> blocks below — the official Approved Foods selections and the dining-out rules.
- "order" lists dishes printed on THIS menu that can work, best options first, at most 8. For each:
  - "name": the dish name as printed on the menu.
  - "howToOrder": one plain sentence the patient can say when ordering, spelling out every change the dish needs — for example grilled or steamed plain, no butter, no oil, no cheese, no breading, sauce or dressing left off, side swapped to approved vegetables.
  - "note": a short caution or tip (portion to eat, what to double-check with the kitchen), or null.
- A dish belongs in "order" only if every component fits the program after realistic requests. If a core component cannot be fixed by asking (breaded or battered, pasta, rice, sugary glaze, cream base), the dish belongs in "avoid" instead.
- "avoid" lists the clearest tempting dishes on this menu that do not fit, at most 8, each with one short plain reason. Pick the ones a patient might reach for by mistake — not every line on the menu.
- Use only dish names actually printed on the menu. Never invent items, and never put the same dish in both lists.
- Portions: protein amounts follow the patient's phase rules in the sources. When a menu portion is clearly larger, tell the patient to eat only the allowed amount and box the rest.
- If nothing on the menu can work, leave "order" empty and use "message" to suggest asking the kitchen for a plain grilled approved protein with steamed vegetables, no butter or oil.
- "message" is 1-2 short sentences in the patient's coach's own texting voice — react like you really just looked the menu over with them, then point at the best option or level with them about the situation. Contractions and plain words; specific, not gushing. Plain text, never emojis, and never an em dash or en dash; punctuate with commas and periods.

You are AI guidance, not the official program materials. Keep every suggestion consistent with the sources below; the app shows your answer next to a link to the official Approved list.

THINNR program materials:

${sourcesBlock(compartments)}

${patientContextLine(patient)}`;
}

// ─── Model call ──────────────────────────────────────────────────────────────

type UserContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type ScanMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: UserContentPart[] };

function buildMessages(
  systemPrompt: string,
  image: string,
  previous: { raw: string; problems: string } | null,
): ScanMessage[] {
  const intro = "Here is the menu photo. Scan it and reply with the single JSON object.";
  const text = previous
    ? `${intro}

Your previous answer was:
${previous.raw.slice(0, 6000)}

That answer was invalid: ${previous.problems}. Reply again with ONLY the corrected JSON object.`
    : intro;
  return [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: [
        { type: "text", text },
        { type: "image_url", image_url: { url: image } },
      ],
    },
  ];
}

async function callModel(
  messages: ScanMessage[],
  signal: AbortSignal,
  log: MinimalLog,
  onUsage: UsageRecorder | undefined,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= TRANSIENT_RETRY_LIMIT; attempt++) {
    // Idle deadline per attempt: a wedged vision upstream must become a
    // prompt, explainable failure, not a request that hangs until a proxy
    // kills the connection.
    const deadline = createUpstreamDeadline(signal);
    const attemptStartedAt = Date.now();
    try {
      const completion = await withModelUsageSurface("coach.menu_scan", () => openai.chat.completions.create(
        {
          model: modelFor("coach.menu_scan"),
          // Reasoning models spend part of this budget internally before
          // emitting text; smaller caps come back empty.
          max_completion_tokens: 8192,
          response_format: { type: "json_object" },
          messages,
        },
        { signal: deadline.signal },
      ));
      onUsage?.(completion.usage);
      return completion.choices[0]?.message?.content ?? "";
    } catch (error) {
      // A deadline expiry already consumed the full idle budget; a transient
      // retry would stack another silent wait on top of it, so surface the
      // named timeout immediately instead of burning the retry.
      if (deadline.expired) {
        throw new UpstreamTimeoutError("menu scan model call", deadline.idleMs, { cause: error });
      }
      lastError = error;
      if (signal.aborted || attempt >= TRANSIENT_RETRY_LIMIT) throw error;
      log.warn(
        { err: error, attempt, elapsedMs: Date.now() - attemptStartedAt },
        "menu scan model call failed; retrying once",
      );
      await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));
      if (signal.aborted) throw error;
    } finally {
      deadline.finish();
    }
  }
  throw lastError;
}

// ─── Interpretation ──────────────────────────────────────────────────────────

type Interpretation =
  | { ok: true; payload: MenuScanPayload }
  | { ok: false; problems: string[] };

function interpret(raw: string): Interpretation {
  const json = extractModelJson(raw);
  if (json === null) {
    return { ok: false, problems: ["the response was not a valid JSON object"] };
  }
  const parsed = ModelOutputSchema.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "output"}: ${issue.message}`);
    return { ok: false, problems };
  }

  const data = parsed.data;
  const message = cleanCoachText(data.message);
  if (!message) {
    return { ok: false, problems: ["message was empty"] };
  }

  // Non-menu / unreadable photos never carry dish lists; coercing (rather
  // than retrying) is the correct reading of that answer.
  const readable = data.result === "ok";
  const order = readable
    ? data.order
        .map((item) => {
          const note = item.note ? cleanCoachText(item.note) : "";
          return {
            name: cleanCoachText(item.name),
            howToOrder: cleanCoachText(item.howToOrder),
            ...(note ? { note } : {}),
          };
        })
        .filter((item) => item.name && item.howToOrder)
    : [];
  const orderNames = new Set(order.map((item) => item.name.toLowerCase()));
  const avoid = readable
    ? data.avoid
        .map((item) => ({ name: cleanCoachText(item.name), reason: cleanCoachText(item.reason) }))
        .filter((item) => item.name && item.reason && !orderNames.has(item.name.toLowerCase()))
    : [];
  const menuTitle = readable && data.menuTitle ? cleanCoachText(data.menuTitle) : "";

  return {
    ok: true,
    payload: {
      result: data.result,
      message,
      ...(menuTitle ? { menuTitle } : {}),
      order,
      avoid,
    },
  };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function generateMenuScan(args: {
  /** Validated image data URI (jpeg/png/webp). Kept in memory only. */
  image: string;
  patient: PatientContext;
  /** Per-call token usage sink (the route's photo usage log). */
  onUsage?: UsageRecorder;
  signal: AbortSignal;
  log: MinimalLog;
}): Promise<MenuScanPayload> {
  const systemPrompt = buildSystemPrompt(args.patient);

  let previous: { raw: string; problems: string } | null = null;
  for (let attempt = 0; attempt <= RETRY_LIMIT; attempt++) {
    const messages = buildMessages(systemPrompt, args.image, previous);
    const raw = await callModel(messages, args.signal, args.log, args.onUsage);
    const outcome = interpret(raw);
    if (outcome.ok) {
      // Real accounts: picks that hit the patient's lists or diet move to
      // the skip side (or drop, for dislikes) no matter what the model chose.
      if (!args.patient.diet) return outcome.payload;
      const guarded = guardMenuPayload(outcome.payload, args.patient.diet);
      if (guarded.moved.length > 0) {
        args.log.warn({ moved: guarded.moved.map((m) => m.code) }, "menu scan picks removed by diet guard");
      }
      return guarded.payload;
    }
    args.log.warn(
      { attempt, problems: outcome.problems },
      "menu scan output failed validation",
    );
    previous = { raw, problems: outcome.problems.join("; ") };
  }
  throw new MenuScanModelError("menu scan output stayed invalid after corrective retry");
}
