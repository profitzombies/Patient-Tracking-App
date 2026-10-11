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
 *   6. Menu and label scans ground on the signed-in patient the same way;
 *      account data down → 502 with no model call, never the demo patient.
 *
 * The OpenAI client and the Supabase surfaces are mocked — no credits, no
 * network. Budget: well under the per-IP burst, lifted to 100 for this file.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CONSENT_POLICY_VERSION } from "../privacy/consent";
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
  process.env.COACH_CHAT_BURST = "100";
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
            const system = params.messages
              .filter((m) => m.role === "system" && typeof m.content === "string")
              .map((m) => m.content as string)
              .join("\n\n");
            // The background safety screen reads every real-patient message;
            // it is not part of the turn under test.
            if (system.includes("safety screen inside the THINNR")) return { choices: [{ message: { content: '{"concern":"none"}' } }] };
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
import { demoPatientContext } from "../coach/demo-patient";
import { COACH_PAUSED_MESSAGE } from "./coach";
import { ALLERGY_SEVERITY_CHIPS, LIST_OFFER_CHIPS, listOfferLine } from "../coach/diet-followups";
import { invalidateOrgPolicyCache } from "../lib/org-policy";

/** Valid scan answers for the photo routes' JSON contracts. */
const MENU_NOT_MENU_JSON = JSON.stringify({
  result: "not_menu",
  message: "That looks like a receipt rather than a menu.",
  order: [],
  avoid: [],
});
const LABEL_OK_JSON = JSON.stringify({
  result: "ok",
  message: "Nice, a label I can actually read.",
  label: {
    servingSize: "2/3 cup (55g)",
    servingsPerContainer: 8,
    calories: 230,
    protein: 8,
    carbs: 37,
    fat: 8,
    fiber: 4,
    sugar: 12,
    sodium: 160,
  },
});

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
  /** Consent on record for PATIENT_ID (routes enforce the current version). */
  consent: { version: CONSENT_POLICY_VERSION as string | null, photoAnalysis: true },
  /** HQ policy row served for hq_organization_settings; null = table unreachable (404). */
  coachAvailable: null as boolean | null,
  /** Diet grounding tables for PATIENT_ID (coach/diet-grounding.ts). */
  dietSelections: [] as Array<Record<string, unknown>>,
  preferenceItems: [] as Array<Record<string, unknown>>,
  screeningAnswers: [] as Array<Record<string, unknown>>,
  dietLibrary: [] as Array<Record<string, unknown>>,
  /** Every PATCH/POST the route made against the diet tables (method, pathname, body). */
  dietWrites: [] as Array<{ method: string; pathname: string; body: Record<string, unknown> | null }>,
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
        { id: PATIENT_ID, name: "Riley Chen", program_start_date: "2026-08-10", created_at: "2026-08-10T09:00:00Z", provider_id: null, timezone: null },
      ]);
    }
    return json(200, []);
  }
  if (url.pathname === "/rest/v1/patient_consents") {
    const byPatient = url.searchParams.get("patient_id");
    if (byPatient !== `eq.${PATIENT_ID}` || fake.consent.version === null) return json(200, []);
    return json(200, [
      {
        id: "consent-1",
        patient_id: PATIENT_ID,
        policy_version: fake.consent.version,
        terms_accepted: true,
        privacy_accepted: true,
        health_data_accepted: true,
        photo_analysis_accepted: fake.consent.photoAnalysis,
        app_version: null,
        platform: null,
        recorded_at: "2026-09-01T00:00:00Z",
      },
    ]);
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
  if (url.pathname === "/rest/v1/patient_protocol_episodes" || url.pathname === "/rest/v1/patient_activity_levels") {
    return json(200, []);
  }
  if (url.pathname === "/rest/v1/hq_organization_settings" && fake.coachAvailable !== null) {
    return json(200, [{ coach_available: fake.coachAvailable, version: 1 }]);
  }
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.pathname === "/rest/v1/patient_diet_selections" || url.pathname === "/rest/v1/patient_preference_items") {
    if (method !== "GET") {
      const raw = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
      const body = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | null;
      fake.dietWrites.push({ method, pathname: url.pathname, body });
      if (method === "PATCH" && url.pathname === "/rest/v1/patient_diet_selections") {
        const id = (url.searchParams.get("id") ?? "").replace(/^eq\./, "");
        for (const row of fake.dietSelections) if (row.id === id && body) Object.assign(row, body);
      }
      if (method === "POST" && url.pathname === "/rest/v1/patient_preference_items") {
        if (fake.preferenceItems.some((item) => item.list === body?.list && item.item_key === body?.item_key)) {
          return json(409, { message: "duplicate" });
        }
        const row = { id: `pref-${fake.dietWrites.length}`, created_at: "2026-08-22T12:00:00Z", ...body };
        fake.preferenceItems.push(row);
        return json(201, [row]);
      }
      return new Response(null, { status: 204 });
    }
    if (url.searchParams.get("patient_id") !== `eq.${PATIENT_ID}`) return json(200, []);
    return json(200, url.pathname === "/rest/v1/patient_diet_selections" ? fake.dietSelections : fake.preferenceItems);
  }
  if (url.pathname === "/rest/v1/patient_screening_answers") return json(200, fake.screeningAnswers);
  if (url.pathname === "/rest/v1/diet_library_entries") return json(200, fake.dietLibrary);
  if (url.pathname === "/rest/v1/diet_library_settings") return json(200, []);
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
  fake.consent = { version: CONSENT_POLICY_VERSION, photoAnalysis: true };
  fake.coachAvailable = null;
  fake.dietSelections = [];
  fake.preferenceItems = [];
  fake.screeningAnswers = [];
  fake.dietLibrary = [];
  fake.dietWrites = [];
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

  it("refuses a patient with no current consent — 403 CONSENT_REQUIRED, never the demo fallback", async () => {
    fake.consent.version = null;
    const missing = await postChat({ ...QUESTION, localDate: "2026-08-22" }, "tok-patient");
    expect(missing.status).toBe(403);
    expect(await missing.json()).toEqual({
      error: expect.any(String),
      code: "CONSENT_REQUIRED",
      consent: expect.objectContaining({ requiredVersion: CONSENT_POLICY_VERSION, recordedVersion: null, satisfied: false }),
      retryable: false,
    });

    fake.consent.version = "2020-01-01";
    const outdated = await postChat({ ...QUESTION, localDate: "2026-08-22" }, "tok-patient");
    expect(outdated.status).toBe(403);
    expect(((await outdated.json()) as { code?: string }).code).toBe("CONSENT_REQUIRED");
    expect(modelState.calls).toHaveLength(0);
  });

  it("keeps photos away from the model when the patient declined photo analysis", async () => {
    fake.consent.photoAnalysis = false;
    const photoTurn = {
      messages: [{ role: "user", content: "What's in this?", image: "data:image/jpeg;base64,dGVzdA==", photoKind: "meal" }],
      localDate: "2026-08-22",
    };
    const chat = await postChat(photoTurn, "tok-patient");
    expect(chat.status).toBe(403);
    expect(await chat.json()).toEqual({
      error: expect.stringContaining("Photo analysis is off"),
      code: "PHOTO_ANALYSIS_OPT_IN_REQUIRED",
      consent: expect.objectContaining({ satisfied: true, photoAnalysis: false }),
      retryable: false,
    });

    for (const path of ["/api/coach/menu-scan", "/api/coach/label-scan"]) {
      const scan = await realFetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tok-patient" },
        body: JSON.stringify({ image: "data:image/jpeg;base64,dGVzdA==" }),
      });
      expect(scan.status, path).toBe(403);
      expect(((await scan.json()) as { code?: string }).code, path).toBe("PHOTO_ANALYSIS_OPT_IN_REQUIRED");
    }
    expect(modelState.calls).toHaveLength(0);

    // Text turns are unaffected by the photo choice.
    const text = await postChat({ ...QUESTION, localDate: "2026-08-22" }, "tok-patient");
    expect(text.status).toBe(200);
    await text.text();
    expect(modelState.calls).toHaveLength(1);
  });

  it("gates the scan routes on consent too, while a bad session stays 401", async () => {
    fake.consent.version = null;
    const scan = await realFetch(`${baseUrl}/api/coach/menu-scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok-patient" },
      body: JSON.stringify({ image: "data:image/jpeg;base64,dGVzdA==" }),
    });
    expect(scan.status).toBe(403);
    expect(((await scan.json()) as { code?: string }).code).toBe("CONSENT_REQUIRED");

    const bad = await realFetch(`${baseUrl}/api/coach/label-scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok-nobody" },
      body: JSON.stringify({ image: "data:image/jpeg;base64,dGVzdA==" }),
    });
    expect(bad.status).toBe(401);
    expect(modelState.calls).toHaveLength(0);
  });

  it("grounds signed-in menu and label scans on the patient's own account, never the demo patient", async () => {
    const demoLine = `Patient context: ${demoPatientContext().firstName} is on day`;
    const postScan = (path: string, token?: string) =>
      realFetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ image: "data:image/jpeg;base64,dGVzdA==" }),
      });

    modelState.scanQueue = [MENU_NOT_MENU_JSON];
    const menu = await postScan("/api/coach/menu-scan", "tok-patient");
    expect(menu.status).toBe(200);
    expect(modelState.calls).toHaveLength(1);
    expect(modelState.calls[0].system).toContain("Patient context: Riley is on day");
    expect(modelState.calls[0].system).toContain("Riley has logged 500 of 1400 calories");
    expect(modelState.calls[0].system).not.toContain(demoLine);

    modelState.calls = [];
    modelState.scanQueue = [LABEL_OK_JSON];
    const label = await postScan("/api/coach/label-scan", "tok-patient");
    expect(label.status).toBe(200);
    expect(((await label.json()) as { result?: string }).result).toBe("ok");
    expect(modelState.calls).toHaveLength(1);
    expect(modelState.calls[0].system).toContain("Patient context: Riley is on day");
    expect(modelState.calls[0].system).not.toContain(demoLine);

    // Account data down: an honest retryable failure, no model call, and
    // never a quiet fallback to the demo patient.
    modelState.calls = [];
    fake.failOnce.add("patient_diary_entries");
    const down = await postScan("/api/coach/menu-scan", "tok-patient");
    expect(down.status).toBe(502);
    expect(((await down.json()) as { error?: string }).error).toMatch(/unavailable right now/);
    expect(modelState.calls).toHaveLength(0);

    // No session: the fixed demo seed, exactly as before.
    modelState.scanQueue = [MENU_NOT_MENU_JSON];
    const anonymous = await postScan("/api/coach/menu-scan");
    expect(anonymous.status).toBe(200);
    expect(modelState.calls).toHaveLength(1);
    expect(modelState.calls[0].system).toContain(demoLine);
    expect(modelState.calls[0].system).not.toContain("Riley");
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

// ── Diet grounding, confirm-to-add and the diet-change acknowledgement ──────

const MEDITERRANEAN_ROW = {
  id: "lib-med", slug: "mediterranean", name: "Mediterranean", summary: "Olive oil, fish, vegetables.", complexity: "easy",
  rule_sheet: ["Olive oil is the main fat."], sample_day: [], oversight_note: false, pregnancy_blocked: false,
  screening_questions: [], fit_rules: null, evidence_strength: "strong", supervision_level: "none", sources: [], review_status: "approved",
};

function seedDiet(options: { acknowledged?: boolean } = {}) {
  fake.dietLibrary = [MEDITERRANEAN_ROW];
  fake.dietSelections = [{
    id: "sel-1", patient_id: PATIENT_ID, diet_slug: "mediterranean", status: "active", settings: {},
    started_at: "2026-08-20T00:00:00Z", coach_acknowledged_at: options.acknowledged ? "2026-08-20T01:00:00Z" : null,
  }];
  fake.preferenceItems = [{
    id: "pref-peanut", patient_id: PATIENT_ID, list: "allergy", item_key: "peanut", label: "Peanuts", is_custom: false,
    severity: "severe", entered_by_role: "patient", entered_by_name: null, created_at: "2026-08-20T00:00:00Z",
  }];
}

async function chatText(body: unknown, token?: string) {
  const res = await postChat(body, token);
  expect(res.status).toBe(200);
  const events = sseEvents(await res.text());
  const content = events.map((e) => (typeof e.content === "string" ? e.content : "")).join("");
  const quickReplies = events.find((e) => Array.isArray(e.quickReplies))?.quickReplies as string[] | undefined;
  return { events, content, quickReplies };
}

describe("coach diet grounding for real accounts", () => {
  it("renders the diet, lists and targets into the real system prompt only; demo and staff prompts never carry it", async () => {
    seedDiet({ acknowledged: true });
    await chatText({ ...QUESTION, localDate: "2026-08-22" }, "tok-patient");
    expect(modelState.calls).toHaveLength(1);
    const system = modelState.calls[0].system;
    const dietAt = system.indexOf("Diet and food lists (authoritative");
    expect(dietAt).toBeGreaterThan(system.indexOf("Today so far (2026-08-22)"));
    expect(dietAt).toBeLessThan(system.indexOf("Grounding rules:"));
    expect(system).toContain("- Diet: Mediterranean (complexity: easy). Olive oil, fish, vegetables.");
    expect(system).toContain("  • Olive oil is the main fat.");
    expect(system).toContain("- Allergies: Peanuts (SEVERE).");
    expect(system).toContain("- Dislikes: none recorded.");
    expect(system).toContain("1400 calories, 120g protein");

    modelState.calls = [];
    await chatText(QUESTION);
    await chatText(QUESTION, "tok-staff");
    expect(modelState.calls).toHaveLength(2);
    for (const call of modelState.calls) expect(call.system).not.toContain("Diet and food lists");
  });

  it("opens the first reply after a diet change with one acknowledgement, stamps it, and never repeats it", async () => {
    seedDiet();
    const first = await chatText({ ...QUESTION, localDate: "2026-08-22" }, "tok-patient");
    expect(first.content.startsWith("Quick note: I see you're following Mediterranean now")).toBe(true);
    expect(first.content.endsWith("Hello there.")).toBe(true);
    // The stamp is fire-and-forget after the stream closes.
    await vi.waitFor(() => expect(fake.dietWrites.some((w) => w.method === "PATCH" && w.pathname === "/rest/v1/patient_diet_selections")).toBe(true));
    const patch = fake.dietWrites.find((w) => w.method === "PATCH")!;
    expect(typeof patch.body?.coach_acknowledged_at).toBe("string");
    expect(fake.dietSelections[0]!.coach_acknowledged_at).toBe(patch.body?.coach_acknowledged_at);

    modelState.calls = [];
    const second = await chatText({ ...QUESTION, localDate: "2026-08-22" }, "tok-patient");
    expect(second.content).toBe("Hello there.");
    expect(second.content).not.toContain("Quick note");
  });

  it("offers to add a mentioned dislike after the model reply and sends the confirm chips", async () => {
    seedDiet({ acknowledged: true });
    const turn = await chatText({ messages: [{ role: "user", content: "Honestly I hate broccoli, what else is green?" }], localDate: "2026-08-22" }, "tok-patient");
    expect(modelState.calls).toHaveLength(1);
    expect(turn.content).toBe(`Hello there.\n\n${listOfferLine({ list: "dislike", label: "broccoli" })}`);
    expect(turn.quickReplies).toEqual(LIST_OFFER_CHIPS);
    expect(fake.dietWrites).toHaveLength(0);

    // Mentioning a food that is already listed earns no offer.
    modelState.calls = [];
    const listed = await chatText({ messages: [{ role: "user", content: "I'm allergic to peanuts, remember" }], localDate: "2026-08-22" }, "tok-patient");
    expect(listed.content).toBe("Hello there.");
    expect(listed.quickReplies).toBeUndefined();

    // The demo persona never hears the offer.
    modelState.calls = [];
    const demo = await chatText({ messages: [{ role: "user", content: "Honestly I hate broccoli, what else is green?" }] });
    expect(demo.content).toBe("Hello there.");
    expect(demo.quickReplies).toBeUndefined();
  });

  it("writes the list item through the foundation store with the coach as entered-by on confirmation, with no model call", async () => {
    seedDiet({ acknowledged: true });
    const confirm = await chatText({
      messages: [
        { role: "user", content: "Honestly I hate broccoli" },
        { role: "assistant", content: `Fair enough.\n\n${listOfferLine({ list: "dislike", label: "broccoli" })}` },
        { role: "user", content: LIST_OFFER_CHIPS[0] },
      ],
      localDate: "2026-08-22",
    }, "tok-patient");
    expect(modelState.calls).toHaveLength(0);
    expect(confirm.content).toMatch(/^Done\. Broccoli is on your dislikes now/);
    const post = fake.dietWrites.find((w) => w.method === "POST" && w.pathname === "/rest/v1/patient_preference_items");
    expect(post?.body).toMatchObject({ patient_id: PATIENT_ID, list: "dislike", item_key: "custom:broccoli", label: "broccoli", is_custom: true, entered_by_role: "coach", severity: null });

    // Allergies ask for the severity first, then write it.
    modelState.calls = [];
    const ask = await chatText({
      messages: [
        { role: "assistant", content: `Noted.\n\n${listOfferLine({ list: "allergy", label: "shellfish" })}` },
        { role: "user", content: LIST_OFFER_CHIPS[0] },
      ],
      localDate: "2026-08-22",
    }, "tok-patient");
    expect(ask.content).toMatch(/Is your shellfish allergy mild or severe\?$/);
    expect(ask.quickReplies).toEqual(ALLERGY_SEVERITY_CHIPS);
    const severe = await chatText({
      messages: [
        { role: "assistant", content: ask.content },
        { role: "user", content: ALLERGY_SEVERITY_CHIPS[1] },
      ],
      localDate: "2026-08-22",
    }, "tok-patient");
    expect(severe.content).toMatch(/as severe\./);
    const allergyPost = fake.dietWrites.filter((w) => w.method === "POST").at(-1);
    // The spoken label lands on the catalog key, so tag rules apply to it.
    expect(allergyPost?.body).toMatchObject({ list: "allergy", item_key: "shellfish", label: "Shellfish", is_custom: false, severity: "severe", entered_by_role: "coach" });
    expect(modelState.calls).toHaveLength(0);

    // Declining writes nothing and the next turn is an ordinary model reply.
    const declined = await chatText({
      messages: [
        { role: "assistant", content: listOfferLine({ list: "dislike", label: "kale" }) },
        { role: "user", content: LIST_OFFER_CHIPS[1] },
      ],
      localDate: "2026-08-22",
    }, "tok-patient");
    expect(modelState.calls).toHaveLength(0);
    expect(fake.dietWrites.filter((w) => w.method === "POST")).toHaveLength(2);
    expect(declined.content).not.toMatch(/^Done/);
  });
});
