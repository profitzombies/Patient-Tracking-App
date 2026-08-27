/**
 * Brand-spelling wiring in the training AI pipeline: transcripts get the
 * capitalized normalizer PLUS the transcript-only spoken-mention rewrite
 * before they are persisted; descriptions and chapter titles inherit the
 * normalizer via the shared cleanModelText choke point; the transcription
 * request carries the THINNR spelling bias; and both text prompts state the
 * brand rule.
 */
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const aiState = vi.hoisted(() => ({
  transcribe: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  chat: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    audio: { transcriptions: { create: aiState.transcribe } },
    chat: { completions: { create: aiState.chat } },
  },
}));

import { TRANSCRIBE_PROMPT, transcribeSegments, writeChapters, writeDescription } from "./pipeline";

let dir: string;
let files: string[];

beforeAll(async () => {
  // transcribeSegments opens real read streams; the SDK is mocked, so tiny
  // placeholder files are all the call needs.
  dir = await mkdtemp(join(tmpdir(), "pipeline-brand-"));
  files = [join(dir, "seg0000.wav"), join(dir, "seg0001.wav")];
  await Promise.all(files.map((file) => writeFile(file, "riff")));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  aiState.transcribe.mockReset();
  aiState.chat.mockReset();
});

function chatReply(payload: unknown) {
  return { choices: [{ message: { content: JSON.stringify(payload) } }] };
}

type ChatRequest = { messages: Array<{ role: string; content: string }> };

describe("transcribeSegments brand spelling", () => {
  it("normalizes spoken and capitalized brand mentions, sparing genuine phrases", async () => {
    aiState.transcribe
      .mockResolvedValueOnce({ text: "Welcome to the thinner program. THINNER Boost helps." })
      .mockResolvedValueOnce({ text: "Blood thinner medications need a thinner soup note." });
    const segments = await transcribeSegments(files, 120);
    expect(segments.map((seg) => seg.text)).toEqual([
      "Welcome to the THINNR program. THINNR Boost helps.",
      "Blood thinner medications need a thinner soup note.",
    ]);
  });

  it("sends the THINNR spelling bias with every slice", async () => {
    aiState.transcribe.mockResolvedValue({ text: "ok" });
    await transcribeSegments(files, 120);
    expect(aiState.transcribe).toHaveBeenCalledTimes(files.length);
    for (const call of aiState.transcribe.mock.calls) {
      expect((call[0] as { prompt?: string }).prompt).toBe(TRANSCRIBE_PROMPT);
    }
    expect(TRANSCRIBE_PROMPT).toContain("THINNR");
  });
});

describe("writeDescription brand spelling", () => {
  it("normalizes brand misspellings in the paragraphs and states the rule in the prompt", async () => {
    aiState.chat.mockResolvedValue(
      chatReply({
        paragraphs: [
          "This video covers the THINNER program schedule.",
          "You will be able to run a Thinner check-in call.",
        ],
      }),
    );
    const paragraphs = await writeDescription("Welcome", [{ at: 0, end: 60, text: "hello" }]);
    expect(paragraphs).toEqual([
      "This video covers the THINNR program schedule.",
      "You will be able to run a THINNR check-in call.",
    ]);
    const [request] = aiState.chat.mock.calls[0] as [ChatRequest];
    expect(request.messages[0].content).toContain("THINNR");
    expect(request.messages[0].content).toContain("never \"Thinner\" or \"THINNER\"");
  });
});

describe("writeChapters brand spelling", () => {
  it("normalizes chapter titles and states the rule in the prompt", async () => {
    aiState.chat.mockResolvedValue(
      chatReply({
        chapters: [
          { at: 0, title: "Thinner welcome basics" },
          { at: 60, title: "Dosing the drops" },
        ],
      }),
    );
    const chapters = await writeChapters(
      "Welcome",
      [
        { at: 0, end: 60, text: "intro" },
        { at: 60, end: 120, text: "dosing" },
      ],
      120,
    );
    expect(chapters[0].title).toBe("THINNR welcome basics");
    expect(chapters[1].title).toBe("Dosing the drops");
    const [request] = aiState.chat.mock.calls[0] as [ChatRequest];
    expect(request.messages[0].content).toContain("THINNR");
  });
});
