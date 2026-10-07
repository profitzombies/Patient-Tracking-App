import { beforeEach, describe, expect, it, vi } from "vitest";

const model = vi.hoisted(() => ({
  reply: '{"concern":"none","reason":""}' as string | Error,
  calls: [] as Array<{ model: string; system: string; user: string; signal: AbortSignal | undefined }>,
}));
vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { chat: { completions: { create: vi.fn(async (params: { model: string; messages: Array<{ role: string; content: string }> }, options?: { signal?: AbortSignal }) => {
    model.calls.push({
      model: params.model,
      system: params.messages.find((m) => m.role === "system")?.content ?? "",
      user: params.messages.find((m) => m.role === "user")?.content ?? "",
      signal: options?.signal,
    });
    if (model.reply instanceof Error) throw model.reply;
    return { choices: [{ message: { content: model.reply } }] };
  }) } } },
}));
vi.mock("@workspace/integrations-openai-ai-server/usage", () => ({
  withModelUsageSurface: vi.fn(async (_surface: string, run: () => Promise<unknown>) => run()),
}));

import { COACH_SAFETY_CATEGORIES, COACH_SAFETY_SCREEN_PROMPT, screenCoachMessage } from "./safety-screen";

const warn = vi.fn();
const log = { warn };
beforeEach(() => { model.reply = '{"concern":"none","reason":""}'; model.calls = []; warn.mockClear(); });

describe("coach safety screen", () => {
  it("reports nothing for an ordinary message and never logs its text", async () => {
    expect(await screenCoachMessage({ text: "I'm starving, can I have a second snack?", log })).toBeNull();
    expect(model.calls[0]?.system).toBe(COACH_SAFETY_SCREEN_PROMPT);
    expect(model.calls[0]?.user).toContain("second snack");
    expect(model.calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(warn).not.toHaveBeenCalled();
  });
  it("returns the category and a trimmed clinical reason for a flagged message", async () => {
    model.reply = '```json\n{"concern":"medication_problem","reason":"  Reports taking   two injections yesterday by mistake. "}\n```';
    expect(await screenCoachMessage({ text: "I think I took my shot twice yesterday", log })).toEqual({
      category: "medication_problem", reason: "Reports taking two injections yesterday by mistake.",
    });
  });
  it("fills a label-based reason when the model leaves it blank", async () => {
    model.reply = '{"concern":"pregnancy"}';
    expect(await screenCoachMessage({ text: "I just found out I'm pregnant", log })).toEqual({ category: "pregnancy", reason: "Pregnancy reported in coach chat" });
  });
  it("treats invalid output, unknown categories, and model failures as no concern", async () => {
    model.reply = "I cannot help with that";
    expect(await screenCoachMessage({ text: "hello", log })).toBeNull();
    model.reply = '{"concern":"sadness","reason":"x"}';
    expect(await screenCoachMessage({ text: "hello", log })).toBeNull();
    model.reply = new Error("gateway down");
    expect(await screenCoachMessage({ text: "hello", log })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(3);
    for (const call of warn.mock.calls) expect(JSON.stringify(call)).not.toContain("hello");
  });
  it("skips the model for an empty message and caps the text it sends", async () => {
    expect(await screenCoachMessage({ text: "   ", log })).toBeNull();
    expect(model.calls).toHaveLength(0);
    await screenCoachMessage({ text: "a".repeat(10_000), log });
    expect(model.calls[0]!.user.length).toBeLessThan(4200);
  });
  it("names every category in the prompt", () => {
    for (const category of COACH_SAFETY_CATEGORIES) expect(COACH_SAFETY_SCREEN_PROMPT).toContain(`"${category}"`);
  });
});
