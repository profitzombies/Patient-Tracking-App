/**
 * Routing aids must be total: the model's summary when it answers usable
 * JSON, the deterministic heuristic on ANY model trouble — extraction never
 * fails because the AI was down.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const aiState = vi.hoisted(() => ({
  create: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { chat: { completions: { create: aiState.create } } },
}));

import { heuristicRoutingAids, writeRoutingAids } from "./summary";

const TEXT =
  "THINNR Boost supports daily energy. Take one capsule each morning with food. " +
  "Boost pairs with the maintenance stack during month two. Ask your provider before combining supplements.";

function aiReply(content: string) {
  return { choices: [{ message: { content } }] };
}

beforeEach(() => {
  aiState.create.mockReset();
});

describe("writeRoutingAids", () => {
  it("uses the model's summary and cleaned keywords when the reply is usable", async () => {
    aiState.create.mockResolvedValue(
      aiReply(
        JSON.stringify({
          summary: "Explains how to take THINNR Boost and combine it with the maintenance stack.",
          keywords: ["boost", "Boost", "  dosing  ", "supplements", 7, ""],
        }),
      ),
    );
    const aids = await writeRoutingAids("Boost product info", TEXT);
    expect(aids.summary).toMatch(/THINNR Boost/);
    expect(aids.keywords).toEqual(["boost", "dosing", "supplements"]);
  });

  it("falls back to the heuristic when the model call throws", async () => {
    aiState.create.mockRejectedValue(new Error("upstream down"));
    const aids = await writeRoutingAids("Boost product info", TEXT);
    expect(aids).toEqual(heuristicRoutingAids("Boost product info", TEXT));
    expect(aids.summary.length).toBeGreaterThan(0);
  });

  it("falls back when the model answers non-JSON", async () => {
    aiState.create.mockResolvedValue(aiReply("I cannot help with that."));
    const aids = await writeRoutingAids("Boost product info", TEXT);
    expect(aids).toEqual(heuristicRoutingAids("Boost product info", TEXT));
  });
});

describe("heuristicRoutingAids", () => {
  it("is deterministic and shaped like the model output", () => {
    const first = heuristicRoutingAids("Boost product info", TEXT);
    const second = heuristicRoutingAids("Boost product info", TEXT);
    expect(first).toEqual(second);
    expect(first.summary.startsWith("THINNR Boost supports daily energy.")).toBe(true);
    expect(first.keywords.length).toBeGreaterThan(0);
    expect(first.keywords.length).toBeLessThanOrEqual(12);
    expect(first.keywords).toContain("boost");
    for (const keyword of first.keywords) {
      expect(keyword).toBe(keyword.toLowerCase());
    }
  });

  it("survives text with no sentence punctuation", () => {
    const aids = heuristicRoutingAids("Notes", "just words without punctuation everywhere");
    expect(aids.summary).toContain("just words");
  });
});
