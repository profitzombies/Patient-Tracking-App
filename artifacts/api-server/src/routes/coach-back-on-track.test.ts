/**
 * Route tests for the back-on-track follow-up inside POST /api/coach/chat —
 * the grounded reset plan after the patient says yes to the coach's
 * proactive stall outreach.
 *
 * The outreach bubble is seeded CLIENT-side (the mobile app's stall-nudge
 * trigger), so the server sees it only as replayed history. The contract
 * under test:
 *
 *   1. A one-tap affirmative directly under the outreach offer routes into
 *      the back-on-track turn: one non-streaming grounded model call whose
 *      system prompt carries the seeded trend numbers, the approved-foods
 *      catalog, and the no-question ending rule; the reply streams out
 *      dash-stripped with NO card and NO chips.
 *   2. An empty model answer degrades to the canned unavailable line.
 *   3. A decline or a richer answer falls through to plain streaming chat.
 *   4. The offer buried deeper in history (not adjacent) never triggers.
 *
 * The OpenAI client is mocked — no credits spent. Budget: 4 chat requests,
 * no images (per-IP burst 10) — no rate-limit interference.
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
  BACK_ON_TRACK_OFFER,
  BACK_ON_TRACK_UNAVAILABLE,
} from "../coach/back-on-track";
import { DEMO_STALL_TREND } from "../coach/demo-patient";

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

/**
 * The coach-initiated outreach as the mobile app seeds it: the patient's own
 * trend, invitation framing, and the offer as the closing line. Only the
 * offer text matters to the detector; the rest is representative.
 */
const OUTREACH_REPLY = [
  "Emma, checking in because I watch these numbers with you.",
  "Your weigh-ins have been holding near 169.5 for about three weeks, and the diary has a stretch of off-list items in it. That combination is worth a small course correction, not a worry.",
  BACK_ON_TRACK_OFFER,
].join("\n\n");

const YES_LABEL = "Yes, set me up";

/** Raw plan with an em dash — the pipeline must strip it on the way out. */
const PLAN_RAW = [
  "Here is the reset, kept simple.",
  "Day one — grilled chicken breast with roasted broccoli for lunch, baked cod with green beans for dinner, plain nonfat Greek yogurt to start the morning.",
  "Log each meal in the app as you eat it for these three days, that is the whole ask.",
  "And if you want eyes on the bigger picture, your provider can set up a check-in whenever you like.",
].join("\n\n");

describe("back-on-track follow-up detection", () => {
  it("answers a one-tap yes under the outreach with the grounded reset plan", async () => {
    modelState.scanQueue = [PLAN_RAW];
    const res = await postChat({
      messages: [
        { role: "assistant", content: OUTREACH_REPLY },
        { role: "user", content: YES_LABEL },
      ],
    });
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());

    const reply = (events.find((e) => typeof e.content === "string")?.content ?? "") as string;
    expect(reply).toContain("Here is the reset");
    expect(reply).toContain("Day one");
    // The no-dash voice rule holds on this model-written turn too.
    expect(reply).not.toMatch(/[—–]/);
    // Plain text end to end: no card, no chips (the reply deliberately ends
    // on a statement so the client's fallback chips stay away).
    expect(events.some((e) => e.card !== undefined)).toBe(false);
    expect(events.some((e) => e.quickReplies !== undefined)).toBe(false);
    expect(events.at(-1)).toEqual({ done: true });

    // One text-only non-streaming model call, grounded server-side.
    expect(modelState.calls).toHaveLength(1);
    expect(modelState.calls[0].hasImage).toBe(false);
    expect(modelState.calls[0].stream).toBe(false);
    const system = modelState.calls[0].system;
    // The seeded trend numbers are supplied by the SERVER (the client is
    // never trusted for them) and match the shared demo-patient constants.
    expect(system).toContain(`started at ${DEMO_STALL_TREND.startWeightLb} pounds`);
    expect(system).toContain(`holding near ${DEMO_STALL_TREND.currentWeightLb} pounds`);
    expect(system).toContain(`${DEMO_STALL_TREND.stalledWeeks} weeks`);
    expect(system).toContain(`goal on file is ${DEMO_STALL_TREND.goalWeightLb} pounds`);
    // Grounding: the catalog itself, the invent-nothing rule, and the
    // statement ending (chips must never ride this turn).
    expect(system).toContain("APPROVED FOODS CATALOG (id — official name):");
    expect(system).toContain("Never invent a rule, a food, or an amount");
    expect(system).toContain("Do NOT end with a question");
    // The outreach exchange rides as replayed history.
    expect(modelState.calls[0].userStrings.at(-1)).toBe(YES_LABEL);
  });

  it("degrades to the canned unavailable line when the model gives nothing", async () => {
    modelState.scanQueue = [""];
    const res = await postChat({
      messages: [
        { role: "assistant", content: OUTREACH_REPLY },
        { role: "user", content: "yes" },
      ],
    });
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());
    expect(events).toContainEqual({ content: BACK_ON_TRACK_UNAVAILABLE });
    expect(events.some((e) => e.quickReplies !== undefined)).toBe(false);
    expect(events.at(-1)).toEqual({ done: true });
  });

  it("lets a decline fall through to the plain chat — no reset machinery", async () => {
    const res = await postChat({
      messages: [
        { role: "assistant", content: OUTREACH_REPLY },
        { role: "user", content: "Not right now" },
      ],
    });
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());
    // The dash smoother holds back the chunk tail, so the first visible
    // piece is "Hello" — same shape the other route suites assert.
    expect(events).toContainEqual({ content: "Hello" });
    expect(events.at(-1)).toEqual({ done: true });
    // The plain streaming pipeline answered.
    expect(modelState.calls).toHaveLength(1);
    expect(modelState.calls[0].stream).toBe(true);
  });

  it("never triggers when the offer is not directly above the yes", async () => {
    const res = await postChat({
      messages: [
        { role: "assistant", content: OUTREACH_REPLY },
        { role: "user", content: "Not right now" },
        { role: "assistant", content: "That's fine, the plan keeps whenever you want it." },
        { role: "user", content: "yes" },
      ],
    });
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());
    // Adjacency is strict: the decline exchange sits between the offer and
    // this yes, so it reads as plain conversation, not a plan acceptance.
    expect(events).toContainEqual({ content: "Hello" });
    expect(events.at(-1)).toEqual({ done: true });
    expect(modelState.calls).toHaveLength(1);
    expect(modelState.calls[0].stream).toBe(true);
  });
});
