/**
 * Route tests for the off-plan meal-photo makeover flow inside
 * POST /api/coach/chat — the chat-only coaching loop that starts when a
 * photographed plate carries items that fail the Approved Foods check:
 *
 *   1. Callout turn: the meal reply names the off-list items, still attaches
 *      the editable meal card, and closes with the makeover offer + the
 *      curated yes/no chips. All three citation failure shapes (uncited,
 *      unknown id, name that the cited id cannot back) read as off-plan.
 *   2. Makeover follow-up: a one-tap yes right under the offer gets the
 *      model-written swaps plus the server-authored version question and the
 *      dedicated two-label chip set; an empty model answer degrades to the
 *      canned decline with NO version chips.
 *   3. Version choice: "The approved version" routes into the recipe
 *      pipeline with cravings-strength approved-only enforcement (invalid
 *      citations get the corrective retry); "Keep it as is" is a canned
 *      reply with ZERO model calls; anything richer falls through to the
 *      plain streaming chat.
 *
 * The OpenAI client is mocked — no credits spent. Budgets: this file makes
 * 8 chat requests (per-IP burst 10) of which 1 carries an image
 * (menu-scan/vision burst 6) — no rate-limit interference.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const modelState = vi.hoisted(() => ({
  /** Non-streaming answers consumed in order; the last one repeats when exhausted. */
  scanQueue: [] as string[],
  chunks: ["Hello ", "Emma."],
  calls: [] as Array<{
    hasImage: boolean;
    stream: boolean;
    system: string;
    /** Plain-string user messages, in order (recipe/makeover history turns). */
    userStrings: string[];
  }>,
}));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: {
      completions: {
        create: vi.fn(
          async (params: {
            stream?: boolean;
            messages: Array<{ role: string; content: unknown }>;
          }) => {
            const userParts = params.messages
              .filter((m) => m.role === "user" && Array.isArray(m.content))
              .flatMap((m) => m.content as Array<{ type?: string; text?: string }>);
            const hasImage = userParts.some((part) => part?.type === "image_url");
            const system =
              typeof params.messages[0]?.content === "string"
                ? (params.messages[0].content as string)
                : "";
            modelState.calls.push({
              hasImage,
              stream: params.stream === true,
              system,
              userStrings: params.messages
                .filter((m) => m.role === "user" && typeof m.content === "string")
                .map((m) => m.content as string),
            });
            if (params.stream === true) {
              return {
                async *[Symbol.asyncIterator]() {
                  for (const content of modelState.chunks) {
                    yield { choices: [{ delta: { content } }] };
                  }
                },
              };
            }
            const content =
              modelState.scanQueue.length > 1
                ? (modelState.scanQueue.shift() as string)
                : (modelState.scanQueue[0] ?? "");
            return { choices: [{ message: { content } }] };
          },
        ),
      },
    },
  },
}));

import app from "../app";
import {
  MEAL_CARD_CLOSER,
  MEAL_KEEP_REPLY,
  MEAL_MAKEOVER_OFFER,
  MEAL_MAKEOVER_UNAVAILABLE,
  MEAL_VERSION_QUESTION,
  offPlanCallout,
} from "../coach/meal-chat";
import { MEAL_VERSION_REPLY_SET, firstQuickReplySet } from "../coach/quick-replies";
import { APPROVED_CATALOG } from "../coach/approved-catalog";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

afterEach(() => {
  modelState.scanQueue = [];
  modelState.chunks = ["Hello ", "Emma."];
  modelState.calls = [];
});

function postChat(body: unknown) {
  return fetch(`${baseUrl}/api/coach/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Parses every SSE data event in the raw stream body. */
function sseEvents(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

const VALID_IMAGE = "data:image/jpeg;base64,dGVzdA==";
const MEAL_TEXT = "I sent a photo of my meal.";
const YES_LABEL = "Yes, please";

const CHICKEN = APPROVED_CATALOG.find((e) => e.id.includes("chicken_breast"));
if (!CHICKEN) throw new Error("catalog fixture missing: chicken breast");

/**
 * A burrito plate exercising every citation failure shape at once: the
 * chicken cites its real catalog entry (approved), the tortilla cites
 * nothing, the sour cream cites an id that is not in the catalog, and the
 * cheese cites a REAL id whose entry is a different food. Item nutrition
 * sums to the meal totals exactly, as the analysis contract requires.
 */
const BURRITO_JSON = JSON.stringify({
  result: "ok",
  message: "That burrito looks hearty, let's get it logged.",
  mealName: "Chicken burrito",
  description: "A chicken burrito with sour cream and shredded cheese.",
  meal: "lunch",
  items: [
    {
      name: "grilled chicken",
      amount: 4,
      unit: "oz",
      nutrition: { calories: 190, protein: 35, carbs: 0, fat: 4 },
      approvedItemId: CHICKEN.id,
    },
    {
      name: "flour tortilla",
      amount: 1,
      unit: "large",
      nutrition: { calories: 210, protein: 6, carbs: 36, fat: 5 },
    },
    {
      name: "sour cream",
      amount: 2,
      unit: "tbsp",
      nutrition: { calories: 60, protein: 1, carbs: 1, fat: 6 },
      approvedItemId: "dairy:sour_cream",
    },
    {
      name: "shredded cheese",
      amount: 0.25,
      unit: "cup",
      nutrition: { calories: 110, protein: 7, carbs: 1, fat: 9 },
      approvedItemId: CHICKEN.id,
    },
  ],
});

const OFF_PLAN_NAMES = ["flour tortilla", "sour cream", "shredded cheese"];

/** The callout exchange as the client replays it for the follow-up turns. */
function calloutReply(): string {
  return [
    "That burrito looks hearty, let's get it logged.",
    MEAL_CARD_CLOSER,
    `${offPlanCallout(OFF_PLAN_NAMES)} ${MEAL_MAKEOVER_OFFER}`,
  ].join("\n\n");
}

/** Raw swaps text with an em dash — the pipeline must strip it on the way out. */
const SWAPS_RAW =
  "Two easy swaps get you there.\n\nSwap the flour tortilla for lettuce cups — crisp and fresh, and swap the sour cream for plain nonfat Greek yogurt. The shredded cheese would simply come off the plate.";

const versionQuestionReply = `Two easy swaps get you there.\n\n${MEAL_VERSION_QUESTION}`;

describe("meal photo callout turn", () => {
  it("names every off-list item, keeps the card, and closes with the offer + yes/no chips", async () => {
    modelState.scanQueue = [BURRITO_JSON];
    const res = await postChat({
      messages: [{ role: "user", content: MEAL_TEXT, image: VALID_IMAGE, photoKind: "meal" }],
    });
    expect(res.status).toBe(200);
    const rawBody = await res.text();
    const events = sseEvents(rawBody);

    const reply = (events.find((e) => typeof e.content === "string")?.content ?? "") as string;
    // The breakdown and card guidance stay exactly as today...
    expect(reply).toContain("That burrito looks hearty");
    expect(reply).toContain("Grilled Chicken: about 4 oz · est. 190 cal");
    expect(reply).toContain(MEAL_CARD_CLOSER);
    // ...then the callout names all three failure shapes (uncited, unknown
    // id, mismatched citation) in plain words and the offer ends the reply.
    expect(reply).toContain(offPlanCallout(OFF_PLAN_NAMES));
    expect(reply.trimEnd().endsWith(MEAL_MAKEOVER_OFFER)).toBe(true);
    // The approved chicken is never called out.
    expect(offPlanCallout(OFF_PLAN_NAMES)).not.toContain("chicken");

    // The editable meal card still attaches — logging as eaten stays one tap.
    const card = events.find((e) => e.card !== undefined)?.card as {
      kind: string;
      payload: { mode: string; ingredients: unknown[] };
    };
    expect(card.kind).toBe("recipe");
    expect(card.payload.mode).toBe("meal");
    expect(card.payload.ingredients).toHaveLength(4);
    // The verdict is a chat-only signal: neither the citation ids nor the
    // off-plan list ride any wire payload (diary stays judgment-free).
    expect(rawBody).not.toContain("approvedItemId");
    expect(rawBody).not.toContain("offPlanItems");

    // The curated yes/no chips ride the turn, before done.
    const chips = events.find((e) => e.quickReplies !== undefined)?.quickReplies;
    expect(chips).toEqual(firstQuickReplySet(["yes_no"])?.labels);
    expect(events.at(-1)).toEqual({ done: true });

    // The vision prompt carries the judgment rules and the catalog itself.
    const vision = modelState.calls.filter((c) => c.hasImage);
    expect(vision).toHaveLength(1);
    expect(vision[0].system).toContain("Judging items against the THINNR approved list");
    expect(vision[0].system).toContain("APPROVED FOODS CATALOG (id — official name):");
    expect(vision[0].system).toContain(CHICKEN.id);
  });
});

describe("makeover suggestion follow-up", () => {
  it("answers a one-tap yes with the swaps, the version question, and the version chips", async () => {
    modelState.scanQueue = [SWAPS_RAW];
    const res = await postChat({
      messages: [
        { role: "user", content: MEAL_TEXT },
        { role: "assistant", content: calloutReply() },
        { role: "user", content: YES_LABEL },
      ],
    });
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());

    const reply = (events.find((e) => typeof e.content === "string")?.content ?? "") as string;
    expect(reply).toContain("Swap the flour tortilla for lettuce cups");
    // The no-dash voice rule holds on this model-written turn too.
    expect(reply).not.toMatch(/[—–]/);
    // The server-authored version question is appended verbatim as the
    // ending — it is the adjacency key the choice detector reads back.
    expect(reply.trimEnd().endsWith(MEAL_VERSION_QUESTION)).toBe(true);

    const chips = events.find((e) => e.quickReplies !== undefined)?.quickReplies;
    expect(chips).toEqual(MEAL_VERSION_REPLY_SET.labels);
    expect(events.some((e) => e.card !== undefined)).toBe(false);
    expect(events.at(-1)).toEqual({ done: true });

    // One text-only model call, grounded: catalog + swap rules ride the
    // system prompt, and the model is told the app asks the question.
    expect(modelState.calls).toHaveLength(1);
    expect(modelState.calls[0].hasImage).toBe(false);
    expect(modelState.calls[0].stream).toBe(false);
    expect(modelState.calls[0].system).toContain("APPROVED FOODS CATALOG (id — official name):");
    expect(modelState.calls[0].system).toContain("Never invent a program rule");
    expect(modelState.calls[0].system).toContain("Do NOT ask the patient anything");
    // The callout exchange rides as replayed history, so the swaps turn
    // knows the exact plate without the photo ever being re-sent.
    expect(modelState.calls[0].userStrings.at(-1)).toBe(YES_LABEL);
  });

  it("degrades to the canned decline with no version chips when the model gives nothing", async () => {
    modelState.scanQueue = [""];
    const res = await postChat({
      messages: [
        { role: "user", content: MEAL_TEXT },
        { role: "assistant", content: calloutReply() },
        { role: "user", content: "yes" },
      ],
    });
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());
    expect(events).toContainEqual({ content: MEAL_MAKEOVER_UNAVAILABLE });
    // No version question went out, so no version chips may ride either —
    // the choice detector must never fire against this reply.
    expect(events.some((e) => e.quickReplies !== undefined)).toBe(false);
    expect(events.at(-1)).toEqual({ done: true });
  });

  it("lets a decline fall through to the plain chat — no makeover machinery", async () => {
    const res = await postChat({
      messages: [
        { role: "user", content: MEAL_TEXT },
        { role: "assistant", content: calloutReply() },
        { role: "user", content: "No thanks" },
      ],
    });
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());
    // The dash smoother holds back the chunk tail, so the first visible
    // piece is "Hello" — same shape the other route suites assert.
    expect(events).toContainEqual({ content: "Hello" });
    expect(events.at(-1)).toEqual({ done: true });
    // The plain streaming pipeline answered (and "No thanks" was NOT read
    // as a meal correction — no vision call, no re-analysis).
    expect(modelState.calls).toHaveLength(1);
    expect(modelState.calls[0].stream).toBe(true);
    expect(modelState.calls[0].hasImage).toBe(false);
  });
});

describe("version choice resolution", () => {
  const historyTo = (answer: string) => ({
    messages: [
      { role: "user", content: MEAL_TEXT },
      { role: "assistant", content: calloutReply() },
      { role: "user", content: YES_LABEL },
      { role: "assistant", content: versionQuestionReply },
      { role: "user", content: answer },
    ],
  });

  const approvedA = APPROVED_CATALOG.find((e) => e.id.includes("chicken_breast"));
  const approvedB = APPROVED_CATALOG.find((e) => e.id.includes("sweet_potatoes"));
  if (!approvedA || !approvedB) throw new Error("catalog fixtures missing");

  const approvedRecipe = {
    name: "Approved Chicken Burrito Bowl",
    description: "The same burrito flavors, rebuilt fully on the list.",
    meal: "lunch",
    minutes: 20,
    servings: 1,
    calories: 420,
    protein: 38,
    carbs: 18,
    fat: 22,
    ingredients: [
      {
        amount: 4,
        unit: "oz",
        name: approvedA.name.toLowerCase(),
        approvedItemId: approvedA.id,
        nutrition: { calories: 300, protein: 20, carbs: 10, fat: 12 },
      },
      {
        amount: 1,
        unit: "cup",
        name: approvedB.name.toLowerCase(),
        approvedItemId: approvedB.id,
        nutrition: { calories: 120, protein: 18, carbs: 8, fat: 10 },
      },
    ],
    steps: ["Grill the chicken.", "Serve over the roasted sweet potatoes."],
  };

  it("routes the approved choice into the recipe pipeline with approved-only enforcement", async () => {
    modelState.scanQueue = [
      JSON.stringify({ reply: "Here is that burrito, fully approved.", recipe: approvedRecipe }),
    ];
    const res = await postChat(historyTo(MEAL_VERSION_REPLY_SET.labels[0]));
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());

    expect(events).toContainEqual({ content: "Here is that burrito, fully approved." });
    const card = events.find((e) => e.card !== undefined)?.card as {
      kind: string;
      payload: { mode: string; ingredients: Array<{ approvedItemId?: string }> };
    };
    expect(card.kind).toBe("recipe");
    // A saveable, loggable coach recipe card — not a meal read.
    expect(card.payload.mode).toBe("recipe");
    expect(card.payload.ingredients.every((i) => i.approvedItemId)).toBe(true);
    expect(events.at(-1)).toEqual({ done: true });

    // One structured call, with the makeover task and the cravings-strength
    // approved-foods rules in the system prompt.
    expect(modelState.calls).toHaveLength(1);
    expect(modelState.calls[0].stream).toBe(false);
    expect(modelState.calls[0].system).toContain("The patient chose the THINNR-approved version");
    expect(modelState.calls[0].system).toContain("STRICT APPROVED-FOODS RULES:");
    expect(modelState.calls[0].system).toContain("APPROVED FOODS CATALOG (id — official name):");
  });

  it("retries correctively when the approved version cites badly, then succeeds", async () => {
    modelState.scanQueue = [
      JSON.stringify({
        reply: "Here you go.",
        recipe: {
          ...approvedRecipe,
          ingredients: [
            {
              amount: 4,
              unit: "oz",
              // Uncited ingredient — must fail the approved-only gate.
              name: "grilled chicken",
              nutrition: { calories: 420, protein: 38, carbs: 18, fat: 22 },
            },
          ],
        },
      }),
      JSON.stringify({ reply: "Here is that burrito, fully approved.", recipe: approvedRecipe }),
    ];
    const res = await postChat(historyTo("the approved version"));
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());

    // The second, verified answer is what reached the patient.
    const card = events.find((e) => e.card !== undefined)?.card as {
      payload: { ingredients: Array<{ approvedItemId?: string }> };
    };
    expect(card.payload.ingredients.every((i) => i.approvedItemId)).toBe(true);
    expect(events.at(-1)).toEqual({ done: true });

    expect(modelState.calls).toHaveLength(2);
    // The corrective turn names the citation problem so the model fixes THAT.
    expect(modelState.calls[1].userStrings.at(-1)).toContain("approvedItemId");
  });

  it("answers the keep choice with the canned reply and zero model calls", async () => {
    const res = await postChat(historyTo(MEAL_VERSION_REPLY_SET.labels[1]));
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());
    expect(events).toContainEqual({ content: MEAL_KEEP_REPLY });
    expect(events.some((e) => e.card !== undefined)).toBe(false);
    expect(events.some((e) => e.quickReplies !== undefined)).toBe(false);
    expect(events.at(-1)).toEqual({ done: true });
    // Canned all the way — the model never ran.
    expect(modelState.calls).toHaveLength(0);
  });

  it("lets a richer answer at the version question fall through to plain chat", async () => {
    const res = await postChat(historyTo("What would the approved version taste like?"));
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());
    expect(events).toContainEqual({ content: "Hello" });
    expect(events.at(-1)).toEqual({ done: true });
    expect(modelState.calls).toHaveLength(1);
    expect(modelState.calls[0].stream).toBe(true);
    expect(events.some((e) => e.card !== undefined)).toBe(false);
  });
});
