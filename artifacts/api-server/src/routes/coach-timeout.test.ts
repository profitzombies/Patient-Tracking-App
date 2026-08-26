/**
 * Deterministic coverage for the coach's upstream reliability guards
 * (coach/upstream.ts): idle deadlines on every model call, SSE comment
 * keepalives during silent stretches, and recipe-image slot release when a
 * generation hangs.
 *
 * The OpenAI client is mocked with calls that hang until their abort signal
 * fires, and the deadline/keepalive knobs are shrunk via their env overrides
 * (read per call, so plain process.env assignment works per test). Wall time
 * stays well under a second per test.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: { completions: { create: vi.fn() } },
    images: { generate: vi.fn() },
  },
}));

import { openai } from "@workspace/integrations-openai-ai-server";
import app from "../app";

const createMock = vi.mocked(openai.chat.completions.create);
const imageMock = vi.mocked(openai.images.generate);

/** The SDK's real types are irrelevant here; the routes pass (body, {signal}). */
type LooseCall = (body: unknown, options?: { signal?: AbortSignal }) => unknown;
const looseCreate = createMock as unknown as { mockImplementation(fn: LooseCall): void };
const looseImage = imageMock as unknown as { mockImplementationOnce(fn: LooseCall): void };

let server: Server;
let baseUrl: string;
let ipCounter = 0;

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

beforeEach(() => {
  createMock.mockReset();
  imageMock.mockReset();
});

afterEach(() => {
  delete process.env.COACH_UPSTREAM_TIMEOUT_MS;
  delete process.env.COACH_KEEPALIVE_MS;
});

/** Distinct client IP per call so per-IP buckets never interfere. */
function nextIp(): string {
  ipCounter += 1;
  return `10.9.${Math.floor(ipCounter / 200)}.${(ipCounter % 200) + 1}`;
}

const ERROR_EVENT = 'data: {"error":"The coach is unavailable right now. Please try again."}';

/** Pends forever, rejecting (like the SDK) only when the signal aborts. */
function hangUntilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    const boom = () => {
      const error = new Error("Request was aborted.");
      error.name = "APIUserAbortError";
      reject(error);
    };
    if (!signal) return; // no signal: hang forever — the deadline must exist
    if (signal.aborted) {
      boom();
      return;
    }
    signal.addEventListener("abort", boom, { once: true });
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function postChat(content: string) {
  return fetch(`${baseUrl}/api/coach/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": nextIp() },
    body: JSON.stringify({ messages: [{ role: "user", content }] }),
  });
}

describe("upstream idle deadlines", () => {
  it("turns a hung recipe upstream into the prompt retryable error without burning the transient retry", async () => {
    process.env.COACH_UPSTREAM_TIMEOUT_MS = "60";
    looseCreate.mockImplementation((_body, options) => hangUntilAborted(options?.signal));

    const res = await postChat("Give me a dinner idea for tonight");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(ERROR_EVENT);
    expect(text).not.toContain('"done":true');
    // Deadline expiry surfaces immediately: no transient retry (which would
    // stack a second full silent wait on top) and no corrective retry.
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("bounds a plain chat turn that never produces a first token", async () => {
    process.env.COACH_UPSTREAM_TIMEOUT_MS = "60";
    looseCreate.mockImplementation((_body, options) => hangUntilAborted(options?.signal));

    const res = await postChat("Is grapefruit approved?");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(ERROR_EVENT);
    expect(text).not.toContain('"done":true');
  });

  it("restarts the idle budget on each streamed chunk and errors only when the stream wedges", async () => {
    process.env.COACH_UPSTREAM_TIMEOUT_MS = "250";
    looseCreate.mockImplementation((_body, options) =>
      Promise.resolve({
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: "Lean " } }] };
          // Well inside one idle budget; only touch() restarting the timer
          // lets the TOTAL turn run past a single budget below.
          await sleep(100);
          yield { choices: [{ delta: { content: "protein 24" } }] };
          await hangUntilAborted(options?.signal); // now wedge for good
        },
      }),
    );

    const startedAt = Date.now();
    const res = await postChat("Is grapefruit approved?");
    const text = await res.text();
    // The dash smoother holds a chunk's trailing space until the next one.
    expect(text).toContain('data: {"content":"Lean"}');
    expect(text).toContain('data: {"content":" protein"}');
    // The held tail (" 24" — digits could open a dash bridge) is drained to
    // the wire before the error event, never silently dropped.
    expect(text).toContain('data: {"content":" 24"}');
    expect(text).toContain(ERROR_EVENT);
    expect(text).not.toContain('"done":true');
    // Total wall time exceeded one idle budget: the budget restarted on data.
    expect(Date.now() - startedAt).toBeGreaterThan(250);
  });
});

describe("SSE keepalives", () => {
  it("emits comment keepalives while the model is silent, invisible to data parsing", async () => {
    process.env.COACH_KEEPALIVE_MS = "25";
    looseCreate.mockImplementation(() =>
      Promise.resolve({
        async *[Symbol.asyncIterator]() {
          await sleep(120); // silent stretch: several keepalive ticks
          yield { choices: [{ delta: { content: "Hi." } }] };
        },
      }),
    );

    const res = await postChat("Is grapefruit approved?");
    const text = await res.text();
    expect(text).toContain(": keepalive\n\n");
    expect(text).toContain('data: {"content":"Hi."}');
    expect(text.trimEnd().endsWith('data: {"done":true}')).toBe(true);
    // Comments never masquerade as data events.
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) expect(() => JSON.parse(line.slice(6))).not.toThrow();
    }
  });
});

describe("POST /api/coach/recipe-image under the deadline", () => {
  function postImage() {
    return fetch(`${baseUrl}/api/coach/recipe-image`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": nextIp() },
      body: JSON.stringify({ name: "Salmon Bowl", description: "Flaky salmon." }),
    });
  }

  it("times out a hung generation with 502 and frees the slot for the next request", async () => {
    process.env.COACH_UPSTREAM_TIMEOUT_MS = "60";
    looseImage.mockImplementationOnce((_body, options) => hangUntilAborted(options?.signal));
    imageMock.mockResolvedValueOnce({ data: [{ b64_json: "aGk=" }] } as never);

    const hung = await postImage();
    expect(hung.status).toBe(502);
    const hungJson = (await hung.json()) as { error: string };
    expect(hungJson.error).toContain("Photo generation failed");

    // The hung call's slot was released on timeout: with only two concurrent
    // slots, a leak here is exactly how the image pipeline used to jam.
    const next = await postImage();
    expect(next.status).toBe(200);
    const nextJson = (await next.json()) as { image: string };
    expect(nextJson.image.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(imageMock).toHaveBeenCalledTimes(2);
  });
});
