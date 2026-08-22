/**
 * Route tests for POST /api/coach/chat.
 *
 * The OpenAI client is mocked (no credits spent). Covers: invalid bodies,
 * origin allow-listing, a normal SSE turn, and rate limiting. The rate-limit
 * test runs last because it drains the shared per-IP bucket.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: {
      completions: {
        create: vi.fn(async () => ({
          async *[Symbol.asyncIterator]() {
            yield { choices: [{ delta: { content: "Hello " } }] };
            yield { choices: [{ delta: { content: "Emma." } }] };
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
    expect(text).toContain('data: {"content":"Hello "}');
    expect(text).toContain('data: {"content":"Emma."}');
    expect(text.trimEnd().endsWith('data: {"done":true}')).toBe(true);
  });

  it("rate limits rapid-fire requests with 429", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      const res = await postChat(validBody);
      statuses.push(res.status);
      if (res.status === 200) await res.text();
      else await res.json();
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    const limited = await postChat(validBody);
    if (limited.status === 429) {
      const json = (await limited.json()) as { error: string };
      expect(json.error).toContain("too quickly");
    }
  });
});
