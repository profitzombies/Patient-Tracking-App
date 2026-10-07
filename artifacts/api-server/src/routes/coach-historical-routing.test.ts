import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  modelRequests: [] as Array<{ messages?: Array<{ role: string; content: string }> }>,
  recipe: vi.fn(),
  resolve: vi.fn(),
  authorize: vi.fn(),
  historical: vi.fn(),
}));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: {
      completions: {
        create: vi.fn(async (request: { messages?: Array<{ role: string; content: string }> }) => {
          // The background safety screen is not part of the turn under test.
          if (request.messages?.some((m) => m.role === "system" && typeof m.content === "string" && m.content.includes("safety screen inside the THINNR"))) {
            return { choices: [{ message: { content: '{"concern":"none"}' } }] };
          }
          state.modelRequests.push(request);
          return {
            async *[Symbol.asyncIterator]() {
              yield { choices: [{ delta: { content: "You previously mentioned vegan recipes." } }] };
            },
          };
        }),
      },
    },
  },
}));
vi.mock("../lib/patient-auth", () => ({
  bearerToken: (req: { headers: { authorization?: string } }) => req.headers.authorization ? "patient-token" : null,
  resolvePatient: state.resolve,
}));
vi.mock("../coach/real-patient", () => ({
  realPatientContext: vi.fn(async () => ({ firstName: "Riley", programDay: 5, phaseName: "Protocol" })),
}));
vi.mock("../lib/org-policy", () => ({ loadOrgPolicy: vi.fn(async () => ({ coachAvailable: true })) }));
vi.mock("../coach/memory-recall", () => ({
  authorizeCoachGeneration: state.authorize,
  recallCoachMemories: vi.fn(async () => []),
}));
vi.mock("../coach/historical-excerpts", () => ({ recallHistoricalExcerpts: state.historical }));
vi.mock("../coach/recipe", () => ({
  generateRecipeTurn: state.recipe,
}));

const CONVERSATION = "00000000-0000-4000-8000-000000000010";
let server: Server;
let baseUrl = "";

beforeAll(async () => {
  const { default: router } = await import("./coach");
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { log: { info: () => void; warn: () => void; error: () => void } }).log = {
      info: () => {}, warn: () => {}, error: () => {},
    };
    next();
  });
  app.use("/api", router);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, error => error ? reject(error) : resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The router's module graph is transformed on first import here; under a
  // loaded machine that alone can pass vitest's default 10 s hook budget.
}, 60_000);
afterAll(() => server.close());

/** Every system message the request carried (stable prefix + per-turn block). */
const systemText = (request: { messages?: Array<{ role: string; content: string }> } | undefined) =>
  (request?.messages ?? []).filter((m) => m.role === "system").map((m) => m.content).join("\n\n");

beforeEach(() => {
  state.modelRequests.length = 0;
  state.resolve.mockReset().mockResolvedValue({ ok: true, patientId: "00000000-0000-4000-8000-000000000001" });
  state.authorize.mockReset().mockResolvedValue("ok");
  state.historical.mockReset().mockResolvedValue({
    excerpts: ["I asked for vegan recipes with chickpeas."], clarification: false,
  });
  state.recipe.mockReset().mockResolvedValue({ reply: "new recipe", card: null });
});

describe("Coach earlier-chat routing", () => {
  it("answers a historical recipe question through bounded recall instead of opening a recipe pipeline", async () => {
    const response = await fetch(`${baseUrl}/api/coach/chat`, {
      method: "POST",
      headers: { authorization: "Bearer patient", "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: CONVERSATION,
        messages: [{ role: "user", content: "What did I say in the previous chat about vegan recipes?" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("You previously mentioned vegan recipes.");
    expect(state.recipe).not.toHaveBeenCalled();
    expect(systemText(state.modelRequests[0])).toContain("I asked for vegan recipes with chickpeas.");
  });

  it("asks for an earlier-chat topic clarification before any specialized pipeline", async () => {
    state.historical.mockResolvedValueOnce({ excerpts: [], clarification: true });
    const response = await fetch(`${baseUrl}/api/coach/chat`, {
      method: "POST",
      headers: { authorization: "Bearer patient", "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: CONVERSATION,
        messages: [{ role: "user", content: "Could you use something from a previous conversation for a recipe?" }],
      }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(state.recipe).not.toHaveBeenCalled();
    expect(systemText(state.modelRequests[0])).toContain("referred ambiguously to an earlier conversation");
  });
});