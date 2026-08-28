/**
 * LIVE acceptance suite for account claiming — runs the real claim routes
 * in-process against the REAL Supabase project, using synthetic rows that are
 * unmistakably test data (@claimtest.invalid emails, +1999555… phones).
 *
 * Gated behind RUN_CLAIM_LIVE=1 so the normal api-tests workflow skips it.
 * Delivery stays in dev mode: no SMS or email ever leaves this suite.
 *
 * Covers the acceptance tests from the build spec that need the real stack:
 *   2/3  claim by shared phone with birthday disambiguation
 *   4    email-only patient claims, then adds a verified phone
 *   5    provider + team member claim
 *   6    running the flow again = password reset, no duplicate login
 *   7    neutral answers for unknown/disabled identifiers
 *   8    claiming creates ZERO demo rows (trigger stand-down)
 *   plus the RLS matrix: own-data reads, staff scoping, financial exclusion.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import { supabaseAdmin, supabaseBase } from "../lib/supabase-admin";

const LIVE = process.env.RUN_CLAIM_LIVE === "1";
const d = LIVE ? describe : describe.skip;

const SHARED_PHONE = "+19995550801";
const DISABLED_PHONE = "+19995550802";
const ADDED_PHONE = "+19995550803";
const BURST_PHONE = "+19995550804";
const SOLO_EMAIL = "claimtest.solo@claimtest.invalid";
const PROVIDER_EMAIL = "claimtest.provider@claimtest.invalid";
const STAFF_EMAIL = "claimtest.staff@claimtest.invalid";
const ALPHA_DOB = "1980-01-15";
const BETA_DOB = "1992-06-20";

const MARKER_EMAILS = [SOLO_EMAIL, PROVIDER_EMAIL, STAFF_EMAIL];
const MARKER_PHONES = [SHARED_PHONE, DISABLED_PHONE, ADDED_PHONE, BURST_PHONE];

let server: http.Server;
let base = "";
let providerId = "99801";
const ids = {
  alpha: crypto.randomUUID(),
  beta: crypto.randomUUID(),
  solo: crypto.randomUUID(),
  disabled: crypto.randomUUID(),
  team: crypto.randomUUID(),
};

function anonKey(): string {
  const key = process.env.SUPABASE_ANON_KEY;
  if (!key) throw new Error("SUPABASE_ANON_KEY missing");
  return key;
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

/** Password-grant sign-in exactly the way the apps do it. */
async function signIn(
  cred: { email?: string; phone?: string },
  password: string,
): Promise<{ status: number; token: string | null }> {
  const response = await fetch(`${supabaseBase()}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anonKey(), "Content-Type": "application/json" },
    body: JSON.stringify({ ...cred, password }),
  });
  const json = (await response.json().catch(() => null)) as { access_token?: string } | null;
  return { status: response.status, token: json?.access_token ?? null };
}

/** REST read as a signed-in user — this is what RLS actually gates. */
async function userRead(token: string | null, pathq: string): Promise<{ status: number; json: any }> {
  const response = await fetch(`${supabaseBase()}/rest/v1/${pathq}`, {
    headers: {
      apikey: anonKey(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: response.status, json };
}

async function runFlow(identifier: string): Promise<{ requestId: string; devCode: string }> {
  const identify = await api("POST", "/api/claim/identify", { identifier });
  expect(identify.status).toBe(200);
  expect(identify.json.devCode).toMatch(/^\d{6}$/);
  return { requestId: identify.json.requestId, devCode: identify.json.devCode };
}

/** Marker-keyed cleanup — never touches anything that isn't obviously ours. */
async function cleanup(): Promise<void> {
  const authIds = new Set<string>();
  for (const email of MARKER_EMAILS) {
    for (const table of ["patients", "providers", "team_members"]) {
      const res = await supabaseAdmin(
        "GET",
        `/rest/v1/${table}?email=eq.${encodeURIComponent(email)}&select=auth_user_id`,
      );
      if (Array.isArray(res.json)) {
        for (const row of res.json) if (row.auth_user_id) authIds.add(String(row.auth_user_id));
      }
    }
  }
  for (const phone of MARKER_PHONES) {
    const res = await supabaseAdmin(
      "GET",
      `/rest/v1/patients?phone=eq.${encodeURIComponent(phone)}&select=auth_user_id`,
    );
    if (Array.isArray(res.json)) {
      for (const row of res.json) if (row.auth_user_id) authIds.add(String(row.auth_user_id));
    }
  }
  for (const authId of authIds) {
    await supabaseAdmin("DELETE", `/auth/v1/admin/users/${authId}`);
  }
  // Children strictly before providers: patients and team_members carry
  // provider_id foreign keys, and a blocked DELETE otherwise fails silently —
  // stale providers then pile up and trip the dup-email clinic guard.
  const failures: string[] = [];
  const del = async (pathq: string) => {
    const res = await supabaseAdmin("DELETE", `/rest/v1/${pathq}`);
    if (res.status >= 300) failures.push(`${pathq} -> ${res.status} ${JSON.stringify(res.json)}`);
  };
  for (const phone of MARKER_PHONES) {
    await del(`patients?phone=eq.${encodeURIComponent(phone)}`);
  }
  for (const email of MARKER_EMAILS) {
    await del(`patients?email=eq.${encodeURIComponent(email)}`);
    await del(`team_members?email=eq.${encodeURIComponent(email)}`);
  }
  // Any patient/team row still hanging off a marker provider (e.g. the
  // messy-format shared-phone sibling) blocks the provider delete via FK.
  for (const email of MARKER_EMAILS) {
    const owned = await supabaseAdmin(
      "GET",
      `/rest/v1/providers?email=eq.${encodeURIComponent(email)}&select=provider_id`,
    );
    if (!Array.isArray(owned.json)) continue;
    for (const row of owned.json) {
      const pid = String(row.provider_id);
      const kids = await supabaseAdmin(
        "GET",
        `/rest/v1/patients?provider_id=eq.${encodeURIComponent(pid)}&select=auth_user_id`,
      );
      if (Array.isArray(kids.json)) {
        for (const kid of kids.json) {
          if (kid.auth_user_id) {
            await supabaseAdmin("DELETE", `/auth/v1/admin/users/${kid.auth_user_id}`);
          }
        }
      }
      await del(`patients?provider_id=eq.${encodeURIComponent(pid)}`);
      await del(`team_members?provider_id=eq.${encodeURIComponent(pid)}`);
    }
  }
  for (const email of MARKER_EMAILS) {
    await del(`providers?email=eq.${encodeURIComponent(email)}`);
  }
  for (const value of [...MARKER_PHONES, ...MARKER_EMAILS]) {
    await del(`claim_verifications?identifier=eq.${encodeURIComponent(value)}`);
  }
  if (failures.length > 0) {
    throw new Error(`cleanup left synthetic rows behind:\n${failures.join("\n")}`);
  }
}

d("account claiming — live acceptance", () => {
  beforeAll(async () => {
    process.env.CLAIM_DELIVERY_MODE = "dev";
    process.env.CLAIM_IDENTIFY_FLOOR_MS = "200"; // asserted by the burst test
    process.env.CLAIM_IDENTIFY_BURST = "100000";
    process.env.CLAIM_IDENTIFY_DAILY_BUDGET = "100000";
    process.env.CLAIM_VERIFY_BURST = "100000";
    process.env.CLAIM_VERIFY_DAILY_BUDGET = "100000";
    process.env.CLAIM_COMPLETE_BURST = "100000";
    process.env.CLAIM_COMPLETE_DAILY_BUDGET = "100000";

    await cleanup();

    // A provider id that cannot collide with real data: only use one that is
    // either absent or already carries our marker email.
    for (let i = 0; i < 20; i += 1) {
      const candidate = String(99801 + i);
      const existing = await supabaseAdmin(
        "GET",
        `/rest/v1/providers?provider_id=eq.${candidate}&select=provider_id,email`,
      );
      if (!Array.isArray(existing.json) || existing.json.length === 0) {
        providerId = candidate;
        break;
      }
    }

    const provider = await supabaseAdmin(
      "POST",
      "/rest/v1/providers",
      {
        provider_id: providerId,
        provider_name: "Claimtest Provider",
        office_name: "Claimtest Office",
        email: PROVIDER_EMAIL,
        access_disabled: false,
      },
      "return=representation",
    );
    if (provider.status >= 300) {
      throw new Error(`provider seed failed (${provider.status}): ${JSON.stringify(provider.json)}`);
    }

    const team = await supabaseAdmin(
      "POST",
      "/rest/v1/team_members",
      {
        id: ids.team,
        provider_id: providerId,
        name: "Claimtest Staffer",
        email: STAFF_EMAIL,
        activation_status: "activated",
      },
      "return=representation",
    );
    if (team.status >= 300) {
      throw new Error(`team seed failed (${team.status}): ${JSON.stringify(team.json)}`);
    }

    const patients = await supabaseAdmin(
      "POST",
      "/rest/v1/patients",
      [
        {
          id: ids.alpha,
          created_at: new Date().toISOString(),
          name: "Claimtest Alpha",
          phone: SHARED_PHONE,
          email: null,
          date_of_birth: ALPHA_DOB,
          activation_status: "activated",
          provider_id: providerId,
        },
        {
          id: ids.beta,
          created_at: new Date().toISOString(),
          name: "Claimtest Beta",
          phone: "999-555-0801", // same last-10 digits, messier formatting
          email: null,
          date_of_birth: BETA_DOB,
          activation_status: "activated",
          provider_id: providerId,
        },
        {
          id: ids.solo,
          created_at: new Date().toISOString(),
          name: "Claimtest Solo",
          phone: null,
          email: SOLO_EMAIL,
          date_of_birth: null,
          activation_status: "activated",
          provider_id: providerId,
        },
        {
          id: ids.disabled,
          created_at: new Date().toISOString(),
          name: "Claimtest Disabled",
          phone: DISABLED_PHONE,
          email: null,
          date_of_birth: "1975-02-02",
          activation_status: "disabled",
          provider_id: providerId,
        },
      ],
      "return=representation",
    );
    if (patients.status >= 300) {
      throw new Error(`patient seed failed (${patients.status}): ${JSON.stringify(patients.json)}`);
    }

    const { default: claimRouter } = await import("../routes/claim");
    const app = express();
    app.use(express.json());
    app.use("/api", claimRouter);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 180_000);

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
    }
  }, 180_000);

  it(
    "answers unknown and disabled identifiers with the same neutral shape (test 7)",
    async () => {
      const unknown = await api("POST", "/api/claim/identify", { identifier: "+19995559999" });
      const disabled = await api("POST", "/api/claim/identify", { identifier: DISABLED_PHONE });
      expect(unknown.status).toBe(200);
      expect(disabled.status).toBe(200);
      expect(Object.keys(unknown.json).sort()).toEqual(Object.keys(disabled.json).sort());
      // Neither stored a ledger row — the decoy is indistinguishable outside.
      const ledger = await supabaseAdmin(
        "GET",
        `/rest/v1/claim_verifications?identifier=eq.${encodeURIComponent(DISABLED_PHONE)}&select=id`,
      );
      expect(Array.isArray(ledger.json) ? ledger.json.length : -1).toBe(0);
    },
    60_000,
  );

  it(
    "holds the hourly send cap under a parallel burst and answers at the timing floor",
    async () => {
      const seeded = await supabaseAdmin(
        "POST",
        "/rest/v1/patients",
        [
          {
            id: crypto.randomUUID(),
            created_at: new Date().toISOString(),
            name: "Claimtest Burst",
            phone: BURST_PHONE,
            email: null,
            date_of_birth: null,
            activation_status: "activated",
            provider_id: providerId,
          },
        ],
        "return=representation",
      );
      expect(seeded.status).toBeLessThan(300);

      const floor = Number(process.env.CLAIM_IDENTIFY_FLOOR_MS ?? "0");
      const burst = await Promise.all(
        Array.from({ length: 6 }, async () => {
          const startedAt = Date.now();
          const result = await api("POST", "/api/claim/identify", { identifier: BURST_PHONE });
          return { ...result, elapsed: Date.now() - startedAt };
        }),
      );
      for (const result of burst) {
        expect(result.status).toBe(200);
        expect(result.json.devCode).toMatch(/^\d{6}$/); // real or decoy — same shape
        expect(result.elapsed).toBeGreaterThanOrEqual(floor - 5);
      }
      // The DATABASE enforced the cap atomically: exactly 3 ledger rows even
      // though all six requests raced through the route concurrently.
      const ledger = await supabaseAdmin(
        "GET",
        `/rest/v1/claim_verifications?identifier=eq.${encodeURIComponent(BURST_PHONE)}&select=id`,
      );
      expect(Array.isArray(ledger.json) ? ledger.json.length : -1).toBe(3);

      // Misses are held to the same floor — timing can't out an account.
      const missStart = Date.now();
      const miss = await api("POST", "/api/claim/identify", { identifier: "+19995559998" });
      expect(miss.status).toBe(200);
      expect(Date.now() - missStart).toBeGreaterThanOrEqual(floor - 5);
    },
    120_000,
  );

  it(
    "claims a shared-phone patient: one birthday try, then a clean restart (tests 2+3)",
    async () => {
      // First attempt: blow the single birthday try.
      const flow1 = await runFlow(SHARED_PHONE);
      const verify1 = await api("POST", "/api/claim/verify", {
        requestId: flow1.requestId,
        code: flow1.devCode,
      });
      expect(verify1.status).toBe(200);
      expect(verify1.json.next).toBe("birthday");
      const wrong = await api("POST", "/api/claim/birthday", {
        claimToken: verify1.json.claimToken,
        birthday: "2001-01-01",
      });
      expect(wrong.status).toBe(409);
      expect(wrong.json.error).toContain("contact your clinic");
      const retry = await api("POST", "/api/claim/birthday", {
        claimToken: verify1.json.claimToken,
        birthday: ALPHA_DOB,
      });
      expect(retry.status).toBe(400); // one shot spent — session dead

      // Fresh start: correct birthday claims Alpha, not Beta.
      const flow2 = await runFlow(SHARED_PHONE);
      const verify2 = await api("POST", "/api/claim/verify", {
        requestId: flow2.requestId,
        code: flow2.devCode,
      });
      const birthday = await api("POST", "/api/claim/birthday", {
        claimToken: verify2.json.claimToken,
        birthday: ALPHA_DOB,
      });
      expect(birthday.status).toBe(200);
      expect(birthday.json.mode).toBe("create");
      const complete = await api("POST", "/api/claim/complete", {
        claimToken: verify2.json.claimToken,
        password: "Alpha!Claim-1",
        passwordConfirm: "Alpha!Claim-1",
      });
      expect(complete.status).toBe(200);
      expect(complete.json.signIn).toEqual({ method: "phone", identifier: SHARED_PHONE });

      const rows = await supabaseAdmin(
        "GET",
        `/rest/v1/patients?id=in.(${ids.alpha},${ids.beta})&select=id,auth_user_id,claimed_at&order=id`,
      );
      const alphaRow = rows.json.find((r: any) => r.id === ids.alpha);
      const betaRow = rows.json.find((r: any) => r.id === ids.beta);
      expect(alphaRow.auth_user_id).toBeTruthy();
      expect(alphaRow.claimed_at).toBeTruthy();
      expect(betaRow.auth_user_id).toBeNull();

      // The login carries the claim marker and ONLY the verified phone.
      const user = await supabaseAdmin("GET", `/auth/v1/admin/users/${alphaRow.auth_user_id}`);
      expect(user.json.app_metadata.thinnr_claim).toBe("patient");
      expect(user.json.app_metadata.thinnr_claim_ref).toBe(ids.alpha);
      expect(user.json.phone).toBe(SHARED_PHONE.replace("+", ""));
      expect(user.json.email ?? "").toBe("");
    },
    120_000,
  );

  it(
    "creates ZERO demo rows for a claimed patient (test 8)",
    async () => {
      const alpha = await supabaseAdmin(
        "GET",
        `/rest/v1/patients?id=eq.${ids.alpha}&select=auth_user_id`,
      );
      const authId = alpha.json[0]?.auth_user_id;
      expect(authId).toBeTruthy();
      const profiles = await supabaseAdmin(
        "GET",
        `/rest/v1/profiles?id=eq.${authId}&select=id,role`,
      );
      expect(Array.isArray(profiles.json) ? profiles.json.length : -1).toBe(0);
    },
    60_000,
  );

  it(
    "RLS: a claimed patient sees exactly their own record and no money tables (test 1)",
    async () => {
      const session = await signIn({ phone: SHARED_PHONE }, "Alpha!Claim-1");
      expect(session.status).toBe(200);
      expect(session.token).toBeTruthy();

      const own = await userRead(session.token, "patients?select=id,provider_id");
      expect(own.status).toBe(200);
      expect(own.json).toHaveLength(1);
      expect(own.json[0].id).toBe(ids.alpha);

      const money = await userRead(session.token, "transactions?select=id&limit=1");
      expect(money.status).toBe(200);
      expect(money.json).toHaveLength(0); // financial tables exclude patients

      const metrics = await userRead(session.token, "user_metrics?select=person_id&limit=1");
      expect(metrics.status).toBe(200);
      expect(metrics.json).toHaveLength(0); // admin-only

      const foods = await userRead(session.token, "approved_foods?select=food_id&limit=1");
      expect(foods.status).toBe(200);
      expect(foods.json).toHaveLength(1); // shared reference data stays readable

      const anon = await userRead(null, "patients?select=id&limit=1");
      expect(anon.status).toBeGreaterThanOrEqual(400); // anon reads nothing
    },
    60_000,
  );

  it(
    "running the flow again resets the password without duplicating the login (test 6)",
    async () => {
      const flow = await runFlow(SHARED_PHONE);
      const verify = await api("POST", "/api/claim/verify", {
        requestId: flow.requestId,
        code: flow.devCode,
      });
      const birthday = await api("POST", "/api/claim/birthday", {
        claimToken: verify.json.claimToken,
        birthday: ALPHA_DOB,
      });
      expect(birthday.json.mode).toBe("reset");
      const complete = await api("POST", "/api/claim/complete", {
        claimToken: verify.json.claimToken,
        password: "Alpha!Claim-2",
        passwordConfirm: "Alpha!Claim-2",
      });
      expect(complete.status).toBe(200);
      expect(complete.json.mode).toBe("reset");

      const fresh = await signIn({ phone: SHARED_PHONE }, "Alpha!Claim-2");
      expect(fresh.status).toBe(200);
      const stale = await signIn({ phone: SHARED_PHONE }, "Alpha!Claim-1");
      expect(stale.status).toBeGreaterThanOrEqual(400);
    },
    60_000,
  );

  it(
    "email-only patient claims by email, then adds a verified phone (test 4)",
    async () => {
      const flow = await runFlow(SOLO_EMAIL);
      const verify = await api("POST", "/api/claim/verify", {
        requestId: flow.requestId,
        code: flow.devCode,
      });
      expect(verify.status).toBe(200);
      expect(verify.json.next).toBe("password");
      expect(verify.json.mode).toBe("create");
      const complete = await api("POST", "/api/claim/complete", {
        claimToken: verify.json.claimToken,
        password: "Solo!Claim-1",
        passwordConfirm: "Solo!Claim-1",
      });
      expect(complete.status).toBe(200);
      expect(complete.json.signIn).toEqual({ method: "email", identifier: SOLO_EMAIL });

      const session = await signIn({ email: SOLO_EMAIL }, "Solo!Claim-1");
      expect(session.token).toBeTruthy();
      const who = await api("GET", "/api/claim/whoami", undefined, {
        Authorization: `Bearer ${session.token}`,
      });
      expect(who.json.kind).toBe("patient");
      expect(who.json.hasPhone).toBe(false);

      const start = await api(
        "POST",
        "/api/claim/add-phone",
        { phone: ADDED_PHONE },
        { Authorization: `Bearer ${session.token}` },
      );
      expect(start.status).toBe(200);
      expect(start.json.devCode).toMatch(/^\d{6}$/);
      const done = await api(
        "POST",
        "/api/claim/add-phone/verify",
        { requestId: start.json.requestId, code: start.json.devCode },
        { Authorization: `Bearer ${session.token}` },
      );
      expect(done.status).toBe(200);

      // The phone now signs in too.
      const byPhone = await signIn({ phone: ADDED_PHONE }, "Solo!Claim-1");
      expect(byPhone.status).toBe(200);
      const whoNow = await api("GET", "/api/claim/whoami", undefined, {
        Authorization: `Bearer ${byPhone.token}`,
      });
      expect(whoNow.json.hasPhone).toBe(true);
    },
    120_000,
  );

  it(
    "provider and team member claim and see only their office's patients (test 5)",
    async () => {
      const flow = await runFlow(PROVIDER_EMAIL);
      const verify = await api("POST", "/api/claim/verify", {
        requestId: flow.requestId,
        code: flow.devCode,
      });
      expect(verify.json.accountType).toBe("provider");
      const complete = await api("POST", "/api/claim/complete", {
        claimToken: verify.json.claimToken,
        password: "Provider!Claim-1",
        passwordConfirm: "Provider!Claim-1",
      });
      expect(complete.status).toBe(200);

      const session = await signIn({ email: PROVIDER_EMAIL }, "Provider!Claim-1");
      const who = await api("GET", "/api/claim/whoami", undefined, {
        Authorization: `Bearer ${session.token}`,
      });
      expect(who.json.kind).toBe("provider");
      expect(who.json.providerId).toBe(providerId);
      expect(who.json.officeName).toBe("Claimtest Office");

      // Staff scoping: every visible patient belongs to this provider.
      const patients = await userRead(session.token, "patients?select=id,provider_id");
      expect(patients.status).toBe(200);
      expect(patients.json.length).toBeGreaterThanOrEqual(3);
      for (const row of patients.json) expect(row.provider_id).toBe(providerId);
      const metrics = await userRead(session.token, "user_metrics?select=person_id&limit=1");
      expect(metrics.json).toHaveLength(0); // analytics stay admin-only

      // Team member rides the same rails.
      const staffFlow = await runFlow(STAFF_EMAIL);
      const staffVerify = await api("POST", "/api/claim/verify", {
        requestId: staffFlow.requestId,
        code: staffFlow.devCode,
      });
      expect(staffVerify.json.accountType).toBe("team_member");
      const staffComplete = await api("POST", "/api/claim/complete", {
        claimToken: staffVerify.json.claimToken,
        password: "Staffer!Claim-1",
        passwordConfirm: "Staffer!Claim-1",
      });
      expect(staffComplete.status).toBe(200);
      const staffSession = await signIn({ email: STAFF_EMAIL }, "Staffer!Claim-1");
      const staffWho = await api("GET", "/api/claim/whoami", undefined, {
        Authorization: `Bearer ${staffSession.token}`,
      });
      expect(staffWho.json.kind).toBe("team_member");
      expect(staffWho.json.providerId).toBe(providerId);
      expect(staffWho.json.officeName).toBe("Claimtest Office");
    },
    120_000,
  );
});
