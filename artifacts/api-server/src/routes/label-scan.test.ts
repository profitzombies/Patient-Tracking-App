/**
 * Route tests for POST /api/coach/label-scan — the non-chat Nutrition Facts
 * reader behind the create-food screen's "Scan a label".
 *
 * The OpenAI client is mocked (no credits spent) with the same scripted
 * scan-queue fake as the chat label tests. Covers: the ok payload carrying
 * the validated per-serving read (with null container counts omitted, not
 * null), the calories-vs-macros double-check flag, unreadable photos
 * answering with the model's warm nudge plus the SAME canned retake ask the
 * chat uses (and no label — nothing guessed), persistent invalid model
 * output as a 502 with a user-facing message, and the photo guards (400
 * non-image body, 413 oversized photo — the latter also proves app.ts
 * routes this path around the global 100kb parser).
 *
 * Budget: exactly 6 requests — the shared photo-scan limiter's burst — so
 * no rate-limit interference (every request consumes a token, even 400s).
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

const modelState = vi.hoisted(() => ({
  /** Vision answers consumed in order; the last one repeats when exhausted. */
  scanQueue: [] as string[],
  calls: [] as Array<{ hasImage: boolean; system: string; userText: string }>,
}));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: {
      completions: {
        create: vi.fn(
          async (params: { messages: Array<{ role: string; content: unknown }> }) => {
            const userParts = params.messages
              .filter((m) => m.role === "user" && Array.isArray(m.content))
              .flatMap((m) => m.content as Array<{ type?: string; text?: string }>);
            modelState.calls.push({
              hasImage: userParts.some((part) => part?.type === "image_url"),
              system:
                typeof params.messages[0]?.content === "string"
                  ? (params.messages[0].content as string)
                  : "",
              userText: userParts.find((part) => part?.type === "text")?.text ?? "",
            });
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
import { LABEL_TRY_ANOTHER_PHOTO } from "../coach/label-chat";
import { PHOTO_TOO_LARGE_MESSAGE, INVALID_PHOTO_MESSAGE } from "../lib/photo-guards";

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
  modelState.calls = [];
});

const VALID_IMAGE = "data:image/jpeg;base64,dGVzdA==";

function postScan(body: unknown) {
  return fetch(`${baseUrl}/api/coach/label-scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/coach/label-scan", () => {
  it("returns the validated per-serving read as one JSON payload", async () => {
    modelState.scanQueue = [LABEL_OK_JSON];
    const res = await postScan({ image: VALID_IMAGE });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: string;
      message: string;
      label: Record<string, unknown>;
    };

    expect(body.result).toBe("ok");
    // The model's coach-voice reaction, dash-cleaned — and no chat closers:
    // the form asks for the name with its own field, not a conversation.
    expect(body.message).toBe("Nice, a label I can actually read, sharp shot.");
    expect(body.message).not.toContain(LABEL_TRY_ANOTHER_PHOTO);

    expect(body.label).toBeDefined();
    expect(String(body.label.id).startsWith("label_")).toBe(true);
    expect(body.label.servingSize).toBe("2/3 cup (55g)");
    expect(body.label.servingsPerContainer).toBe(8);
    expect(body.label.calories).toBe(230);
    expect(body.label.protein).toBe(8);
    expect(body.label.carbs).toBe(37);
    expect(body.label.fat).toBe(8);
    expect(body.label.fiber).toBe(4);
    expect(body.label.sugar).toBe(12);
    expect(body.label.sodium).toBe(160);
    // No clock context on this surface: a packaged food files under snacks.
    expect(body.label.suggestedSlot).toBe("snacks");
    expect(body.label.flagged).toBeUndefined();

    // Exactly one vision call, same transcription contract as the chat turn.
    expect(modelState.calls).toHaveLength(1);
    expect(modelState.calls[0].hasImage).toBe(true);
    expect(modelState.calls[0].system).toContain("label reader");
    expect(modelState.calls[0].system).toContain("Never estimate");
  });

  it("flags calories that fight the macro math and omits unprinted values", async () => {
    modelState.scanQueue = [LABEL_MISPRINT_JSON];
    const res = await postScan({ image: VALID_IMAGE });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: string; label: Record<string, unknown> };

    expect(body.result).toBe("ok");
    expect(body.label.flagged).toBe(true);
    expect(body.label.calories).toBe(400);
    // REST payloads omit what the panel does not print — no explicit nulls.
    expect("servingsPerContainer" in body.label).toBe(false);
    expect("fiber" in body.label).toBe(false);
    expect("sugar" in body.label).toBe(false);
    expect("sodium" in body.label).toBe(false);
  });

  it("answers unreadable labels with the same warm re-ask as chat and no label", async () => {
    modelState.scanQueue = [LABEL_UNREADABLE_JSON];
    const res = await postScan({ image: VALID_IMAGE });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.result).toBe("unreadable");
    expect(String(body.message)).toContain("too blurry");
    // The canned retake nudge the chat's label turn appends — one voice.
    expect(String(body.message)).toContain(LABEL_TRY_ANOTHER_PHOTO);
    expect("label" in body).toBe(false);
  });

  it("surfaces persistently invalid model output as a 502, never guessed numbers", async () => {
    modelState.scanQueue = ["this is not json", "still not json"];
    const res = await postScan({ image: VALID_IMAGE });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("The label scan is unavailable right now. Please try again.");
    // Initial attempt + ONE corrective retry, then an honest failure.
    expect(modelState.calls).toHaveLength(2);
  });

  it("rejects a body whose image is not a supported data URI", async () => {
    const res = await postScan({ image: "https://example.com/label.jpg" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(INVALID_PHOTO_MESSAGE);
    expect(modelState.calls).toHaveLength(0);
  });

  it("rejects an oversized photo with 413 (and thus rides the large-body parser)", async () => {
    // >5MB decoded but <8mb body: only reachable if app.ts routed this path
    // around the global 100kb parser and the route's own guard fired.
    const oversized = `data:image/jpeg;base64,${"A".repeat(7_000_000)}`;
    const res = await postScan({ image: oversized });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(PHOTO_TOO_LARGE_MESSAGE);
    expect(modelState.calls).toHaveLength(0);
  });
});
