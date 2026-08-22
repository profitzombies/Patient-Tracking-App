/**
 * Route tests for stopped-reply handling in POST /api/coach/chat.
 *
 * When the client flags an assistant history message with `stopped: true`
 * (the patient aborted it mid-stream), the server must append the
 * interruption note before replaying it to the model — in both the plain
 * streaming path and the structured recipe pipeline — and must leave every
 * other message verbatim. The OpenAI client is mocked (no credits spent).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: { completions: { create: vi.fn() } },
  },
}));

import { openai } from "@workspace/integrations-openai-ai-server";
import { STOPPED_REPLY_NOTE } from "../coach/prompt";
import app from "../app";

const createMock = vi.mocked(openai.chat.completions.create);

/** Streaming-shaped completion for the plain chat path. */
function streamOf(...chunks: string[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const content of chunks) {
        yield { choices: [{ delta: { content } }] };
      }
    },
  } as never;
}

/** Non-streaming JSON completion for the recipe pipeline. */
function completionOf(payload: unknown) {
  return { choices: [{ message: { content: JSON.stringify(payload) } }] } as never;
}

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
});

/** Distinct client IP per call so per-IP rate buckets never interfere. */
function nextIp(): string {
  ipCounter += 1;
  return `10.9.${Math.floor(ipCounter / 200)}.${(ipCounter % 200) + 1}`;
}

async function postChat(messages: unknown[]) {
  return fetch(`${baseUrl}/api/coach/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": nextIp() },
    body: JSON.stringify({ messages }),
  });
}

/** The chat history the mocked model actually received. */
function sentMessages(): { role: string; content: string }[] {
  expect(createMock).toHaveBeenCalledTimes(1);
  const request = createMock.mock.calls[0][0] as {
    messages: { role: string; content: string }[];
  };
  return request.messages.filter((m) => m.role !== "system");
}

const CUT_OFF = "Eggs are a great start. For your phase you could pair two of them with";

describe("stopped replies in POST /api/coach/chat", () => {
  it("appends the interruption note to a stopped assistant reply", async () => {
    createMock.mockResolvedValueOnce(streamOf("Grapefruit is ", "approved."));

    const res = await postChat([
      { role: "user", content: "What should breakfast look like?" },
      { role: "assistant", content: CUT_OFF, stopped: true },
      { role: "user", content: "Is grapefruit approved?" },
    ]);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('data: {"done":true}');
    // The note is model-only context; it must never leak into the SSE stream.
    expect(body).not.toContain("stopped this reply");

    const history = sentMessages();
    expect(history).toHaveLength(3);
    expect(history[1]).toEqual({
      role: "assistant",
      content: `${CUT_OFF}\n\n${STOPPED_REPLY_NOTE}`,
    });
    expect(history[2]).toEqual({ role: "user", content: "Is grapefruit approved?" });
  });

  it("leaves finished replies verbatim and ignores the flag on user messages", async () => {
    createMock.mockResolvedValueOnce(streamOf("Yes, coffee is fine."));

    const finished = "Grapefruit is approved on your plan.\n\nWant a breakfast idea?";
    const res = await postChat([
      { role: "user", content: "Is grapefruit approved?", stopped: true },
      { role: "assistant", content: finished },
      { role: "user", content: "Thanks. Is coffee allowed too?" },
    ]);
    expect(res.status).toBe(200);
    await res.text();

    const history = sentMessages();
    expect(history[0]).toEqual({ role: "user", content: "Is grapefruit approved?" });
    expect(history[1]).toEqual({ role: "assistant", content: finished });
    for (const message of history) {
      expect(message.content).not.toContain(STOPPED_REPLY_NOTE);
    }
  });

  it("annotates stopped replies for recipe-pipeline turns too", async () => {
    createMock.mockResolvedValueOnce(
      completionOf({ reply: "How about a simple salmon dinner?", recipe: null }),
    );

    const res = await postChat([
      { role: "user", content: "What should breakfast look like?" },
      { role: "assistant", content: CUT_OFF, stopped: true },
      { role: "user", content: "Give me a dinner idea for tonight" },
    ]);
    expect(res.status).toBe(200);
    await res.text();

    const history = sentMessages();
    expect(history[1]).toEqual({
      role: "assistant",
      content: `${CUT_OFF}\n\n${STOPPED_REPLY_NOTE}`,
    });
  });
});
