/**
 * The AI pass over a hosted training video.
 *
 * The AI integration transcribes AUDIO only — it cannot ingest video — so
 * ffmpeg first pulls a mono 16 kHz WAV track and slices it into fixed
 * 60-second segments. Each segment is transcribed on its own; the segment
 * boundaries double as the timing grid, which is why chapter timestamps land
 * on near-minute marks (the plan accepts that precision). The text model then
 * writes the description and the chapter list FROM that timed transcript, and
 * ffmpeg captures the first frame as the thumbnail.
 *
 * Every step either returns a usable result or throws with plain words — the
 * routes surface failures verbatim and offer a retry; nothing falls back
 * silently to canned copy.
 */
import { spawn } from "child_process";
import { createReadStream } from "fs";
import { mkdtemp, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { openai } from "@workspace/integrations-openai-ai-server";
import { upstreamTimeoutMs, UpstreamTimeoutError } from "../coach/upstream";
import { cleanModelText, extractModelJson } from "../coach/model-json";
import { normalizeSpokenBrandMentions } from "../lib/brand-spelling";
import type { TranscriptSegment } from "./videos-store";

/** Transcription slice length; also the chapter timestamp grid. */
export const SEGMENT_SECONDS = 60;

export const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";

/**
 * Spelling bias for transcription: the brand is pronounced exactly like the
 * English word "thinner", so without a hint every spoken mention transcribes
 * as the misspelling. The AI gateway passes the transcription `prompt`
 * through (probed 2026-08-27: accepted, and usage counted its text tokens,
 * so it reaches the model). Bias only — the deterministic rewrites on the
 * transcript text are the guarantee.
 */
export const TRANSCRIBE_PROMPT =
  "Internal staff training video for the THINNR med-spa weight-loss program. " +
  "THINNR, THINNR Boost, and the THINNR Metabolic Thinning Phase are brand names.";
export const TEXT_MODEL = "gpt-5-nano";

/** How many audio segments are in flight at once against the AI proxy. */
const TRANSCRIBE_CONCURRENCY = 2;

export async function makeWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "training-video-"));
}

export async function cleanupWorkDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

/** Spawn ffmpeg/ffprobe with a hard timeout; rejects with stderr context. */
function run(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 20_000) stderr = stderr.slice(-10_000);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with code ${code}: ${stderr.slice(-400)}`));
    });
  });
}

export interface MediaProbe {
  durationSeconds: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

/** ffprobe a local file or (signed) URL — GCS supports range reads. */
export async function probeMedia(input: string): Promise<MediaProbe> {
  const raw = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type",
      "-of",
      "json",
      input,
    ],
    90_000,
  );
  let parsed: { format?: { duration?: string }; streams?: Array<{ codec_type?: string }> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("ffprobe returned unreadable output");
  }
  const durationSeconds = Number.parseFloat(parsed.format?.duration ?? "");
  const streams = parsed.streams ?? [];
  return {
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
    hasVideo: streams.some((s) => s.codec_type === "video"),
    hasAudio: streams.some((s) => s.codec_type === "audio"),
  };
}

/**
 * Extract the audio track as mono 16 kHz WAV slices of SEGMENT_SECONDS each.
 * WAV/PCM on purpose: it needs no encoder support from the ffmpeg build and
 * a 60-second slice is ~1.9 MB — well inside the transcription size limit.
 */
export async function extractAudioSegments(videoPath: string, workDir: string): Promise<string[]> {
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-i",
      videoPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "-f",
      "segment",
      "-segment_time",
      String(SEGMENT_SECONDS),
      "-reset_timestamps",
      "1",
      join(workDir, "seg%04d.wav"),
    ],
    10 * 60_000,
  );
  const files = (await readdir(workDir)).filter((name) => /^seg\d{4}\.wav$/.test(name)).sort();
  if (files.length === 0) {
    throw new Error("No audio could be extracted from this video.");
  }
  return files.map((name) => join(workDir, name));
}

function withClientAbort(clientSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return clientSignal ? AbortSignal.any([clientSignal, timeout]) : timeout;
}

/**
 * Transcribe the audio slices in order. Each slice gets one retry (transient
 * proxy hiccups); a second failure aborts the whole step with the slice
 * number in the message so the editor can say something concrete.
 */
export async function transcribeSegments(
  files: string[],
  durationSeconds: number,
  options: {
    signal?: AbortSignal;
    onProgress?: (completed: number, total: number) => void;
  } = {},
): Promise<TranscriptSegment[]> {
  const results: Array<TranscriptSegment | null> = new Array(files.length).fill(null);
  let nextIndex = 0;
  let completed = 0;

  const transcribeOne = async (index: number): Promise<string> => {
    const attempt = async (): Promise<string> => {
      // The SDK accepts a fs.ReadStream directly; the .wav name rides along.
      const response = await openai.audio.transcriptions.create(
        {
          file: createReadStream(files[index]),
          model: TRANSCRIBE_MODEL,
          response_format: "json",
          prompt: TRANSCRIBE_PROMPT,
        },
        { signal: withClientAbort(options.signal, upstreamTimeoutMs()) },
      );
      // cleanModelText fixes capitalized brand misspellings; the spoken-
      // mention rewrite catches the lowercase form transcription actually
      // produces ("the thinner program") while genuine phrases like "blood
      // thinner" pass through untouched.
      return normalizeSpokenBrandMentions(cleanModelText(response.text ?? ""));
    };
    try {
      return await attempt();
    } catch (first) {
      if (options.signal?.aborted) throw first;
      try {
        return await attempt();
      } catch (second) {
        throw new Error(
          `Transcribing minute ${index + 1} of ${files.length} failed twice — try again.`,
          { cause: second },
        );
      }
    }
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= files.length) return;
      if (options.signal?.aborted) return;
      const text = await transcribeOne(index);
      const at = index * SEGMENT_SECONDS;
      const end = Math.min((index + 1) * SEGMENT_SECONDS, Math.max(Math.round(durationSeconds), at + 1));
      results[index] = { at, end, text };
      completed += 1;
      options.onProgress?.(completed, files.length);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(TRANSCRIBE_CONCURRENCY, files.length) }, () => worker()),
  );
  if (options.signal?.aborted) throw new Error("Processing was cancelled.");

  const segments = results.filter((seg): seg is TranscriptSegment => seg !== null && seg.text.length > 0);
  if (segments.length === 0) {
    throw new Error("The audio track produced no speech to transcribe.");
  }
  return segments;
}

function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(s / 60);
  const seconds = s % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function transcriptForPrompt(segments: TranscriptSegment[]): string {
  return segments
    .map((seg) => `[${formatClock(seg.at)}–${formatClock(seg.end)}] ${seg.text}`)
    .join("\n");
}

async function jsonModelTurn(system: string, user: string, signal?: AbortSignal): Promise<unknown> {
  let response;
  try {
    response = await openai.chat.completions.create(
      {
        model: TEXT_MODEL,
        // Reasoning models spend part of this budget internally; the AI
        // integration requires >= 8192 to avoid empty replies.
        max_completion_tokens: 8192,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      },
      { signal: withClientAbort(signal, upstreamTimeoutMs()) },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new UpstreamTimeoutError("training model turn", upstreamTimeoutMs(), { cause: error });
    }
    throw error;
  }
  const raw = response.choices[0]?.message?.content ?? "";
  const parsed = extractModelJson(raw);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("The AI reply wasn't readable JSON — try again.");
  }
  return parsed;
}

/** Two short catalog paragraphs written from the timed transcript. */
export async function writeDescription(
  title: string,
  segments: TranscriptSegment[],
  signal?: AbortSignal,
): Promise<string[]> {
  const system =
    "You write catalog descriptions for an internal med-spa staff training library. " +
    "Plain, specific, factual tone; address the staff member as \u201cyou\u201d where natural. " +
    "No hype, no emojis, no exclamation marks, and never mention the transcript, AI, or timestamps. " +
    "The brand name is THINNR — always spell it THINNR, never \"Thinner\" or \"THINNER\", " +
    "even where the transcript spells it otherwise.";
  const user =
    `Video title: ${title}\n\nTimed transcript:\n${transcriptForPrompt(segments)}\n\n` +
    'Reply with JSON exactly like {"paragraphs": ["...", "..."]} — two short paragraphs of 2\u20133 sentences. ' +
    "First paragraph: what the video covers, concretely. Second: what the viewer will be able to do afterwards.";
  const parsed = (await jsonModelTurn(system, user, signal)) as { paragraphs?: unknown };
  const paragraphs = Array.isArray(parsed.paragraphs)
    ? parsed.paragraphs
        .filter((p): p is string => typeof p === "string")
        .map((p) => cleanModelText(p))
        .filter((p) => p.length > 0)
        .slice(0, 4)
    : [];
  if (paragraphs.length === 0) {
    throw new Error("The AI reply didn't include a usable description — try again.");
  }
  return paragraphs;
}

export interface DraftChapter {
  at: number;
  title: string;
}

/**
 * Chapter list from the timed transcript. Timestamps are constrained to the
 * transcription grid: the model may only pick segment start times, and the
 * server snaps/dedupes anyway so a hallucinated timestamp can't corrupt the
 * timeline.
 */
export async function writeChapters(
  title: string,
  segments: TranscriptSegment[],
  durationSeconds: number,
  signal?: AbortSignal,
): Promise<DraftChapter[]> {
  const boundaries = Array.from(
    new Set(segments.map((seg) => seg.at).filter((at) => at < Math.max(1, durationSeconds))),
  ).sort((a, b) => a - b);
  const system =
    "You outline internal staff training videos into chapters. Titles are short, concrete, and scannable " +
    "(3\u20136 words, sentence case, no numbering, no emojis). " +
    "The brand name is THINNR — always spell it THINNR, never \"Thinner\" or \"THINNER\", " +
    "even where the transcript spells it otherwise.";
  const user =
    `Video title: ${title}\nVideo length: ${formatClock(durationSeconds)}\n\n` +
    `Timed transcript:\n${transcriptForPrompt(segments)}\n\n` +
    `Allowed chapter start times (seconds): ${boundaries.join(", ")}\n\n` +
    'Reply with JSON exactly like {"chapters": [{"at": 0, "title": "..."}]} — between 3 and 8 chapters ' +
    "(fewer only if the video is very short), each \"at\" chosen from the allowed start times, " +
    "the first chapter at 0, in ascending order, marking real topic changes.";
  const parsed = (await jsonModelTurn(system, user, signal)) as { chapters?: unknown };
  const raw = Array.isArray(parsed.chapters) ? parsed.chapters : [];
  const snap = (value: number): number => {
    let best = boundaries[0] ?? 0;
    for (const b of boundaries) {
      if (Math.abs(b - value) < Math.abs(best - value)) best = b;
    }
    return best;
  };
  const seen = new Set<number>();
  const chapters: DraftChapter[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const at = (item as { at?: unknown }).at;
    const chapterTitle = (item as { title?: unknown }).title;
    if (typeof at !== "number" || !Number.isFinite(at) || typeof chapterTitle !== "string") continue;
    const cleaned = cleanModelText(chapterTitle).slice(0, 80);
    if (!cleaned) continue;
    const snapped = snap(Math.max(0, at));
    if (seen.has(snapped)) continue;
    seen.add(snapped);
    chapters.push({ at: snapped, title: cleaned });
  }
  chapters.sort((a, b) => a.at - b.at);
  if (chapters.length === 0) {
    throw new Error("The AI reply didn't include usable chapters — try again.");
  }
  if (chapters[0].at !== 0) {
    chapters[0] = { ...chapters[0], at: 0 };
  }
  return chapters.slice(0, 12);
}

/** Capture one frame as JPEG. `input` may be a local path or a signed URL. */
export async function captureFrame(input: string, atSeconds: number, outPath: string): Promise<void> {
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-ss",
      String(Math.max(0, atSeconds)),
      "-i",
      input,
      "-frames:v",
      "1",
      "-q:v",
      "3",
      outPath,
    ],
    2 * 60_000,
  );
}

/** Fully decode one image frame; header-only or corrupt files fail loudly. */
export async function validateThumbnailImage(inputPath: string): Promise<void> {
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-i",
      inputPath,
      "-f",
      "null",
      "-",
    ],
    30_000,
  );
}
