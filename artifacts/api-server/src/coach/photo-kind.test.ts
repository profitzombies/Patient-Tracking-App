/**
 * Unit tests for the chat camera's photo triage: menu photos route to the
 * menu scan, everything else (food, other, invalid output, upstream
 * failures) resolves to the meal pipeline, whose not-food outcome reads
 * junk photos warmly. Client disconnects propagate instead of defaulting.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const modelState = vi.hoisted(() => ({
  content: "" as string,
  failNext: false,
  lastParams: null as { messages: Array<{ role: string; content: unknown }> } | null,
}));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: {
      completions: {
        create: vi.fn(async (params: { messages: Array<{ role: string; content: unknown }> }) => {
          modelState.lastParams = params;
          if (modelState.failNext) throw new Error("upstream boom");
          return { choices: [{ message: { content: modelState.content } }] };
        }),
      },
    },
  },
}));

import { resolvePhotoKind } from "./photo-kind";

const IMAGE = "data:image/jpeg;base64,dGVzdA==";

function makeLog() {
  return { warn: vi.fn() };
}

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

afterEach(() => {
  modelState.content = "";
  modelState.failNext = false;
  modelState.lastParams = null;
});

describe("resolvePhotoKind", () => {
  it("routes a clear menu to the menu pipeline", async () => {
    modelState.content = '{"subject":"menu"}';
    const kind = await resolvePhotoKind({ image: IMAGE, signal: freshSignal(), log: makeLog() });
    expect(kind).toBe("menu");
  });

  it("routes food to the meal pipeline", async () => {
    modelState.content = '{"subject":"food"}';
    const kind = await resolvePhotoKind({ image: IMAGE, signal: freshSignal(), log: makeLog() });
    expect(kind).toBe("meal");
  });

  it("routes 'other' to the meal pipeline, whose not-food outcome answers warmly", async () => {
    modelState.content = '{"subject":"other"}';
    const kind = await resolvePhotoKind({ image: IMAGE, signal: freshSignal(), log: makeLog() });
    expect(kind).toBe("meal");
  });

  it("defaults to meal on unparseable output, with a warning", async () => {
    modelState.content = "definitely not json";
    const log = makeLog();
    const kind = await resolvePhotoKind({ image: IMAGE, signal: freshSignal(), log });
    expect(kind).toBe("meal");
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("defaults to meal when the triage call itself fails, with a warning", async () => {
    modelState.failNext = true;
    const log = makeLog();
    const kind = await resolvePhotoKind({ image: IMAGE, signal: freshSignal(), log });
    expect(kind).toBe("meal");
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("propagates a client disconnect instead of defaulting", async () => {
    modelState.failNext = true;
    const controller = new AbortController();
    controller.abort();
    await expect(
      resolvePhotoKind({ image: IMAGE, signal: controller.signal, log: makeLog() }),
    ).rejects.toThrow();
  });

  it("sends the photo as an image part under the triage prompt", async () => {
    modelState.content = '{"subject":"menu"}';
    await resolvePhotoKind({ image: IMAGE, signal: freshSignal(), log: makeLog() });
    const messages = modelState.lastParams?.messages ?? [];
    expect(messages[0]?.content).toContain("photo triage");
    const parts = messages[1]?.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts.some((p) => p.type === "image_url" && p.image_url?.url === IMAGE)).toBe(true);
  });
});
