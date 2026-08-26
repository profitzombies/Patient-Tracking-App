/**
 * Route tests for POST /api/support/chat (the provider AI Support chat).
 *
 * The OpenAI client and the knowledge-library loader are mocked (no credits,
 * no database). Covers: open access (the demo posture has no staff gate, so
 * tokenless and bearer-carrying calls behave identically), invalid bodies,
 * the grounded happy path, two-stage broadening mechanics, stage narration
 * (searching/thinking/formulating events in real work order), the
 * deterministic output guards (brand spelling, dashes, emojis — including
 * emojis split across chunks), stopped-history annotation, the
 * empty-library and library-outage paths, upstream reliability (idle
 * deadline, keepalives), and rate limiting. The rate-limit test runs last
 * because it drains one IP's bucket.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

/** Per-call model scripts: each create() call shifts the next chunk list. */
const streamState = vi.hoisted(() => ({
  queue: [] as string[][],
  fallback: ["Grounded ", "answer."],
}));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: {
      completions: {
        create: vi.fn(async () => {
          const chunks = streamState.queue.shift() ?? streamState.fallback;
          return {
            async *[Symbol.asyncIterator]() {
              for (const content of chunks) {
                yield { choices: [{ delta: { content } }] };
              }
            },
          };
        }),
      },
    },
  },
}));

/** Fixture library; docsState lets tests stage outages and empty libraries. */
const docsState = vi.hoisted(() => {
  const library = [
    {
      id: "d-foods",
      title: "Approved Foods",
      summary: "Which foods are approved on the protocol.",
      keywords: ["approved foods", "grapefruit", "protein"],
      text: "APPROVED-FOODS-TEXT Grapefruit is approved in the thinning phase.",
    },
    {
      id: "d-boost",
      title: "Boost Product Info",
      summary: "Dosing and facts for the Boost stack.",
      keywords: ["boost", "dosing"],
      text: "BOOST-TEXT Take Boost once daily.",
    },
    {
      id: "d-clinical",
      title: "Clinical Training Document",
      summary: "Clinical protocol details including side effects.",
      keywords: ["side effects", "headache"],
      text: "CLINICAL-TEXT Headache guidance for week one.",
    },
  ];
  return { library, docs: [...library], error: null as Error | null };
});

vi.mock("../support/docs", () => ({
  loadSupportDocuments: vi.fn(async () => {
    if (docsState.error) throw docsState.error;
    return docsState.docs;
  }),
  clearSupportDocumentCache: vi.fn(),
}));

import { openai } from "@workspace/integrations-openai-ai-server";
import app from "../app";

const createMock = vi.mocked(openai.chat.completions.create);
type LooseCall = (body: unknown, options?: { signal?: AbortSignal }) => unknown;
const looseCreate = createMock as unknown as {
  mockImplementationOnce(fn: LooseCall): void;
};

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
  // mockClear (not mockReset) keeps the queue-driven factory implementation.
  createMock.mockClear();
  streamState.queue = [];
  docsState.docs = [...docsState.library];
  docsState.error = null;
});

afterEach(() => {
  delete process.env.COACH_UPSTREAM_TIMEOUT_MS;
  delete process.env.COACH_KEEPALIVE_MS;
});

/** Distinct client IP per call so per-IP buckets never interfere. */
function nextIp(): string {
  ipCounter += 1;
  return `10.7.${Math.floor(ipCounter / 200)}.${(ipCounter % 200) + 1}`;
}

/** Calls are anonymous by default — the demo posture sends no bearer. */
function postChat(body: unknown, ip = nextIp(), token: string | null = null) {
  return fetch(`${baseUrl}/api/support/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": ip,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function userTurn(content: string) {
  return { messages: [{ role: "user", content }] };
}

/** System prompt sent on the nth (0-based) model call. */
function systemPromptOfCall(index: number): string {
  const body = createMock.mock.calls[index]?.[0] as unknown as {
    messages: { role: string; content: string }[];
  };
  return body.messages[0].content;
}

function modelMessagesOfCall(index: number): { role: string; content: string }[] {
  const body = createMock.mock.calls[index]?.[0] as unknown as {
    messages: { role: string; content: string }[];
  };
  return body.messages;
}

const ERROR_EVENT = 'data: {"error":"AI Support is unavailable right now. Please try again."}';

/** All parsed SSE data events, in wire order (keepalive comments excluded). */
function dataEvents(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

/** Joined visible reply text across all content events. */
function joinedContent(text: string): string {
  return dataEvents(text)
    .filter((event) => typeof event.content === "string")
    .map((event) => event.content as string)
    .join("");
}

describe("POST /api/support/chat", () => {
  it("streams for tokenless callers — the demo posture has no staff gate", async () => {
    const res = await postChat(userTurn("Hello"), nextIp(), null);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('data: {"content":"Grounded"}');
    expect(text.trimEnd().endsWith('data: {"done":true}')).toBe(true);
  });

  it("treats a bearer-carrying call (signed-in staff) exactly the same", async () => {
    const res = await postChat(userTurn("Hello"), nextIp(), "real-staff-session-token");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.trimEnd().endsWith('data: {"done":true}')).toBe(true);
  });

  it("rejects an invalid body with 400", async () => {
    const res = await postChat({ nonsense: true });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBeTruthy();
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
    const res = await fetch(`${baseUrl}/api/support/chat`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example.com",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("streams a grounded turn with only the matching documents attached", async () => {
    const res = await postChat(userTurn("Is grapefruit approved for my patient?"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain('data: {"content":"Grounded"}');
    expect(text.trimEnd().endsWith('data: {"done":true}')).toBe(true);

    expect(createMock).toHaveBeenCalledTimes(1);
    const prompt = systemPromptOfCall(0);
    // Stage 1 carries the matched document, not the whole library.
    expect(prompt).toContain("APPROVED-FOODS-TEXT");
    expect(prompt).not.toContain("CLINICAL-TEXT");
    // Stage 1 offers the broaden escape hatch.
    expect(prompt).toContain("[[broaden:all]]");
  });

  it("embeds the verbatim persona rules with the company slot filled", async () => {
    await (await postChat(userTurn("Is grapefruit approved?"))).text();
    const prompt = systemPromptOfCall(0);
    expect(prompt).toContain("Search the knowledge base and don't make up stuff.");
    expect(prompt).toContain(
      "If you have additional concerns, please have the patient check with their primary care physician.",
    );
    expect(prompt).toContain("The product name is THINNR, not Thinner");
    expect(prompt).toContain("# Style: Your communication style should be friendly and professional.");
    expect(prompt).toContain("Support@Thinnrweightloss.com");
    // The template slot is filled, never sent raw.
    expect(prompt).not.toContain("[Company Info");
    // The one approved deviation from the verbatim source: emojis are banned,
    // never requested.
    expect(prompt).toContain("Never use emojis");
    expect(prompt).not.toContain("Add emojis");
  });

  it("narrates stages in real work order: searching, thinking, formulating, content", async () => {
    const res = await postChat(userTurn("Is grapefruit approved?"));
    const events = dataEvents(await res.text());
    const stages = events.filter((event) => "stage" in event).map((event) => event.stage);
    expect(stages).toEqual(["searching", "thinking", "formulating"]);
    const lastStageIndex = events.reduce(
      (last, event, index) => ("stage" in event ? index : last),
      -1,
    );
    const firstContentIndex = events.findIndex((event) => "content" in event);
    expect(firstContentIndex).toBeGreaterThan(lastStageIndex);
    expect(events.at(-1)).toEqual({ done: true });
  });

  it("restarts the stage narration when broadening to the full library", async () => {
    streamState.queue = [["[[broa", "den:all]]"], ["Answer from the clinical document."]];
    const res = await postChat(userTurn("Is grapefruit approved?"));
    const events = dataEvents(await res.text());
    const stages = events.filter((event) => "stage" in event).map((event) => event.stage);
    // Stage 1 produced no visible output, so formulating first fires in
    // stage 2 — the client's status line honestly starts over.
    expect(stages).toEqual(["searching", "thinking", "searching", "thinking", "formulating"]);
    const firstContentIndex = events.findIndex((event) => "content" in event);
    const lastStageIndex = events.reduce(
      (last, event, index) => ("stage" in event ? index : last),
      -1,
    );
    expect(firstContentIndex).toBeGreaterThan(lastStageIndex);
  });

  it("strips emojis from the stream, including ones split across chunks", async () => {
    const thumb = "👍";
    streamState.queue = [
      [
        "Great news! 🎉 ",
        `Boost helps${thumb.charAt(0)}`,
        `${thumb.charAt(1)} daily. `,
        "Rated 5 ⭐ by teams 👩\u200D",
        "👦 everywhere. Boost™ 1\uFE0F\u20E3",
      ],
    ];
    const res = await postChat(userTurn("Boost dosing?"));
    const text = await res.text();
    const contents = joinedContent(text);
    // Purely subtractive: emojis vanish, spacing and ™ survive.
    expect(contents).toBe(
      "Great news!  Boost helps daily. Rated 5  by teams  everywhere. Boost™ 1",
    );
    expect(/[\u{1F000}-\u{1FAFF}\u200D\uFE0F\u20E3]/u.test(text)).toBe(false);
    expect(text.trimEnd().endsWith('data: {"done":true}')).toBe(true);
  });

  it("broadens to the full library when stage 1 signals it cannot answer", async () => {
    streamState.queue = [["[[broa", "den:all]]"], ["Answer from the clinical document."]];
    const res = await postChat(userTurn("Is grapefruit approved?"));
    const text = await res.text();

    expect(createMock).toHaveBeenCalledTimes(2);
    // Stage 2 carries every document and drops the escape hatch.
    const secondPrompt = systemPromptOfCall(1);
    expect(secondPrompt).toContain("APPROVED-FOODS-TEXT");
    expect(secondPrompt).toContain("BOOST-TEXT");
    expect(secondPrompt).toContain("CLINICAL-TEXT");
    expect(secondPrompt).toContain("COMPLETE THINNR knowledge library");
    expect(secondPrompt).not.toContain("[[broaden:all]]");

    // The marker never reaches the wire; the visible reply is stage 2's.
    expect(text).not.toContain("broaden");
    expect(text).toContain("Answer from the clinical document.");
    expect(text.trimEnd().endsWith('data: {"done":true}')).toBe(true);
    expect(text.split('"done":true').length - 1).toBe(1);
  });

  it("ignores the broaden marker when the model also answered", async () => {
    streamState.queue = [["Grapefruit is approved. ", "[[broaden:all]]"]];
    const res = await postChat(userTurn("Is grapefruit approved?"));
    const text = await res.text();
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(text).toContain("Grapefruit is approved.");
    expect(text).not.toContain("broaden");
    expect(text).toContain('data: {"done":true}');
  });

  it("sends the whole library up front when nothing matches the question", async () => {
    const res = await postChat(userTurn("zzz completely unrelated"));
    const text = await res.text();
    expect(createMock).toHaveBeenCalledTimes(1);
    const prompt = systemPromptOfCall(0);
    expect(prompt).toContain("APPROVED-FOODS-TEXT");
    expect(prompt).toContain("BOOST-TEXT");
    expect(prompt).toContain("CLINICAL-TEXT");
    // Full mode: honesty instructions, no escape hatch.
    expect(prompt).toContain("COMPLETE THINNR knowledge library");
    expect(prompt).not.toContain("[[broaden:all]]");
    expect(text).toContain('data: {"done":true}');
  });

  it("errors instead of sending a blank reply when the model only emits a stray marker", async () => {
    streamState.queue = [["[[broaden:all]]"]];
    const res = await postChat(userTurn("zzz completely unrelated"));
    const text = await res.text();
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(text).toContain(ERROR_EVENT);
    expect(text).not.toContain('"done":true');
  });

  it("normalizes THINNER/Thinner to THINNR across chunk splits", async () => {
    streamState.queue = [
      [
        "THIN",
        "NER patients ask about Thin",
        "ner, but a thinner soup is fine. Support@Thinnrweightloss.com",
      ],
    ];
    const res = await postChat(userTurn("Is grapefruit approved?"));
    const text = await res.text();
    const contents = text
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line.includes('"content"'))
      .map((line) => (JSON.parse(line.slice(6)) as { content: string }).content)
      .join("");
    expect(contents).toBe(
      "THINNR patients ask about THINNR, but a thinner soup is fine. Support@Thinnrweightloss.com",
    );
  });

  it("smooths em dashes out of the stream", async () => {
    streamState.queue = [["Great question ", "\u2014 Boost is taken daily 2", "\u20143 hours after meals."]];
    const res = await postChat(userTurn("Boost dosing?"));
    const text = await res.text();
    expect(text).not.toContain("\u2014");
    const contents = text
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line.includes('"content"'))
      .map((line) => (JSON.parse(line.slice(6)) as { content: string }).content)
      .join("");
    expect(contents).toBe("Great question, Boost is taken daily 2-3 hours after meals.");
  });

  it("accepts a long comprehensive assistant reply replayed as history", async () => {
    // Regression: first answers routinely exceed 4000 chars; replaying them
    // on turn two must not fail validation (schema cap is 8000).
    const longReply = `Boost guidance. ${"detail ".repeat(1000)}`.trim(); // ~7000 chars
    const res = await postChat({
      messages: [
        { role: "user", content: "Tell me about Boost dosing" },
        { role: "assistant", content: longReply },
        { role: "user", content: "And when should they take it?" },
      ],
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('data: {"done":true}');
    const replayed = modelMessagesOfCall(0);
    expect(replayed.some((m) => m.content.startsWith("Boost guidance."))).toBe(true);
  });

  it("still rejects a history message beyond the schema cap", async () => {
    const res = await postChat({
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "x".repeat(8001) },
        { role: "user", content: "Continue" },
      ],
    });
    expect(res.status).toBe(400);
  });

  it("annotates stopped assistant replies before replaying them to the model", async () => {
    const res = await postChat({
      messages: [
        { role: "user", content: "Tell me about Boost dosing" },
        { role: "assistant", content: "Boost is taken", stopped: true },
        { role: "user", content: "Please continue" },
      ],
    });
    await res.text();
    const replayed = modelMessagesOfCall(0);
    const stoppedReply = replayed.find((m) => m.content.startsWith("Boost is taken"));
    expect(stoppedReply?.content).toContain("the provider stopped this reply");
  });

  it("answers honestly without a model call when the library is empty", async () => {
    docsState.docs = [];
    const res = await postChat(userTurn("Is grapefruit approved?"));
    const text = await res.text();
    expect(createMock).not.toHaveBeenCalled();
    expect(text).toContain("I don't have any knowledge documents to search yet");
    expect(text).toContain("Support@Thinnrweightloss.com");
    expect(text.trimEnd().endsWith('data: {"done":true}')).toBe(true);
  });

  it("returns a retryable 503 when the knowledge library is unreachable", async () => {
    docsState.error = new Error("supabase down");
    const res = await postChat(userTurn("Is grapefruit approved?"));
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: string; retryable: boolean };
    expect(json.error).toContain("knowledge library");
    expect(json.retryable).toBe(true);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("bounds a hung upstream with the idle deadline and errors without done", async () => {
    process.env.COACH_UPSTREAM_TIMEOUT_MS = "60";
    looseCreate.mockImplementationOnce(
      (_body, options) =>
        new Promise((_resolve, reject) => {
          const boom = () => {
            const error = new Error("Request was aborted.");
            error.name = "APIUserAbortError";
            reject(error);
          };
          if (options?.signal?.aborted) return boom();
          options?.signal?.addEventListener("abort", boom, { once: true });
        }),
    );
    const res = await postChat(userTurn("Is grapefruit approved?"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(ERROR_EVENT);
    expect(text).not.toContain('"done":true');
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("emits comment keepalives while the model is silent", async () => {
    process.env.COACH_KEEPALIVE_MS = "25";
    looseCreate.mockImplementationOnce(async () => ({
      async *[Symbol.asyncIterator]() {
        await new Promise((resolve) => setTimeout(resolve, 120));
        yield { choices: [{ delta: { content: "Here you go." } }] };
      },
    }));
    const res = await postChat(userTurn("Is grapefruit approved?"));
    const text = await res.text();
    expect(text).toContain(": keepalive\n\n");
    expect(text).toContain('data: {"content":"Here you go."}');
    expect(text.trimEnd().endsWith('data: {"done":true}')).toBe(true);
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) expect(() => JSON.parse(line.slice(6))).not.toThrow();
    }
  });

  it("rate limits rapid-fire requests from one IP with a retryable 429", async () => {
    const ip = "10.7.250.1";
    const denials: Array<{ error?: string; retryable?: unknown }> = [];
    for (let i = 0; i < 15; i++) {
      const res = await postChat(userTurn("Is grapefruit approved?"), ip);
      if (res.status === 429) {
        denials.push((await res.json()) as { error?: string; retryable?: unknown });
      } else {
        await res.text();
      }
    }
    expect(denials.length).toBeGreaterThan(0);
    for (const denial of denials) {
      expect(denial.error).toContain("too quickly");
      expect(denial.retryable).toBe(true);
    }
  });
});
