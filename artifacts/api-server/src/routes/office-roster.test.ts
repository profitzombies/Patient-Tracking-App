/**
 * Office roster + patient invitation endpoints.
 *
 * The fake backend below emulates just enough PostgREST/GoTrue surface for
 * the real routers to run end-to-end in-process: token → auth user mapping,
 * providers/team_members/patients tables with the query filters the routes
 * actually use, the claim candidate RPC, account locks, and Resend. Every
 * test asserts through the public HTTP surface.
 */
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/objectStorage", () => ({
  objectStorage: {
    signedDownloadURL: vi.fn(async (path: string) => `https://signed.test/read?key=${encodeURIComponent(path)}`),
  },
  ObjectNotFoundError: class extends Error {},
  THUMBNAIL_CONTENT_TYPES: new Set(["image/jpeg", "image/png", "image/webp"]),
  detectThumbnailContentType: () => "image/jpeg",
}));

// The invite limiter sizes itself from env at module load — pin the knobs
// BEFORE the router import graph is evaluated.
vi.hoisted(() => {
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.CLAIM_EMAIL_DELIVERY_MODE = "live";
  process.env.RESEND_API_KEY = "resend";
  process.env.CLAIM_EMAIL_FROM = "THINNR <test@thinnr.test>";
  process.env.PATIENT_APP_URL = "https://app.thinnr.test";
  process.env.PATIENT_INVITE_RESEND_SECONDS = "60";
  process.env.AUTH_INVITE_BURST = "1000";
  process.env.AUTH_INVITE_DAILY_BUDGET = "100000";
});

import router from "./office-roster";
import { ensurePatientAuthUser } from "../auth/session";

type Row = Record<string, unknown>;
const originalFetch = global.fetch;
let server: http.Server;
let baseUrl = "";

let authUsers: Record<string, string> = {};
let providers: Row[] = [];
let teamMembers: Row[] = [];
let patients: Row[] = [];
let patientTables: Record<string, Row[]> = {};
let locks: string[] = [];
let hqMemberships: Row[] = [];
let resendFails = false;
let insertFailsWith: string | null = null;
let resendCalls: Array<{ to: unknown; template: unknown; vars: Row }> = [];
let patchFailures = 0;

function response(json: unknown, status = 200): Response {
  return new Response(json == null ? "" : JSON.stringify(json), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function bearerOf(init?: RequestInit): string {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return (headers.Authorization ?? "").replace("Bearer ", "");
}

/** Minimal PostgREST filter support for the patients table. */
function patientsMatching(params: URLSearchParams): Row[] {
  let rows = patients;
  const id = params.get("id");
  if (id) rows = rows.filter((row) => row.id === id.replace("eq.", ""));
  const providerId = params.get("provider_id");
  if (providerId) rows = rows.filter((row) => row.provider_id === providerId.replace("eq.", ""));
  const email = params.get("email");
  if (email) {
    const wanted = email.replace("ilike.", "").toLowerCase();
    rows = rows.filter((row) => String(row.email ?? "").toLowerCase() === wanted);
  }
  if (params.get("auth_user_id") === "is.null") rows = rows.filter((row) => row.auth_user_id == null);
  const status = params.get("activation_status");
  if (status) rows = rows.filter((row) => row.activation_status === status.replace("eq.", ""));
  const or = params.get("or");
  if (or?.includes("invite_email_updated_at")) {
    const cutoff = or.match(/invite_email_updated_at\.lt\.([^)]+)\)?$/)?.[1] ?? "";
    rows = rows.filter(
      (row) => row.invite_email_updated_at == null || String(row.invite_email_updated_at) < cutoff,
    );
  }
  return rows;
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  global.fetch = originalFetch;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

beforeEach(() => {
  authUsers = {
    "provider-token": "provider-user",
    "member-token": "member-user",
    "hq-token": "hq-user",
    "patient-token": "patient-user",
  };
  providers = [
    {
      provider_id: "office-1", provider_name: "Dr. Reyes", office_name: "Harbor Med Spa",
      onboarding_code: "483920", access_disabled: false, auth_user_id: "provider-user",
    },
    {
      provider_id: "office-2", provider_name: "Dr. Chen", office_name: "Lakeside Clinic",
      onboarding_code: "775501", access_disabled: false, auth_user_id: "other-provider-user",
    },
  ];
  teamMembers = [
    { id: "tm-1", provider_id: "office-1", auth_user_id: "member-user", activation_status: "activated" },
  ];
  patients = [
    {
      id: "pat-own", provider_id: "office-1", name: "Casey Ortiz", email: "casey@example.com",
      phone: "+15550001111", activation_status: "activated", auth_user_id: "casey-user",
      claimed_at: "2026-01-01", created_at: "2026-01-01", invited_at: null, invited_by: null,
      invite_email_status: null, invite_email_updated_at: null,
    },
    {
      id: "pat-other", provider_id: "office-2", name: "Riley Park", email: "riley@example.com",
      phone: "+15550002222", activation_status: "invited", auth_user_id: null,
      claimed_at: null, created_at: "2026-02-01", invited_at: "2026-02-01T00:00:00Z", invited_by: "other-provider-user",
      invite_email_status: "sent", invite_email_updated_at: "2026-02-01T00:00:00Z",
    },
  ];
  patientTables = {
    patient_diary_entries: [],
    patient_water_days: [],
    patient_target_overrides: [],
    patient_food_prefs: [],
    patient_custom_foods: [],
    patient_saved_recipes: [],
    patient_progress_photos: [],
    patient_check_ins: [],
    patient_flags: [],
  };
  locks = [];
  hqMemberships = [{ department_role: "admin", status: "active" }];
  resendFails = false;
  insertFailsWith = null;
  resendCalls = [];
  patchFailures = 0;

  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname === "api.resend.com") {
      const body = JSON.parse(String(init?.body)) as Row;
      resendCalls.push({ to: body.to, template: body.subject, vars: body });
      return response(resendFails ? { message: "boom" } : { id: "email-1" }, resendFails ? 500 : 200);
    }
    if (url.pathname === "/auth/v1/user") {
      const userId = authUsers[bearerOf(init)];
      return userId ? response({ id: userId }) : response({ message: "bad token" }, 401);
    }
    if (url.pathname === "/rest/v1/providers") {
      const byAuth = url.searchParams.get("auth_user_id");
      const byId = url.searchParams.get("provider_id");
      let rows = providers;
      if (byAuth) rows = rows.filter((row) => row.auth_user_id === byAuth.replace("eq.", ""));
      if (byId) rows = rows.filter((row) => row.provider_id === byId.replace("eq.", ""));
      return response(rows);
    }
    if (url.pathname === "/rest/v1/team_members") {
      const byAuth = url.searchParams.get("auth_user_id");
      return response(
        teamMembers.filter((row) => !byAuth || row.auth_user_id === byAuth.replace("eq.", "")),
      );
    }
    if (url.pathname === "/rest/v1/provider_account_locks") {
      const or = url.searchParams.get("or") ?? "";
      return response(locks.filter((id) => or.includes(`account_id.eq.${id}`)).map((id) => ({ account_id: id })));
    }
    if (url.pathname === "/rest/v1/hq_memberships") {
      const byAuth = url.searchParams.get("auth_user_id");
      return response(byAuth === "eq.hq-user" ? hqMemberships : []);
    }
    if (url.pathname === "/rest/v1/profiles") {
      const byId = url.searchParams.get("id");
      return response(byId === "eq.hq-user" ? [{ role: "hq_admin" }] : []);
    }
    if (url.pathname === "/rest/v1/rpc/claim_find_candidates") {
      const body = JSON.parse(String(init?.body)) as { p_kind: string; p_value: string };
      const last10 = body.p_value.replace(/\D/g, "").slice(-10);
      return response(
        patients
          .filter((row) => String(row.phone ?? "").replace(/\D/g, "").slice(-10) === last10)
          .map((row) => ({ type: "patient", ref: row.id })),
      );
    }
    if (url.pathname === "/rest/v1/patients") {
      if (!init?.method || init.method === "GET") {
        return response(patientsMatching(url.searchParams));
      }
      if (init.method === "POST") {
        if (insertFailsWith) return response({ message: insertFailsWith }, 409);
        const row = JSON.parse(String(init.body)) as Row;
        const emailKey = String(row.email ?? "").trim().toLowerCase();
        if (
          emailKey &&
          patients.some(
            (patient) => String(patient.email ?? "").trim().toLowerCase() === emailKey,
          )
        ) {
          return response(
            {
              message:
                'duplicate key value violates unique constraint "patients_email_normalized_unique_idx"',
            },
            409,
          );
        }
        const phoneKey = String(row.phone ?? "").replace(/\D/g, "").slice(-10);
        if (
          phoneKey.length === 10 &&
          patients.some(
            (patient) =>
              String(patient.phone ?? "").replace(/\D/g, "").slice(-10) === phoneKey,
          )
        ) {
          return response(
            {
              message:
                'duplicate key value violates unique constraint "patients_phone_normalized_unique_idx"',
            },
            409,
          );
        }
        patients.push(row);
        return response([row], 201);
      }
      if (init.method === "PATCH") {
        if (patchFailures > 0) {
          patchFailures -= 1;
          return response({ message: "kaboom" }, 500);
        }
        const updates = JSON.parse(String(init.body)) as Row;
        const matched = patientsMatching(url.searchParams);
        for (const row of matched) Object.assign(row, updates);
        return response(matched, 200);
      }
    }
    const patientTable = url.pathname.replace("/rest/v1/", "");
    if (patientTable in patientTables) {
      const patientId = (url.searchParams.get("patient_id") ?? "").replace("eq.", "");
      return response(patientTables[patientTable].filter((row) => row.patient_id === patientId));
    }
    throw new Error(`Unexpected fake request: ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;
});

async function api(path: string, token: string, init?: RequestInit) {
  return originalFetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init?.headers },
  });
}

const INVITE = {
  firstName: "Jordan",
  lastName: "Ellis",
  email: "Jordan.Ellis@Example.com",
  phone: "(555) 201-7788",
};

describe("office scope", () => {
  it("gives a provider owner exactly their own office, ignoring office overrides", async () => {
    const res = await api("/office/roster?office=office-2", "provider-token");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { office: Row; patients: Row[] };
    expect(body.office).toMatchObject({ providerId: "office-1", providerCode: "483920" });
    expect(body.patients.map((p) => p.id)).toEqual(["pat-own"]);
  });

  it("resolves a team member to their office", async () => {
    const res = await api("/office/roster", "member-token");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { office: Row }).office).toMatchObject({ providerId: "office-1" });
  });

  it("requires HQ to name an office explicitly and honors it", async () => {
    const missing = await api("/office/roster", "hq-token");
    expect(missing.status).toBe(400);
    const scoped = await api("/office/roster?office=office-2", "hq-token");
    expect(scoped.status).toBe(200);
    const body = (await scoped.json()) as { office: Row; patients: Row[] };
    expect(body.office).toMatchObject({ providerId: "office-2" });
    expect(body.patients.map((p) => p.id)).toEqual(["pat-other"]);
  });

  it("denies HQ roles without provider permissions", async () => {
    hqMemberships = [{ department_role: "support", status: "active" }];
    const res = await api("/office/roster?office=office-1", "hq-token");
    expect(res.status).toBe(403);
  });

  it("rejects non-staff tokens and missing tokens", async () => {
    const patient = await api("/office/roster", "patient-token");
    expect(patient.status).toBe(403);
    const anonymous = await originalFetch(`${baseUrl}/office/roster`);
    expect(anonymous.status).toBe(401);
    const invalid = await api("/office/roster", "nope");
    expect(invalid.status).toBe(401);
  });

  it("locks out a locked office's own staff but lets HQ read through the lock", async () => {
    locks = ["office-1"];
    const own = await api("/office/roster", "provider-token");
    expect(own.status).toBe(403);
    expect(((await own.json()) as Row).error).toMatch(/locked/i);
    const hqRead = await api("/office/roster?office=office-1", "hq-token");
    expect(hqRead.status).toBe(200);
    const hqWrite = await api("/office/invitations", "hq-token", {
      method: "POST",
      body: JSON.stringify({ ...INVITE, office: "office-1" }),
    });
    expect(hqWrite.status).toBe(403);
  });

  it("answers a neutral 404 for unknown or disabled offices", async () => {
    const unknown = await api("/office/roster?office=nope", "hq-token");
    expect(unknown.status).toBe(404);
    providers[1].access_disabled = true;
    const disabled = await api("/office/roster?office=office-2", "hq-token");
    expect(disabled.status).toBe(404);
    expect(((await disabled.json()) as Row).error).not.toMatch(/disabled|locked/i);
  });
});

describe("live patient records", () => {
  it("returns a stable empty-history contract", async () => {
    const res = await api("/office/patients/pat-own", "provider-token");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.patient.identity).toMatchObject({
      id: "pat-own",
      name: "Casey Ortiz",
      verified: true,
    });
    expect(body.diary).toEqual({
      entries: [],
      nutritionTotals: {
        overall: { calories: 0, protein: 0, carbs: 0, fat: 0 },
        byDate: [],
      },
    });
    expect(body.water).toEqual([]);
    expect(body.checkIns).toEqual([]);
    expect(body.weights).toEqual([]);
    expect(body.progressPhotos).toEqual([]);
    expect(body.account).toMatchObject({
      favorites: [],
      recents: [],
      customFoods: [],
      savedRecipes: [],
      flags: { onboardingComplete: false },
    });
  });

  it("returns populated diary totals, water, weights, account data, and authorized photos", async () => {
    const ownId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    Object.assign(patients[0], {
      id: ownId,
      first_name: "Canonical",
      last_name: "Ortiz",
      program_id: "metabolic",
      program_start_date: "2026-01-05",
      date_of_birth: "1985-04-03",
      height: "5' 6\"",
      starting_weight: "205.5",
      current_weight: 191,
      goal_weight: 165,
      weight_gain_lost: -14.5,
      timezone: "America/New_York",
      last_log_date: "2026-01-06",
    });
    const ownPath =
      `/objects/patient-media/${ownId}/progress-11111111-1111-4111-8111-111111111111`;
    const otherPath =
      "/objects/patient-media/pat-other/progress-22222222-2222-4222-8222-222222222222";
    patientTables.patient_diary_entries.push(
      {
        patient_id: ownId, entry_id: "e-1", date_key: "2026-01-05", meal: "breakfast",
        kind: "food", name: "Eggs", quantity: 1, calories: 200, protein: 20, carbs: 2, fat: 12,
      },
      {
        patient_id: ownId, entry_id: "e-2", date_key: "2026-01-05", meal: "dinner",
        kind: "food", name: "Chicken", quantity: 1, calories: 300, protein: 40, carbs: 3, fat: 10,
      },
    );
    patientTables.patient_water_days.push({ patient_id: ownId, date_key: "2026-01-05", oz: 72 });
    patientTables.patient_check_ins.push({
      patient_id: ownId, check_in_id: "c-1", date_key: "2026-01-05",
      weight: "191", mood: 4, side_effects: ["nausea"], notes: "Doing well",
    });
    patientTables.patient_target_overrides.push({
      patient_id: ownId, calories: 1400, protein: 100, carbs: null, fat: 50, water_oz: 80,
    });
    patientTables.patient_food_prefs.push({
      patient_id: ownId, favorites: ["eggs"], recents: ["chicken"],
    });
    patientTables.patient_flags.push({
      patient_id: ownId, nudge_opt_out: true, onboarding_complete: true,
      onboarding_answers: { medication: "semaglutide" }, notification_prefs: { reminders: true },
    });
    patientTables.patient_progress_photos.push(
      { patient_id: ownId, photo_id: "p-1", date_key: "2026-01-05", label: "Start", angle: "front", object_path: ownPath },
      { patient_id: ownId, photo_id: "p-bad", date_key: "2026-01-05", label: "Bad", angle: "side", object_path: otherPath },
    );

    const res = await api(`/office/patients/${ownId}`, "provider-token");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.patient.program).toMatchObject({
      id: "metabolic", startingWeight: 205.5, currentWeight: 191, goalWeight: 165,
    });
    expect(body.patient.identity).toMatchObject({
      name: "Canonical Ortiz", firstName: "Canonical", lastName: "Ortiz",
    });
    expect(body.patient.program.day).toEqual(expect.any(Number));
    expect(body.diary.nutritionTotals).toEqual({
      overall: { calories: 500, protein: 60, carbs: 5, fat: 22 },
      byDate: [{ dateKey: "2026-01-05", calories: 500, protein: 60, carbs: 5, fat: 22 }],
    });
    expect(body.water).toEqual([{ dateKey: "2026-01-05", oz: 72 }]);
    expect(body.weights).toEqual([{ dateKey: "2026-01-05", weight: 191 }]);
    expect(body.account.flags).toMatchObject({
      nudgeOptOut: true,
      onboardingComplete: true,
      onboardingAnswers: { medication: "semaglutide" },
    });
    expect(body.progressPhotos[0].url).toEqual(expect.stringMatching(/^https:\/\/signed\.test\//));
    expect(body.progressPhotos[1].url).toBeNull();
    expect(JSON.stringify(body)).not.toContain("objectPath");
    expect(JSON.stringify(body)).not.toContain("object_path");
  });

  it("enforces office isolation with the same neutral direct-link denial as an unknown id", async () => {
    const crossOffice = await api("/office/patients/pat-other", "provider-token");
    const unknown = await api("/office/patients/does-not-exist", "provider-token");
    expect(crossOffice.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await crossOffice.json()).toEqual(await unknown.json());
    expect(JSON.stringify(await api("/office/patients/pat-other", "provider-token").then(r => r.json())))
      .not.toMatch(/Riley|office-2|Lakeside/i);
  });

  it("requires explicit provider_read scope for HQ record reads", async () => {
    const missing = await api("/office/patients/pat-other", "hq-token");
    expect(missing.status).toBe(400);
    const allowed = await api("/office/patients/pat-other?office=office-2", "hq-token");
    expect(allowed.status).toBe(200);
    hqMemberships = [{ department_role: "support", status: "active" }];
    const denied = await api("/office/patients/pat-other?office=office-2", "hq-token");
    expect(denied.status).toBe(403);
  });
});

describe("creating invitations", () => {
  it("creates a pending patient in the caller's office and emails after the row lands", async () => {
    const res = await api("/office/invitations", "provider-token", {
      method: "POST",
      body: JSON.stringify(INVITE),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { patient: Row; invitation: string };
    expect(body.invitation).toBe("sent");
    expect(body.patient).toMatchObject({
      name: "Jordan Ellis",
      email: "jordan.ellis@example.com",
      phone: "+15552017788",
      phoneDisplay: "(555) 201-7788",
      verified: false,
    });
    expect((body.patient.invitation as Row).state).toBe("pending");
    const stored = patients.find((row) => row.email === "jordan.ellis@example.com")!;
    expect(stored).toMatchObject({
      provider_id: "office-1",
      activation_status: "invited",
      invited_by: "provider-user",
      invite_email_status: "sent",
    });
    // The branded email carries the provider, code, phone, and app link.
    expect(resendCalls).toHaveLength(1);
    const emailText = JSON.stringify(resendCalls[0].vars);
    expect(resendCalls[0].vars.to).toEqual(["jordan.ellis@example.com"]);
    expect(emailText).toContain("Dr. Reyes");
    expect(emailText).toContain("483920");
    expect(emailText).toContain("(555) 201-7788");
    expect(emailText).toContain("https://app.thinnr.test");
  });

  it("scopes an HQ invitation to the explicitly named office only", async () => {
    const res = await api("/office/invitations", "hq-token", {
      method: "POST",
      body: JSON.stringify({ ...INVITE, office: "office-2" }),
    });
    expect(res.status).toBe(201);
    const stored = patients.find((row) => row.email === "jordan.ellis@example.com")!;
    expect(stored.provider_id).toBe("office-2");
    expect(stored.invited_by).toBe("hq-user");
  });

  it("validates fields with field-keyed errors", async () => {
    const bad = await api("/office/invitations", "provider-token", {
      method: "POST",
      body: JSON.stringify({ ...INVITE, phone: "12345" }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ field: "phone" });
    const missing = await api("/office/invitations", "provider-token", {
      method: "POST",
      body: JSON.stringify({ ...INVITE, firstName: " " }),
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ field: "firstName" });
  });

  it("answers duplicate email and phone neutrally, even across offices", async () => {
    const email = await api("/office/invitations", "provider-token", {
      method: "POST",
      body: JSON.stringify({ ...INVITE, email: "RILEY@example.com" }),
    });
    expect(email.status).toBe(409);
    const emailBody = (await email.json()) as Row;
    expect(emailBody.field).toBe("email");
    expect(JSON.stringify(emailBody)).not.toMatch(/Riley|office-2|Lakeside/i);

    const phone = await api("/office/invitations", "provider-token", {
      method: "POST",
      body: JSON.stringify({ ...INVITE, phone: "555-000-2222" }),
    });
    expect(phone.status).toBe(409);
    const phoneBody = (await phone.json()) as Row;
    expect(phoneBody.field).toBe("phone");
    expect(JSON.stringify(phoneBody)).not.toMatch(/Riley|office-2|Lakeside/i);
    expect(patients).toHaveLength(2);
    expect(resendCalls).toHaveLength(0);
  });

  it("maps unique-index race failures to the same neutral 409s", async () => {
    insertFailsWith = 'duplicate key value violates unique constraint "patients_phone_unique_idx"';
    const res = await api("/office/invitations", "provider-token", {
      method: "POST",
      body: JSON.stringify(INVITE),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ field: "phone" });
    expect(resendCalls).toHaveLength(0);
  });

  it("maps the hardened normalized index names to the same neutral 409s", async () => {
    for (const [indexName, field] of [
      ["patients_email_normalized_unique_idx", "email"],
      ["patients_phone_normalized_unique_idx", "phone"],
    ] as const) {
      insertFailsWith = `duplicate key value violates unique constraint "${indexName}"`;
      const res = await api("/office/invitations", "provider-token", {
        method: "POST",
        body: JSON.stringify(INVITE),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ field });
      expect(resendCalls).toHaveLength(0);
    }
  });

  it("lands exactly one patient under parallel identical invitations", async () => {
    const fire = () =>
      api("/office/invitations", "provider-token", {
        method: "POST",
        body: JSON.stringify(INVITE),
      });
    const responses = await Promise.all([fire(), fire()]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(
      patients.filter(
        (patient) =>
          String(patient.email ?? "").toLowerCase() === "jordan.ellis@example.com",
      ),
    ).toHaveLength(1);
    expect(resendCalls).toHaveLength(1);
  });

  it("keeps the patient and reports a durable failed state when the email bounces", async () => {
    resendFails = true;
    const res = await api("/office/invitations", "provider-token", {
      method: "POST",
      body: JSON.stringify(INVITE),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { patient: Row; invitation: string };
    expect(body.invitation).toBe("failed");
    expect((body.patient.invitation as Row).emailStatus).toBe("failed");
    const stored = patients.find((row) => row.email === "jordan.ellis@example.com")!;
    expect(stored.invite_email_status).toBe("failed");
  });
});

describe("resending invitations", () => {
  beforeEach(() => {
    patients.push({
      id: "pat-invited", provider_id: "office-1", name: "Alex Kim", email: "alex@example.com",
      phone: "+15550003333", activation_status: "invited", auth_user_id: null,
      claimed_at: null, created_at: "2026-03-01", invited_at: "2026-03-01T00:00:00Z", invited_by: "provider-user",
      invite_email_status: "failed", invite_email_updated_at: "2026-03-01T00:00:00Z",
    });
  });

  it("resends a pending invitation and refreshes its durable state", async () => {
    const res = await api("/office/invitations/pat-invited/resend", "provider-token", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, invitation: "sent" });
    expect(resendCalls).toHaveLength(1);
    const stored = patients.find((row) => row.id === "pat-invited")!;
    expect(stored.invite_email_status).toBe("sent");
  });

  it("rate-limits rapid resends via the atomic guard", async () => {
    const first = await api("/office/invitations/pat-invited/resend", "provider-token", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(first.status).toBe(200);
    const second = await api("/office/invitations/pat-invited/resend", "provider-token", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(second.status).toBe(429);
    expect(resendCalls).toHaveLength(1);
    expect(patients).toHaveLength(3);
  });

  it("defaults to a 60s cooldown when the env knob is unset or blank", async () => {
    // Regression: Number("") is 0, which silently disabled the cooldown.
    const saved = process.env.PATIENT_INVITE_RESEND_SECONDS;
    try {
      for (const broken of [undefined, "", "  ", "nope", "-5"]) {
        if (broken === undefined) delete process.env.PATIENT_INVITE_RESEND_SECONDS;
        else process.env.PATIENT_INVITE_RESEND_SECONDS = broken;
        const target = patients.find((row) => row.id === "pat-invited")!;
        target.invite_email_updated_at = new Date().toISOString();
        const res = await api("/office/invitations/pat-invited/resend", "provider-token", {
          method: "POST",
          body: JSON.stringify({}),
        });
        expect(res.status, `knob=${JSON.stringify(broken)}`).toBe(429);
      }
    } finally {
      process.env.PATIENT_INVITE_RESEND_SECONDS = saved;
    }
  });

  it("hides other offices' invitations behind a neutral 404", async () => {
    const res = await api("/office/invitations/pat-other/resend", "provider-token", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toMatch(/Riley|office-2|Lakeside/i);
    expect(resendCalls).toHaveLength(0);
  });

  it("refuses to resend to an already verified patient", async () => {
    const target = patients.find((row) => row.id === "pat-invited")!;
    target.auth_user_id = "alex-user";
    const res = await api("/office/invitations/pat-invited/resend", "provider-token", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
  });

  it("404s for non-invited patients (no invitation to resend)", async () => {
    const res = await api("/office/invitations/pat-own/resend", "provider-token", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});

describe("first-login activation flip", () => {
  it("flips invited → activated when a login already exists", async () => {
    patients.push({
      id: "pat-flip", provider_id: "office-1", activation_status: "invited",
      auth_user_id: null, invite_email_updated_at: null,
    });
    await ensurePatientAuthUser({
      id: "pat-flip", provider_id: "office-1", name: "Flip", email: "flip@example.com",
      phone: "+15550004444", activation_status: "invited", auth_user_id: "flip-user",
    });
    expect(patients.find((row) => row.id === "pat-flip")!.activation_status).toBe("activated");
  });

  it("leaves non-invited rows alone", async () => {
    const before = JSON.stringify(patients);
    await ensurePatientAuthUser({
      id: "pat-own", provider_id: "office-1", name: "Casey", email: "casey@example.com",
      phone: "+15550001111", activation_status: "activated", auth_user_id: "casey-user",
    });
    expect(JSON.stringify(patients)).toBe(before);
  });

  it("fails loudly when the flip cannot be recorded", async () => {
    patchFailures = 1;
    await expect(
      ensurePatientAuthUser({
        id: "pat-flip2", provider_id: "office-1", name: "Flip", email: "flip2@example.com",
        phone: "+15550005555", activation_status: "invited", auth_user_id: "flip2-user",
      }),
    ).rejects.toThrow(/activation failed/);
  });
});
