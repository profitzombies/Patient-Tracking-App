/**
 * Route tests for the coach chat's menu-photo turns.
 *
 * The OpenAI client is mocked (no credits spent) with a shape-aware fake:
 * calls carrying an image_url part answer with the scripted scan JSON,
 * non-streaming text calls answer with the scripted recipe JSON, and
 * streaming calls yield the scripted chunks. Covers: photo validation (400 /
 * 413 before the stream opens), the conversational menu reply with the
 * curated yes/no chips, not-a-menu as a warm outcome (never an error event),
 * genuine model failure as the standard SSE error, the yes-follow-up recipe
 * turn, and that an image is honored ONLY on the latest message.
 *
 * Budgets: this file makes 8 chat requests (burst 10) of which 3 reach the
 * vision model (menu-scan burst 6) — no rate-limit interference. Kindless
 * images additionally make a photo-triage model call plus the speculative
 * meal read it launches in parallel (cancelled when triage says "menu");
 * both ride the same request slot, not new ones.
 */
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const SCAN_OK_JSON = JSON.stringify({
  result: "ok",
  message: "The grill section is your friend here.",
  menuTitle: "Harbor Grill",
  order: [
    {
      name: "Grilled Salmon",
      howToOrder: "Ask for it grilled plain, sauce on the side.",
      note: "Stick to the 4 oz portion.",
    },
    {
      name: "Chicken Paillard",
      howToOrder: "No oil on the greens, lemon instead of dressing.",
      note: null,
    },
  ],
  avoid: [{ name: "Fettuccine Alfredo", reason: "Cream sauce cannot be fixed by asking." }],
});

const RECIPE_JSON = JSON.stringify({
  reply: "Here is a home version of that grilled salmon.\n\nWant anything else?",
  recipe: {
    name: "Home Grilled Salmon",
    description: "Plain grilled salmon with lemon and steamed green beans.",
    meal: "dinner",
    minutes: 25,
    servings: 1,
    calories: 320,
    protein: 34,
    carbs: 8,
    fat: 16,
    ingredients: [
      { amount: 4, unit: "oz", name: "salmon fillet", nutrition: { calories: 320, protein: 34, carbs: 8, fat: 16 } },
    ],
    steps: ["Grill the salmon plain.", "Steam the green beans."],
  },
});

const DEFAULT_CHUNKS = ["Hello ", "Emma."];

const modelState = vi.hoisted(() => ({
  scanJson: "",
  recipeJson: "",
  /** Answer for the photo-triage call a kindless image now makes first. */
  triageJson: '{"subject":"menu"}',
  chunks: ["Hello ", "Emma."],
  failNext: 0,
  calls: [] as Array<{ hasImage: boolean; stream: boolean; system: string }>,
}));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: {
      completions: {
        create: vi.fn(
          async (params: { stream?: boolean; messages: Array<{ role: string; content: unknown }> }) => {
            const hasImage = params.messages.some(
              (m) =>
                Array.isArray(m.content) &&
                m.content.some(
                  (part) => (part as { type?: string } | null)?.type === "image_url",
                ),
            );
            const system =
              typeof params.messages[0]?.content === "string"
                ? (params.messages[0].content as string)
                : "";
            modelState.calls.push({ hasImage, stream: params.stream === true, system });
            if (modelState.failNext > 0) {
              modelState.failNext -= 1;
              throw new Error("upstream boom");
            }
            // A kindless image's first vision call is the triage router.
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
            const content = hasImage ? modelState.scanJson : modelState.recipeJson;
            return { choices: [{ message: { content } }] };
          },
        ),
      },
    },
  },
}));

import app from "../app";
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
  modelState.scanJson = SCAN_OK_JSON;
  modelState.recipeJson = RECIPE_JSON;
  modelState.triageJson = '{"subject":"menu"}';
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
const PHOTO_TEXT = "I sent a photo of a restaurant menu.";

function photoBody(image: string, photoKind?: "menu" | "meal") {
  return {
    messages: [{ role: "user", content: PHOTO_TEXT, image, ...(photoKind ? { photoKind } : {}) }],
  };
}

describe("POST /api/coach/chat with a menu photo", () => {
  it("rejects a non-image data URI with 400 before opening the stream", async () => {
    const res = await postChat(photoBody("data:text/plain;base64,aGVsbG8="));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("could not be used");
  });

  it("rejects an oversized photo with 413 and friendly wording", async () => {
    const res = await postChat(photoBody(`data:image/jpeg;base64,${"A".repeat(7_000_000)}`));
    expect(res.status).toBe(413);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("too large");
  });

  it("answers a menu photo with picks, skips, and the yes/no recipe offer", async () => {
    modelState.scanJson = SCAN_OK_JSON;
    const res = await postChat(photoBody(VALID_IMAGE));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("The grill section is your friend here.");
    expect(text).toContain("1. Grilled Salmon: Ask for it grilled plain, sauce on the side.");
    expect(text).toContain("Skip Fettuccine Alfredo: Cream sauce cannot be fixed by asking.");
    expect(text).toContain(MENU_RECIPE_OFFER);
    expect(text).toContain('"quickReplies":["Yes, please","No thanks"]');
    expect(text).not.toContain('"card"');
    expect(text.trimEnd().endsWith('data: {"done":true}')).toBe(true);
    // The kindless photo was triaged first, then reached the scan model,
    // and the resolved route was announced so a client retry can name it
    // explicitly. Stage narration brackets the work: received the moment
    // the stream opens, the menu line only after the route settles.
    expect(text).toContain('data: {"photoKind":"menu"}');
    expect(text).toContain('data: {"stage":"received"}');
    expect(text.indexOf('data: {"stage":"received"}')).toBeLessThan(
      text.indexOf('data: {"photoKind":"menu"}'),
    );
    expect(text.indexOf('data: {"photoKind":"menu"}')).toBeLessThan(
      text.indexOf('data: {"stage":"reading_menu"}'),
    );
    expect(modelState.calls[0]?.system).toContain("photo triage");
    // THREE vision calls: triage, the speculative meal read launched
    // alongside it (cancelled unawaited on the "menu" verdict), and the
    // menu scan that actually answered.
    expect(modelState.calls.filter((c) => c.hasImage && !c.stream)).toHaveLength(3);
  });

  it("treats not-a-menu as a warm conversational outcome, not an error", async () => {
    modelState.scanJson = JSON.stringify({
      result: "not_menu",
      message: "That looks like a photo of a storefront, not a menu.",
      order: [],
      avoid: [],
    });
    const res = await postChat(photoBody(VALID_IMAGE));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("That looks like a photo of a storefront");
    expect(text).toContain("snap another photo");
    expect(text).not.toContain('"error"');
    expect(text).not.toContain('"quickReplies"');
    expect(text).toContain('data: {"done":true}');
  });

  it("surfaces a genuine model failure as the standard SSE error event", async () => {
    modelState.failNext = 2; // both vision attempts (initial + transient retry)
    // Explicit kind: the failure must hit the scan itself, not the triage
    // (whose failures deliberately fall back to the meal pipeline).
    const res = await postChat(photoBody(VALID_IMAGE, "menu"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(
      'data: {"error":"The coach is unavailable right now. Please try again."}',
    );
    expect(text).not.toContain('"done":true');
  });

  it("routes a yes after the offer into the menu-inspired recipe turn", async () => {
    modelState.recipeJson = RECIPE_JSON;
    const menuReply = [
      "The grill section is your friend here.",
      "1. Grilled Salmon: Ask for it grilled plain, sauce on the side.",
      MENU_RECIPE_OFFER,
    ].join("\n\n");
    const res = await postChat({
      messages: [
        { role: "user", content: PHOTO_TEXT },
        { role: "assistant", content: menuReply },
        { role: "user", content: "Yes, please" },
      ],
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Here is a home version of that grilled salmon.");
    expect(text).toContain('"card":{"kind":"recipe","payload":{"id":"sugg_');
    expect(text).toContain('"name":"Home Grilled Salmon"');
    expect(text).toContain('data: {"done":true}');
    // One non-streaming text call, seeded with the menu-inspiration task and
    // grounded in the approved-foods compartment.
    const call = modelState.calls.find((c) => !c.stream && !c.hasImage);
    expect(call).toBeDefined();
    expect(call?.system).toContain("said yes to a custom recipe inspired by it");
    expect(call?.system.toLowerCase()).toContain("approved");
  });

  it("keeps a bare yes on the normal pipeline when no offer preceded it", async () => {
    const res = await postChat({
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello! How can I help today?" },
        { role: "user", content: "Yes, please" },
      ],
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('data: {"content":"Hello"}');
    expect(text).not.toContain('"card"');
    expect(modelState.calls.at(-1)?.stream).toBe(true);
  });

  it("honors a photo only on the latest message — history images are ignored", async () => {
    const res = await postChat({
      messages: [
        { role: "user", content: PHOTO_TEXT, image: VALID_IMAGE },
        { role: "assistant", content: "Great picks there." },
        { role: "user", content: "thanks for the help" },
      ],
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('data: {"done":true}');
    // No call ever carried an image part; the turn streamed normally.
    expect(modelState.calls.every((c) => !c.hasImage)).toBe(true);
    expect(modelState.calls.at(-1)?.stream).toBe(true);
  });
});
