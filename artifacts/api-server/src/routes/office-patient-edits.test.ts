/**
 * Provider-portal write actions on a live patient record.
 *
 * The fake PostgREST below emulates the tables and the profile RPC these
 * routes touch — including the version precondition, the one-per-day staff
 * weight index, and the trigger that recomputes the patients row's current
 * weight — so scope, validation, conflict, audit, and privacy contracts are
 * asserted through the real routers over HTTP.
 */
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
});

import editsRouter from "./office-patient-edits";
import historyRouter from "./office-patient-history";
import rosterRouter from "./office-roster";
import { resetRecordAccessCache } from "../lib/record-access-audit";

type Row = Record<string, unknown>;
const originalFetch = global.fetch;
let server: http.Server;
let baseUrl = "";

let authUsers: Record<string, string> = {};
let providers: Row[] = [];
let teamMembers: Row[] = [];
let hqMemberships: Row[] = [];
let locks: string[] = [];
let patients: Row[] = [];
let notes: Row[] = [];
let staffWeights: Row[] = [];
let measurementVisits: Row[] = [];
let medications: Row[] = [];
let doseLogs: Row[] = [];
let checkIns: Row[] = [];
let audits: Row[] = [];
let readAudits: Row[] = [];
/** One fake row per (change, field), the shape the edit-history RPC stores. */
let history: Row[] = [];
let requests: string[] = [];
let profileRpcFailsWith: string | null = null;

const OWN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LEGACY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const V1 = "2026-01-06T08:00:00+00:00";

function response(json: unknown, status = 200): Response {
  return new Response(json == null ? "" : JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
}
function bearerOf(init?: RequestInit): string {
  return String(((init?.headers ?? {}) as Record<string, string>).Authorization ?? "").replace("Bearer ", "");
}
function eq(params: URLSearchParams, key: string, row: Row): boolean {
  const raw = params.get(key);
  if (!raw) return true;
  if (raw === "is.null") return row[key] == null;
  return String(row[key]) === decodeURIComponent(raw.replace(/^eq\./, ""));
}
function matching(rows: Row[], params: URLSearchParams, keys: string[]): Row[] {
  return rows.filter((row) => keys.every((key) => eq(params, key, row)));
}
/** Mirrors private.recompute_patient_current_weight: newest dated reading, fallback to starting weight. */
function recompute(patientId: string) {
  const readings = [
    ...checkIns.filter((row) => row.patient_id === patientId && row.weight != null),
    ...staffWeights.filter((row) => row.patient_id === patientId),
  ].sort((a, b) => String(b.date_key).localeCompare(String(a.date_key)) || String(b.updated_at).localeCompare(String(a.updated_at)));
  const patient = patients.find((row) => row.id === patientId);
  if (!patient) return;
  const latest = readings[0] ? Number(readings[0].weight) : null;
  const starting = patient.starting_weight == null ? null : Number(patient.starting_weight);
  patient.current_weight = latest ?? starting;
  if (patient.current_weight != null && starting != null) patient.weight_gain_lost = Math.round((Number(patient.current_weight) - starting) * 10) / 10;
  patient.updated_at = new Date().toISOString();
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(editsRouter);
  app.use(historyRouter);
  app.use(rosterRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  global.fetch = originalFetch;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

beforeEach(() => {
  readAudits = [];
  resetRecordAccessCache();
  authUsers = { "provider-token": "provider-user", "member-token": "member-user", "hq-token": "hq-user", "patient-token": "patient-user" };
  providers = [
    { provider_id: "office-1", provider_name: "Dr. Reyes", office_name: "Harbor Med Spa", onboarding_code: "483920", access_disabled: false, auth_user_id: "provider-user" },
    { provider_id: "office-2", provider_name: "Dr. Chen", office_name: "Lakeside Clinic", onboarding_code: "775501", access_disabled: false, auth_user_id: "other-provider-user" },
  ];
  teamMembers = [{ id: "tm-1", provider_id: "office-1", auth_user_id: "member-user", activation_status: "activated", name: "Sam Front Desk" }];
  hqMemberships = [{ department_role: "admin", status: "active", display_name: "Avery HQ" }];
  locks = [];
  patients = [
    {
      id: OWN, provider_id: "office-1", first_name: "Casey", last_name: "Ortiz", name: "Casey Ortiz", email: "casey@example.com", phone: "+15550001111",
      activation_status: "activated", activation_reason: null, auth_user_id: "casey-user", created_at: "2026-01-01", updated_at: V1,
      starting_weight: 200, current_weight: 190, goal_weight: 160, weight_gain_lost: -10, timezone: "America/New_York", program_start_date: "2026-01-01",
    },
    {
      id: OTHER, provider_id: "office-2", first_name: "Riley", last_name: "Park", name: "Riley Park", email: "riley@example.com", phone: "+15550002222",
      activation_status: "activated", auth_user_id: "riley-user", created_at: "2026-01-01", updated_at: V1, starting_weight: 180, current_weight: 175,
    },
    {
      // Invitation-created rows carry only the combined name (legacy shape).
      id: LEGACY, provider_id: "office-1", first_name: null, last_name: null, name: "Morgan Ellery", email: "morgan@example.com", phone: "+15550003333",
      activation_status: "activated", auth_user_id: null, created_at: "2026-01-01", updated_at: V1, starting_weight: 210, current_weight: 210,
    },
  ];
  notes = [];
  staffWeights = [];
  measurementVisits = [];
  medications = [];
  doseLogs = [];
  checkIns = [];
  audits = [];
  history = [];
  requests = [];
  profileRpcFailsWith = null;

  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url.pathname}`);
    const body = init?.body ? (JSON.parse(String(init.body)) as Row) : {};
    if (url.pathname === "/auth/v1/user") {
      const userId = authUsers[bearerOf(init)];
      return userId ? response({ id: userId }) : response({ message: "bad token" }, 401);
    }
    if (url.pathname === "/rest/v1/providers") return response(matching(providers, url.searchParams, ["auth_user_id", "provider_id"]));
    if (url.pathname === "/rest/v1/team_members") return response(matching(teamMembers, url.searchParams, ["auth_user_id"]));
    if (url.pathname === "/rest/v1/provider_account_locks") {
      const or = url.searchParams.get("or") ?? "";
      return response(locks.filter((id) => or.includes(`account_id.eq.${id}`)).map((id) => ({ account_id: id })));
    }
    if (url.pathname === "/rest/v1/hq_memberships") return response(url.searchParams.get("auth_user_id") === "eq.hq-user" ? hqMemberships : []);
    if (url.pathname === "/rest/v1/profiles") return response(url.searchParams.get("id") === "eq.hq-user" ? [{ role: "hq_admin" }] : []);
    if (url.pathname === "/rest/v1/rpc/record_admin_audit_read_event") {
      readAudits.push(body);
      return response([{ recorded: true, window_started_at: new Date().toISOString() }]);
    }
    // The audit RPC answers its event id so the history rows can pair with it.
    if (url.pathname === "/rest/v1/rpc/record_admin_audit_event") { audits.push(body); return response(1000 + audits.length); }
    if (url.pathname === "/rest/v1/rpc/record_patient_edit_history") {
      const changeId = `chg-${history.length + 1}`;
      const at = new Date(Date.UTC(2026, 0, 10, 0, 0, history.length)).toISOString();
      for (const field of body.p_fields as Row[]) {
        history.push({
          change_id: changeId, patient_id: body.p_patient_id, family: body.p_family, record_id: body.p_record_id, change_kind: body.p_change_kind,
          actor_kind: body.p_actor_kind, actor_user_id: body.p_actor_user_id, actor_name: body.p_actor_name, audit_event_id: body.p_audit_event_id,
          field: field.field, old_value: field.old, new_value: field.new, created_at: at,
        });
      }
      return response(changeId);
    }
    // Mirrors the read RPC: one row per change (fields grouped), newest first, office-scoped, with the total.
    if (url.pathname === "/rest/v1/rpc/office_patient_edit_history") {
      const owner = patients.find((row) => row.id === body.p_patient_id && row.provider_id === body.p_provider_id);
      const rows = owner ? history.filter((row) => row.patient_id === body.p_patient_id && (!body.p_family || row.family === body.p_family)) : [];
      const grouped = new Map<string, Row>();
      for (const row of rows) {
        const change = grouped.get(String(row.change_id)) ?? { ...row, fields: [] as Row[] };
        (change.fields as Row[]).push({ field: row.field, old: row.old_value, new: row.new_value });
        grouped.set(String(row.change_id), change);
      }
      const changes = [...grouped.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      const page = changes.slice(Number(body.p_offset), Number(body.p_offset) + Number(body.p_limit));
      return response(page.map((row) => ({ ...row, total: changes.length })));
    }
    // The activity aggregate answers one fact row per patient (no activity of
    // any kind yet); a missing row would read as "unknown" rather than inactive.
    if (url.pathname === "/rest/v1/rpc/provider_patient_activity_summary") {
      return response(patients.filter((row) => row.provider_id === body.p_provider_id && !row.archived_at).map((row) => ({
        patient_id: row.id, latest_activity_date: null, latest_diary_date: null, latest_water_date: null,
        latest_check_in_date: null, latest_weight_date: null, latest_photo_date: null, logged_days_7: 0, check_ins_7: 0,
      })));
    }
    if (url.pathname === "/rest/v1/patient_operational_follow_ups") return response([]);
    if (url.pathname === "/rest/v1/rpc/provider_outreach_states") return response([]);
    if (url.pathname === "/rest/v1/rpc/office_update_patient_profile") {
      if (profileRpcFailsWith) return response({ message: profileRpcFailsWith }, 409);
      const patient = patients.find((row) => row.id === body.p_patient_id && row.provider_id === body.p_provider_id);
      if (!patient) return response({ message: "office_patient_record_not_found" }, 400);
      if ((patient.updated_at ?? null) !== (body.p_expected_updated_at ?? null)) return response({ message: "office_patient_record_conflict" }, 400);
      const patch = body.p_patch as Row;
      // Mirrors the SQL: legacy rows only carry `name`, so the untouched half
      // comes from that split rather than the null column.
      const legacyName = String(patient.name ?? "").trim();
      const currentFirst = String(patient.first_name ?? "").trim() || legacyName.split(/\s+/)[0] || null;
      const currentLast = String(patient.last_name ?? "").trim() || legacyName.split(/\s+/).slice(1).join(" ") || null;
      Object.assign(patient, patch);
      if ("first_name" in patch || "last_name" in patch) {
        patient.first_name = "first_name" in patch ? patch.first_name : currentFirst;
        patient.last_name = "last_name" in patch ? patch.last_name : currentLast;
        patient.name = [patient.first_name, patient.last_name].filter(Boolean).join(" ");
      }
      patient.updated_at = new Date().toISOString();
      return response(patient);
    }
    if (url.pathname === "/rest/v1/patients") {
      const rows = matching(patients, url.searchParams, ["id", "provider_id", "updated_at", "archived_at"]);
      if (method === "GET") return response(rows);
      if (method === "PATCH") { for (const row of rows) Object.assign(row, body); return response(rows); }
    }
    if (url.pathname === "/rest/v1/patient_provider_notes") {
      if (method === "GET") return response(matching(notes, url.searchParams, ["patient_id", "provider_id"]));
      if (method === "POST") { notes.push(body); return response([body], 201); }
      if (method === "DELETE") {
        const gone = matching(notes, url.searchParams, ["note_id", "patient_id", "provider_id"]);
        notes = notes.filter((row) => !gone.includes(row));
        return response(gone);
      }
    }
    if (url.pathname === "/rest/v1/patient_staff_weights") {
      if (method === "GET") return response(matching(staffWeights, url.searchParams, ["weight_id", "patient_id", "provider_id"]));
      if (method === "POST") {
        if (staffWeights.some((row) => row.patient_id === body.patient_id && row.date_key === body.date_key)) {
          return response({ message: 'duplicate key value violates unique constraint "patient_staff_weights_one_per_day"' }, 409);
        }
        staffWeights.push(body); recompute(String(body.patient_id)); return response([body], 201);
      }
      if (method === "PATCH") {
        const rows = matching(staffWeights, url.searchParams, ["weight_id", "patient_id", "provider_id", "updated_at"]);
        for (const row of rows) {
          if (body.date_key && staffWeights.some((other) => other !== row && other.patient_id === row.patient_id && other.date_key === body.date_key)) {
            return response({ message: 'duplicate key value violates unique constraint "patient_staff_weights_one_per_day"' }, 409);
          }
          Object.assign(row, body); recompute(String(row.patient_id));
        }
        return response(rows);
      }
      if (method === "DELETE") {
        const gone = matching(staffWeights, url.searchParams, ["weight_id", "patient_id", "provider_id", "updated_at"]);
        staffWeights = staffWeights.filter((row) => !gone.includes(row));
        for (const row of gone) recompute(String(row.patient_id));
        return response(gone);
      }
    }
    if (url.pathname === "/rest/v1/patient_body_measurements") {
      if (method === "GET") return response(matching(measurementVisits, url.searchParams, ["visit_id", "patient_id", "provider_id"]));
      if (method === "POST") {
        const areas = ["neck", "chest", "left_arm", "right_arm", "waist", "hips", "left_thigh", "right_thigh", "left_calf", "right_calf"];
        if (areas.every((column) => body[column] == null)) return response({ message: 'new row violates check constraint "patient_body_measurements_at_least_one"' }, 400);
        measurementVisits.push(body); return response([body], 201);
      }
      if (method === "DELETE") {
        const gone = matching(measurementVisits, url.searchParams, ["visit_id", "patient_id", "provider_id", "updated_at"]);
        measurementVisits = measurementVisits.filter((row) => !gone.includes(row));
        return response(gone);
      }
    }
    if (url.pathname === "/rest/v1/patient_medications") {
      if (method === "GET") return response(matching(medications, url.searchParams, ["id", "patient_id"]));
      if (method === "POST") { medications.push(body); return response([body], 201); }
      if (method === "PATCH") {
        const rows = matching(medications, url.searchParams, ["id", "patient_id", "updated_at"]);
        for (const row of rows) Object.assign(row, body);
        return response(rows);
      }
    }
    if (url.pathname === "/rest/v1/patient_medication_dose_logs") {
      if (method === "GET") return response(matching(doseLogs, url.searchParams, ["patient_id", "medication_id"]));
    }
    if (url.pathname === "/rest/v1/patient_check_ins") return response(checkIns.filter((row) => row.patient_id === (url.searchParams.get("patient_id") ?? "").replace("eq.", "")));
    if (url.pathname.startsWith("/rest/v1/patient_")) return response([]);
    throw new Error(`Unexpected fake request: ${method} ${url}`);
  }) as typeof fetch;
});

async function api(path: string, token: string | null, init?: RequestInit) {
  return originalFetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", "x-request-id": "req-1", ...init?.headers },
  });
}
const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

describe("scope and permissions", () => {
  const writes: Array<[string, string, unknown]> = [
    ["PATCH", "", { expectedVersion: V1, firstName: "Cass" }],
    ["PATCH", "/status", { expectedVersion: V1, status: "paused", reason: "Vacation" }],
    ["POST", "/notes", { body: "Hello" }],
    ["DELETE", "/notes/n-1", undefined],
    ["POST", "/weights", { dateKey: "2026-01-02", weight: 188 }],
    ["PATCH", "/weights/w-1", { expectedVersion: V1, weight: 187 }],
    ["DELETE", "/weights/w-1", { expectedVersion: V1 }],
    ["POST", "/measurements", { dateKey: "2026-01-02", measurements: { waist: 34.5 } }],
    ["DELETE", "/measurements/m-1", { expectedVersion: V1 }],
    ["POST", "/medications", { medication: { name: "Vitamin D", form: "capsule", scheduleKind: "daily", times: ["08:00"], startDate: "2026-01-02" } }],
    ["PATCH", "/medications/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", { expectedVersion: V1, stopDate: "2026-01-10" }],
  ];

  it("answers cross-office ids and unknown ids with the identical neutral 404 and writes nothing", async () => {
    for (const [method, suffix, body] of writes) {
      const cross = await api(`/office/patients/${OTHER}${suffix}`, "provider-token", { method, ...(body ? json(body) : {}) });
      const unknown = await api(`/office/patients/does-not-exist${suffix}`, "provider-token", { method, ...(body ? json(body) : {}) });
      expect(cross.status, `${method} ${suffix}`).toBe(404);
      expect(await cross.json()).toEqual(await unknown.json());
    }
    expect(notes).toEqual([]);
    expect(staffWeights).toEqual([]);
    expect(measurementVisits).toEqual([]);
    expect(medications).toEqual([]);
    expect(patients[1]).toMatchObject({ first_name: "Riley", activation_status: "activated" });
    expect(audits).toEqual([]);
    expect(requests.filter((line) => !line.startsWith("GET "))).toEqual([]);
  });

  it("refuses locked offices, disabled offices, non-staff tokens, and HQ without provider_manage", async () => {
    locks = ["office-1"];
    expect((await api(`/office/patients/${OWN}/notes`, "provider-token", { method: "POST", ...json({ body: "x" }) })).status).toBe(403);
    expect((await api(`/office/patients/${OWN}/notes?office=office-1`, "hq-token", { method: "POST", ...json({ body: "x" }) })).status).toBe(403);
    locks = [];
    providers[0].access_disabled = true;
    expect((await api(`/office/patients/${OWN}/notes`, "provider-token", { method: "POST", ...json({ body: "x" }) })).status).toBe(404);
    providers[0].access_disabled = false;
    expect((await api(`/office/patients/${OWN}/notes`, "patient-token", { method: "POST", ...json({ body: "x" }) })).status).toBe(403);
    expect((await api(`/office/patients/${OWN}/notes`, null, { method: "POST", ...json({ body: "x" }) })).status).toBe(401);
    // Clinical HQ can READ provider records but must not write to them.
    for (const departmentRole of ["clinical", "support"]) {
      hqMemberships = [{ department_role: departmentRole, status: "active" }];
      const denied = await api(`/office/patients/${OWN}/notes?office=office-1`, "hq-token", { method: "POST", ...json({ body: "x" }) });
      expect(denied.status, departmentRole).toBe(403);
      expect(await denied.json()).toEqual({ error: "Your HQ role does not have permission to do this." });
    }
    hqMemberships = [{ department_role: "admin", status: "active", display_name: "Avery HQ" }];
    expect((await api(`/office/patients/${OWN}/notes`, "hq-token", { method: "POST", ...json({ body: "x" }) })).status).toBe(400);
    expect(notes).toEqual([]);
    // Refused attempts leave only denial events — never a note-write event.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const denials = audits.filter((a) => a.p_action === "access_denied");
    expect(audits.length).toBe(denials.length);
    expect(denials.length).toBeGreaterThan(0);
    for (const denial of denials) {
      expect(denial.p_target_kind).toBe("route");
      expect(denial.p_target_id).toBe("/office/patients/:id/notes");
      expect(denial.p_metadata).toMatchObject({ status: 403, method: "POST" });
      expect(["permission", "office_locked", "staff_only"]).toContain((denial.p_metadata as { reason?: string }).reason);
      expect(JSON.stringify(denial)).not.toContain(OWN);
    }
    audits.length = 0;
  });

  it("lets a team member and a permitted HQ admin write to the named office", async () => {
    const member = await api(`/office/patients/${OWN}/notes`, "member-token", { method: "POST", ...json({ body: "Front desk note" }) });
    expect(member.status).toBe(201);
    expect(await member.json()).toMatchObject({ note: { authorName: "Sam Front Desk", authorKind: "team_member" } });
    const hq = await api(`/office/patients/${OWN}/notes`, "hq-token", { method: "POST", ...json({ body: "HQ note", office: "acct-office-1" }) });
    expect(hq.status).toBe(201);
    expect(await hq.json()).toMatchObject({ note: { authorName: "Avery HQ", authorKind: "hq" } });
    expect(audits.map((row) => [row.p_actor_kind, row.p_provider_id, row.p_target_id])).toEqual([
      ["team_member", "office-1", OWN], ["hq", "office-1", OWN],
    ]);
  });
});

describe("profile edits", () => {
  it("validates fields with field-keyed errors before touching scope", async () => {
    const cases: Array<[Row, string]> = [
      [{ expectedVersion: V1, email: "nope" }, "email"],
      [{ expectedVersion: V1, phone: "123" }, "phone"],
      [{ expectedVersion: V1, dateOfBirth: "2020-01-01" }, "dateOfBirth"],
      [{ expectedVersion: V1, dateOfBirth: "1990-02-30" }, "dateOfBirth"],
      [{ expectedVersion: V1, heightInches: 12 }, "heightInches"],
      [{ expectedVersion: V1, goalWeight: 20 }, "goalWeight"],
      [{ expectedVersion: V1, programStartDate: "not-a-date" }, "programStartDate"],
      [{ expectedVersion: V1, timezone: "Mars/Olympus" }, "timezone"],
      [{ expectedVersion: V1, firstName: "" }, "firstName"],
    ];
    for (const [body, field] of cases) {
      const res = await api(`/office/patients/${OWN}`, "provider-token", { method: "PATCH", ...json(body) });
      expect(res.status, field).toBe(400);
      expect(((await res.json()) as Row).field, field).toBe(field);
    }
    expect((await api(`/office/patients/${OWN}`, "provider-token", { method: "PATCH", ...json({ expectedVersion: V1 }) })).status).toBe(400);
    expect((await api(`/office/patients/${OWN}`, "provider-token", { method: "PATCH", ...json({ firstName: "Cass" }) })).status).toBe(400);
    expect(requests).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("applies a normalized patch through the transactional RPC and audits a field summary only", async () => {
    const res = await api(`/office/patients/${OWN}`, "provider-token", {
      method: "PATCH",
      ...json({ expectedVersion: V1, firstName: "  Cass  ", email: "Cass.Ortiz@Example.com", phone: "(555) 300-4000", dateOfBirth: "1985-04-03", heightInches: 66, goalWeight: 158, programStartDate: "2026-01-05", timezone: "America/Chicago" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.patient.identity).toMatchObject({ firstName: "Cass", name: "Cass Ortiz", email: "cass.ortiz@example.com", phone: "+15553004000", dateOfBirth: "1985-04-03", heightInches: 66, height: "5' 6\"", timezone: "America/Chicago" });
    expect(body.patient.program).toMatchObject({ goalWeight: 158, startDate: "2026-01-05" });
    expect(body.patient.version).not.toBe(V1);
    const rpc = requests.find((line) => line.includes("office_update_patient_profile"));
    expect(rpc).toBe("POST /rest/v1/rpc/office_update_patient_profile");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      p_action: "patient_profile_updated", p_actor_user_id: "provider-user", p_actor_kind: "provider", p_provider_id: "office-1",
      p_target_kind: "patient", p_target_id: OWN, p_request_id: "req-1",
      p_metadata: { fields: "firstName,email,phone,dateOfBirth,heightInches,goalWeight,programStartDate,timezone" },
    });
    expect(JSON.stringify(audits[0].p_metadata)).not.toMatch(/Cass|example\.com|1985|Chicago/);
  });

  it("keeps the untouched half of a legacy combined name when only one half is edited", async () => {
    const res = await api(`/office/patients/${LEGACY}`, "provider-token", { method: "PATCH", ...json({ expectedVersion: V1, firstName: "Morgana" }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.patient.identity).toMatchObject({ name: "Morgana Ellery", firstName: "Morgana", lastName: "Ellery" });
    const row = patients.find((patient) => patient.id === LEGACY)!;
    expect(row).toMatchObject({ first_name: "Morgana", last_name: "Ellery", name: "Morgana Ellery" });
  });

  it("refuses a stale save with a reload conflict instead of overwriting", async () => {
    const res = await api(`/office/patients/${OWN}`, "provider-token", { method: "PATCH", ...json({ expectedVersion: "2025-12-31T00:00:00+00:00", firstName: "Stale" }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "record_changed", error: expect.stringMatching(/changed since you opened it/i) });
    expect(patients[0].first_name).toBe("Casey");
    expect(audits).toEqual([]);
  });

  it("maps unique email/phone failures to the neutral taken messages", async () => {
    profileRpcFailsWith = 'duplicate key value violates unique constraint "patients_email_normalized_unique_idx"';
    const res = await api(`/office/patients/${OWN}`, "provider-token", { method: "PATCH", ...json({ expectedVersion: V1, email: "riley@example.com" }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "That email is already on a patient account. Use a different email.", field: "email" });
    profileRpcFailsWith = 'duplicate key value violates unique constraint "users_phone_key"';
    const phone = await api(`/office/patients/${OWN}`, "provider-token", { method: "PATCH", ...json({ expectedVersion: V1, phone: "5550002222" }) });
    expect(phone.status).toBe(409);
    expect(((await phone.json()) as Row).field).toBe("phone");
    expect(audits).toEqual([]);
  });
});

describe("activation status", () => {
  it("requires a reason to pause or discharge and refuses no-op or unlinked changes", async () => {
    const noReason = await api(`/office/patients/${OWN}/status`, "provider-token", { method: "PATCH", ...json({ expectedVersion: V1, status: "paused" }) });
    expect(noReason.status).toBe(400);
    expect(((await noReason.json()) as Row).field).toBe("reason");
    const badStatus = await api(`/office/patients/${OWN}/status`, "provider-token", { method: "PATCH", ...json({ expectedVersion: V1, status: "disabled", reason: "x" }) });
    expect(badStatus.status).toBe(400);
    const same = await api(`/office/patients/${OWN}/status`, "provider-token", { method: "PATCH", ...json({ expectedVersion: V1, status: "activated" }) });
    expect(same.status).toBe(400);
    patients[0].activation_status = "invited";
    const invited = await api(`/office/patients/${OWN}/status`, "provider-token", { method: "PATCH", ...json({ expectedVersion: V1, status: "discharged", reason: "Never joined" }) });
    expect(invited.status).toBe(400);
    expect(patients[0].activation_status).toBe("invited");
    expect(audits).toEqual([]);
  });

  it("persists the status with its reason, audits from/to only, and the roster badge follows", async () => {
    const res = await api(`/office/patients/${OWN}/status`, "provider-token", { method: "PATCH", ...json({ expectedVersion: V1, status: "paused", reason: "  Travelling  for a month " }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.patient.identity).toMatchObject({ activationStatus: "paused", activationReason: "Travelling for a month" });
    expect(body.patient.identity.activationUpdatedAt).toEqual(expect.any(String));
    expect(body.patient.version).not.toBe(V1);
    expect(patients[0]).toMatchObject({ activation_status: "paused", activation_updated_by: "provider-user" });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ p_action: "patient_status_changed", p_metadata: { from: "activated", to: "paused" } });
    expect(JSON.stringify(audits[0].p_metadata)).not.toMatch(/Travelling/);

    const roster = await api("/office/roster", "provider-token");
    const rosterBody = (await roster.json()) as { patients: Row[]; summary: Row };
    expect((rosterBody.patients[0].operational as Row).status).toBe("paused");
    expect((rosterBody.patients[0].operational as Row).reasons).toEqual([]);
    // Paused drops out of active; only the legacy row still counts (inactive by age).
    expect(rosterBody.summary).toMatchObject({ activePatients: 1, needsAttention: 0, inactive: 1 });

    const back = await api(`/office/patients/${OWN}/status`, "provider-token", { method: "PATCH", ...json({ expectedVersion: body.patient.version, status: "activated" }) });
    expect(back.status).toBe(200);
    expect(((await back.json()) as any).patient.identity).toMatchObject({ activationStatus: "activated", activationReason: null });
  });

  it("answers a stale version with the reload conflict", async () => {
    const res = await api(`/office/patients/${OWN}/status`, "provider-token", { method: "PATCH", ...json({ expectedVersion: null, status: "discharged", reason: "Completed program" }) });
    expect(res.status).toBe(409);
    expect(patients[0].activation_status).toBe("activated");
    expect(audits).toEqual([]);
  });
});

describe("provider notes", () => {
  it("stores who wrote the note, returns it on the record, and keeps the body out of the audit log", async () => {
    const empty = await api(`/office/patients/${OWN}/notes`, "provider-token", { method: "POST", ...json({ body: "   " }) });
    expect(empty.status).toBe(400);
    const res = await api(`/office/patients/${OWN}/notes`, "provider-token", { method: "POST", ...json({ body: "Patient reports nausea after dose 2." }) });
    expect(res.status).toBe(201);
    const { note } = (await res.json()) as any;
    expect(note).toMatchObject({ body: "Patient reports nausea after dose 2.", authorName: "Dr. Reyes", authorKind: "provider" });
    expect(note.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(notes[0]).toMatchObject({ provider_id: "office-1", patient_id: OWN, author_user_id: "provider-user" });
    expect(audits[0]).toMatchObject({ p_action: "patient_note_added", p_metadata: { noteId: note.id } });
    expect(JSON.stringify(audits)).not.toMatch(/nausea/);

    const detail = await api(`/office/patients/${OWN}`, "provider-token");
    expect(((await detail.json()) as any).providerNotes).toEqual([note]);

    const gone = await api(`/office/patients/${OWN}/notes/${note.id}`, "provider-token", { method: "DELETE" });
    expect(gone.status).toBe(200);
    expect(notes).toEqual([]);
    expect(audits[1]).toMatchObject({ p_action: "patient_note_deleted", p_metadata: { noteId: note.id } });
    expect((await api(`/office/patients/${OWN}/notes/${note.id}`, "provider-token", { method: "DELETE" })).status).toBe(404);
  });

  it("never lets another office read or delete a note through the record", async () => {
    notes.push({ note_id: "n-1", provider_id: "office-1", patient_id: OWN, body: "Private", author_name: "Dr. Reyes", author_kind: "provider", created_at: "2026-01-04T12:00:00Z" });
    const del = await api(`/office/patients/${OWN}/notes/n-1?office=office-2`, "hq-token", { method: "DELETE" });
    expect(del.status).toBe(404);
    expect(notes).toHaveLength(1);
  });
});

describe("staff weigh-ins", () => {
  it("validates the reading and the day", async () => {
    const low = await api(`/office/patients/${OWN}/weights`, "provider-token", { method: "POST", ...json({ dateKey: "2026-01-02", weight: 12 }) });
    expect(low.status).toBe(400);
    expect(((await low.json()) as Row).field).toBe("weight");
    const future = await api(`/office/patients/${OWN}/weights`, "provider-token", { method: "POST", ...json({ dateKey: "2999-01-01", weight: 180 }) });
    expect(future.status).toBe(400);
    expect(((await future.json()) as Row).field).toBe("dateKey");
    const text = await api(`/office/patients/${OWN}/weights`, "provider-token", { method: "POST", ...json({ dateKey: "2026-01-02", weight: "180" }) });
    expect(text.status).toBe(400);
    expect(staffWeights).toEqual([]);
  });

  it("records, corrects, and removes a staff weight while the record's current weight follows", async () => {
    checkIns.push({ patient_id: OWN, check_in_id: "c-1", date_key: "2026-01-03", weight: 190, mood: 4, side_effects: [], notes: null, updated_at: "2026-01-03T00:00:00Z" });
    const created = await api(`/office/patients/${OWN}/weights`, "provider-token", { method: "POST", ...json({ dateKey: "2026-01-04", weight: 186.26, note: "Office scale" }) });
    expect(created.status).toBe(201);
    const body = (await created.json()) as any;
    expect(body.weight).toMatchObject({ dateKey: "2026-01-04", weight: 186.3, note: "Office scale", recordedByName: "Dr. Reyes" });
    expect(body.patient.program).toMatchObject({ currentWeight: 186.3, weightChange: -13.7 });
    expect(audits[0]).toMatchObject({ p_action: "patient_weight_recorded", p_metadata: { weightId: body.weight.id, dateKey: "2026-01-04" } });
    expect(JSON.stringify(audits[0].p_metadata)).not.toMatch(/186|Office scale/);

    const dup = await api(`/office/patients/${OWN}/weights`, "provider-token", { method: "POST", ...json({ dateKey: "2026-01-04", weight: 185 }) });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as Row).field).toBe("dateKey");

    const detail = (await (await api(`/office/patients/${OWN}`, "provider-token")).json()) as any;
    expect(detail.weights).toEqual([
      { dateKey: "2026-01-03", weight: 190, source: "patient" },
      { dateKey: "2026-01-04", weight: 186.3, source: "staff", id: body.weight.id },
    ]);

    const stale = await api(`/office/patients/${OWN}/weights/${body.weight.id}`, "provider-token", { method: "PATCH", ...json({ expectedVersion: "1999-01-01T00:00:00Z", weight: 184 }) });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as Row).code).toBe("record_changed");

    const corrected = await api(`/office/patients/${OWN}/weights/${body.weight.id}`, "provider-token", { method: "PATCH", ...json({ expectedVersion: body.weight.version, weight: 184, note: null }) });
    expect(corrected.status).toBe(200);
    const correctedBody = (await corrected.json()) as any;
    expect(correctedBody.weight).toMatchObject({ weight: 184, note: null });
    expect(correctedBody.patient.program.currentWeight).toBe(184);
    expect(audits[1]).toMatchObject({ p_action: "patient_weight_updated", p_metadata: { weightId: body.weight.id, fields: "weight,note" } });

    // A removal from a dialog opened before the correction is a stale write:
    // it must raise the reload conflict, never delete the corrected reading.
    const staleRemove = await api(`/office/patients/${OWN}/weights/${body.weight.id}`, "provider-token", { method: "DELETE", ...json({ expectedVersion: body.weight.version }) });
    expect(staleRemove.status).toBe(409);
    expect(((await staleRemove.json()) as Row).code).toBe("record_changed");
    expect(staffWeights).toHaveLength(1);
    expect((await api(`/office/patients/${OWN}/weights/${body.weight.id}`, "provider-token", { method: "DELETE", ...json({}) })).status).toBe(400);
    expect(audits).toHaveLength(2);

    const removed = await api(`/office/patients/${OWN}/weights/${body.weight.id}`, "provider-token", { method: "DELETE", ...json({ expectedVersion: correctedBody.weight.version }) });
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as any).patient.program.currentWeight).toBe(190);
    expect(staffWeights).toEqual([]);
    expect(audits[2]).toMatchObject({ p_action: "patient_weight_removed" });
    expect((await api(`/office/patients/${OWN}/weights/${body.weight.id}`, "provider-token", { method: "DELETE", ...json({ expectedVersion: null }) })).status).toBe(404);
  });

  it("treats an archived patient like an unknown record for every write", async () => {
    staffWeights.push({ weight_id: "w-arch", patient_id: OWN, provider_id: "office-1", date_key: "2026-01-02", weight: 188, note: null, recorded_by_name: "Dr. Reyes", created_at: V1, updated_at: V1 });
    notes.push({ note_id: "n-arch", patient_id: OWN, provider_id: "office-1", body: "Keep", author_name: "Dr. Reyes", author_kind: "provider", created_at: V1 });
    patients[0].archived_at = "2026-02-01T00:00:00Z";
    const attempts: Array<[string, string, Row | null]> = [
      ["PATCH", "", { expectedVersion: V1, firstName: "Ghost" }],
      ["PATCH", "/status", { expectedVersion: V1, status: "paused", reason: "x" }],
      ["POST", "/notes", { body: "late note" }],
      ["DELETE", "/notes/n-arch", null],
      ["POST", "/weights", { dateKey: "2026-01-05", weight: 180 }],
      ["PATCH", "/weights/w-arch", { expectedVersion: V1, weight: 170 }],
      ["DELETE", "/weights/w-arch", { expectedVersion: V1 }],
      ["POST", "/measurements", { dateKey: "2026-01-05", measurements: { waist: 33 } }],
      ["DELETE", "/measurements/m-arch", { expectedVersion: V1 }],
    ];
    measurementVisits.push({ visit_id: "m-arch", patient_id: OWN, provider_id: "office-1", date_key: "2026-01-02", note: null, waist: 34, recorded_by_name: "Dr. Reyes", created_at: V1, updated_at: V1 });
    for (const [method, suffix, body] of attempts) {
      const res = await api(`/office/patients/${OWN}${suffix}`, "provider-token", { method, ...(body ? json(body) : {}) });
      expect([method, suffix, res.status]).toEqual([method, suffix, 404]);
    }
    expect(patients[0].first_name).toBe("Casey");
    expect(staffWeights).toHaveLength(1);
    expect(measurementVisits).toHaveLength(1);
    expect(notes).toHaveLength(1);
    expect(audits).toEqual([]);
  });
});

describe("body measurement visits", () => {
  it("validates the day, every inch value, and requires at least one area", async () => {
    const cases: Array<[Row, string]> = [
      [{ dateKey: "2999-01-01", measurements: { waist: 34 } }, "dateKey"],
      [{ dateKey: "2026-02-30", measurements: { waist: 34 } }, "dateKey"],
      [{ dateKey: "2026-01-02", measurements: {} }, "measurements"],
      [{ dateKey: "2026-01-02", measurements: { waist: 0 } }, "waist"],
      [{ dateKey: "2026-01-02", measurements: { waist: -2 } }, "waist"],
      [{ dateKey: "2026-01-02", measurements: { chest: 41.25 } }, "chest"],
      [{ dateKey: "2026-01-02", measurements: { neck: 500 } }, "neck"],
      [{ dateKey: "2026-01-02", measurements: { hips: "40" } }, "hips"],
      [{ dateKey: "2026-01-02", measurements: { waist: 34, leftArm: 12, shoulders: 50 } }, "measurements"],
      [{ dateKey: "2026-01-02", measurements: { waist: 34 }, note: "x".repeat(501) }, "note"],
    ];
    for (const [body, field] of cases) {
      const res = await api(`/office/patients/${OWN}/measurements`, "provider-token", { method: "POST", ...json(body) });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as Row).field, JSON.stringify(body)).toBe(field);
    }
    expect(measurementVisits).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("stores only the measured areas, returns them on the record, and audits the count rather than the values", async () => {
    const created = await api(`/office/patients/${OWN}/measurements`, "provider-token", {
      method: "POST",
      ...json({ dateKey: "2026-01-03", note: "  Morning visit  ", measurements: { waist: 34.5, hips: 41, leftArm: 12.3 } }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as any;
    expect(body.visit).toMatchObject({
      dateKey: "2026-01-03",
      note: "Morning visit",
      measurements: { waist: 34.5, hips: 41, leftArm: 12.3 },
      recordedByName: "Dr. Reyes",
    });
    expect(Object.keys(body.visit.measurements).sort()).toEqual(["hips", "leftArm", "waist"]);
    expect(body.visit.version).toBeTruthy();
    expect(body.patient.identity.id).toBe(OWN);
    expect(measurementVisits[0]).toMatchObject({ waist: 34.5, hips: 41, left_arm: 12.3, neck: null, chest: null, right_arm: null, recorded_by: "provider-user" });

    // The audit trail names the visit and how many areas were measured, never the inches.
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ p_action: "patient_measurements_recorded", p_target_id: OWN, p_metadata: { visitId: body.visit.id, dateKey: "2026-01-03", areaCount: 3 } });
    // Scan everything except the random visit id, whose hex digits can legitimately contain "41".
    const serialized = JSON.stringify({ ...(audits[0].p_metadata as Record<string, unknown>), visitId: undefined });
    for (const forbidden of ["34.5", "41", "12.3", "waist", "hips", "leftArm", "Morning"]) expect(serialized).not.toContain(forbidden);

    // The live record carries the visit list, newest first, with values intact.
    measurementVisits.push({ visit_id: "m-older", patient_id: OWN, provider_id: "office-1", date_key: "2025-12-01", note: null, waist: 36, hips: null, recorded_by_name: "Dr. Reyes", created_at: "2025-12-01T10:00:00Z", updated_at: "2025-12-01T10:00:00Z" });
    const record = await api(`/office/patients/${OWN}`, "provider-token");
    expect(record.status).toBe(200);
    const detail = (await record.json()) as any;
    expect(detail.bodyMeasurements.map((visit: any) => [visit.id, visit.dateKey, visit.measurements])).toEqual([
      [body.visit.id, "2026-01-03", { waist: 34.5, hips: 41, leftArm: 12.3 }],
      ["m-older", "2025-12-01", { waist: 36 }],
    ]);
  });

  it("removes a visit only with its current version, and another office can never reach it", async () => {
    const created = await api(`/office/patients/${OWN}/measurements`, "member-token", { method: "POST", ...json({ dateKey: "2026-01-03", measurements: { waist: 34.5 } }) });
    expect(created.status).toBe(201);
    const visit = ((await created.json()) as any).visit;
    expect(visit.recordedByName).toBe("Sam Front Desk");

    // Another office's staff see neither the visit nor the patient.
    const otherToken = "provider-token";
    patients[0].provider_id = "office-2";
    expect((await api(`/office/patients/${OWN}/measurements/${visit.id}`, otherToken, { method: "DELETE", ...json({ expectedVersion: visit.version }) })).status).toBe(404);
    patients[0].provider_id = "office-1";
    expect(measurementVisits).toHaveLength(1);

    expect((await api(`/office/patients/${OWN}/measurements/${visit.id}`, "provider-token", { method: "DELETE", ...json({}) })).status).toBe(400);
    const stale = await api(`/office/patients/${OWN}/measurements/${visit.id}`, "provider-token", { method: "DELETE", ...json({ expectedVersion: "2020-01-01T00:00:00Z" }) });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as Row).code).toBe("record_changed");
    expect(measurementVisits).toHaveLength(1);

    const removed = await api(`/office/patients/${OWN}/measurements/${visit.id}`, "provider-token", { method: "DELETE", ...json({ expectedVersion: visit.version }) });
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as any).patient.identity.id).toBe(OWN);
    expect(measurementVisits).toEqual([]);
    expect(audits.at(-1)).toMatchObject({ p_action: "patient_measurements_removed", p_metadata: { visitId: visit.id, dateKey: "2026-01-03" } });
    expect(JSON.stringify(audits.at(-1)!.p_metadata)).not.toContain("34.5");
    expect((await api(`/office/patients/${OWN}/measurements/${visit.id}`, "provider-token", { method: "DELETE", ...json({ expectedVersion: visit.version }) })).status).toBe(404);
  });
});

describe("patient-facing boundary", () => {
  it("keeps staff-only tables out of the patient app's own-record reads", async () => {
    // patient-data.ts is the only patient-facing reader of the check-in and
    // profile tables; the staff-only tables and the status reason must never
    // appear in it. (Also enforced structurally: the tables have no
    // authenticated grants, so a client-side query could not read them either.)
    const { readFileSync } = await import("node:fs");
    const patientData = readFileSync(new URL("./patient-data.ts", import.meta.url), "utf8");
    expect(patientData).toContain("patient_check_ins");
    expect(patientData).not.toContain("patient_provider_notes");
    expect(patientData).not.toContain("patient_staff_weights");
    expect(patientData).not.toContain("patient_body_measurements");
    expect(patientData).not.toContain("activation_reason");
  });
});

describe("medications", () => {
  const MED = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const V_MED = "2026-01-05T09:00:00+00:00";
  function seedMedication(over: Row = {}) {
    medications.push({
      id: MED, patient_id: OWN, name: "THINNR Protocol drops", form: "drops", dose: "1 mL under the tongue", schedule_kind: "daily",
      times: ["08:00", "15:00", "22:00"], weekday: null, notes: null, start_date: "2026-01-01", stop_date: null, source: "onboarding",
      created_by_name: null, created_at: "2026-01-01T00:00:00+00:00", updated_at: V_MED, ...over,
    });
  }

  it("lists the medication record with a 30-day adherence view computed in the patient's zone", async () => {
    seedMedication();
    // The adherence window ends on the patient's local today (real clock), so
    // the logs sit two days back to land inside it and past the grace period.
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    doseLogs.push(
      { id: "l1", patient_id: OWN, medication_id: MED, due_date: twoDaysAgo, due_time: "08:00", status: "taken", source: "reminder", logged_at: `${twoDaysAgo}T13:05:00Z` },
      { id: "l2", patient_id: OWN, medication_id: MED, due_date: twoDaysAgo, due_time: "15:00", status: "skipped", source: "check_in", logged_at: `${twoDaysAgo}T20:05:00Z` },
    );
    const res = await api(`/office/patients/${OWN}/medications`, "member-token");
    expect(res.status).toBe(200);
    const body = await res.json() as { medications: Row[]; doseLogs: Row[]; adherence: Row; timeZone: string };
    expect(body.timeZone).toBe("America/New_York");
    expect(body.medications).toEqual([expect.objectContaining({ id: MED, name: "THINNR Protocol drops", scheduleKind: "daily", times: ["08:00", "15:00", "22:00"], version: V_MED, stopDate: null })]);
    expect(body.doseLogs.map((row) => row.status)).toEqual(["taken", "skipped"]);
    expect(body.adherence).toMatchObject({ taken: 1, skipped: 1 });
    expect(Number(body.adherence.missed)).toBeGreaterThan(0);
    expect(Array.isArray(body.adherence.days)).toBe(true);
    // Other office: neutral 404, no read of the record.
    expect((await api(`/office/patients/${OTHER}/medications`, "provider-token")).status).toBe(404);
    // Reading the list is record access: one deduped event for the reader, none for the refused read.
    expect((await api(`/office/patients/${OWN}/medications`, "member-token")).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readAudits.map((row) => [row.p_action, row.p_actor_user_id, row.p_actor_kind, row.p_provider_id, row.p_target_kind, row.p_target_id])).toEqual([
      ["patient_medications_viewed", "member-user", "team_member", "office-1", "patient", OWN],
    ]);
  });

  it("adds a medication on the patient's behalf (office source, staff attribution) and audits the id only", async () => {
    const res = await api(`/office/patients/${OWN}/medications`, "member-token", {
      method: "POST",
      ...json({ medication: { name: "Vitamin D", form: "capsule", dose: "2000 IU", scheduleKind: "weekly", weekday: 1, times: ["09:00"], startDate: "2026-01-02", notes: "With food" } }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { medication: Row; medications: Row[] };
    expect(body.medication).toMatchObject({ name: "Vitamin D", form: "capsule", dose: "2000 IU", scheduleKind: "weekly", weekday: 1, times: ["09:00"], source: "office", stopDate: null });
    expect(medications[0]).toMatchObject({ patient_id: OWN, source: "office", created_by: "member-user", created_by_name: "Sam Front Desk" });
    expect(body.medications).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(audits.at(-1)).toMatchObject({ p_action: "patient_medication_added", p_target_id: OWN, p_metadata: { medicationId: body.medication.id, kind: "weekly" } });
    expect(JSON.stringify(audits.at(-1)?.p_metadata)).not.toMatch(/Vitamin|2000|food/);
  });

  it("rejects incomplete or inconsistent records before touching the store", async () => {
    const bad = [
      { medication: { name: "", form: "capsule", scheduleKind: "daily", times: ["08:00"], startDate: "2026-01-02" } },
      { medication: { name: "X", form: "pill", scheduleKind: "daily", times: ["08:00"], startDate: "2026-01-02" } },
      { medication: { name: "X", form: "capsule", scheduleKind: "weekly", times: ["08:00"], startDate: "2026-01-02" } },
      { medication: { name: "X", form: "capsule", scheduleKind: "daily", times: [], startDate: "2026-01-02" } },
      { medication: { name: "X", form: "capsule", scheduleKind: "daily", times: ["8am"], startDate: "2026-01-02" } },
      { medication: { name: "X", form: "capsule", scheduleKind: "daily", times: ["08:00"], startDate: "2026-01-02", stopDate: "2026-01-01" } },
    ];
    for (const body of bad) {
      const res = await api(`/office/patients/${OWN}/medications`, "provider-token", { method: "POST", ...json(body) });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(typeof ((await res.json()) as { field?: string }).field).toBe("string");
    }
    expect(medications).toEqual([]);
  });

  it("edits with a version precondition, validates the merged record, and audits a stop as its own action", async () => {
    seedMedication();
    // Partial edit that would leave a weekly record without a weekday is refused.
    const inconsistent = await api(`/office/patients/${OWN}/medications/${MED}`, "provider-token", { method: "PATCH", ...json({ expectedVersion: V_MED, scheduleKind: "weekly" }) });
    expect(inconsistent.status).toBe(400);
    expect(await inconsistent.json()).toMatchObject({ field: "weekday" });

    const stale = await api(`/office/patients/${OWN}/medications/${MED}`, "provider-token", { method: "PATCH", ...json({ expectedVersion: "2020-01-01T00:00:00+00:00", dose: "2 mL" }) });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "record_changed" });
    expect(medications[0].dose).toBe("1 mL under the tongue");

    const edit = await api(`/office/patients/${OWN}/medications/${MED}`, "provider-token", { method: "PATCH", ...json({ expectedVersion: V_MED, dose: "2 mL", times: ["07:30", "21:30"] }) });
    expect(edit.status).toBe(200);
    const edited = (await edit.json() as { medication: Row }).medication;
    expect(edited).toMatchObject({ dose: "2 mL", times: ["07:30", "21:30"], stopDate: null });
    expect(edited.version).not.toBe(V_MED);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(audits.at(-1)).toMatchObject({ p_action: "patient_medication_updated", p_metadata: { medicationId: MED, fields: "dose,times" } });

    const stop = await api(`/office/patients/${OWN}/medications/${MED}`, "provider-token", { method: "PATCH", ...json({ expectedVersion: edited.version, stopDate: "2026-01-20" }) });
    expect(stop.status).toBe(200);
    expect((await stop.json() as { medication: Row }).medication.stopDate).toBe("2026-01-20");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(audits.at(-1)).toMatchObject({ p_action: "patient_medication_stopped", p_metadata: { medicationId: MED, fields: "stopDate" } });

    const missing = await api(`/office/patients/${OWN}/medications/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee`, "provider-token", { method: "PATCH", ...json({ expectedVersion: V_MED, dose: "x" }) });
    expect(missing.status).toBe(404);
    const noChange = await api(`/office/patients/${OWN}/medications/${MED}`, "provider-token", { method: "PATCH", ...json({ expectedVersion: V_MED }) });
    expect(noChange.status).toBe(400);
  });
});

describe("edit history", () => {
  const MED = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const V_MED = "2026-01-05T09:00:00+00:00";
  const byFamily = (family: string) => history.filter((row) => row.family === family);
  const fieldsOf = (rows: Row[]) => rows.map((row) => [row.field, row.old_value, row.new_value]);

  it("keeps the prior value of every staff correction, paired with its audit event and actor name", async () => {
    // Profile: only the fields that actually changed, old → new, paired with the audit id the RPC answered.
    const profile = await api(`/office/patients/${OWN}`, "member-token", { method: "PATCH", ...json({ expectedVersion: V1, firstName: "Cass", goalWeight: 155 }) });
    expect(profile.status).toBe(200);
    expect(byFamily("profile")).toEqual([
      expect.objectContaining({ record_id: OWN, change_kind: "update", actor_kind: "team_member", actor_user_id: "member-user", actor_name: "Sam Front Desk", audit_event_id: 1001, field: "firstName", old_value: "Casey", new_value: "Cass" }),
      expect.objectContaining({ field: "goalWeight", old_value: 160, new_value: 155, audit_event_id: 1001 }),
    ]);
    expect(audits[0]).toMatchObject({ p_action: "patient_profile_updated" });
    expect(JSON.stringify(audits[0].p_metadata)).not.toMatch(/Casey|Cass|155/);

    // Status: the transition and its reason.
    const version = String(patients[0].updated_at);
    const status = await api(`/office/patients/${OWN}/status`, "provider-token", { method: "PATCH", ...json({ expectedVersion: version, status: "paused", reason: "Travel" }) });
    expect(status.status).toBe(200);
    expect(fieldsOf(byFamily("status"))).toEqual([["status", "activated", "paused"], ["reason", null, "Travel"]]);
    expect(byFamily("status")[0]).toMatchObject({ actor_kind: "provider", actor_name: "Dr. Reyes", audit_event_id: 1002 });

    // Notes: the body is recorded on create and again on delete (the audit ledger never carries it).
    const note = await api(`/office/patients/${OWN}/notes`, "provider-token", { method: "POST", ...json({ body: "Prefers morning visits" }) });
    const noteId = String(((await note.json()) as any).note.id);
    expect((await api(`/office/patients/${OWN}/notes/${noteId}`, "provider-token", { method: "DELETE" })).status).toBe(200);
    expect(fieldsOf(byFamily("note"))).toEqual([["body", null, "Prefers morning visits"], ["body", "Prefers morning visits", null]]);
    expect(byFamily("note").map((row) => row.change_kind)).toEqual(["create", "delete"]);
    expect(JSON.stringify(audits.map((row) => row.p_metadata))).not.toMatch(/morning/);

    // Measurements: a visit is created with its measured areas and removed with the same values.
    const visit = await api(`/office/patients/${OWN}/measurements`, "provider-token", { method: "POST", ...json({ dateKey: "2026-01-05", measurements: { waist: 34.5, hips: 40 } }) });
    expect(visit.status).toBe(201);
    const visitBody = (await visit.json()) as any;
    expect(fieldsOf(byFamily("measurement"))).toEqual([["dateKey", null, "2026-01-05"], ["waist", null, 34.5], ["hips", null, 40]]);
    expect((await api(`/office/patients/${OWN}/measurements/${visitBody.visit.id}`, "provider-token", { method: "DELETE", ...json({ expectedVersion: visitBody.visit.version }) })).status).toBe(200);
    expect(fieldsOf(byFamily("measurement").filter((row) => row.change_kind === "delete"))).toEqual([["dateKey", "2026-01-05", null], ["waist", 34.5, null], ["hips", 40, null]]);

    // Medications: create snapshot, then only the edited fields.
    medications.push({
      id: MED, patient_id: OWN, name: "THINNR Protocol drops", form: "drops", dose: "1 mL under the tongue", schedule_kind: "daily",
      times: ["08:00", "15:00", "22:00"], weekday: null, notes: null, start_date: "2026-01-01", stop_date: null, source: "onboarding",
      created_by_name: null, created_at: "2026-01-01T00:00:00+00:00", updated_at: V_MED,
    });
    const edit = await api(`/office/patients/${OWN}/medications/${MED}`, "provider-token", { method: "PATCH", ...json({ expectedVersion: V_MED, dose: "2 mL", times: ["07:30", "21:30"] }) });
    expect(edit.status).toBe(200);
    expect(fieldsOf(byFamily("medication"))).toEqual([["dose", "1 mL under the tongue", "2 mL"], ["times", ["08:00", "15:00", "22:00"], ["07:30", "21:30"]]]);
    expect(byFamily("medication")[0]).toMatchObject({ record_id: MED, change_kind: "update", audit_event_id: 1000 + audits.length });

    // Every history row pairs with a real audit event and the audit ledger itself still holds no values.
    for (const row of history) expect(audits[Number(row.audit_event_id) - 1001]).toBeDefined();
  });

  it("overwriting a weight twice leaves both prior values retrievable through the office read route", async () => {
    const created = await api(`/office/patients/${OWN}/weights`, "provider-token", { method: "POST", ...json({ dateKey: "2026-01-04", weight: 190.2, note: "Office scale" }) });
    expect(created.status).toBe(201);
    const weight = ((await created.json()) as any).weight;
    const first = await api(`/office/patients/${OWN}/weights/${weight.id}`, "member-token", { method: "PATCH", ...json({ expectedVersion: weight.version, weight: 188.4 }) });
    expect(first.status).toBe(200);
    const second = await api(`/office/patients/${OWN}/weights/${weight.id}`, "provider-token", { method: "PATCH", ...json({ expectedVersion: ((await first.json()) as any).weight.version, weight: 187 }) });
    expect(second.status).toBe(200);
    expect(fieldsOf(byFamily("weight").filter((row) => row.field === "weight"))).toEqual([["weight", null, 190.2], ["weight", 190.2, 188.4], ["weight", 188.4, 187]]);

    // Newest first, grouped per change, with the actor's display name; a
    // read-only team member (or HQ naming the office) can see it too.
    const page = await api(`/office/patients/${OWN}/history?family=weight`, "member-token");
    expect(page.status).toBe(200);
    const body = (await page.json()) as any;
    expect(body.total).toBe(3);
    expect(body.nextOffset).toBeNull();
    expect(body.changes.map((change: any) => [change.changeKind, change.actorName, change.fields.find((f: any) => f.field === "weight")])).toEqual([
      ["update", "Dr. Reyes", { field: "weight", old: 188.4, new: 187 }],
      ["update", "Sam Front Desk", { field: "weight", old: 190.2, new: 188.4 }],
      ["create", "Dr. Reyes", { field: "weight", old: null, new: 190.2 }],
    ]);
    expect(body.changes[0]).toMatchObject({ family: "weight", recordId: weight.id, actorKind: "provider", auditEventId: 1003 });

    // Paging and filters.
    const paged = (await (await api(`/office/patients/${OWN}/history?limit=2`, "provider-token")).json()) as any;
    expect(paged.changes).toHaveLength(2);
    expect(paged.nextOffset).toBe(2);
    expect(((await (await api(`/office/patients/${OWN}/history?family=note`, "provider-token")).json()) as any).total).toBe(0);
    expect((await api(`/office/patients/${OWN}/history?family=diary`, "provider-token")).status).toBe(400);
    const hq = await api(`/office/patients/${OWN}/history?office=office-1`, "hq-token");
    expect(hq.status).toBe(200);
    expect(((await hq.json()) as any).total).toBe(3);
    // Another office's patient and HQ naming the wrong office are the neutral 404.
    expect((await api(`/office/patients/${OTHER}/history`, "provider-token")).status).toBe(404);
    expect((await api(`/office/patients/${OWN}/history?office=office-2`, "hq-token")).status).toBe(404);
  });
});
