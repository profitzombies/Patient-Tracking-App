/**
 * Server-side enforcement of the office app-access rule on every premium
 * route, in one module graph with the entitlement read stubbed:
 *
 *   - a LOCKED signed-in patient gets the distinct, non-retryable 402
 *     upgrade payload from coach chat/stream, menu reads, label reads,
 *     recipe-image generation and barcode lookup — before any model call or
 *     upstream lookup;
 *   - HQ's coach-paused state is checked first and wins with its own 503;
 *   - the demo persona (no bearer) and staff browsing it never meet the gate;
 *   - an entitlement outage fails OPEN (a payments problem must not take the
 *     coach away from paying or still-free patients).
 */
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AppAccessEntitlement } from "../billing/app-access/entitlement";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const PROVIDER_ID = "office-1";

const state = vi.hoisted(() => ({
  /** Entitlement served to the gate; null = patient row missing; "throw" = read failure. */
  entitlement: null as unknown,
  coachAvailable: true,
  /** Whether the bearer resolves to a real patient (true) or to staff browsing the persona (false). */
  bearerIsPatient: true,
  modelCalls: 0,
  imageCalls: 0,
  entitlementReads: [] as string[],
}));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    images: {
      generate: vi.fn(async () => {
        state.imageCalls += 1;
        return { data: [{ b64_json: Buffer.from("jpeg").toString("base64") }] };
      }),
    },
    chat: {
      completions: {
        create: vi.fn(async (params: { stream?: boolean }) => {
          state.modelCalls += 1;
          if (params.stream) {
            return { async *[Symbol.asyncIterator]() { yield { choices: [{ delta: { content: "hi" } }] }; } };
          }
          return { choices: [{ message: { content: JSON.stringify({ result: "not_menu", message: "no", order: [], avoid: [] }) } }] };
        }),
      },
    },
  },
}));

vi.mock("../billing/app-access/service", () => ({
  patientAppAccess: vi.fn(async (patientId: string) => {
    state.entitlementReads.push(patientId);
    if (state.entitlement === "throw") throw new Error("billing tables unreachable");
    if (state.entitlement === null) return null;
    return { patient: { id: patientId }, entitlement: state.entitlement, subscription: null };
  }),
}));

vi.mock("../lib/org-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/org-policy")>();
  return {
    ...actual,
    loadOrgPolicy: vi.fn(async () => ({ ...actual.DEFAULT_ORG_POLICY, coachAvailable: state.coachAvailable })),
  };
});

vi.mock("../lib/patient-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/patient-auth")>();
  const bearer = (req: { headers: Record<string, unknown> }) => actual.bearerToken(req);
  const resolvePatient = vi.fn(async (req: { headers: Record<string, unknown> }) => {
    if (bearer(req) === null) return { ok: false as const, status: 401, error: "Sign in first." };
    if (!state.bearerIsPatient) return { ok: false as const, status: 403, error: "Not a patient account." };
    return {
      ok: true as const, patientId: PATIENT_ID, authUserId: "user-1", providerId: PROVIDER_ID,
      consent: { satisfied: true, version: "v", photoAnalysis: true },
    };
  });
  return {
    ...actual,
    resolvePatient,
    // The recipe-image route resolves identity only (no consent gate).
    resolvePatientIdentity: vi.fn(async (req: { headers: Record<string, unknown> }) => {
      const auth = await resolvePatient(req);
      return auth.ok ? { ok: true as const, patientId: auth.patientId, authUserId: auth.authUserId, providerId: auth.providerId } : auth;
    }),
    gatePhotoAnalysis: vi.fn(async (req: { headers: Record<string, unknown> }) => {
      if (bearer(req) === null) return { ok: true as const, patientId: null, providerId: null };
      const auth = await resolvePatient(req);
      if (auth.ok) return { ok: true as const, patientId: auth.patientId, providerId: auth.providerId };
      if (auth.status === 403) return { ok: true as const, patientId: null, providerId: null };
      return { ok: false as const, status: auth.status, body: { error: auth.error } };
    }),
  };
});

// The signed-in account's context is not under test: serve the demo persona's
// shape so an entitled patient's scan can reach the (stubbed) model.
vi.mock("../coach/real-patient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../coach/real-patient")>();
  const { demoPatientContext } = await import("../coach/demo-patient");
  return { ...actual, realPatientContext: vi.fn(async () => demoPatientContext()) };
});

const barcode = vi.hoisted(() => ({
  getBarcodeFactsRecord: vi.fn(async (code: string) => ({
    code, name: "Cached Product", brand: null, serving: "30 g", calories: 100, protein: 1, carbs: 2, fat: 3, source: "openfoodfacts",
  })),
  upsertBarcodeFactsRecord: vi.fn(async () => {}),
  fetchOffProduct: vi.fn(),
}));
vi.mock("../barcode/facts-store", () => ({
  getBarcodeFactsRecord: barcode.getBarcodeFactsRecord,
  upsertBarcodeFactsRecord: barcode.upsertBarcodeFactsRecord,
}));
vi.mock("../barcode/off", () => ({ fetchOffProduct: barcode.fetchOffProduct }));

import app from "../app";
import { UPGRADE_REQUIRED_MESSAGE } from "../billing/app-access/gate";
import { COACH_PAUSED_MESSAGE } from "./coach";

const LOCKED: AppAccessEntitlement = {
  available: false, reason: "locked",
  free_window: { kind: "trial", ends_on: "2026-03-07" },
  office_charges: true, price_cents: 699, cadence: "2_weeks", subscription: null,
};
const OPEN: AppAccessEntitlement = { ...LOCKED, available: true, reason: "trial" };

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))));

afterEach(() => {
  state.entitlement = null;
  state.coachAvailable = true;
  state.bearerIsPatient = true;
  state.modelCalls = 0;
  state.imageCalls = 0;
  state.entitlementReads = [];
  barcode.getBarcodeFactsRecord.mockClear();
});

const IMAGE = "data:image/jpeg;base64,dGVzdA==";
const headers = (token: string | null) => ({
  "Content-Type": "application/json",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});
const post = (path: string, body: unknown, token: string | null = "tok") =>
  fetch(`${baseUrl}/api${path}`, { method: "POST", headers: headers(token), body: JSON.stringify(body) });
const chat = (token: string | null = "tok") => post("/coach/chat", { messages: [{ role: "user", content: "Hi" }], localDate: "2026-03-10" }, token);
const menu = (token: string | null = "tok") => post("/coach/menu-scan", { image: IMAGE }, token);
const label = (token: string | null = "tok") => post("/coach/label-scan", { image: IMAGE }, token);
const recipeImage = (token: string | null = "tok") => post("/coach/recipe-image", { name: "Lemon chicken", description: "Grilled" }, token);
const lookup = (token: string | null = "tok") => fetch(`${baseUrl}/api/barcode/3017624010701`, { headers: headers(token) });

const UPGRADE_BODY = { error: UPGRADE_REQUIRED_MESSAGE, retryable: false, upgradeRequired: true, entitlement: LOCKED };

describe("app-access gate on premium routes", () => {
  it("refuses a locked patient with the 402 upgrade payload on every premium route, before any model work", async () => {
    state.entitlement = LOCKED;
    for (const [name, call] of [["chat", chat], ["menu", menu], ["label", label], ["recipe-image", recipeImage], ["barcode", lookup]] as const) {
      const res = await call();
      expect(res.status, name).toBe(402);
      expect(res.headers.get("content-type"), name).toContain("application/json");
      expect(await res.json(), name).toEqual(UPGRADE_BODY);
    }
    expect(state.modelCalls).toBe(0);
    expect(state.imageCalls).toBe(0);
    expect(barcode.getBarcodeFactsRecord).not.toHaveBeenCalled();
    expect(state.entitlementReads).toEqual([PATIENT_ID, PATIENT_ID, PATIENT_ID, PATIENT_ID, PATIENT_ID]);
  });

  it("lets an entitled patient through to the premium work", async () => {
    state.entitlement = OPEN;
    expect((await menu()).status).toBe(200);
    expect(state.modelCalls).toBe(1);
    expect((await recipeImage()).status).toBe(200);
    expect(state.imageCalls).toBe(1);
    expect((await lookup()).status).toBe(200);
    expect(barcode.getBarcodeFactsRecord).toHaveBeenCalledTimes(1);
  });

  it("keeps HQ's coach-paused state separate and ahead of the gate", async () => {
    state.entitlement = LOCKED;
    state.coachAvailable = false;
    const res = await chat();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: COACH_PAUSED_MESSAGE, retryable: false, coachPaused: true });
    expect(state.entitlementReads).toEqual([]);
    expect(state.modelCalls).toBe(0);
  });

  it("never gates the demo persona or staff browsing it", async () => {
    state.entitlement = LOCKED;
    expect((await menu(null)).status).toBe(200);
    expect((await recipeImage(null)).status).toBe(200);
    expect((await lookup(null)).status).toBe(200);
    state.bearerIsPatient = false;
    expect((await menu("staff")).status).toBe(200);
    expect((await recipeImage("staff")).status).toBe(200);
    expect((await lookup("staff")).status).toBe(200);
    expect(state.entitlementReads).toEqual([]);
  });

  it("fails open when the entitlement cannot be read or the patient row is gone", async () => {
    state.entitlement = "throw";
    expect((await menu()).status).toBe(200);
    state.entitlement = null;
    expect((await lookup()).status).toBe(200);
    expect(state.entitlementReads).toEqual([PATIENT_ID, PATIENT_ID]);
  });
});
