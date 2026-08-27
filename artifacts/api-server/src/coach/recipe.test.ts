/**
 * Recipe turn output-cleaning contract: every patient-visible string on the
 * generated recipe card — not just the conversational reply — goes through
 * the shared model-text cleaning, so the brand is always spelled THINNR even
 * when the model (echoing the archived program documents) misspells it in a
 * recipe name, description, step, or ingredient name. Genuine lowercase
 * English ("a thinner consistency") must survive untouched.
 *
 * The model is mocked (no credits spent); the misspellings are planted in
 * every card field at once so a regression in any single field fails loudly.
 */
import { describe, expect, it, vi } from "vitest";

const modelState = vi.hoisted(() => ({ content: "" }));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: {
      completions: {
        create: vi.fn(async () => ({
          choices: [{ message: { content: modelState.content } }],
        })),
      },
    },
  },
}));

import { generateRecipeTurn } from "./recipe";

const silentLog = { info: () => {}, warn: () => {} };

describe("generateRecipeTurn output cleaning", () => {
  it("spells the brand THINNR in the reply and every card field, sparing genuine English", async () => {
    modelState.content = JSON.stringify({
      reply: "Here is a THINNER classic your plan loves.",
      recipe: {
        name: "Thinner Harvest Bowl",
        description: "A cozy bowl straight from the THINNER program playbook.",
        meal: "dinner",
        minutes: 25,
        servings: 2,
        calories: 400,
        protein: 40,
        carbs: 30,
        fat: 10,
        ingredients: [
          {
            amount: 6,
            unit: "oz",
            name: "Thinner Broth Base",
            nutrition: { calories: 100, protein: 10, carbs: 8, fat: 2 },
          },
          {
            amount: 8,
            unit: "oz",
            name: "Chicken breast",
            nutrition: { calories: 300, protein: 30, carbs: 22, fat: 8 },
          },
        ],
        steps: [
          "Serve it the THINNER way with fresh herbs.",
          "Add broth until a thinner consistency forms.",
        ],
      },
    });

    const result = await generateRecipeTurn({
      mode: "recipe",
      history: [{ role: "user", content: "Give me a dinner recipe" }],
      compartments: [],
      patient: { firstName: "Emma", programDay: 10, phaseName: "Metabolic Thinning" },
      signal: new AbortController().signal,
      log: silentLog,
    });

    const misspelled = /THINNER|Thinner\b/;

    expect(result.reply).toBe("Here is a THINNR classic your plan loves.");
    expect(result.card).not.toBeNull();
    const payload = result.card!.payload;

    expect(payload.name).toBe("THINNR Harvest Bowl");
    expect(payload.description).toBe("A cozy bowl straight from the THINNR program playbook.");
    expect(payload.steps[0]).toBe("Serve it the THINNR way with fresh herbs.");
    expect(payload.ingredients.map((i) => i.name)).toEqual(["THINNR Broth Base", "Chicken breast"]);

    // Genuine lowercase English is never rewritten (capitalized-only contract).
    expect(payload.steps[1]).toBe("Add broth until a thinner consistency forms.");

    // Belt and braces: no field anywhere on the wire still carries the misspelling.
    expect(JSON.stringify(result)).not.toMatch(misspelled);
  });
});
