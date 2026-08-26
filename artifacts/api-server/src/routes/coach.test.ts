/**
 * Route tests for POST /api/coach/chat.
 *
 * The OpenAI client is mocked (no credits spent). Covers: invalid bodies,
 * origin allow-listing, a normal SSE turn, product-card enforcement,
 * quick-reply suggestion enforcement, and rate limiting. The rate-limit test
 * runs last because it drains the shared per-IP bucket.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

/** Per-test control over what the mocked model streams back. */
const DEFAULT_CHUNKS = ["Hello ", "Emma."];
const streamState = vi.hoisted(() => ({ chunks: ["Hello ", "Emma."] }));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: {
      completions: {
        create: vi.fn(async () => ({
          async *[Symbol.asyncIterator]() {
            for (const content of streamState.chunks) {
              yield { choices: [{ delta: { content } }] };
            }
          },
        })),
      },
    },
  },
}));

import app from "../app";

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

function postChat(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/api/coach/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const validBody = { messages: [{ role: "user", content: "Is grapefruit approved?" }] };

describe("POST /api/coach/chat", () => {
  it("rejects an invalid body with 400", async () => {
    const res = await postChat({ nonsense: true });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBeTruthy();
  });

  it("rejects a history whose last message is not from the user", async () => {
    const res = await postChat({
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ],
    });
    expect(res.status).toBe(400);
  });

  it("does not grant CORS to unknown origins", async () => {
    const res = await fetch(`${baseUrl}/api/coach/chat`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example.com",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("grants CORS to Replit-hosted app origins", async () => {
    const res = await fetch(`${baseUrl}/api/coach/chat`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://some-app.expo.kirk.replit.dev",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://some-app.expo.kirk.replit.dev",
    );
  });

  it("streams a normal turn as SSE and finishes with done", async () => {
    const res = await postChat(validBody);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain('data: {"content":"Hello"}');
    expect(text).toContain('data: {"content":" Emma."}');
    expect(text.trimEnd().endsWith('data: {"done":true}')).toBe(true);
  });

  describe("product cards", () => {
    afterEach(() => {
      streamState.chunks = [...DEFAULT_CHUNKS];
    });

    const muscleBody = {
      messages: [{ role: "user", content: "I've been lifting and want to build muscle" }],
    };

    it("attaches one card when the model marks an offered product", async () => {
      streamState.chunks = [
        "Creatine+ supports ",
        "muscle maintenance.",
        "\n[[produ",
        "ct:prod7]]",
      ];
      const res = await postChat(muscleBody);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('"card":{"kind":"product","payload":{"id":"prod7"');
      expect(text).not.toContain("[[product");
      expect(text.indexOf('"card"')).toBeLessThan(text.indexOf('"done":true'));
    });

    it("drops the marker and card for an ordinary program question", async () => {
      streamState.chunks = ["Yes, grapefruit is approved.", "\n[[product:prod7]]"];
      const res = await postChat(validBody);
      const text = await res.text();
      expect(text).not.toContain('"card"');
      expect(text).not.toContain("[[product");
      expect(text).toContain('data: {"done":true}');
    });

    it("ignores marker ids that are not in the catalog", async () => {
      streamState.chunks = ["Try this.", "\n[[product:prod999]]"];
      const res = await postChat(muscleBody);
      const text = await res.text();
      expect(text).not.toContain('"card"');
      expect(text).not.toContain("[[product");
    });

    it("keeps at most one card even if the model emits several markers", async () => {
      streamState.chunks = [
        "Regulate can help with those spikes.",
        "\n[[product:prod5]]",
        "\n[[product:prod7]]",
      ];
      const res = await postChat({
        messages: [
          {
            role: "user",
            content: "I want to build muscle and my blood sugar spikes after meals",
          },
        ],
      });
      const text = await res.text();
      expect(text.split('"card"').length - 1).toBe(1);
      expect(text).toContain('"payload":{"id":"prod5"');
      expect(text).not.toContain('"id":"prod7"');
    });
  });

  describe("quick reply suggestions", () => {
    afterEach(() => {
      streamState.chunks = [...DEFAULT_CHUNKS];
    });

    it("emits the curated labels when the model marks a known set", async () => {
      streamState.chunks = [
        "What sounds good for dinner tonight?",
        "\n[[repl",
        "ies:meal_preference]]",
      ];
      const res = await postChat(validBody);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('"quickReplies":["Surprise me","Something light"]');
      expect(text).not.toContain("[[replies");
      expect(text.indexOf('"quickReplies"')).toBeLessThan(text.indexOf('"done":true'));
    });

    it("drops ids that are not in the curated set", async () => {
      streamState.chunks = ["Anything else?", "\n[[replies:free_pizza]]"];
      const res = await postChat(validBody);
      const text = await res.text();
      expect(text).not.toContain('"quickReplies"');
      expect(text).not.toContain("[[replies");
      expect(text).toContain('data: {"done":true}');
    });

    it("keeps the first known set and rides alongside a product card", async () => {
      streamState.chunks = [
        "Creatine+ fits that goal. Which meal should we plan around it?",
        "\n[[product:prod7]]",
        "\n[[replies:meal_of_day]]",
        "\n[[replies:yes_no]]",
      ];
      const res = await postChat({
        messages: [{ role: "user", content: "I've been lifting and want to build muscle" }],
      });
      const text = await res.text();
      expect(text.split('"quickReplies"').length - 1).toBe(1);
      expect(text).toContain('"quickReplies":["Lunch","Dinner"]');
      expect(text).toContain('"card":{"kind":"product","payload":{"id":"prod7"');
      expect(text).not.toContain("[[");
    });
  });

  it("rate limits rapid-fire requests with a retryable 429", async () => {
    const denials: Array<{ error?: string; retryable?: unknown }> = [];
    for (let i = 0; i < 15; i++) {
      const res = await postChat(validBody);
      if (res.status === 429) {
        denials.push((await res.json()) as { error?: string; retryable?: unknown });
      } else if (res.status === 200) {
        await res.text();
      } else {
        await res.json();
      }
    }
    expect(denials.length).toBeGreaterThan(0);
    // Sequential requests never trip the concurrency cap and stay far below
    // the daily budget, so every denial here is the rapid-fire one — which
    // must read as transient (retryable) to the client, unlike daily-budget
    // denials (covered in coach/limits.test.ts as retryable: false).
    for (const denial of denials) {
      expect(denial.error).toContain("too quickly");
      expect(denial.retryable).toBe(true);
    }
  });
});
