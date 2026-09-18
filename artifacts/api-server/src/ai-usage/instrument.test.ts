/**
 * The shared-client metering seam, driven with a fake OpenAI client: every
 * call shape (unary, stream, image, transcription) produces exactly one
 * usage event with the provider's token counts, streams get
 * include_usage injected, failures and aborts are labelled, and the
 * AsyncLocalStorage context reaches the event across awaits.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentModelUsageContext,
  instrumentOpenAI,
  runWithModelUsageContext,
  setModelUsageSink,
  updateModelUsageContext,
  withModelUsageContext,
  withModelUsageSurface,
  type ModelUsageEvent,
} from "@workspace/integrations-openai-ai-server/usage";

type AnyFn = (...args: unknown[]) => unknown;

function fakeClient(overrides: { create?: AnyFn; generate?: AnyFn; edit?: AnyFn; transcribe?: AnyFn } = {}) {
  const create = vi.fn(overrides.create ?? (async () => ({ model: "gpt-5-nano-2025-08-07", usage: { prompt_tokens: 10, completion_tokens: 4 } })));
  const generate = vi.fn(overrides.generate ?? (async () => ({ usage: { input_tokens: 100, output_tokens: 1000, input_tokens_details: { cached_tokens: 0 } } })));
  const edit = vi.fn(overrides.edit ?? (async () => ({})));
  const transcribe = vi.fn(overrides.transcribe ?? (async () => ({ text: "hi", usage: { input_tokens: 50, output_tokens: 5 } })));
  const client = {
    chat: { completions: { create } },
    images: { generate, edit },
    audio: { transcriptions: { create: transcribe } },
  };
  return { client: instrumentOpenAI(client as unknown as Parameters<typeof instrumentOpenAI>[0]), create, generate, edit, transcribe };
}

async function* chunks(list: unknown[]) {
  for (const chunk of list) yield chunk;
}

function streamOf(list: unknown[], onIterate?: () => void) {
  const stream = {
    controller: new AbortController(),
    [Symbol.asyncIterator]: () => {
      onIterate?.();
      return chunks(list);
    },
  };
  return stream;
}

const events: ModelUsageEvent[] = [];
setModelUsageSink((event) => events.push(event));
afterEach(() => {
  events.length = 0;
});

describe("instrumentOpenAI", () => {
  it("records a unary chat completion with the provider's usage, model, and cached tokens", async () => {
    const { client, create } = fakeClient({
      create: async () => ({
        model: "gpt-5.6-terra-2026-01-01",
        usage: { prompt_tokens: 2420, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 2304 }, completion_tokens_details: { reasoning_tokens: 120 } },
      }),
    });
    const result = await client.chat.completions.create({ model: "gpt-5.6-terra", messages: [] });
    expect(result.model).toBe("gpt-5.6-terra-2026-01-01");
    expect(create).toHaveBeenCalledWith({ model: "gpt-5.6-terra", messages: [] }, undefined);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      api: "chat.completions", model: "gpt-5.6-terra", responseModel: "gpt-5.6-terra-2026-01-01", stream: false, status: "ok",
      usageReported: true, promptTokens: 2420, cachedTokens: 2304, completionTokens: 300, reasoningTokens: 120, firstTokenMs: null, context: null,
    });
    expect(events[0]!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("marks a missing usage block as unreported rather than zero-cost success", async () => {
    const { client } = fakeClient({ create: async () => ({ choices: [] }) });
    await client.chat.completions.create({ model: "gpt-5-nano", messages: [] });
    expect(events[0]).toMatchObject({ usageReported: false, promptTokens: 0, completionTokens: 0, status: "ok" });
  });

  it("injects include_usage on streams and records usage from the trailing chunk when iteration ends", async () => {
    const { client, create } = fakeClient({
      create: async () =>
        streamOf([
          { model: "gpt-5.6-terra-x", choices: [{ delta: { content: "Hi" } }] },
          { choices: [{ delta: { content: " there" } }] },
          { choices: [], usage: { prompt_tokens: 3000, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 2816 } } },
        ]),
    });
    const stream = await client.chat.completions.create({ model: "gpt-5.6-terra", messages: [], stream: true, stream_options: { include_obfuscation: false } as never });
    expect(create.mock.calls[0]![0]).toMatchObject({ stream: true, stream_options: { include_usage: true, include_obfuscation: false } });
    const text: string[] = [];
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) text.push(delta);
    }
    expect(text.join("")).toBe("Hi there");
    expect((stream as { controller?: AbortController }).controller).toBeInstanceOf(AbortController);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stream: true, status: "ok", usageReported: true, promptTokens: 3000, cachedTokens: 2816, completionTokens: 40, responseModel: "gpt-5.6-terra-x" });
    expect(events[0]!.firstTokenMs).not.toBeNull();
  });

  it("records a stream the consumer abandoned as aborted, exactly once", async () => {
    const { client } = fakeClient({
      create: async () => streamOf([{ choices: [{ delta: { content: "a" } }] }, { choices: [{ delta: { content: "b" } }] }, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }]),
    });
    const stream = await client.chat.completions.create({ model: "gpt-5.6-terra", messages: [], stream: true });
    for await (const _chunk of stream) break;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stream: true, status: "aborted", usageReported: false });
  });

  it("labels upstream failures error and abort signals aborted, on unary and stream calls", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "APIUserAbortError" });
    const { client } = fakeClient({
      create: vi.fn()
        .mockRejectedValueOnce(new Error("502 bad gateway"))
        .mockRejectedValueOnce(abortError)
        .mockResolvedValueOnce({
          [Symbol.asyncIterator]: async function* () {
            yield { choices: [{ delta: { content: "x" } }] };
            throw abortError;
          },
        }),
    });
    await expect(client.chat.completions.create({ model: "m", messages: [] })).rejects.toThrow("502");
    await expect(client.chat.completions.create({ model: "m", messages: [] })).rejects.toThrow("aborted");
    const stream = await client.chat.completions.create({ model: "m", messages: [], stream: true });
    await expect((async () => { for await (const _chunk of stream) { /* drain */ } })()).rejects.toThrow("aborted");
    expect(events.map((event) => event.status)).toEqual(["error", "aborted", "aborted"]);
  });

  it("meters image generation and transcription with their input/output token shapes", async () => {
    const { client } = fakeClient();
    await client.images.generate({ model: "gpt-image-1", prompt: "a bowl" });
    await client.audio.transcriptions.create({ model: "gpt-4o-transcribe", file: new Blob(["x"]) as never });
    expect(events.map((event) => [event.api, event.model, event.promptTokens, event.completionTokens])).toEqual([
      ["images.generate", "gpt-image-1", 100, 1000],
      ["audio.transcriptions", "gpt-4o-transcribe", 50, 5],
    ]);
  });

  it("never lets a throwing sink break the call", async () => {
    setModelUsageSink(() => { throw new Error("sink down"); });
    try {
      const { client } = fakeClient();
      await expect(client.chat.completions.create({ model: "m", messages: [] })).resolves.toBeTruthy();
    } finally {
      setModelUsageSink((event) => events.push(event));
    }
  });
});

describe("usage context", () => {
  it("attributes calls to the enclosing context, including updates made after entry and across awaits", async () => {
    const { client } = fakeClient();
    await runWithModelUsageContext({ surface: "unattributed", requestId: "req-1" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      updateModelUsageContext({ surface: "coach.chat", patientId: "patient-1", providerId: "office-1" });
      await client.chat.completions.create({ model: "m", messages: [] });
      await withModelUsageSurface("coach.photo_classify", () => client.chat.completions.create({ model: "m", messages: [] }));
      await withModelUsageContext({ surface: "coach.title", scope: "system" }, () => client.chat.completions.create({ model: "m", messages: [] }));
      // Narrowing is scoped: back outside, the turn's own surface is intact.
      expect(currentModelUsageContext()).toMatchObject({ surface: "coach.chat", patientId: "patient-1" });
    });
    expect(events.map((event) => event.context)).toEqual([
      { surface: "coach.chat", requestId: "req-1", patientId: "patient-1", providerId: "office-1" },
      { surface: "coach.photo_classify", requestId: "req-1", patientId: "patient-1", providerId: "office-1" },
      { surface: "coach.title", requestId: "req-1", patientId: "patient-1", providerId: "office-1", scope: "system" },
    ]);
  });

  it("keeps concurrent requests apart and leaves out-of-context calls unattributed", async () => {
    const { client } = fakeClient({
      create: async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return { usage: { prompt_tokens: 1, completion_tokens: 1 } };
      },
    });
    await Promise.all([
      runWithModelUsageContext({ surface: "support.chat", requestId: "a" }, () => client.chat.completions.create({ model: "m", messages: [] })),
      runWithModelUsageContext({ surface: "coach.chat", requestId: "b" }, () => client.chat.completions.create({ model: "m", messages: [] })),
      client.chat.completions.create({ model: "m", messages: [] }),
    ]);
    expect(updateModelUsageContext({ surface: "ignored" })).toBeUndefined();
    const byRequest = new Map(events.map((event) => [event.context?.requestId ?? null, event.context?.surface ?? null]));
    expect(byRequest.get("a")).toBe("support.chat");
    expect(byRequest.get("b")).toBe("coach.chat");
    expect(byRequest.get(null)).toBeNull();
  });
});
