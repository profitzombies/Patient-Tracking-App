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
import { afterEach, afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// These legacy-office fixtures have a fixed, synthetic billing environment.
vi.mock("../billing/mode-state", () => ({
  getBillingModeStatus: async () => ({mode:"test",platformAccountId:"acct_fixture",version:0}),
}));

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

import router, { RECORD_NOT_FOUND } from "./office-roster";
import { ensurePatientAuthUser } from "../auth/session";
import { resetRecordAccessCache } from "../lib/record-access-audit";

type Row = Record<string, unknown>;
const originalFetch = global.fetch;
let server: http.Server;
let baseUrl = "";

let authUsers: Record<string, string> = {};
let providers: Row[] = [];
let launchRequired = false;
let teamMembers: Row[] = [];
let patients: Row[] = [];
let patientTables: Record<string, Row[]> = {};
let locks: string[] = [];
let hqMemberships: Row[] = [];
let resendFails = false;
let insertFailsWith: string | null = null;
let resendCalls: Array<{ to: unknown; template: unknown; vars: Row }> = [];
let patchFailures = 0;
let operationalFacts: Row[] | null = null;
let activityRequests: Array<{ p_provider_id: string; p_at: string }> = [];
let operationalFollowUps: Row[] = [];
let groupMembers: Row[] = [];
let outreachStates: Row[] = [];
let deletionRequests: Row[] = [];
let tombstones: Row[] = [];
let billingSubscriptions: Row[] | "unavailable" = [];
let readAudits: Row[] = [];
let spendRows: Row[] | "unavailable" = [];
const spendRequests: string[] = [];

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
  launchRequired = false;
  readAudits = [];
  resetRecordAccessCache();
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
    patient_media: [],
    patient_check_ins: [],
    patient_flags: [],
    patient_provider_notes: [],
    patient_staff_weights: [],
    patient_body_measurements: [],
    patient_medications: [],
    patient_medication_dose_logs: [],
  };
  locks = [];
  hqMemberships = [{ department_role: "admin", status: "active" }];
  resendFails = false;
  insertFailsWith = null;
  resendCalls = [];
  patchFailures = 0;
  operationalFacts = null;
  activityRequests = [];
  operationalFollowUps = [];
  groupMembers = [];
  outreachStates = [];
  deletionRequests = [];
  tombstones = [];
  billingSubscriptions = [];
  spendRows = [];
  spendRequests.length = 0;

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
    // Unwaived practices have no completion in the current payment mode.
    if (url.pathname === "/rest/v1/practice_launch_completions") return response([]);
    if (url.pathname === "/rest/v1/practice_launch") {
      const id=url.searchParams.get("provider_id")?.replace("eq.","");
      return response(providers.some(row=>row.provider_id===id) ? [{provider_id:id,required:launchRequired,version:0,details_confirmed:false,products_confirmed:false,completed_at:null,setup_override_at:launchRequired?null:"2026-01-01T00:00:00Z"}] : []);
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
      return response(patients
          .filter((row) => String(row.phone ?? "").replace(/\D/g, "").slice(-10) === last10)
          .map((row) => ({ type: "patient", ref: row.id })),
      );
    }
    if (url.pathname === "/rest/v1/rpc/provider_patient_activity_summary") {
      const body = JSON.parse(String(init?.body)) as { p_provider_id: string; p_at: string };
      activityRequests.push(body);
      return response(operationalFacts ?? patients
          .filter((patient) => patient.provider_id === body.p_provider_id)
          .map((patient) => ({
            patient_id: patient.id,
            latest_activity_date: null,
            latest_diary_date: null,
            latest_water_date: null,
            latest_check_in_date: null,
            latest_weight_date: null,
            latest_photo_date: null,
            logged_days_7: 0,
            check_ins_7: 0,
          })),
      );
    }
    if (url.pathname === "/rest/v1/rpc/record_admin_audit_event") return response(null, 204);
    if (url.pathname === "/rest/v1/rpc/record_admin_audit_read_event") {
      readAudits.push(JSON.parse(String(init?.body)) as Row);
      return response([{ recorded: true, window_started_at: new Date().toISOString() }]);
    }
    if (url.pathname === "/rest/v1/rpc/provider_outreach_states") return response(outreachStates);
    if (url.pathname === "/rest/v1/rpc/billing_office_patient_spend") {
      const body = JSON.parse(String(init?.body)) as { p_provider_id: string };
      spendRequests.push(body.p_provider_id);
      if (spendRows === "unavailable") return response({ message: "function missing" }, 500);
      return response(spendRows.filter((row) => row.provider_id === body.p_provider_id).map(({ provider_id: _office, ...row }) => row));
    }
    if (url.pathname === "/rest/v1/billing_subscriptions") {
      if (billingSubscriptions === "unavailable") return response({ message: "relation missing" }, 500);
      const officeId = (url.searchParams.get("provider_id") ?? "").replace("eq.", "");
      const statuses = (url.searchParams.get("status") ?? "").replace(/^in\.\((.*)\)$/, "$1").split(",");
      return response(billingSubscriptions.filter((row) => row.provider_id === officeId && statuses.includes(String(row.status))));
    }
    if (url.pathname === "/rest/v1/patient_deletion_requests" || url.pathname === "/rest/v1/patient_tombstones") {
      const source = url.pathname.endsWith("requests") ? deletionRequests : tombstones;
      return response(source.filter((row) => [...url.searchParams.entries()].every(([key, raw]) => !raw.startsWith("eq.") || String(row[key]) === raw.slice(3))));
    }
    if (url.pathname === "/rest/v1/patient_group_members") {
      const providerId = url.searchParams.get("provider_id")?.replace("eq.", "");
      const patientId = url.searchParams.get("patient_id")?.replace("eq.", "");
      return response(groupMembers.filter((row) => (!providerId || row.provider_id === providerId) && (!patientId || row.patient_id === patientId)));
    }
    if (url.pathname === "/rest/v1/patient_operational_follow_ups") {
      const providerId = url.searchParams.get("provider_id")?.replace("eq.", "");
      return response(operationalFollowUps.filter((row) => !providerId || row.provider_id === providerId));
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
      // Office-wide reads (roster adherence) filter on the embedded patients row.
      const officeId = (url.searchParams.get("patients.provider_id") ?? "").replace("eq.", "");
      if (officeId) {
        const ids = new Set(patients.filter((row) => row.provider_id === officeId).map((row) => row.id));
        return response(patientTables[patientTable].filter((row) => ids.has(row.patient_id)));
      }
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
  it("blocks owner and teammate operational deep links for a new unfinished practice",async()=>{
    launchRequired=true;
    for(const token of ["provider-token","member-token"]) {
      const res=await api("/office/roster",token);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({error:expect.stringContaining("complete setup")});
    }
    // Grandfathering, not a client-side bypass, restores the same legacy fixture.
    launchRequired=false;
    expect((await api("/office/roster","provider-token")).status).toBe(200);
  });
  it("merges safe operational facts and derives deterministic roster summary", async () => {
    const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    patients[0].created_at = `${day(10)}T00:00:00Z`;
    operationalFacts = [{
      patient_id: "pat-own", latest_activity_date: day(1), latest_diary_date: day(3),
      latest_water_date: day(1), latest_check_in_date: day(7), latest_weight_date: day(4),
      latest_photo_date: day(4), logged_days_7: 3, check_ins_7: 1,
      notes: "must never be returned", value: 190, object_path: "private/path",
    }];
    const res = await api("/office/roster", "provider-token");
    expect(res.status).toBe(200);
    const body = await res.json() as { patients: Row[]; summary: Row };
    expect(body.patients[0].operational).toMatchObject({ loggedDays7: 3, checkIns7: 1, status: "needs_attention", reasons: ["logging_lapsed", "check_in_overdue"] });
    expect(body.summary).toMatchObject({ totalPatients: 1, activePatients: 1, needsAttention: 1, checkInsOverdue: 1, loggingLapsed: 1 });
    expect(JSON.stringify(body)).not.toMatch(/private\/path|must never|190/);
    // The aggregate is asked once per roster load, for the request moment —
    // it derives each patient's own local day from that instant.
    expect(activityRequests).toHaveLength(1);
    expect(activityRequests[0]).toMatchObject({ p_provider_id: "office-1" });
    expect(Date.parse(activityRequests[0].p_at)).not.toBeNaN();
    // No outreach state on file: the chip stays silent.
    expect(body.patients[0].outreach).toMatchObject({ state: "none", delivery: null });
  });

  it("surfaces the server-side coach outreach state as the roster chip", async () => {
    outreachStates = [{
      patient_id: "pat-own", eligible: true, crossed_on_key: "2026-06-20", evaluated_at: "2026-07-01T00:00:00Z", decision: "send",
      nudge_opt_out: false, nudge_engaged: false, nudge_last_sent_key: "2026-06-21", nudge_last_crossing_key: "2026-06-20",
      notification_id: "n-1", notification_status: "suppressed", notification_updated_at: "2026-06-21T00:00:00Z", notification_suppression_reason: "no_device",
    }];
    const res = await api("/office/roster", "provider-token");
    const body = await res.json() as { patients: Row[] };
    expect(body.patients[0].outreach).toEqual({
      state: "sent_awaiting", eligible: true, crossedOnKey: "2026-06-20", evaluatedAt: "2026-07-01T00:00:00Z", lastSentKey: "2026-06-21",
      delivery: "suppressed", deliveryDetail: "No registered device", notificationId: "n-1",
    });
  });

  it("shows a pending deletion on the roster and record, lists purged accounts as tombstones, and keeps them out of the patient totals", async () => {
    const GONE_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const GONE_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
    deletionRequests = [{ patient_id: "pat-own", provider_id: "office-1", status: "pending", requested_at: "2026-07-01T00:00:00Z", purge_after: "2026-07-08T00:00:00Z" }];
    patients[0].deletion_requested_at = "2026-07-01T00:00:00Z";
    tombstones = [
      { id: GONE_1, provider_id: "office-1", requested_at: "2026-06-01T00:00:00Z", purged_at: "2026-06-08T00:00:00Z", was_activated: true, program_id: "thinnr", enrolled_on: "2026-01-15" },
      { id: GONE_2, provider_id: "office-2", requested_at: "2026-06-01T00:00:00Z", purged_at: "2026-06-08T00:00:00Z", was_activated: false, program_id: null, enrolled_on: null },
    ];
    const res = await api("/office/roster", "provider-token");
    expect(res.status).toBe(200);
    const body = await res.json() as { patients: Row[]; deletedAccounts: Row[]; summary: Row };
    expect(body.patients[0].deletion).toEqual({ state: "requested", requestedAt: "2026-07-01T00:00:00Z", purgeAfter: "2026-07-08T00:00:00Z" });
    // Only this office's tombstones, and nothing but the PII-free shape.
    expect(body.deletedAccounts).toEqual([
      { id: GONE_1, requestedAt: "2026-06-01T00:00:00Z", purgedAt: "2026-06-08T00:00:00Z", wasActivated: true, programId: "thinnr", enrolledOn: "2026-01-15" },
    ]);
    expect(body.summary).toMatchObject({ totalPatients: 1, deletionRequested: 1, deletedAccounts: 1 });

    // The record carries the same pending state.
    const record = await api("/office/patients/pat-own", "provider-token");
    expect(record.status).toBe(200);
    expect(((await record.json()) as { patient: Row }).patient.deletion).toEqual({ state: "requested", requestedAt: "2026-07-01T00:00:00Z", purgeAfter: "2026-07-08T00:00:00Z" });

    // A purged patient's record answers 410 with the tombstone, never a 404 or a half-record.
    const gone = await api(`/office/patients/${GONE_1}`, "provider-token");
    expect(gone.status).toBe(410);
    const goneBody = await gone.json() as { error: string; deleted: Row };
    expect(goneBody.error).toMatch(/deleted their account/);
    expect(goneBody.deleted).toMatchObject({ id: GONE_1, wasActivated: true });
    // Another office's tombstone is invisible.
    expect((await api(`/office/patients/${GONE_2}`, "provider-token")).status).toBe(404);
  });

  it("flags patients with an active shop subscription and goes null when billing cannot be read", async () => {
    const none = await (await api("/office/roster", "provider-token")).json() as { patients: Row[] };
    expect(none.patients.map((row) => row.activeSubscription)).toEqual([false]);

    billingSubscriptions = [
      { provider_id: "office-1", patient_id: "pat-own", status: "past_due" },
      { provider_id: "office-1", patient_id: "pat-own", status: "canceled" },
      // Another office's subscription for a different patient never leaks in.
      { provider_id: "office-2", patient_id: "pat-other", status: "active" },
    ];
    const flagged = await (await api("/office/roster", "provider-token")).json() as { patients: Row[] };
    expect(flagged.patients.map((row) => [row.id, row.activeSubscription])).toEqual([["pat-own", true]]);

    billingSubscriptions = [{ provider_id: "office-1", patient_id: "pat-own", status: "canceled" }];
    const canceled = await (await api("/office/roster", "provider-token")).json() as { patients: Row[] };
    expect(canceled.patients[0].activeSubscription).toBe(false);

    billingSubscriptions = "unavailable";
    const unknown = await api("/office/roster", "provider-token");
    expect(unknown.status).toBe(200);
    expect((await unknown.json() as { patients: Row[] }).patients[0].activeSubscription).toBeNull();
  });

  it("carries lifetime spend from the office spend aggregate and goes null when it cannot run", async () => {
    // No paid orders yet: a real zero, not unknown.
    const none = await (await api("/office/roster", "provider-token")).json() as { patients: Row[] };
    expect(none.patients[0].spend).toEqual({ paidCents: 0, refundedCents: 0, netCents: 0, lastPaidAt: null });
    expect(spendRequests).toEqual(["office-1"]);

    spendRows = [
      { provider_id: "office-1", patient_id: "pat-own", paid_cents: "61400", refunded_cents: "1400", last_paid_at: "2026-09-10T15:00:00.000Z" },
      // Another office's spend for a different patient never leaks in.
      { provider_id: "office-2", patient_id: "pat-other", paid_cents: 9900, refunded_cents: 0, last_paid_at: "2026-09-11T15:00:00.000Z" },
    ];
    const spent = await (await api("/office/roster", "provider-token")).json() as { patients: Row[] };
    expect(spent.patients.map((row) => [row.id, row.spend])).toEqual([
      ["pat-own", { paidCents: 61400, refundedCents: 1400, netCents: 60000, lastPaidAt: "2026-09-10T15:00:00.000Z" }],
    ]);

    // HQ drill-in asks the aggregate for the explicitly scoped office.
    spendRequests.length = 0;
    const hq = await (await api("/office/roster?office=office-2", "hq-token")).json() as { patients: Row[] };
    expect(spendRequests).toEqual(["office-2"]);
    expect(hq.patients.map((row) => [row.id, row.spend])).toEqual([
      ["pat-other", { paidCents: 9900, refundedCents: 0, netCents: 9900, lastPaidAt: "2026-09-11T15:00:00.000Z" }],
    ]);

    spendRows = "unavailable";
    const unknown = await api("/office/roster", "provider-token");
    expect(unknown.status).toBe(200);
    expect((await unknown.json() as { patients: Row[] }).patients[0].spend).toBeNull();
  });

  it("reports no deletion state for an untouched roster", async () => {
    const body = await (await api("/office/roster", "provider-token")).json() as { patients: Row[]; deletedAccounts: Row[]; summary: Row };
    expect(body.patients[0].deletion).toBeNull();
    expect(body.deletedAccounts).toEqual([]);
    expect(body.summary).toMatchObject({ deletionRequested: 0, deletedAccounts: 0 });
  });

  it("adds medication adherence as its own roster and record input, null until a dose has come due, without touching the engagement families", async () => {
    const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    const before = await (await api("/office/roster", "provider-token")).json() as { patients: Row[] };
    expect(before.patients[0].medicationAdherence).toBeNull();

    patientTables.patient_medications.push({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", patient_id: "pat-own", name: "THINNR Protocol drops", form: "drops", dose: "1 mL",
      schedule_kind: "daily", times: ["08:00"], weekday: null, notes: null, start_date: day(3), stop_date: null, source: "onboarding",
      created_by_name: null, created_at: `${day(3)}T00:00:00Z`, updated_at: `${day(3)}T00:00:00Z`,
    }, {
      // Another office's patient never leaks into this roster's input.
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", patient_id: "pat-other", name: "Other", form: "tablet", dose: null,
      schedule_kind: "daily", times: ["08:00"], weekday: null, notes: null, start_date: day(3), stop_date: null, source: "patient",
      created_by_name: null, created_at: `${day(3)}T00:00:00Z`, updated_at: `${day(3)}T00:00:00Z`,
    });
    patientTables.patient_medication_dose_logs.push(
      { id: "l1", patient_id: "pat-own", medication_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", due_date: day(3), due_time: "08:00", status: "taken", source: "reminder", logged_at: `${day(3)}T13:00:00Z` },
      { id: "l2", patient_id: "pat-own", medication_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", due_date: day(2), due_time: "08:00", status: "skipped", source: "check_in", logged_at: `${day(2)}T13:00:00Z` },
    );
    const body = await (await api("/office/roster", "provider-token")).json() as { patients: Array<Row & { operational: Row; medicationAdherence: Row }> };
    const own = body.patients.find((row) => row.id === "pat-own")!;
    expect(own.medicationAdherence).toMatchObject({ taken: 1, skipped: 1 });
    const due = own.medicationAdherence.due;
    if (typeof due !== "number") throw new Error("Expected a numeric medication due count");
    expect(due).toBeGreaterThanOrEqual(3);
    expect(own.medicationAdherence.missed).toBe(due - 2);
    expect(own.medicationAdherence.rate).toBe(Math.round((100 * 1) / Number(own.medicationAdherence.due)));
    // Engagement signals keep their own definitions and shape: the untouched
    // activity aggregate still reads as no-activity-yet regardless of doses.
    const beforeOwn = before.patients.find((row) => row.id === "pat-own")!;
    expect(own.operational).toEqual(beforeOwn.operational);
    expect(Object.keys(own.operational.activity as Row)).not.toContain("medicationAdherence");

    const record = await (await api("/office/patients/pat-own", "provider-token")).json() as { medicationAdherence: Row; medications: Row[]; engagement: Row };
    expect(record.medicationAdherence).toEqual(own.medicationAdherence);
    expect(record.medications).toEqual([expect.objectContaining({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "THINNR Protocol drops" })]);
    expect(Object.keys(record.engagement)).not.toContain("medicationAdherence");
  });

  it("passes the aggregate's activity signals through as explicit nullable families", async () => {
    const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    operationalFacts = [{
      patient_id: "pat-own", as_of_date: day(0), latest_activity_date: day(0), latest_diary_date: day(0),
      latest_water_date: day(1), latest_check_in_date: day(2), latest_weight_date: day(2), latest_photo_date: null,
      logged_days_7: 4, check_ins_7: 1,
      logged_last_7: [false, true, true, false, true, false, true], meal_streak: 1,
      avg_calories_7: "1412", avg_water_7: 58, check_in_streak: 0, check_in_rate_30: 13,
      mood_counts: { "1": 0, "2": 1, "3": 2, "4": 1, "5": 0 },
      top_side_effects: [{ name: "Nausea", count: 3 }, { name: "Fatigue", count: 1 }],
    }];
    const body = await (await api("/office/roster", "provider-token")).json() as { patients: Row[] };
    expect(body.patients[0].operational).toMatchObject({
      asOfDate: day(0), loggedDays7: 4, checkIns7: 1, status: "on_track", reasons: [],
      activity: {
        asOfDate: day(0), loggedLast7: [false, true, true, false, true, false, true], loggedDays7: 4,
        mealStreak: 1, avgCalories7: 1412, avgWater7: 58, checkInStreak: 0, checkInRate30: 13,
        latestCheckInDate: day(2), moodCounts: { "1": 0, "2": 1, "3": 2, "4": 1, "5": 0 },
        topSideEffects: [{ name: "Nausea", count: 3 }, { name: "Fatigue", count: 1 }],
      },
    });
  });

  it("keeps 'no data yet' families null instead of coining zeros", async () => {
    const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    // Water only: the diary and check-in families are unknown, water is real.
    operationalFacts = [{
      patient_id: "pat-own", as_of_date: day(0), latest_activity_date: day(0), latest_diary_date: null,
      latest_water_date: day(0), latest_check_in_date: null, latest_weight_date: null, latest_photo_date: null,
      logged_days_7: null, check_ins_7: null, logged_last_7: null, meal_streak: null,
      avg_calories_7: null, avg_water_7: 40, check_in_streak: null, check_in_rate_30: null,
      mood_counts: null, top_side_effects: null,
    }];
    const body = await (await api("/office/roster", "provider-token")).json() as { patients: Row[] };
    const operational = body.patients[0].operational as Record<string, unknown>;
    expect(operational).toMatchObject({
      loggedDays7: null, checkIns7: null,
      activity: {
        loggedLast7: null, loggedDays7: null, mealStreak: null, avgCalories7: null, avgWater7: 40,
        checkInStreak: null, checkInRate30: null, latestCheckInDate: null, moodCounts: null, topSideEffects: null,
      },
    });
    expect(JSON.stringify(operational.activity)).not.toMatch(/"loggedDays7":0|"checkInRate30":0/);
  });

  it("reports a patient missing from the aggregate as unknown, never as lapsed", async () => {
    patients[0].created_at = new Date(Date.now() - 20 * 86_400_000).toISOString();
    operationalFacts = []; // aggregate answered, but not for this patient
    const body = await (await api("/office/roster", "provider-token")).json() as { patients: Row[]; summary: Row };
    expect(body.patients[0].operational).toMatchObject({
      status: "unknown", reasons: [], activity: null, loggedDays7: null, checkIns7: null,
    });
    expect(body.summary).toMatchObject({ needsAttention: 0, inactive: 0, loggingLapsed: 0, checkInsOverdue: 0 });
  });

  it("measures recency against the patient's own local day", async () => {
    // Account created 3 UTC-days ago; the patient's local day is one behind
    // the server's, so they are only 2 local days old — not yet lapsed.
    const utcDay = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    patients[0].created_at = `${utcDay(3)}T12:00:00Z`;
    operationalFacts = [{
      patient_id: "pat-own", as_of_date: utcDay(1), latest_activity_date: null, latest_diary_date: null,
      latest_water_date: null, latest_check_in_date: null, latest_weight_date: null, latest_photo_date: null,
      logged_days_7: null, check_ins_7: null, logged_last_7: null, meal_streak: null, avg_calories_7: null,
      avg_water_7: null, check_in_streak: null, check_in_rate_30: null, mood_counts: null, top_side_effects: null,
    }];
    const body = await (await api("/office/roster", "provider-token")).json() as { patients: Row[] };
    expect(body.patients[0].operational).toMatchObject({ asOfDate: utcDay(1), status: "on_track", reasons: [] });
  });

  it("fails loudly when the aggregate itself is unavailable", async () => {
    operationalFacts = null;
    const failing = global.fetch;
    global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/rest/v1/rpc/provider_patient_activity_summary") {
        return new Response(JSON.stringify({ message: "boom" }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
      return failing(input, init);
    }) as typeof fetch;
    try {
      const res = await api("/office/roster", "provider-token");
      expect(res.status).toBe(502);
    } finally {
      global.fetch = failing;
    }
  });

  it("merges only newest follow-up metadata per reason without clinical fields", async () => {
    operationalFollowUps = [
      { provider_id: "office-1", patient_id: "pat-own", reason: "logging_lapsed", status: "resolved", created_at: "2026-02-02T00:00:00Z", resolved_at: "2026-02-03T00:00:00Z", resolved_by: "staff" },
      { provider_id: "office-1", patient_id: "pat-own", reason: "logging_lapsed", status: "open", created_at: "2026-02-01T00:00:00Z", notes: "clinical secret" },
    ];
    const body = await (await api("/office/roster", "provider-token")).json() as { patients: Array<{ operational: { followUps: unknown[] } }> };
    const followUps = body.patients[0].operational.followUps;
    expect(followUps).toEqual([{ reason: "logging_lapsed", status: "resolved", createdAt: "2026-02-02T00:00:00Z", resolvedAt: "2026-02-03T00:00:00Z" }]);
    expect(JSON.stringify(followUps)).not.toContain("secret");
  });

  it("carries each patient's office group ids on the roster row and the record, scoped to the office", async () => {
    groupMembers = [
      { provider_id: "office-1", patient_id: "pat-own", group_id: "grp-mjh", added_at: "2026-02-01T00:00:00Z" },
      { provider_id: "office-1", patient_id: "pat-own", group_id: "grp-tue", added_at: "2026-02-02T00:00:00Z" },
      { provider_id: "office-2", patient_id: "pat-other", group_id: "grp-other", added_at: "2026-02-02T00:00:00Z" },
    ];
    const roster = await (await api("/office/roster", "provider-token")).json() as { patients: Array<{ id: string; groupIds: string[] }> };
    expect(roster.patients.find((row) => row.id === "pat-own")?.groupIds).toEqual(["grp-mjh", "grp-tue"]);
    expect(roster.patients.every((row) => Array.isArray(row.groupIds))).toBe(true);
    expect(roster.patients.filter((row) => row.id !== "pat-own").every((row) => row.groupIds.length === 0)).toBe(true);
    const record = await (await api("/office/patients/pat-own", "provider-token")).json() as { patient: { groupIds: string[] } };
    expect(record.patient.groupIds).toEqual(["grp-mjh", "grp-tue"]);
  });

  it("returns a zero operational summary for an empty scoped office", async () => {
    patients = patients.filter((patient) => patient.provider_id !== "office-2");
    const res = await api("/office/roster?office=office-2", "hq-token");
    expect(res.status).toBe(200);
    expect((await res.json() as { summary: Row }).summary).toMatchObject({
      totalPatients: 0, activePatients: 0, needsAttention: 0, inactive: 0, invited: 0,
    });
  });

  it("marks activated patients with fourteen days of no activity", async () => {
    patients[0].created_at = new Date(Date.now() - 15 * 86_400_000).toISOString();
    const res = await api("/office/roster", "provider-token");
    const body = await res.json() as { patients: Row[] };
    expect(body.patients[0].operational).toMatchObject({
      status: "inactive", reasons: ["no_activity_14d", "logging_lapsed", "check_in_overdue"],
    });
    expect(body.patients[0].program).toMatchObject({ day: null, stage: null, week: null });
  });
  it("badges paused and discharged patients and keeps them out of outreach signals", async () => {
    patients[0].created_at = new Date(Date.now() - 15 * 86_400_000).toISOString();
    patients[0].activation_status = "paused";
    patients[0].activation_reason = "Travelling for a month";
    patients.push({ ...patients[0], id: "pat-discharged", activation_status: "discharged", email: "d@example.com", phone: "+15550009999" });
    const res = await api("/office/roster", "provider-token");
    const body = await res.json() as { patients: Row[]; summary: Row };
    expect(body.patients.map((patient) => (patient.operational as Row).status)).toEqual(["paused", "discharged"]);
    expect(body.patients.every((patient) => ((patient.operational as Row).reasons as unknown[]).length === 0)).toBe(true);
    expect(body.summary).toMatchObject({ totalPatients: 2, activePatients: 0, needsAttention: 0, inactive: 0, loggingLapsed: 0, checkInsOverdue: 0 });
    const detail = await api("/office/patients/pat-own", "provider-token");
    expect(((await detail.json()) as any).patient.identity).toMatchObject({ activationStatus: "paused", activationReason: "Travelling for a month" });
  });

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
    expect(body.providerNotes).toEqual([]);
    expect(body.staffWeights).toEqual([]);
    expect(body.bodyMeasurements).toEqual([]);
    expect(body.patient.version).toBeNull();
    expect(body.patient.groupIds).toEqual([]);
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
        kind: "food", ref_id: "eggs", name: "Eggs", quantity: 1, calories: 200, protein: 20, carbs: 2, fat: 12,
      },
      {
        patient_id: ownId, entry_id: "e-2", date_key: "2026-01-05", meal: "dinner",
        kind: "food", ref_id: "chicken", name: "Chicken", quantity: 1, calories: 300, protein: 40, carbs: 3, fat: 10,
      },
    );
    patientTables.patient_water_days.push({ patient_id: ownId, date_key: "2026-01-05", oz: 72 });
    patientTables.patient_check_ins.push({
      patient_id: ownId, check_in_id: "c-1", date_key: "2026-01-05",
      weight: "191", mood: 4, side_effects: ["nausea"], notes: "Doing well",
    });
    patientTables.patient_staff_weights.push({
      patient_id: ownId, provider_id: "office-1", weight_id: "sw-1", date_key: "2026-01-03", weight: "196.5",
      note: "Office scale", recorded_by_name: "Dr. Reyes", created_at: "2026-01-03T15:00:00Z", updated_at: "2026-01-03T15:00:00Z",
    });
    patientTables.patient_body_measurements.push({
      patient_id: ownId, provider_id: "office-1", visit_id: "bm-1", date_key: "2026-01-03", note: "Baseline",
      neck: "15.0", waist: "36.5", hips: null, chest: null, left_arm: null, right_arm: null,
      left_thigh: null, right_thigh: null, left_calf: null, right_calf: null,
      recorded_by_name: "Dr. Reyes", created_at: "2026-01-03T15:10:00Z", updated_at: "2026-01-03T15:10:00Z",
    });
    patientTables.patient_provider_notes.push({
      patient_id: ownId, provider_id: "office-1", note_id: "n-1", body: "Discussed hydration.",
      author_name: "Dr. Reyes", author_kind: "provider", created_at: "2026-01-04T12:00:00Z",
    });
    patients[0].updated_at = "2026-01-06T08:00:00+00:00";
    patientTables.patient_target_overrides.push({
      patient_id: ownId, calories: 1400, protein: 100, carbs: null, fat: 50, water_oz: 80,
    });
    patientTables.patient_food_prefs.push({
      patient_id: ownId, favorites: ["eggs"], recents: ["custom-1", "chicken"],
    });
    patientTables.patient_custom_foods.push({
      patient_id: ownId,
      food_id: "custom-1",
      name: "Vanilla protein shake",
      brand: "Test dairy",
      serving: "1 bottle",
      calories: 230,
      protein: 42,
      carbs: 9,
      fat: 3.5,
      photo_path: null,
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
    // Staff weigh-ins merge into the trend with a source marker; the patient
    // series stays exactly what the check-ins hold.
    expect(body.weights).toEqual([
      { dateKey: "2026-01-03", weight: 196.5, source: "staff", id: "sw-1" },
      { dateKey: "2026-01-05", weight: 191, source: "patient" },
    ]);
    expect(body.staffWeights).toEqual([{
      id: "sw-1", dateKey: "2026-01-03", weight: 196.5, note: "Office scale", recordedByName: "Dr. Reyes",
      createdAt: "2026-01-03T15:00:00Z", version: "2026-01-03T15:00:00Z",
    }]);
    expect(body.providerNotes).toEqual([{
      id: "n-1", body: "Discussed hydration.", authorName: "Dr. Reyes", authorKind: "provider", createdAt: "2026-01-04T12:00:00Z",
    }]);
    // Measurement visits ride the record with only the areas that were measured.
    expect(body.bodyMeasurements).toEqual([{
      id: "bm-1", dateKey: "2026-01-03", note: "Baseline", measurements: { neck: 15, waist: 36.5 },
      recordedByName: "Dr. Reyes", createdAt: "2026-01-03T15:10:00Z", version: "2026-01-03T15:10:00Z",
    }]);
    expect(body.patient.version).toBe("2026-01-06T08:00:00+00:00");
    // Engagement rides the same rows with the roster's definitions, anchored
    // on the patient's own (America/New_York) day. The 2026-01-05 fixture is
    // long past, so every window is empty but the families are known.
    expect(body.engagement).toEqual({
      asOfDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      loggedLast7: [false, false, false, false, false, false, false],
      loggedDays7: 0, mealStreak: 0, avgCalories7: null, avgWater7: null,
      checkInStreak: 0, checkInRate30: 0, latestCheckInDate: "2026-01-05",
      moodCounts: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 }, topSideEffects: [],
    });
    expect(body.account.flags).toMatchObject({
      nudgeOptOut: true,
      onboardingComplete: true,
      onboardingAnswers: { medication: "semaglutide" },
    });
    expect(body.account.favorites).toEqual([
      { id: "eggs", name: "Eggs", detail: "" },
    ]);
    expect(body.account.recents).toEqual([
      {
        id: "custom-1",
        name: "Vanilla protein shake",
        brand: "Test dairy",
        serving: "1 bottle",
        calories: 230,
        protein: 42,
        carbs: 9,
        fat: 3.5,
        photoUrl: null,
      },
      { id: "chicken", name: "Chicken", detail: "" },
    ]);
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

  it("audits each staff record read once per actor and target window, photos separately", async () => {
    patientTables.patient_progress_photos.push(
      { patient_id: "pat-own", photo_id: "p-1", date_key: "2026-01-05", label: "Start", angle: "front", object_path: "/objects/patient-media/pat-own/progress-1" },
    );
    expect((await api("/office/patients/pat-own", "provider-token")).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readAudits.map((row) => [row.p_action, row.p_actor_user_id, row.p_actor_kind, row.p_provider_id, row.p_target_kind, row.p_target_id, row.p_dedupe_key])).toEqual([
      ["patient_record_viewed", "provider-user", "provider", "office-1", "patient", "pat-own", "patient_record_viewed:patient:pat-own"],
      ["patient_photos_viewed", "provider-user", "provider", "office-1", "patient", "pat-own", "patient_photos_viewed:patient:pat-own"],
    ]);
    expect(readAudits[1].p_metadata).toEqual({ photos: 1 });
    expect(readAudits[0].p_window_seconds).toBe(900);
    // Same actor again inside the window: the process already knows the window is open, no second write.
    expect((await api("/office/patients/pat-own", "provider-token")).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readAudits).toHaveLength(2);
    // A different staffer opening the same chart is its own event.
    expect((await api("/office/patients/pat-own", "member-token")).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readAudits.map((row) => [row.p_action, row.p_actor_user_id])).toEqual([
      ["patient_record_viewed", "provider-user"], ["patient_photos_viewed", "provider-user"],
      ["patient_record_viewed", "member-user"], ["patient_photos_viewed", "member-user"],
    ]);
    // HQ drill-in reads are recorded as HQ against the office they entered.
    expect((await api("/office/patients/pat-other?office=office-2", "hq-token")).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readAudits.at(-1)).toMatchObject({ p_action: "patient_record_viewed", p_actor_kind: "hq", p_provider_id: "office-2", p_target_id: "pat-other" });
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

describe("staff photo page signing", () => {
  const ownId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const own = (slug: string) => `/objects/patient-media/${ownId}/progress-${slug}`;
  const post = (path: string, token: string, body: unknown) =>
    api(path, token, { method: "POST", body: JSON.stringify(body) });

  beforeEach(() => {
    patients[0].id = ownId;
    patientTables.patient_progress_photos.push(
      { patient_id: ownId, photo_id: "p-1", date_key: "2026-01-05", label: "Start", angle: "front", object_path: own("11111111") },
      { patient_id: ownId, photo_id: "p-2", date_key: "2026-01-12", label: "Week 1", angle: "front", object_path: own("22222222") },
      { patient_id: ownId, photo_id: "p-bad", date_key: "2026-01-12", label: "Bad", angle: "side", object_path: `/objects/patient-media/pat-other/progress-33333333` },
    );
    patientTables.patient_media.push(
      { patient_id: ownId, object_path: own("11111111"), kind: "progress", variants: ["thumb", "medium"] },
      { patient_id: ownId, object_path: own("22222222"), kind: "progress", variants: [] },
    );
  });

  it("signs a page of the patient's own photos at the asked size, falling back per photo to the original", async () => {
    const res = await post(`/office/patients/${ownId}/photos/urls`, "provider-token", { ids: ["p-1", "p-2", "p-bad", "p-missing"], variant: "thumb" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.urls).toEqual([
      { id: "p-1", url: `https://signed.test/read?key=${encodeURIComponent(`${own("11111111")}.thumb`)}`, size: "thumb" },
      { id: "p-2", url: `https://signed.test/read?key=${encodeURIComponent(own("22222222"))}`, size: "original" },
    ]);
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(JSON.stringify(body)).not.toContain("object_path");
  });

  it("serves medium for the viewer and the original when no size is asked", async () => {
    const medium = (await (await post(`/office/patients/${ownId}/photos/urls`, "member-token", { ids: ["p-1"], variant: "medium" })).json()) as any;
    expect(medium.urls[0]).toMatchObject({ id: "p-1", size: "medium" });
    expect(medium.urls[0].url).toContain(encodeURIComponent(".medium"));
    const original = (await (await post(`/office/patients/${ownId}/photos/urls`, "member-token", { ids: ["p-1"] })).json()) as any;
    expect(original.urls[0]).toEqual({ id: "p-1", url: `https://signed.test/read?key=${encodeURIComponent(own("11111111"))}`, size: "original" });
  });

  it("rejects bad pages and unknown sizes", async () => {
    expect((await post(`/office/patients/${ownId}/photos/urls`, "provider-token", { ids: [], variant: "thumb" })).status).toBe(400);
    expect((await post(`/office/patients/${ownId}/photos/urls`, "provider-token", { ids: [1, 2] })).status).toBe(400);
    expect((await post(`/office/patients/${ownId}/photos/urls`, "provider-token", { ids: Array.from({ length: 101 }, (_, i) => `p-${i}`) })).status).toBe(400);
    expect((await post(`/office/patients/${ownId}/photos/urls`, "provider-token", { ids: ["p-1"], variant: "huge" })).status).toBe(400);
  });

  it("audits the photo page signing as one progress-photo view per actor window", async () => {
    expect((await post(`/office/patients/${ownId}/photos/urls`, "member-token", { ids: ["p-1", "p-2"], variant: "thumb" })).status).toBe(200);
    expect((await post(`/office/patients/${ownId}/photos/urls`, "member-token", { ids: ["p-2"], variant: "medium" })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readAudits.map((row) => [row.p_action, row.p_actor_user_id, row.p_target_id, row.p_metadata])).toEqual([
      ["patient_photos_viewed", "member-user", ownId, { photos: 2 }],
    ]);
  });

  it("keeps office isolation and HQ scope rules identical to the record read", async () => {
    const crossOffice = await post("/office/patients/pat-other/photos/urls", "provider-token", { ids: ["p-1"], variant: "thumb" });
    expect(crossOffice.status).toBe(404);
    expect(await crossOffice.json()).toEqual({ error: RECORD_NOT_FOUND });
    expect((await post("/office/patients/pat-other/photos/urls", "hq-token", { ids: ["p-1"] })).status).toBe(400);
    expect((await post("/office/patients/pat-other/photos/urls?office=office-2", "hq-token", { ids: ["p-1"] })).status).toBe(200);
    hqMemberships = [{ department_role: "support", status: "active" }];
    expect((await post("/office/patients/pat-other/photos/urls?office=office-2", "hq-token", { ids: ["p-1"] })).status).toBe(403);
    expect((await post(`/office/patients/${ownId}/photos/urls`, "patient-token", { ids: ["p-1"] })).status).toBe(403);
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

  describe("on the published site", () => {
    const saved = { ...process.env };
    afterEach(() => {
      for (const key of ["NODE_ENV", "PATIENT_APP_URL", "PATIENT_INVITE_URL", "REPLIT_EXPO_DEV_DOMAIN"]) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });

    it("links the invitation to the configured Expo Go page", async () => {
      process.env.NODE_ENV = "production";
      process.env.PATIENT_INVITE_URL = "https://app.thinnr.test/thinnr-mobile/";
      const res = await api("/office/invitations", "provider-token", { method: "POST", body: JSON.stringify(INVITE) });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { invitation: string }).invitation).toBe("sent");
      expect(JSON.stringify(resendCalls[0].vars)).toContain("https://app.thinnr.test/thinnr-mobile/");
    });

    it("never emails the workspace preview: no live link holds the email as not configured", async () => {
      process.env.NODE_ENV = "production";
      delete process.env.PATIENT_APP_URL;
      delete process.env.PATIENT_INVITE_URL;
      process.env.REPLIT_EXPO_DEV_DOMAIN = "abc123.expo.worf.replit.dev";
      const res = await api("/office/invitations", "provider-token", { method: "POST", body: JSON.stringify(INVITE) });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { invitation: string }).invitation).toBe("not_configured");
      expect(resendCalls).toHaveLength(0);
      expect(patients.find((row) => row.email === "jordan.ellis@example.com")?.invite_email_status).toBe("failed");
    });
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
