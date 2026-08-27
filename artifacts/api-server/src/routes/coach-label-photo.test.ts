/**
 * Route tests for the coach chat's nutrition-label turns (photoKind:
 * "label").
 *
 * The OpenAI client is mocked (no credits spent) with the same shape-aware
 * fake as the meal-photo tests: vision calls answer from a scripted scan
 * queue (so corrective retries can see a different second answer), the
 * kindless triage call answers from triageJson. Covers: the facts read-back
 * reply with the canned name ask (never a "?" ending, so the fallback chips
 * stay hidden), the validated `labelDraft` SSE event the client holds
 * through the name conversation, deterministic slot resolution (explicit
 * pin over clock over snacks), the calories-vs-macros double-check flag,
 * unreadable photos as warm re-asks with no draft (never guessed numbers),
 * the corrective retry, persistent invalid output as the standard SSE
 * error, and kindless triage routing a Nutrition Facts panel here with the
 * route announced on the wire.
 *
 * Budgets: this file makes 6 chat requests (burst 10), all carrying an
 * image (menu-scan/vision burst 6) — no rate-limit interference. The triage
 * answer and the speculative meal read a kindless photo launches alongside
 * it (cancelled here when triage says "label") are model calls inside the
 * same request, not extra request slots.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

/** Muesli box: printed calories 230 vs 4/4/9 math 252 — consistent, no flag. */
const LABEL_OK_JSON = JSON.stringify({
  result: "ok",
  message: "Nice, a label I can actually read — sharp shot.",
  label: {
    servingSize: "2/3 cup (55g)",
    servingsPerContainer: 8,
    calories: 230,
    protein: 8,
    carbs: 37,
    fat: 8,
    fiber: 4,
    sugar: 12,
    sodium: 160,
  },
});

/** Printed calories 400 vs 4/4/9 math ~42 — wildly off, must be flagged. */
const LABEL_MISPRINT_JSON = JSON.stringify({
  result: "ok",
  message: "Got the panel, this one reads like a light snack.",
  label: {
    servingSize: "1 pouch (20g)",
    servingsPerContainer: null,
    calories: 400,
    protein: 2,
    carbs: 5,
    fat: 1.5,
    fiber: null,
    sugar: null,
    sodium: null,
  },
});

const LABEL_UNREADABLE_JSON = JSON.stringify({
  result: "unreadable",
  message:
    "It does look like a nutrition label, but the macro rows are too blurry for me to read with confidence.",
  label: null,
});

/** Claims "ok" while omitting the values — must trigger the corrective retry. */
const LABEL_OK_BUT_EMPTY_JSON = JSON.stringify({
  result: "ok",
  message: "Read it, all set.",
  label: null,
});

const modelState = vi.hoisted(() => ({
  /** Vision answers consumed in order; the last one repeats when exhausted. */
  scanQueue: [] as string[],
  /** Answer for the photo-triage call a kindless image makes first. */
  triageJson: '{"subject":"label"}',
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
            if (hasImage && system.includes("photo triage")) {
              return { choices: [{ message: { content: modelState.triageJson } }] };
            }
            if (params.stream === true) {
              return {
                async *[Symbol.asyncIterator]() {
                  yield { choices: [{ delta: { content: "Hello." } }] };
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
  LABEL_CHECK_NOTE,
  LABEL_NAME_ASK,
  LABEL_TRY_ANOTHER_PHOTO,
} from "../coach/label-chat";

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
  modelState.triageJson = '{"subject":"label"}';
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
const LABEL_TEXT = "I sent a photo of a nutrition label.";

function labelBody(extra?: { localTime?: string; mealSlot?: string }) {
  return {
    messages: [{ role: "user", content: LABEL_TEXT, image: VALID_IMAGE, photoKind: "label" }],
    ...extra,
  };
}

/** Parses every SSE data event in the raw stream body. */
function sseEvents(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

interface DraftEvent {
  id: string;
  servingSize: string;
  servingsPerContainer: number | null;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber?: number;
  sugar?: number;
  sodium?: number;
  suggestedSlot: string;
  flagged?: boolean;
}

function draftOf(events: Array<Record<string, unknown>>): DraftEvent | undefined {
  return events.find((e) => e.labelDraft !== undefined)?.labelDraft as DraftEvent | undefined;
}

describe("POST /api/coach/chat with a nutrition label photo", () => {
  it("reads the facts back, asks for the product name, and emits the label draft", async () => {
    modelState.scanQueue = [LABEL_OK_JSON];
    // 14:05 on the patient's clock — the draft's slot must file under lunch.
    const res = await postChat(labelBody({ localTime: "14:05" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = sseEvents(await res.text());

    // Staged progress: the photo is acknowledged the instant the stream
    // opens; the explicit photoKind names its pipeline before any model
    // work, so the app can narrate the wait.
    expect(events[0]).toEqual({ stage: "received" });
    expect(events[1]).toEqual({ stage: "reading_label" });

    const reply = (events.find((e) => typeof e.content === "string")?.content ?? "") as string;
    // The fixture's coach message carries an em dash; the pipeline's
    // no-dash cleaning must rewrite it before it reaches the patient.
    expect(reply).toContain("Nice, a label I can actually read, sharp shot.");
    expect(reply).not.toContain("—");
    // The read-back mirrors exactly what the eventual card will show.
    expect(reply).toContain("Per serving (2/3 cup (55g)): 230 cal · 8g protein · 37g carbs · 8g fat");
    expect(reply).toContain("Servings per container: 8");
    expect(reply).toContain("Also printed: 4g fiber · 12g sugar · 160mg sodium");
    expect(reply).toContain(LABEL_NAME_ASK);
    expect(reply).not.toContain(LABEL_CHECK_NOTE);
    // Never ends with a question — the client's fallback yes/no chips fit
    // nothing here; the name ask closes as an instruction.
    expect(reply.trimEnd().endsWith("?")).toBe(false);

    // The validated read rides its own event (no card yet — the client
    // builds the food card after the name conversation).
    const draft = draftOf(events);
    expect(draft).toBeDefined();
    expect(draft!.id.startsWith("label_")).toBe(true);
    expect(draft!.servingSize).toBe("2/3 cup (55g)");
    expect(draft!.servingsPerContainer).toBe(8);
    expect(draft!.calories).toBe(230);
    expect(draft!.protein).toBe(8);
    expect(draft!.carbs).toBe(37);
    expect(draft!.fat).toBe(8);
    expect(draft!.fiber).toBe(4);
    expect(draft!.sugar).toBe(12);
    expect(draft!.sodium).toBe(160);
    expect(draft!.suggestedSlot).toBe("lunch");
    expect(draft!.flagged).toBeUndefined();

    expect(events.some((e) => e.card !== undefined)).toBe(false);
    expect(events.some((e) => e.quickReplies !== undefined)).toBe(false);
    expect(events.at(-1)).toEqual({ done: true });

    // Exactly one vision call, and the prompt is a transcription contract:
    // printed values only, null over guessing, unreadable over estimating.
    const visionCalls = modelState.calls.filter((c) => c.hasImage);
    expect(visionCalls).toHaveLength(1);
    expect(visionCalls[0].stream).toBe(false);
    expect(visionCalls[0].system).toContain("label reader");
    expect(visionCalls[0].system).toContain("Never estimate");
    expect(visionCalls[0].system).toContain("Choose \"unreadable\" over guessing");
    expect(visionCalls[0].system).toContain("Transcribe the printed PER SERVING values exactly");
  });

  it("flags printed calories that fight the macro math and honors an explicit slot pin", async () => {
    modelState.scanQueue = [LABEL_MISPRINT_JSON];
    const res = await postChat(labelBody({ localTime: "14:05", mealSlot: "breakfast" }));
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());

    const reply = (events.find((e) => typeof e.content === "string")?.content ?? "") as string;
    // 400 printed calories vs ~42 from 4/4/9 — the patient is asked to
    // double-check the package, but the read still goes through.
    expect(reply).toContain(LABEL_CHECK_NOTE);
    expect(reply).toContain(LABEL_NAME_ASK);

    const draft = draftOf(events);
    expect(draft).toBeDefined();
    expect(draft!.flagged).toBe(true);
    expect(draft!.calories).toBe(400);
    // No printed container count stays an explicit null (not omitted), and
    // the optional extras are omitted when illegible.
    expect(draft!.servingsPerContainer).toBeNull();
    expect(draft!.fiber).toBeUndefined();
    expect(draft!.sugar).toBeUndefined();
    expect(draft!.sodium).toBeUndefined();
    // An explicit client pin beats the clock deterministically.
    expect(draft!.suggestedSlot).toBe("breakfast");
    expect(events.at(-1)).toEqual({ done: true });
  });

  it("asks warmly for another shot when the label is unreadable — no draft, no guessed numbers", async () => {
    modelState.scanQueue = [LABEL_UNREADABLE_JSON];
    const res = await postChat(labelBody());
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());

    const reply = (events.find((e) => typeof e.content === "string")?.content ?? "") as string;
    expect(reply).toContain("too blurry");
    expect(reply).toContain(LABEL_TRY_ANOTHER_PHOTO);
    expect(reply).not.toContain(LABEL_NAME_ASK);
    expect(reply.trimEnd().endsWith("?")).toBe(false);

    expect(draftOf(events)).toBeUndefined();
    expect(events.some((e) => e.error !== undefined)).toBe(false);
    expect(events.some((e) => e.quickReplies !== undefined)).toBe(false);
    expect(events.at(-1)).toEqual({ done: true });
  });

  it("retries correctively when the model claims ok without the values", async () => {
    modelState.scanQueue = [LABEL_OK_BUT_EMPTY_JSON, LABEL_OK_JSON];
    const res = await postChat(labelBody());
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());

    // The empty "ok" never reached the patient — the corrected read did.
    const draft = draftOf(events);
    expect(draft).toBeDefined();
    expect(draft!.calories).toBe(230);
    // No localTime on this request: a packaged food defaults to snacks.
    expect(draft!.suggestedSlot).toBe("snacks");
    expect(events.at(-1)).toEqual({ done: true });

    const visionCalls = modelState.calls.filter((c) => c.hasImage);
    expect(visionCalls).toHaveLength(2);
    expect(visionCalls[1].userText).toContain("That answer was invalid");
    expect(visionCalls[1].userText).toContain('result was "ok" but "label" was null');
  });

  it("surfaces persistently invalid model output as the standard SSE error", async () => {
    modelState.scanQueue = ["this is not json", "still not json"];
    const res = await postChat(labelBody());
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

  it("triages a kindless Nutrition Facts photo onto the label pipeline and announces the route", async () => {
    modelState.triageJson = '{"subject":"label"}';
    modelState.scanQueue = [LABEL_OK_JSON];
    const res = await postChat({
      messages: [{ role: "user", content: "I sent a photo.", image: VALID_IMAGE }],
    });
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());

    // The resolved route is announced so a client retry can name it
    // explicitly instead of triaging the same photo again.
    expect(events).toContainEqual({ photoKind: "label" });
    const reply = (events.find((e) => typeof e.content === "string")?.content ?? "") as string;
    expect(reply).toContain(LABEL_NAME_ASK);
    expect(draftOf(events)).toBeDefined();
    expect(events.at(-1)).toEqual({ done: true });

    // Stage narration: received on open, the label line only after the
    // route announcement settles it.
    expect(events[0]).toEqual({ stage: "received" });
    const kindIdx = events.findIndex((e) => e.photoKind !== undefined);
    const stageIdx = events.findIndex((e) => e.stage === "reading_label");
    expect(stageIdx).toBeGreaterThan(kindIdx);

    // THREE vision calls: the triage, the speculative meal read launched
    // alongside it (cancelled unawaited on the "label" verdict), then the
    // label read that actually answered.
    const vision = modelState.calls.filter((c) => c.hasImage);
    expect(vision).toHaveLength(3);
    expect(vision[0].system).toContain("photo triage");
    expect(vision[1].system).toContain("ALWAYS commit to one specific portion");
    expect(vision[2].system).toContain("label reader");
  });
});

describe("label turn canned strings", () => {
  it.each([
    ["LABEL_NAME_ASK", LABEL_NAME_ASK],
    ["LABEL_TRY_ANOTHER_PHOTO", LABEL_TRY_ANOTHER_PHOTO],
    ["LABEL_CHECK_NOTE", LABEL_CHECK_NOTE],
  ])("%s never ends with a question mark and carries no dash", (_name, text) => {
    // A canned string ending "?" would summon the client's fallback yes/no
    // chips; a dash would break the coach's structural no-dash voice rule.
    expect(text.trimEnd().endsWith("?")).toBe(false);
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });
});
