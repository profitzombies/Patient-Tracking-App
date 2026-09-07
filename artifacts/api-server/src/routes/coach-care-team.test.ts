/**
 * Care-team (staff) messages in the coach history.
 *
 * Office staff reply into a patient's coach thread from the dashboard. The
 * patient app replays those lines with role "staff"; the model must see them
 * as context (what the care team already said) and never treat one as the
 * turn it answers. Lives in its own file because the route's per-IP burst
 * bucket is shared per process and coach.test.ts already spends it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const createMock = vi.hoisted(() => ({ calls: [] as Array<{ messages: Array<{ role: string; content: unknown }> }> }));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: {
      completions: {
        create: vi.fn(async (params: { messages: Array<{ role: string; content: unknown }> }) => ({
          async *[Symbol.asyncIterator]() {
            createMock.calls.push(params);
            yield { choices: [{ delta: { content: "Grapefruit is approved." } }] };
          },
        })),
      },
    },
  },
}));

import app from "../app";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

function postChat(body: unknown) {
  return fetch(`${baseUrl}/api/coach/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("care-team messages in the coach history", () => {
  it("refuses a history that ends on a care-team message", async () => {
    const res = await postChat({
      messages: [
        { role: "user", content: "Hi" },
        { role: "staff", content: "Skip pasta tonight." },
      ],
    });
    expect(res.status).toBe(400);
    expect(createMock.calls).toHaveLength(0);
  });

  it("shows care-team messages to the model as context only, never as a turn to answer", async () => {
    const res = await postChat({
      messages: [
        { role: "user", content: "Can I have pasta tonight?" },
        { role: "staff", content: "Skip pasta tonight, try zucchini." },
        { role: "user", content: "Is grapefruit approved?" },
      ],
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.trimEnd().endsWith('data: {"done":true}')).toBe(true);
    const sent = createMock.calls.at(-1)?.messages ?? [];
    const asText = (m: { content: unknown }) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
    expect(sent.some((m) => m.role === "staff")).toBe(false);
    const staffTurn = sent.find((m) => asText(m).includes("Skip pasta tonight, try zucchini."));
    expect(staffTurn?.role).toBe("user");
    expect(asText(staffTurn!)).toContain("do not answer it or speak for the care team");
    expect(asText(sent.at(-1)!)).toContain("Is grapefruit approved?");
  });
});
