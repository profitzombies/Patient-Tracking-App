/**
 * Live end-state verification against the clean database, using ONLY a
 * disposable @thinnr-staff-check.com identity that is removed afterwards.
 *
 * Phases:
 *   setup    — create a throwaway auth user (no email is ever sent: the
 *              admin API creates it pre-confirmed) plus an active `admin`
 *              hq_membership so the operations app and API accept it.
 *   verify   — password sign-in through GoTrue (proves the auth stack),
 *              then API checks: provider accounts list must be an empty
 *              array, the HQ team roster must contain Andrew, and the
 *              training/knowledge content routes must still serve rows.
 *   cleanup  — delete the membership and the auth user, then assert the
 *              database is back to exactly-Andrew.
 *
 * Usage: node scripts/legacy-reset/smoke-live-verify.mjs <setup|verify|cleanup>
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { sql, adminFetch, supabaseBase, OWNER_AUTH_ID, OWNER_EMAIL } from "./lib.mjs";

const CREDS_FILE = "/tmp/t366_smoke_creds.json";
const API = "http://127.0.0.1:80/api";
const phase = process.argv[2];

function anonKey() {
  const key = process.env.SUPABASE_ANON_KEY;
  if (!key) throw new Error("SUPABASE_ANON_KEY is not configured");
  return key;
}

if (phase === "setup") {
  const email = `qa-hq-smoke-${randomBytes(4).toString("hex")}@thinnr-staff-check.com`;
  const password = randomBytes(18).toString("base64url");
  const created = await adminFetch("POST", "/auth/v1/admin/users", {
    email,
    password,
    email_confirm: true,
    app_metadata: { thinnr_disposable_smoke: true },
  });
  if (created.status !== 200 && created.status !== 201) {
    throw new Error(`create user failed: ${created.status} ${JSON.stringify(created.json).slice(0, 300)}`);
  }
  const userId = created.json.id;
  await sql(
    `insert into public.hq_memberships
       (email, display_name, job_title, department_role, status, auth_user_id, activated_at)
     values ('${email}', 'QA Smoke Check', 'Disposable verification login', 'admin', 'active', '${userId}', now())`,
    { label: "insert disposable hq membership" },
  );
  writeFileSync(CREDS_FILE, JSON.stringify({ email, password, userId }));
  console.log(`setup complete: ${email} (${userId})`);
} else if (phase === "verify") {
  const { email, password } = JSON.parse(readFileSync(CREDS_FILE, "utf8"));

  // 1. Real password sign-in through GoTrue.
  const tokenRes = await fetch(`${supabaseBase()}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anonKey(), "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!tokenRes.ok) throw new Error(`password sign-in failed: ${tokenRes.status}`);
  const { access_token: token } = await tokenRes.json();
  console.log("PASS  password sign-in works");

  const authed = (path) =>
    fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });

  // 2. Provider accounts: an honest empty list, not an error.
  const accounts = await authed("/provider-accounts");
  const accountsBody = await accounts.json();
  const list = Array.isArray(accountsBody) ? accountsBody : accountsBody.accounts;
  if (accounts.status !== 200 || !Array.isArray(list) || list.length !== 0) {
    throw new Error(
      `provider-accounts expected empty 200, got ${accounts.status}: ${JSON.stringify(accountsBody).slice(0, 300)}`,
    );
  }
  console.log("PASS  /api/provider-accounts → 200 with empty list");

  // 3. HQ team roster: Andrew present.
  const team = await authed("/hq-team");
  const teamBody = await team.json();
  const members = Array.isArray(teamBody) ? teamBody : teamBody.members;
  if (team.status !== 200 || !Array.isArray(members)) {
    throw new Error(`hq-team failed: ${team.status} ${JSON.stringify(teamBody).slice(0, 300)}`);
  }
  const emails = members.map((m) => (m.email || "").toLowerCase());
  if (!emails.includes(OWNER_EMAIL)) {
    throw new Error(`hq-team roster missing Andrew: ${JSON.stringify(emails)}`);
  }
  console.log(`PASS  /api/hq-team → roster includes Andrew (${members.length} member(s) incl. disposable check login)`);

  // 4. Content endpoints still serve program content.
  const knowledge = await authed("/knowledge/documents");
  const knowledgeBody = await knowledge.json();
  const docs = Array.isArray(knowledgeBody) ? knowledgeBody : knowledgeBody.documents;
  if (knowledge.status !== 200 || !Array.isArray(docs) || docs.length !== 5) {
    throw new Error(`knowledge documents expected 5 docs, got ${knowledge.status} ${JSON.stringify(knowledgeBody).slice(0, 200)}`);
  }
  console.log("PASS  /api/knowledge/documents → 5 documents");

  console.log("VERIFY COMPLETE");
} else if (phase === "cleanup") {
  const { email, userId } = JSON.parse(readFileSync(CREDS_FILE, "utf8"));
  if (userId === OWNER_AUTH_ID || email.toLowerCase().includes("andrew")) {
    throw new Error("ABORT: refusing to clean up a protected identity");
  }
  await sql(`delete from public.hq_memberships where lower(email) = '${email.toLowerCase()}'`, {
    label: "delete disposable membership",
  });
  const del = await adminFetch("DELETE", `/auth/v1/admin/users/${userId}`);
  if (del.status !== 200) throw new Error(`delete disposable user failed: ${del.status}`);
  rmSync(CREDS_FILE, { force: true });

  const [state] = await sql(
    `select
       (select count(*) from auth.users) as auth_users,
       (select count(*) from auth.users where id = '${OWNER_AUTH_ID}') as owner_present,
       (select count(*) from public.profiles) as profiles,
       (select count(*) from public.staff_role_assignments) as staff_role_assignments,
       (select count(*) from public.hq_memberships) as hq_memberships,
       (select count(*) from public.providers) as providers,
       (select count(*) from public.patients) as patients`,
  );
  console.log("post-cleanup state:", JSON.stringify(state));
  const clean =
    state.auth_users === 1 &&
    state.owner_present === 1 &&
    state.profiles === 1 &&
    state.staff_role_assignments === 1 &&
    state.hq_memberships === 1 &&
    state.providers === 0 &&
    state.patients === 0;
  if (!clean) {
    console.error("CLEANUP STATE MISMATCH — investigate immediately");
    process.exit(1);
  }
  console.log("CLEANUP COMPLETE — database back to exactly-Andrew");
} else {
  console.error("usage: node smoke-live-verify.mjs <setup|verify|cleanup>");
  process.exit(1);
}
