/**
 * Route tests for the structured recipe/cravings pipeline inside
 * POST /api/coach/chat, plus POST /api/coach/recipe-image.
 *
 * The OpenAI client is mocked (no credits spent). Each chat test programs the
 * non-streaming completion mock per call; cravings tests exercise the
 * validate → retry → decline ladder against the real Approved Foods catalog.
 */
import { beforeEach, afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: { completions: { create: vi.fn() } },
    images: { generate: vi.fn() },
  },
}));

import { openai } from "@workspace/integrations-openai-ai-server";
import {
  APPROVED_CATALOG,
  ingredientNameMatchesItem,
} from "../coach/approved-catalog";
import app from "../app";

const createMock = vi.mocked(openai.chat.completions.create);
const imageMock = vi.mocked(openai.images.generate);

function completionOf(payload: unknown) {
  return {
    choices: [{ message: { content: JSON.stringify(payload) } }],
  } as never;
}

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
  createMock.mockReset();
  imageMock.mockReset();
});

/** Distinct client IP per call so per-IP buckets never interfere. */
function nextIp(): string {
  ipCounter += 1;
  return `10.1.${Math.floor(ipCounter / 200)}.${(ipCounter % 200) + 1}`;
}

async function chatTurn(content: string) {
  const res = await fetch(`${baseUrl}/api/coach/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": nextIp(),
    },
    body: JSON.stringify({ messages: [{ role: "user", content }] }),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  const events: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
  }
  return events;
}

const validRecipe = {
  name: "Baked Salmon Bowl",
  description: "Flaky salmon over crisp vegetables with lemon.",
  meal: "dinner",
  minutes: 25,
  servings: 2,
  calories: 420,
  protein: 38,
  carbs: 18,
  fat: 22,
  ingredients: [
    { amount: 6, unit: "oz", name: "salmon" },
    { amount: 2, unit: "cups", name: "broccoli" },
  ],
  steps: ["Season the salmon.", "Bake at 400F for 12 minutes and serve."],
};

describe("recipe turns in POST /api/coach/chat", () => {
  it("returns a reply plus a recipe card for a meal-idea ask", async () => {
    createMock.mockResolvedValueOnce(
      completionOf({ reply: "Try this salmon bowl tonight.", recipe: validRecipe }),
    );

    const events = await chatTurn("Give me a dinner idea for tonight");

    expect(createMock).toHaveBeenCalledTimes(1);
    const request = createMock.mock.calls[0][0] as { response_format?: { type: string } };
    expect(request.response_format?.type).toBe("json_object");

    expect(events.find((e) => e.content)?.content).toBe("Try this salmon bowl tonight.");
    const card = events.find((e) => e.card)?.card as {
      kind: string;
      payload: { id: string; mode: string; name: string; calories: number; groceryList?: string[] };
    };
    expect(card.kind).toBe("recipe");
    expect(card.payload.mode).toBe("recipe");
    expect(card.payload.id).toMatch(/^sugg_/);
    expect(card.payload.name).toBe("Baked Salmon Bowl");
    expect(card.payload.calories).toBe(420);
    expect(card.payload.groceryList).toBeUndefined();
    expect(events.at(-1)).toEqual({ done: true });
  });

  it("retries once when cravings ingredients are not approved, then succeeds", async () => {
    const approvedA = APPROVED_CATALOG[0];
    const approvedB = APPROVED_CATALOG[1];
    const badRecipe = {
      ...validRecipe,
      meal: "snacks",
      ingredients: [
        { amount: 1, unit: "", name: "chocolate cake", approvedItemId: "chocolate-cake" },
      ],
    };
    const goodRecipe = {
      ...validRecipe,
      name: "Approved Sweet Fix",
      meal: "snacks",
      ingredients: [
        { amount: 1, unit: "cup", name: approvedA.name.toLowerCase(), approvedItemId: approvedA.id },
        { amount: 0.5, unit: "cup", name: approvedB.name.toLowerCase(), approvedItemId: approvedB.id },
      ],
    };
    createMock
      .mockResolvedValueOnce(completionOf({ reply: "Here you go.", recipe: badRecipe }))
      .mockResolvedValueOnce(completionOf({ reply: "Here is an approved fix.", recipe: goodRecipe }));

    const events = await chatTurn("I'm craving chocolate cake");

    expect(createMock).toHaveBeenCalledTimes(2);
    const retryRequest = createMock.mock.calls[1][0] as {
      messages: { role: string; content: string }[];
    };
    expect(retryRequest.messages.at(-1)?.content).toContain("That response was invalid");
    expect(retryRequest.messages.at(-1)?.content).toContain("chocolate-cake");

    const card = events.find((e) => e.card)?.card as {
      payload: {
        mode: string;
        groceryList?: string[];
        ingredients: { approvedItemId?: string }[];
      };
    };
    expect(card.payload.mode).toBe("cravings");
    expect(card.payload.ingredients.every((i) => i.approvedItemId)).toBe(true);
    // The server derives grocery lines from the cited items' OFFICIAL names.
    expect(card.payload.groceryList?.length).toBe(2);
    expect(card.payload.groceryList?.[0]).toContain(approvedA.name);
    expect(card.payload.groceryList?.[1]).toContain(approvedB.name);
    expect(events.at(-1)).toEqual({ done: true });
  });

  it("rejects a valid approved id paired with an off-list name, retries, then declines", async () => {
    const approved = APPROVED_CATALOG[0];
    const mislabeled = {
      ...validRecipe,
      meal: "snacks",
      ingredients: [
        { amount: 1, unit: "slice", name: "chocolate cake", approvedItemId: approved.id },
      ],
    };
    createMock
      .mockResolvedValueOnce(completionOf({ reply: "Cake fix.", recipe: mislabeled }))
      .mockResolvedValueOnce(completionOf({ reply: "Cake fix again.", recipe: mislabeled }));

    const events = await chatTurn("I'm craving chocolate cake");

    expect(createMock).toHaveBeenCalledTimes(2);
    const retryRequest = createMock.mock.calls[1][0] as {
      messages: { role: string; content: string }[];
    };
    expect(retryRequest.messages.at(-1)?.content).toContain(
      "does not read as its cited catalog item",
    );
    expect(events.some((e) => e.card)).toBe(false);
    expect(events.find((e) => e.content)?.content).toContain("Approved Foods");
    expect(events.at(-1)).toEqual({ done: true });
  });

  it("accepts the corrected turn after a mislabeled ingredient and ignores model grocery text", async () => {
    const approved = APPROVED_CATALOG[0];
    const mislabeled = {
      ...validRecipe,
      meal: "snacks",
      ingredients: [
        { amount: 1, unit: "slice", name: "chocolate cake", approvedItemId: approved.id },
      ],
    };
    const corrected = {
      ...validRecipe,
      name: "Approved Fix",
      meal: "snacks",
      ingredients: [
        { amount: 4, unit: "oz", name: approved.name.toLowerCase(), approvedItemId: approved.id },
      ],
      // Free-text grocery list from the model must NOT pass through.
      groceryList: ["1 box chocolate cake mix"],
    };
    createMock
      .mockResolvedValueOnce(completionOf({ reply: "Cake fix.", recipe: mislabeled }))
      .mockResolvedValueOnce(completionOf({ reply: "Here is an approved fix.", recipe: corrected }));

    const events = await chatTurn("I'm craving chocolate cake");

    expect(createMock).toHaveBeenCalledTimes(2);
    const card = events.find((e) => e.card)?.card as {
      payload: { groceryList?: string[] };
    };
    expect(card.payload.groceryList).toEqual([`4 oz ${approved.name}`]);
  });

  it("declines honestly without a card when cravings output stays invalid", async () => {
    const badRecipe = {
      ...validRecipe,
      meal: "snacks",
      ingredients: [{ amount: 1, unit: "", name: "candy bar" }],
    };
    createMock
      .mockResolvedValueOnce(completionOf({ reply: "Sweet fix!", recipe: badRecipe }))
      .mockResolvedValueOnce(completionOf({ reply: "Sweet fix again!", recipe: badRecipe }));

    const events = await chatTurn("I have such a craving for candy");

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.card)).toBe(false);
    const reply = events.find((e) => e.content)?.content as string;
    expect(reply).toContain("Approved Foods");
    expect(events.at(-1)).toEqual({ done: true });
  });

  it("passes through a card-less reply when the model returns recipe null", async () => {
    createMock.mockResolvedValueOnce(
      completionOf({ reply: "I do not have that in the THINNR materials.", recipe: null }),
    );

    const events = await chatTurn("recipe for deep fried butter please");

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.card)).toBe(false);
    expect(events.at(-1)).toEqual({ done: true });
  });
});

describe("ingredientNameMatchesItem", () => {
  it("allows preparation words around the cited catalog item", () => {
    const chicken = APPROVED_CATALOG.find((e) => /chicken breast/i.test(e.name));
    expect(chicken).toBeDefined();
    expect(ingredientNameMatchesItem("grilled chicken breast", chicken!.id)).toBe(true);
  });

  it("rejects a different food riding on a valid id", () => {
    const first = APPROVED_CATALOG[0];
    expect(ingredientNameMatchesItem("chocolate cake", first.id)).toBe(false);
  });

  it("rejects names with no catalog anchor word", () => {
    const first = APPROVED_CATALOG[0];
    expect(ingredientNameMatchesItem("fresh slices", first.id)).toBe(false);
  });

  it("tolerates singular/plural differences", () => {
    const berries = APPROVED_CATALOG.find((e) => /strawberr/i.test(e.name));
    if (berries) {
      expect(ingredientNameMatchesItem("sliced strawberry", berries.id)).toBe(true);
    }
  });
});

describe("POST /api/coach/recipe-image", () => {
  function postImage(body: unknown) {
    return fetch(`${baseUrl}/api/coach/recipe-image`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": nextIp(),
      },
      body: JSON.stringify(body),
    });
  }

  it("returns a data-URI JPEG for a valid request", async () => {
    imageMock.mockResolvedValueOnce({ data: [{ b64_json: "aGVsbG8=" }] } as never);
    const res = await postImage({ name: "Baked Salmon Bowl", description: "Flaky salmon." });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { image: string };
    expect(json.image).toBe("data:image/jpeg;base64,aGVsbG8=");
    const params = imageMock.mock.calls[0][0] as { prompt: string; model: string };
    expect(params.model).toBe("gpt-image-1");
    expect(params.prompt).toContain("Baked Salmon Bowl");
    expect(params.prompt).toContain("No people");
  });

  it("rejects an invalid body with 400", async () => {
    const res = await postImage({ description: "no name" });
    expect(res.status).toBe(400);
    expect(imageMock).not.toHaveBeenCalled();
  });

  it("rejects a name that sanitizes to nothing", async () => {
    const res = await postImage({ name: "<<>>" });
    expect(res.status).toBe(400);
    expect(imageMock).not.toHaveBeenCalled();
  });

  it("maps upstream failures to 502", async () => {
    imageMock.mockRejectedValueOnce(new Error("boom"));
    const res = await postImage({ name: "Baked Salmon Bowl" });
    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("Photo generation failed");
  });
});
