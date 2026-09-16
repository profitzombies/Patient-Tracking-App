import { beforeEach, describe, expect, it, vi } from "vitest";

const modelState = vi.hoisted(() => ({
  content: "" as string,
  failNext: false,
  calls: [] as Array<{ model: string; messages: Array<{ role: string; content: string }> }>,
}));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: {
      completions: {
        create: vi.fn(async (params: { model: string; messages: Array<{ role: string; content: string }> }) => {
          modelState.calls.push(params);
          if (modelState.failNext) throw new Error("upstream boom");
          return { choices: [{ message: { content: modelState.content } }] };
        }),
      },
    },
  },
}));

import { COACH_TITLE_MAX_CHARS, COACH_TITLE_PROMPT, generateCoachTitle, shapeCoachTitle, titleLooksSensitive } from "./title";

beforeEach(() => {
  modelState.content = "";
  modelState.failNext = false;
  modelState.calls.length = 0;
});

describe("shapeCoachTitle", () => {
  it("removes dashes, quotes, emoji, and trailing punctuation, and fixes brand spelling", () => {
    expect(shapeCoachTitle('"Chipotle - dinner   plan!"')).toBe("Chipotle dinner plan");
    expect(shapeCoachTitle("Thinner snack ideas 🍎")).toBe("THINNR snack ideas");
    expect(shapeCoachTitle("Week one — feeling stuck:")).toBe("Week one feeling stuck");
  });

  it("caps on a word boundary and returns empty for unusable input", () => {
    const long = "Planning a full week of breakfasts lunches and dinners for the family";
    const shaped = shapeCoachTitle(long);
    expect(shaped.length).toBeLessThanOrEqual(COACH_TITLE_MAX_CHARS);
    expect(long.startsWith(shaped)).toBe(true);
    expect(shaped.endsWith(" ")).toBe(false);
    expect(shapeCoachTitle("  !!! ")).toBe("");
  });
});

describe("generateCoachTitle", () => {
  it("asks the small model with the first message and stores the shaped title", async () => {
    modelState.content = '{"title": "Chipotle dinner plan."}';
    const result = await generateCoachTitle({ firstMessage: "What can I eat at Chipotle tonight?" });
    expect(result).toEqual({ title: "Chipotle dinner plan", source: "model" });
    expect(modelState.calls[0]?.messages[0]).toEqual({ role: "system", content: COACH_TITLE_PROMPT });
    expect(modelState.calls[0]?.messages[1]?.content).toContain("What can I eat at Chipotle tonight?");
  });

  it("falls back to a keyword title when the model fails or answers unusably, and never logs the reply", async () => {
    const warn = vi.fn();
    modelState.failNext = true;
    expect(await generateCoachTitle({ firstMessage: "Any dinner recipe ideas?", log: { warn } }))
      .toEqual({ title: "Meal ideas", source: "fallback" });
    modelState.content = "not json at all";
    expect(await generateCoachTitle({ firstMessage: "I keep giving in to a snack at night", log: { warn } }))
      .toEqual({ title: "Snack support", source: "fallback" });
    modelState.content = '{"title": "!!!"}';
    expect(await generateCoachTitle({ firstMessage: "hello", log: { warn } }))
      .toEqual({ title: "Coach conversation", source: "fallback" });
    expect(warn).toHaveBeenCalledTimes(3);
    for (const [detail] of warn.mock.calls) expect(JSON.stringify(detail)).not.toMatch(/not json|snack|!!!/);
  });

  it("skips the model entirely for an empty first message", async () => {
    expect(await generateCoachTitle({ firstMessage: "   " })).toEqual({ title: "Coach conversation", source: "fallback" });
    expect(modelState.calls).toHaveLength(0);
  });
});

describe("titleLooksSensitive", () => {
  it("flags health numbers, doses, and contact details", () => {
    for (const title of [
      "Down 12 lbs this week", "Weight 185 today", "Ozempic 0.5 mg question", "A1C 6.4 result",
      "Lost 4% so far", "Call 555 123 4567", "Email jane@example.com", "Account 204981",
    ]) expect(titleLooksSensitive(title), title).toBe(true);
  });

  it("lets ordinary counts and topics through", () => {
    for (const title of ["3 day meal plan", "Chipotle dinner plan", "Week 2 grocery list", "Two eggs or three", "Quick check in"]) {
      expect(titleLooksSensitive(title), title).toBe(false);
    }
  });

  it("swaps a sensitive model title for the keyword fallback without logging it", async () => {
    modelState.content = JSON.stringify({ title: "Semaglutide 1 mg nausea" });
    const warn = vi.fn();
    const result = await generateCoachTitle({ firstMessage: "I started semaglutide 1 mg and feel sick after dinner", log: { warn } });
    expect(result).toEqual({ title: "Meal ideas", source: "fallback" });
    expect(warn).toHaveBeenCalledWith({ reason: "sensitive" }, expect.any(String));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Semaglutide");
  });
});
