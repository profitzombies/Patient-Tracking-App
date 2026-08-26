/**
 * Route tests for the coach chat's meal-photo turns (photoKind: "meal").
 *
 * The OpenAI client is mocked (no credits spent) with a shape-aware fake:
 * calls carrying an image_url part answer with the next scripted scan JSON
 * (a queue, so corrective retries can see a different second answer), and
 * streaming calls yield the scripted chunks. Covers: the friendly breakdown
 * reply with per-item committed portions and the editable meal card (mode
 * "meal", one serving, no steps, exact integer sums), the prompt's
 * visible-only / always-estimate rules, the corrective retry when the model
 * refuses to commit to an amount, non-food photos as warm conversational
 * outcomes (never errors), persistent invalid output as the standard SSE
 * error, and routing: an image without photoKind is triaged by a tiny
 * vision call (menu photos to the menu scan, everything else to the meal
 * pipeline), and photoKind without an image stays on the plain chat.
 *
 * Budgets: this file makes 7 chat requests (burst 10) of which 6 carry an
 * image (menu-scan/vision burst 6) — no rate-limit interference. The
 * triage answer (triageJson) is a model call inside the same request, not
 * an extra request slot.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const MEAL_OK_JSON = JSON.stringify({
  result: "ok",
  message: "That's a solid plate — lean protein and a real vegetable side.",
  mealName: "Grilled chicken with sweet potatoes",
  description: "Grilled chicken breast with a side of roasted sweet potatoes.",
  meal: "dinner",
  items: [
    {
      name: "grilled chicken breast",
      amount: 6,
      unit: "oz",
      nutrition: { calories: 280, protein: 50, carbs: 0, fat: 6 },
    },
    {
      name: "roasted sweet potatoes",
      amount: 1,
      unit: "cup",
      nutrition: { calories: 180, protein: 3, carbs: 41, fat: 1 },
    },
  ],
});

/** First answer refuses to commit (amount 0) — must trigger the corrective retry. */
const MEAL_ZERO_AMOUNT_JSON = JSON.stringify({
  result: "ok",
  message: "Looks like grilled chicken, though the portion is hard to tell.",
  mealName: "Grilled chicken",
  description: "A grilled chicken breast.",
  meal: "dinner",
  items: [
    {
      name: "grilled chicken breast",
      amount: 0,
      unit: "oz",
      nutrition: { calories: 280, protein: 50, carbs: 0, fat: 6 },
    },
  ],
});

const MEAL_NOT_FOOD_JSON = JSON.stringify({
  result: "not_food",
  message: "That looks like a snapshot of your desk, not a meal.",
  mealName: null,
  description: null,
  meal: null,
  items: [],
});

/** Menu-scan shape, for the back-compat test (image without photoKind). */
const MENU_OK_JSON = JSON.stringify({
  result: "ok",
  message: "The grill section is your friend here.",
  menuTitle: "Harbor Grill",
  order: [
    {
      name: "Grilled Salmon",
      howToOrder: "Ask for it grilled plain, sauce on the side.",
      note: null,
    },
  ],
  avoid: [],
});

const DEFAULT_CHUNKS = ["Hello ", "Emma."];

const modelState = vi.hoisted(() => ({
  /** Vision answers consumed in order; the last one repeats when exhausted. */
  scanQueue: [] as string[],
  /** Answer for the photo-triage call a kindless image makes first. */
  triageJson: '{"subject":"food"}',
  chunks: ["Hello ", "Emma."],
  failNext: 0,
  calls: [] as Array<{ hasImage: boolean; stream: boolean; system: string; userText: string }>,
}));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: {
      completions: {
        create: vi.fn(
          async (params: { stream?: boolean; messages: Array<{ role: string; content: unknown }> }) => {
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
              userText: userParts.find((part) => part?.type === "text")?.text ?? "",
            });
            if (modelState.failNext > 0) {
              modelState.failNext -= 1;
              throw new Error("upstream boom");
            }
            // A kindless image's first vision call is the triage router; it
            // answers from triageJson and never consumes the scan queue.
            if (hasImage && system.includes("photo triage")) {
              return { choices: [{ message: { content: modelState.triageJson } }] };
            }
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
import { MEAL_CARD_CLOSER, MEAL_TRY_ANOTHER_PHOTO } from "../coach/meal-chat";
import { MENU_RECIPE_OFFER } from "../coach/menu-chat";

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
  modelState.triageJson = '{"subject":"food"}';
  modelState.chunks = [...DEFAULT_CHUNKS];
  modelState.failNext = 0;
  modelState.calls = [];
});

function postChat(body: unknown) {
  return fetch(`${baseUrl}/api/coach/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_IMAGE = "data:image/jpeg;base64,dGVzdA==";
const MEAL_TEXT = "I sent a photo of my meal.";

function mealBody(image: string) {
  return { messages: [{ role: "user", content: MEAL_TEXT, image, photoKind: "meal" }] };
}

/** Parses every SSE data event in the raw stream body. */
function sseEvents(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

interface CardPayload {
  id: string;
  mode: string;
  name: string;
  minutes: number;
  servings: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  ingredients: Array<{
    amount: number;
    unit: string;
    name: string;
    nutrition: { calories: number; protein: number; carbs: number; fat: number };
  }>;
  steps: string[];
}

describe("POST /api/coach/chat with a meal photo", () => {
  it("answers with the friendly breakdown, committed portions, and the editable meal card", async () => {
    modelState.scanQueue = [MEAL_OK_JSON];
    const res = await postChat(mealBody(VALID_IMAGE));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = sseEvents(await res.text());

    const reply = (events.find((e) => typeof e.content === "string")?.content ?? "") as string;
    // The fixture's coach message carries an em dash; the pipeline's
    // no-dash cleaning must rewrite it before it reaches the patient.
    expect(reply).toContain("That's a solid plate, lean protein and a real vegetable side.");
    expect(reply).not.toContain("—");
    // One line per VISIBLE item, each with a committed best-guess portion
    // and the same integer calories the card shows.
    expect(reply).toContain("Grilled chicken breast: about 6 oz · est. 280 cal");
    expect(reply).toContain("Roasted sweet potatoes: about 1 cup · est. 180 cal");
    expect(reply).toContain(MEAL_CARD_CLOSER);
    // Never ends with a question — the client's fallback yes/no chips must
    // stay hidden (the retake chip rides this turn instead).
    expect(reply.trimEnd().endsWith("?")).toBe(false);

    // The card is the existing recipe payload with mode "meal": one serving,
    // nothing to cook, totals as the exact integer sums of the items.
    const card = events.find((e) => e.card !== undefined)?.card as {
      kind: string;
      payload: CardPayload;
    };
    expect(card.kind).toBe("recipe");
    expect(card.payload.mode).toBe("meal");
    expect(card.payload.id.startsWith("meal_")).toBe(true);
    // Created names are Title Case at payload assembly ("with" stays small).
    expect(card.payload.name).toBe("Grilled Chicken with Sweet Potatoes");
    expect(card.payload.servings).toBe(1);
    expect(card.payload.minutes).toBe(0);
    expect(card.payload.steps).toEqual([]);
    expect(card.payload.calories).toBe(460);
    expect(card.payload.protein).toBe(53);
    expect(card.payload.carbs).toBe(41);
    expect(card.payload.fat).toBe(7);
    expect(card.payload.ingredients).toHaveLength(2);
    expect(card.payload.ingredients[0].nutrition.calories).toBe(280);
    const itemCals = card.payload.ingredients.reduce((sum, i) => sum + i.nutrition.calories, 0);
    expect(itemCals).toBe(card.payload.calories);

    // No quick replies on meal turns; the turn closes cleanly.
    expect(events.some((e) => e.quickReplies !== undefined)).toBe(false);
    expect(events.at(-1)).toEqual({ done: true });

    // Exactly one vision call, and the prompt carries the two hard rules:
    // visible items only (no hidden fats), always commit to an estimate.
    const visionCalls = modelState.calls.filter((c) => c.hasImage);
    expect(visionCalls).toHaveLength(1);
    expect(visionCalls[0].stream).toBe(false);
    expect(visionCalls[0].system).toContain("Never add ingredients you cannot see");
    expect(visionCalls[0].system).toContain("No assumed butter, cooking oil");
    expect(visionCalls[0].system).toContain("Never split a visible dish into its parts");
    expect(visionCalls[0].system).toContain("ALWAYS commit to one specific portion");
    expect(visionCalls[0].system).toContain("Never say you cannot determine the portions");
    // The everyday-food rules that keep home plates from coming back as
    // specialty restaurant dishes (steak + sweet potatoes, not "smoked
    // brisket with burnt ends"), sides separate from proteins, one visible
    // protein as ONE item, and honest uncertainty over dressed-up guesses.
    expect(visionCalls[0].system).toContain("Default to everyday home-cooked names");
    expect(visionCalls[0].system).toContain("Never name a specialty restaurant dish");
    expect(visionCalls[0].system).toContain(
      "the protein is one item and each vegetable or side is its own item",
    );
    expect(visionCalls[0].system).toContain("One visible protein is ONE item");
    expect(visionCalls[0].system).toContain("never list the same piece of meat as two different meats");
    expect(visionCalls[0].system).toContain("use the plain generic name");
    // A plain meal turn runs UNCORRECTED — no ground-truth override rule.
    expect(visionCalls[0].system).not.toContain("ground truth");
    expect(visionCalls[0].userText).toContain("Here is the photo of my meal.");
  });

  it("retries correctively when the model refuses to commit to an amount", async () => {
    modelState.scanQueue = [MEAL_ZERO_AMOUNT_JSON, MEAL_OK_JSON];
    const res = await postChat(mealBody(VALID_IMAGE));
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());

    // The retake answer (amount 0) never reached the patient — the second,
    // committed answer did.
    const reply = (events.find((e) => typeof e.content === "string")?.content ?? "") as string;
    expect(reply).toContain("Grilled chicken breast: about 6 oz · est. 280 cal");
    expect(events.at(-1)).toEqual({ done: true });

    const visionCalls = modelState.calls.filter((c) => c.hasImage);
    expect(visionCalls).toHaveLength(2);
    // The corrective turn names the violation so the model fixes THAT.
    expect(visionCalls[1].userText).toContain("That answer was invalid");
    expect(visionCalls[1].userText).toContain("must be a positive number");
    expect(visionCalls[1].userText).toContain("commit to your single best portion estimate");
  });

  it("treats a non-food photo as a warm conversational outcome, not an error", async () => {
    modelState.scanQueue = [MEAL_NOT_FOOD_JSON];
    const res = await postChat(mealBody(VALID_IMAGE));
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());

    const reply = (events.find((e) => typeof e.content === "string")?.content ?? "") as string;
    expect(reply).toContain("That looks like a snapshot of your desk");
    expect(reply).toContain(MEAL_TRY_ANOTHER_PHOTO);
    expect(reply.trimEnd().endsWith("?")).toBe(false);

    expect(events.some((e) => e.error !== undefined)).toBe(false);
    expect(events.some((e) => e.card !== undefined)).toBe(false);
    expect(events.some((e) => e.quickReplies !== undefined)).toBe(false);
    expect(events.at(-1)).toEqual({ done: true });
  });

  it("surfaces persistently invalid model output as the standard SSE error", async () => {
    modelState.scanQueue = ["this is not json", "still not json"];
    const res = await postChat(mealBody(VALID_IMAGE));
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());

    expect(events).toContainEqual({
      error: "The coach is unavailable right now. Please try again.",
    });
    expect(events.some((e) => e.done === true)).toBe(false);
    // Initial attempt + ONE corrective retry — invalid JSON is not a
    // transient failure, so no extra upstream retries pile on.
    expect(modelState.calls.filter((c) => c.hasImage)).toHaveLength(2);
  });

  it("triages a kindless image that shows a menu onto the menu pipeline", async () => {
    modelState.triageJson = '{"subject":"menu"}';
    modelState.scanQueue = [MENU_OK_JSON];
    const res = await postChat({
      messages: [{ role: "user", content: "I sent a photo.", image: VALID_IMAGE }],
    });
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());

    const reply = (events.find((e) => typeof e.content === "string")?.content ?? "") as string;
    expect(reply).toContain("The grill section is your friend here.");
    expect(reply).toContain(MENU_RECIPE_OFFER);
    // Menu turns carry the yes/no chips; meal turns never do.
    expect(events.some((e) => e.quickReplies !== undefined)).toBe(true);
    expect(events.some((e) => e.card !== undefined)).toBe(false);
    expect(events.at(-1)).toEqual({ done: true });
    // Triage first, then the scan — and the resolved route is announced so
    // a client retry can name it explicitly instead of triaging again.
    expect(events).toContainEqual({ photoKind: "menu" });
    const vision = modelState.calls.filter((c) => c.hasImage);
    expect(vision).toHaveLength(2);
    expect(vision[0].system).toContain("photo triage");
  });

  it("triages a kindless image that shows a plate onto the meal pipeline", async () => {
    modelState.triageJson = '{"subject":"food"}';
    modelState.scanQueue = [MEAL_OK_JSON];
    const res = await postChat({
      messages: [{ role: "user", content: "I sent a photo.", image: VALID_IMAGE }],
    });
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());

    const reply = (events.find((e) => typeof e.content === "string")?.content ?? "") as string;
    expect(reply).toContain(MEAL_CARD_CLOSER);
    const card = events.find((e) => e.card !== undefined)?.card as {
      kind: string;
      payload: { mode?: string };
    };
    expect(card.kind).toBe("recipe");
    expect(card.payload.mode).toBe("meal");
    // Meal turns never carry chips — the client shows its own retake chip.
    expect(events.some((e) => e.quickReplies !== undefined)).toBe(false);
    expect(events.at(-1)).toEqual({ done: true });
    const vision = modelState.calls.filter((c) => c.hasImage);
    expect(vision).toHaveLength(2);
    expect(vision[0].system).toContain("photo triage");
    expect(events).toContainEqual({ photoKind: "meal" });
  });

  it("keeps photoKind without an image on the plain chat pipeline", async () => {
    // Neutral wording — must not trip the recipe-intent detector.
    const res = await postChat({
      messages: [{ role: "user", content: "Is grapefruit approved?", photoKind: "meal" }],
    });
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());
    expect(events).toContainEqual({ content: "Hello" });
    expect(events.at(-1)).toEqual({ done: true });
    // No vision call was made — the streaming chat answered.
    expect(modelState.calls.every((c) => !c.hasImage)).toBe(true);
    expect(modelState.calls.at(-1)?.stream).toBe(true);
  });
});
