/**
 * Route tests for real-account grounding inside POST /api/coach/chat.
 *
 * A coach request carrying a patient's bearer session must be answered from
 * THAT patient's live account — their name, program day, and today's diary
 * numbers — while everything else keeps the demo seed exactly as before.
 * The auth ladder runs BEFORE the SSE stream opens, so failures are plain
 * JSON statuses and a real patient is never silently grounded on demo data:
 *
 *   1. No token → demo persona, byte-identical prompt path (no today line).
 *   2. Patient token → system prompt speaks to the real patient with the
 *      live "Today so far" block at the app's own calendar date.
 *   3. Staff token (session valid, no patients row) → demo persona; that IS
 *      what a provider browsing the persona is looking at.
 *   4. Invalid token → 401; auth outage → 503; account data down → 502.
 *      All JSON, all retryable, no stream.
 *   5. The demo-only back-on-track pipeline never fires for real accounts.
 *
 * The OpenAI client and the Supabase surfaces are mocked — no credits, no
 * network. Budget: 12 chat requests (per-IP burst lifted to 40 for this file).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";

// Env must exist before any module under test evaluates (vi.hoisted runs
// ahead of the hoisted imports; supabase-admin reads env lazily, but this
// keeps the file honest either way).
vi.hoisted(() => {
  process.env.SUPABASE_URL = "http://fake.supabase.local";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  // Twelve chat posts in one file: lift the per-IP burst so the limiter never
  // interferes (its own behavior is covered elsewhere).
  process.env.COACH_CHAT_BURST = "40";
});

const modelState = vi.hoisted(() => ({
  /** Non-streaming answers consumed in order; the last one repeats when exhausted. */
  scanQueue: [] as string[],
  chunks: ["Hello ", "there."],
  calls: [] as Array<{ stream: boolean; system: string }>,
}));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: {
      completions: {
        create: vi.fn(
          async (params: {
            stream?: boolean;
            messages: Array<{ role: string; content: unknown }>;
          }) => {
            const system =
              typeof params.messages[0]?.content === "string"
                ? (params.messages[0].content as string)
                : "";
            modelState.calls.push({ stream: params.stream === true, system });
            if (params.stream === true) {
              return {
                async *[Symbol.asyncIterator]() {
                  for (const content of modelState.chunks) {
                    yield { choices: [{ delta: { content } }] };
                  }
                },
              };
            }
            const content =
              modelState.scanQueue.length > 1
                ? (modelState.scanQueue.shift() as string)
                : (modelState.scanQueue[0] ?? "");
            return { choices: [{ message: { content } }] };
          },
        ),
      },
    },
  },
}));

import app from "../app";
import { BACK_ON_TRACK_OFFER } from "../coach/back-on-track";
import { COACH_PAUSED_MESSAGE } from "./coach";
import { invalidateOrgPolicyCache } from "../lib/org-policy";

// ── Fake Supabase account data ───────────────────────────────────────────────

const PATIENT_ID = crypto.randomUUID();
const PATIENT_USER = crypto.randomUUID();
const STAFF_USER = crypto.randomUUID();

const fake = {
  tokens: new Map<string, string>([
    ["tok-patient", PATIENT_USER],
    ["tok-staff", STAFF_USER],
  ]),
  authOutage: false,
  /** pathname substrings that fail once with a 500 */
  failOnce: new Set<string>(),
  /** HQ policy row served for hq_organization_settings; null = table unreachable (404). */
  coachAvailable: null as boolean | null,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function handleSupabase(url: URL, init?: RequestInit): Response {
  const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
  if (url.pathname === "/auth/v1/user") {
    if (fake.authOutage) return json(500, { error: "outage" });
    const token = (headers.get("authorization") ?? "").replace(/^Bearer /i, "");
    const userId = fake.tokens.get(token);
    if (!userId) return json(401, { message: "invalid token" });
    return json(200, { id: userId, email: null, phone: null });
  }
  for (const key of fake.failOnce) {
    if (url.pathname.includes(key)) {
      fake.failOnce.delete(key);
      return json(500, { message: "fake upstream failure" });
    }
  }
  if (url.pathname === "/rest/v1/patients") {
    const byUser = url.searchParams.get("auth_user_id");
    if (byUser === `eq.${PATIENT_USER}`) return json(200, [{ id: PATIENT_ID }]);
    if (byUser !== null) return json(200, []);
    const byId = url.searchParams.get("id");
    if (byId === `eq.${PATIENT_ID}`) {
      return json(200, [
        { name: "Riley Chen", program_start_date: "2026-08-10", created_at: "2026-08-10T09:00:00Z" },
      ]);
    }
    return json(200, []);
  }
  if (url.pathname === "/rest/v1/patient_diary_entries") {
    return json(200, [
      { calories: 300, protein: 30, carbs: 20, fat: 10 },
      { calories: 200, protein: 20, carbs: 10, fat: 5 },
    ]);
  }
  if (url.pathname === "/rest/v1/patient_water_days") {
    return json(200, [{ oz: 40 }]);
  }
  if (url.pathname === "/rest/v1/patient_target_overrides") {
    return json(200, [{ calories: 1400 }]);
  }
  if (url.pathname === "/rest/v1/hq_organization_settings" && fake.coachAvailable !== null) {
    return json(200, [{ coach_available: fake.coachAvailable, version: 1 }]);
  }
  return json(404, { message: `fake: no route ${url.pathname}` });
}

// ── Server plumbing ──────────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;
const realFetch = globalThis.fetch.bind(globalThis);

beforeAll(async () => {
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    if (url.hostname === "fake.supabase.local") {
      return Promise.resolve(handleSupabase(url, init));
    }
    return realFetch(input as string, init);
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

afterEach(() => {
  modelState.scanQueue = [];
  modelState.chunks = ["Hello ", "there."];
  modelState.calls = [];
  fake.authOutage = false;
  fake.failOnce.clear();
  fake.coachAvailable = null;
  invalidateOrgPolicyCache();
});

function getAvailability(token?: string) {
  return realFetch(`${baseUrl}/api/coach/availability`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

function postChat(body: unknown, token?: string) {
  return realFetch(`${baseUrl}/api/coach/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function sseEvents(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

const QUESTION = { messages: [{ role: "user", content: "How am I doing today?" }] };

describe("coach chat grounding ladder", () => {
  it("grounds tokenless requests on the demo seed with no today line", async () => {
    const res = await postChat(QUESTION);
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());
    expect(events.at(-1)).toEqual({ done: true });
    expect(modelState.calls).toHaveLength(1);
    expect(modelState.calls[0].system).toContain("Emma");
    expect(modelState.calls[0].system).not.toContain("Today so far");
  });

  it("grounds a patient session on THEIR live account at the app's own date", async () => {
    const res = await postChat({ ...QUESTION, localDate: "2026-08-22" }, "tok-patient");
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());
    expect(events.at(-1)).toEqual({ done: true });
    expect(modelState.calls).toHaveLength(1);
    const system = modelState.calls[0].system;
    expect(system).toContain("Riley is on day 12");
    expect(system).toContain("Today so far (2026-08-22)");
    expect(system).toContain("500 of 1400 calories");
    expect(system).toContain("50g of 120g protein");
    expect(system).toContain("40 of 64 oz water");
    expect(system).not.toContain("Emma");
  });

  it("lets a staff session browse the demo persona unchanged", async () => {
    const res = await postChat(QUESTION, "tok-staff");
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());
    expect(events.at(-1)).toEqual({ done: true });
    expect(modelState.calls[0].system).toContain("Emma");
    expect(modelState.calls[0].system).not.toContain("Today so far");
  });

  it("answers a bad session 401 and an auth outage 503 — plain JSON, no stream", async () => {
    const bad = await postChat(QUESTION, "tok-nobody");
    expect(bad.status).toBe(401);
    expect(bad.headers.get("content-type")).toContain("application/json");
    expect(await bad.json()).toEqual({ error: "Sign in required.", retryable: true });

    fake.authOutage = true;
    const outage = await postChat(QUESTION, "tok-patient");
    expect(outage.status).toBe(503);
    expect(await outage.json()).toEqual({
      error: "Account lookup is unavailable right now.",
      retryable: true,
    });
    expect(modelState.calls).toHaveLength(0);
  });

  it("answers 502 when the account's data cannot be loaded — never demo fallback", async () => {
    fake.failOnce.add("patient_diary_entries");
    const res = await postChat({ ...QUESTION, localDate: "2026-08-22" }, "tok-patient");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "Couldn't load your account right now. Please try again.",
      retryable: true,
    });
    expect(modelState.calls).toHaveLength(0);
  });

  it("honors the HQ coach-availability policy for real patients only, before any model call", async () => {
    fake.coachAvailable = false;
    const paused = await postChat({ ...QUESTION, localDate: "2026-08-22" }, "tok-patient");
    expect(paused.status).toBe(503);
    expect(paused.headers.get("content-type")).toContain("application/json");
    expect(await paused.json()).toEqual({ error: COACH_PAUSED_MESSAGE, retryable: false, coachPaused: true });
    expect(modelState.calls).toHaveLength(0);

    // The demo persona (no token) and staff browsing it are never paused.
    expect((await postChat(QUESTION)).status).toBe(200);
    expect((await postChat(QUESTION, "tok-staff")).status).toBe(200);

    // The availability probe mirrors the gate so the app can show the state up front.
    expect(await (await getAvailability("tok-patient")).json()).toEqual({ available: false, message: COACH_PAUSED_MESSAGE });
    expect(await (await getAvailability()).json()).toEqual({ available: true, message: null });
    expect(await (await getAvailability("tok-staff")).json()).toEqual({ available: true, message: null });
    expect((await getAvailability("tok-nobody")).status).toBe(401);

    // Turned back on: the policy cache was invalidated by the save path; a
    // fresh read serves the patient again.
    invalidateOrgPolicyCache();
    fake.coachAvailable = true;
    expect(await (await getAvailability("tok-patient")).json()).toEqual({ available: true, message: null });
  });

  it("keeps the back-on-track pipeline demo-only", async () => {
    const trigger = {
      messages: [
        { role: "assistant", content: `Checking in.\n\n${BACK_ON_TRACK_OFFER}` },
        { role: "user", content: "Yes, set me up" },
      ],
    };
    // Real account: plain streaming chat, never the non-streaming scan.
    const real = await postChat({ ...trigger, localDate: "2026-08-22" }, "tok-patient");
    expect(real.status).toBe(200);
    await real.text();
    expect(modelState.calls).toHaveLength(1);
    expect(modelState.calls[0].stream).toBe(true);
    expect(modelState.calls[0].system).toContain("Riley");

    // Same history with no token: the demo pipeline takes the grounded turn
    // (a non-streaming model call), exactly as before this feature.
    modelState.calls = [];
    modelState.scanQueue = ["Here is the reset plan, kept simple."];
    const demo = await postChat(trigger);
    expect(demo.status).toBe(200);
    await demo.text();
    expect(modelState.calls.length).toBeGreaterThan(0);
    expect(modelState.calls[0].stream).toBe(false);
  });
});
