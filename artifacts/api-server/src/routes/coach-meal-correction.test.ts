/**
 * Route tests for TYPED meal corrections: after a misread meal card, the
 * patient types what the plate really is ("No, that's steak and sweet
 * potato wedges") and the client re-attaches the SAME held photo with
 * photoKind "meal". The route detects the correction with
 * isMealCorrectionText and re-runs the analysis with the patient's words as
 * ground truth for WHAT the foods are — portions still come from the photo.
 *
 * Covers: the correction turn reaches the meal pipeline without re-triage
 * and its prompt carries the ground-truth rule plus the patient's words;
 * the fixed photo replay text is never treated as a correction (retakes
 * stay fresh reads); the corrective retry (invalid model answer) keeps the
 * correction context; and an unrelated text message sent after a meal-card
 * exchange stays on the plain streaming chat.
 *
 * Budgets: this file makes 4 chat requests (burst 10) of which 3 carry an
 * image (menu-scan/vision burst 6) — no rate-limit interference.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

/** The corrected read after "No, that's steak and sweet potato wedges". */
const CORRECTED_OK_JSON = JSON.stringify({
  result: "ok",
  message: "Got the fix, steak and sweet potato wedges it is.",
  mealName: "Steak with sweet potato wedges",
  description: "Sliced steak with roasted sweet potato wedges.",
  meal: "dinner",
  items: [
    {
      name: "sliced steak",
      amount: 7,
      unit: "oz",
      nutrition: { calories: 490, protein: 49, carbs: 0, fat: 31 },
    },
    {
      name: "sweet potato wedges",
      amount: 1,
      unit: "cup",
      nutrition: { calories: 180, protein: 2, carbs: 41, fat: 1 },
    },
  ],
});

/** First answer refuses to commit (amount 0) — must trigger the corrective retry. */
const ZERO_AMOUNT_JSON = JSON.stringify({
  result: "ok",
  message: "Steak and sweet potato wedges, though the portion is hard to tell.",
  mealName: "Steak with sweet potato wedges",
  description: "Sliced steak with sweet potato wedges.",
  meal: "dinner",
  items: [
    {
      name: "sliced steak",
      amount: 0,
      unit: "oz",
      nutrition: { calories: 490, protein: 49, carbs: 0, fat: 31 },
    },
  ],
});

const modelState = vi.hoisted(() => ({
  /** Vision answers consumed in order; the last one repeats when exhausted. */
  scanQueue: [] as string[],
  chunks: ["Hello ", "Emma."],
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
import { MEAL_CARD_CLOSER } from "../coach/meal-chat";

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
const CORRECTION_TEXT = "No, that's steak and sweet potato wedges";

/** The exchange as the client replays it: photo turn, misread reply, typed fix. */
function correctionBody(latestContent: string) {
  return {
    messages: [
      { role: "user", content: MEAL_TEXT },
      { role: "assistant", content: `Logged brisket with burnt ends.\n\n${MEAL_CARD_CLOSER}` },
      { role: "user", content: latestContent, image: VALID_IMAGE, photoKind: "meal" },
    ],
  };
}

describe("POST /api/coach/chat with a typed meal correction", () => {
  it("re-reads the held photo with the patient's words as ground truth", async () => {
    modelState.scanQueue = [CORRECTED_OK_JSON];
    const res = await postChat(correctionBody(CORRECTION_TEXT));
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());

    const reply = (events.find((e) => typeof e.content === "string")?.content ?? "") as string;
    expect(reply).toContain("Got the fix, steak and sweet potato wedges it is.");
    expect(reply).toContain("Sliced steak: about 7 oz · est. 490 cal");
    expect(reply).toContain("Sweet potato wedges: about 1 cup · est. 180 cal");
    expect(reply).toContain(MEAL_CARD_CLOSER);
    // The corrected read never ends with a question mark either.
    expect(reply.trimEnd().endsWith("?")).toBe(false);

    const card = events.find((e) => e.card !== undefined)?.card as {
      kind: string;
      payload: { mode: string; name: string };
    };
    expect(card.kind).toBe("recipe");
    expect(card.payload.mode).toBe("meal");
    expect(card.payload.name).toBe("Steak with Sweet Potato Wedges");
    expect(events.at(-1)).toEqual({ done: true });

    // The explicit photoKind means NO triage — exactly one vision call, and
    // its prompt honors the patient's words while keeping the photo in
    // charge of portions and the base visible-only rules intact.
    const vision = modelState.calls.filter((c) => c.hasImage);
    expect(vision).toHaveLength(1);
    expect(vision[0].system).toContain("Treat their naming as ground truth");
    expect(vision[0].system).toContain("Portions and nutrition still come from the photo");
    expect(vision[0].system).toContain("Never add ingredients you cannot see");
    expect(vision[0].userText).toContain(CORRECTION_TEXT);
    expect(vision[0].userText).toContain("the foods were identified wrong");
  });

  it("never treats the fixed photo replay text as a correction — retakes stay fresh reads", async () => {
    modelState.scanQueue = [CORRECTED_OK_JSON];
    const res = await postChat(correctionBody(MEAL_TEXT));
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());
    expect(events.at(-1)).toEqual({ done: true });

    const vision = modelState.calls.filter((c) => c.hasImage);
    expect(vision).toHaveLength(1);
    expect(vision[0].system).not.toContain("ground truth");
    expect(vision[0].userText).toContain("Here is the photo of my meal.");
    expect(vision[0].userText).not.toContain("identified wrong");
  });

  it("keeps the patient's words through the corrective retry", async () => {
    modelState.scanQueue = [ZERO_AMOUNT_JSON, CORRECTED_OK_JSON];
    const res = await postChat(correctionBody(CORRECTION_TEXT));
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());

    // The committed second answer reached the patient.
    const reply = (events.find((e) => typeof e.content === "string")?.content ?? "") as string;
    expect(reply).toContain("Sliced steak: about 7 oz · est. 490 cal");
    expect(events.at(-1)).toEqual({ done: true });

    const vision = modelState.calls.filter((c) => c.hasImage);
    expect(vision).toHaveLength(2);
    // The corrective turn names the violation AND still carries the
    // patient's naming, so the fixed answer stays the corrected meal.
    expect(vision[1].userText).toContain("That answer was invalid");
    expect(vision[1].userText).toContain(CORRECTION_TEXT);
    expect(vision[1].system).toContain("Treat their naming as ground truth");
  });

  it("keeps an unrelated message after a meal-card exchange on the plain chat", async () => {
    // The client only re-attaches the photo when the text reads as a
    // correction, so an ordinary follow-up arrives with no image at all.
    const res = await postChat({
      messages: [
        { role: "user", content: MEAL_TEXT },
        { role: "assistant", content: `Logged your plate.\n\n${MEAL_CARD_CLOSER}` },
        { role: "user", content: "Is grapefruit approved?" },
      ],
    });
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());
    expect(events).toContainEqual({ content: "Hello" });
    expect(events.at(-1)).toEqual({ done: true });
    // No vision call — the streaming chat answered normally.
    expect(modelState.calls.every((c) => !c.hasImage)).toBe(true);
    expect(modelState.calls.at(-1)?.stream).toBe(true);
  });
});
