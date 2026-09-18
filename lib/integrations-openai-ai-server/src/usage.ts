/**
 * Model-usage metering at the shared OpenAI client seam.
 *
 * Every model call the app makes goes through the one client this package
 * exports, so this is the single place that can see them all: the request's
 * model, whether it streamed, how long it took, and the usage block the
 * provider returned (prompt / cached / completion / reasoning tokens). The
 * wrapper hands one `ModelUsageEvent` per call to a process-wide sink; the
 * API server installs a sink that batches those into its usage table.
 *
 * Attribution (which surface, which patient, which office) is not visible
 * at the seam, so callers supply it through an AsyncLocalStorage context:
 * a request handler runs its work inside `runWithModelUsageContext`, and a
 * pipeline that owns a sub-step (the photo triage inside a chat turn)
 * narrows the surface with `withModelUsageSurface`. Calls made with no
 * context still meter — they are recorded as `unattributed` so a missed
 * wrapper shows up in the numbers instead of hiding.
 *
 * Streams: usage arrives on the final chunk only when the request asks for
 * it (`stream_options.include_usage`), so the wrapper adds that flag to
 * every streaming request. The extra trailing chunk has an empty `choices`
 * array, which every consumer already tolerates via `choices[0]?.`.
 *
 * Nothing here awaits the sink: recording is a synchronous hand-off, so
 * metering can never slow a reply.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type OpenAI from "openai";

export interface ModelUsageContext {
  /** Product surface, e.g. `coach.chat`, `coach.meal_photo`, `support.chat`. */
  surface: string;
  /** Signed-in patient the call served, when there is one. */
  patientId?: string | null;
  /** The office (provider id) the call is charged to, when known. */
  providerId?: string | null;
  /** HTTP request id, for tracing a row back to a log line. */
  requestId?: string | null;
  /**
   * Who the spend belongs to. Derived from the ids when omitted (patient >
   * office > anonymous); background work names itself `system`.
   */
  scope?: "patient" | "office" | "anonymous" | "system";
}

export type ModelUsageApi = "chat.completions" | "images.generate" | "images.edit" | "audio.transcriptions";

export type ModelUsageStatus = "ok" | "error" | "aborted";

export interface ModelUsageEvent {
  api: ModelUsageApi;
  /** Model named in the request. */
  model: string;
  /** Model the provider reports having served (versioned name), if any. */
  responseModel: string | null;
  stream: boolean;
  status: ModelUsageStatus;
  /** Whether the provider returned a usage block at all. */
  usageReported: boolean;
  promptTokens: number;
  /** Prompt tokens served from the provider's prompt cache (subset of prompt). */
  cachedTokens: number;
  completionTokens: number;
  /** Reasoning tokens are part of `completionTokens`, broken out for cost math. */
  reasoningTokens: number;
  /** Wall time from the call until the response (or the stream's end). */
  latencyMs: number;
  /** Streams only: time to the first chunk. */
  firstTokenMs: number | null;
  startedAt: Date;
  context: ModelUsageContext | null;
}

export type ModelUsageSink = (event: ModelUsageEvent) => void;

const contextStorage = new AsyncLocalStorage<ModelUsageContext>();
let sink: ModelUsageSink | null = null;

/** Installs (or with null, removes) the process-wide usage sink. */
export function setModelUsageSink(next: ModelUsageSink | null): void {
  sink = next;
}

/** Runs `fn` with `context` attributed to every model call it (transitively) makes. */
export function runWithModelUsageContext<T>(context: ModelUsageContext, fn: () => T): T {
  return contextStorage.run({ ...context }, fn);
}

/** Runs `fn` under the current context with a narrower surface (sub-step of a turn). */
export function withModelUsageSurface<T>(surface: string, fn: () => T): T {
  return withModelUsageContext({ surface }, fn);
}

/** Runs `fn` under the current context with `patch` layered over it. */
export function withModelUsageContext<T>(patch: Partial<ModelUsageContext> & { surface: string }, fn: () => T): T {
  const current = contextStorage.getStore();
  return contextStorage.run({ ...(current ?? {}), ...patch }, fn);
}

/**
 * Enriches the current context in place (identity resolves after a request
 * handler has already entered its context). No-op outside any context.
 */
export function updateModelUsageContext(patch: Partial<ModelUsageContext>): void {
  const current = contextStorage.getStore();
  if (!current) return;
  Object.assign(current, patch);
}

export function currentModelUsageContext(): ModelUsageContext | null {
  const current = contextStorage.getStore();
  return current ? { ...current } : null;
}

/** Structural slice of the provider's usage block (chat and image shapes). */
interface UsageLike {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
  input_tokens_details?: { cached_tokens?: number | null } | null;
  completion_tokens_details?: { reasoning_tokens?: number | null } | null;
}

const count = (value: number | null | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

function tokensOf(usage: UsageLike | null | undefined) {
  if (!usage || typeof usage !== "object") {
    return { usageReported: false, promptTokens: 0, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0 };
  }
  return {
    usageReported: true,
    promptTokens: count(usage.prompt_tokens ?? usage.input_tokens),
    cachedTokens: count(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens),
    completionTokens: count(usage.completion_tokens ?? usage.output_tokens),
    reasoningTokens: count(usage.completion_tokens_details?.reasoning_tokens),
  };
}

function isAbort(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  if (name === "AbortError" || name === "APIUserAbortError") return true;
  const cause = (error as { cause?: unknown }).cause;
  return cause !== undefined && cause !== error && isAbort(cause);
}

function emit(event: ModelUsageEvent): void {
  if (!sink) return;
  try {
    sink(event);
  } catch {
    // A broken sink must never take a reply down with it.
  }
}

interface CallFrame {
  api: ModelUsageApi;
  model: string;
  stream: boolean;
  startedAt: Date;
  startedMs: number;
  context: ModelUsageContext | null;
}

function record(
  frame: CallFrame,
  status: ModelUsageStatus,
  usage: UsageLike | null | undefined,
  responseModel: string | null,
  firstTokenMs: number | null,
): void {
  emit({
    api: frame.api,
    model: frame.model,
    responseModel,
    stream: frame.stream,
    status,
    ...tokensOf(usage),
    latencyMs: Math.max(0, Math.round(performance.now() - frame.startedMs)),
    firstTokenMs,
    startedAt: frame.startedAt,
    context: frame.context,
  });
}

function openFrame(api: ModelUsageApi, model: unknown, stream: boolean): CallFrame {
  return {
    api,
    model: typeof model === "string" && model.length > 0 ? model : "unknown",
    stream,
    startedAt: new Date(),
    startedMs: performance.now(),
    context: currentModelUsageContext(),
  };
}

/** Wraps a non-streaming call: one event when the promise settles. */
async function meterUnary<T extends { usage?: unknown; model?: string }>(
  frame: CallFrame,
  call: () => Promise<T>,
): Promise<T> {
  try {
    const result = await call();
    const usage = (result && typeof result === "object" ? (result as { usage?: UsageLike }).usage : undefined) ?? undefined;
    const model = result && typeof result === "object" && typeof (result as { model?: unknown }).model === "string"
      ? (result as { model: string }).model
      : null;
    record(frame, "ok", usage, model, null);
    return result;
  } catch (error) {
    record(frame, isAbort(error) ? "aborted" : "error", undefined, null, null);
    throw error;
  }
}

type ChunkLike = { usage?: UsageLike | null; model?: string; choices?: unknown[] };

/**
 * Wraps a stream: the event fires when iteration ends (normally, by error,
 * or by abort). The SDK's Stream object is returned as-is with its async
 * iterator replaced, so `controller`, `tee()` and friends keep working.
 */
function meterStream<S extends AsyncIterable<ChunkLike>>(frame: CallFrame, stream: S): S {
  const iterate = stream[Symbol.asyncIterator].bind(stream);
  let done = false;
  let usage: UsageLike | null | undefined;
  let responseModel: string | null = null;
  let firstTokenMs: number | null = null;
  const finish = (status: ModelUsageStatus) => {
    if (done) return;
    done = true;
    record(frame, status, usage, responseModel, firstTokenMs);
  };
  const metered = async function* (): AsyncGenerator<ChunkLike, void, undefined> {
    try {
      const source: AsyncIterable<ChunkLike> = { [Symbol.asyncIterator]: iterate };
      for await (const chunk of source) {
        if (firstTokenMs === null) firstTokenMs = Math.max(0, Math.round(performance.now() - frame.startedMs));
        if (chunk && typeof chunk === "object") {
          if (chunk.usage) usage = chunk.usage;
          if (typeof chunk.model === "string" && chunk.model) responseModel = chunk.model;
        }
        yield chunk;
      }
      finish("ok");
    } catch (error) {
      finish(isAbort(error) ? "aborted" : "error");
      throw error;
    } finally {
      // A consumer that breaks out of the loop early (or is torn down)
      // lands here without a status: it never saw the end of the reply.
      finish("aborted");
    }
  };
  Object.defineProperty(stream, Symbol.asyncIterator, { value: metered, configurable: true, writable: true });
  return stream;
}

/**
 * Returns the same client with its billable methods metered. Mutates the
 * client's resource objects in place (the SDK exposes them as plain
 * instances), so every existing reference to `client.chat.completions`
 * sees the metered method too.
 */
export function instrumentOpenAI(client: OpenAI): OpenAI {
  const completions = client.chat.completions;
  const createCompletion = completions.create.bind(completions);
  type CreateParams = Parameters<typeof createCompletion>[0];
  type CreateOptions = Parameters<typeof createCompletion>[1];
  const meteredCreate = (params: CreateParams, options?: CreateOptions) => {
    if (params && (params as { stream?: boolean }).stream === true) {
      const frame = openFrame("chat.completions", params.model, true);
      const withUsage = {
        ...params,
        stream_options: { include_usage: true, ...((params as { stream_options?: object }).stream_options ?? {}) },
      } as CreateParams & { stream: true };
      return (async () => {
        try {
          const stream = await createCompletion(withUsage, options);
          return meterStream(frame, stream as AsyncIterable<ChunkLike>);
        } catch (error) {
          record(frame, isAbort(error) ? "aborted" : "error", undefined, null, null);
          throw error;
        }
      })();
    }
    const frame = openFrame("chat.completions", params?.model, false);
    return meterUnary(frame, () => createCompletion(params as CreateParams & { stream?: false }, options) as Promise<OpenAI.Chat.Completions.ChatCompletion>);
  };
  (completions as { create: unknown }).create = meteredCreate;

  const images = client.images;
  const generate = images.generate.bind(images);
  (images as { generate: unknown }).generate = (params: Parameters<typeof generate>[0], options?: Parameters<typeof generate>[1]) =>
    meterUnary(openFrame("images.generate", params?.model, false), () => generate(params as OpenAI.Images.ImageGenerateParamsNonStreaming, options));
  const edit = images.edit.bind(images);
  (images as { edit: unknown }).edit = (params: Parameters<typeof edit>[0], options?: Parameters<typeof edit>[1]) =>
    meterUnary(openFrame("images.edit", params?.model, false), () => edit(params as OpenAI.Images.ImageEditParamsNonStreaming, options));

  const transcriptions = client.audio.transcriptions;
  const transcribe = transcriptions.create.bind(transcriptions);
  (transcriptions as { create: unknown }).create = (
    params: Parameters<typeof transcribe>[0],
    options?: Parameters<typeof transcribe>[1],
  ) => meterUnary(openFrame("audio.transcriptions", params?.model, false), () => transcribe(params as unknown as OpenAI.Audio.Transcriptions.TranscriptionCreateParamsNonStreaming, options) as Promise<{ usage?: unknown }>);

  return client;
}
