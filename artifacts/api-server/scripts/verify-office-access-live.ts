/**
 * Live proof that the office access gate holds.
 *
 * The unit and RTR suites prove the pieces; this harness drives the real
 * api-server (STAFF_API_BASE, default the preview proxy at
 * http://localhost:80) against the shared dev Supabase project with a
 * throwaway office and owner login, and asserts the gate itself:
 *
 *   1. A brand-new office is refused on an ordinary office route (roster),
 *      while the setup rail (/office/launch, /billing/office/access) stays
 *      reachable — the direct-URL attempt fails on the server, whatever the
 *      client does.
 *   2. An office that ALREADY connected Stripe (connected account ready and
 *      its mode completion recorded — the pre-existing offices this task
 *      migrates) is still refused: connect reads done, the bank account, the
 *      two cards, the plan and the disclosure are what is missing.
 *   3. With a bank account, two distinct cards, a chosen plan and an
 *      acknowledged disclosure on file, the same owner reads the roster.
 *   4. A bank account awaiting microdeposits keeps the office in while the
 *      48-hour window runs, and the block returns the moment it expires.
 *
 * Fixtures are removed in `finally`.
 */

import { randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const MANAGEMENT_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const API_BASE = process.env.STAFF_API_BASE ?? "http://localhost:80";
if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY || !MANAGEMENT_TOKEN) {
  throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY and SUPABASE_ACCESS_TOKEN are required.");
}
const PROJECT_REF = new URL(SUPABASE_URL).hostname.split(".")[0];

const enc = encodeURIComponent;
const brief = (value: unknown) => JSON.stringify(value ?? null).slice(0, 300);
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function svc(method: string, path: string, body?: unknown, prefer = "return=representation") {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: { apikey: SERVICE_KEY!, authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json", Prefer: prefer },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* empty or non-JSON */ }
  return { status: response.status, json, text };
}

/**
 * Direct SQL, for the two things PostgREST cannot do here: attaching a
 * connected-account fixture (the connect guard owns that table through its own
 * RPC) and clearing append-only operational ledgers on the way out.
 */
async function sql(query: string) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await response.text();
  if (response.status >= 300) throw new Error(`management query failed (${response.status}): ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return null; }
}
const lit = (value: string) => `'${value.replace(/'/g, "''")}'`;

async function api(token: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${API_BASE}/api${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...((init.headers as Record<string, string>) ?? {}) },
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: response.status, json, text };
}

const stamp = Date.now();
const password = `Qa-${stamp}!access`;
const ownerEmail = `qa-access-owner-${stamp}@thinnr-qa.example.com`;
const officeId = `qa-access-${stamp}`;
let ownerUserId: string | null = null;
let officeCreated = false;

async function createFixtures(): Promise<string> {
  const created = await svc("POST", "/auth/v1/admin/users", { email: ownerEmail, password, email_confirm: true, app_metadata: { thinnr_provisioned: "true" } });
  ownerUserId = created.json?.id ?? null;
  if (!ownerUserId) throw new Error(`could not create the owner login: ${brief(created.json)}`);
  const office = await svc("POST", "/rest/v1/providers", {
    provider_id: officeId, office_name: "QA Access Office", provider_name: "QA Access Provider",
    email: ownerEmail, auth_user_id: ownerUserId, access_disabled: false, created_at: new Date().toISOString(),
  });
  if (office.status !== 201) throw new Error(`office insert failed (${office.status}): ${brief(office.json)}`);
  officeCreated = true;
  const grant = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON_KEY!, "content-type": "application/json" },
    body: JSON.stringify({ email: ownerEmail, password }),
  });
  const session = await grant.json().catch(() => null);
  if (!session?.access_token) throw new Error(`owner sign-in failed: ${brief(session)}`);
  return session.access_token as string;
}

async function cleanup() {
  if (officeCreated) {
    // Every provider-keyed table, including the append-only ledgers PostgREST
    // refuses to delete from, then the office row itself.
    await sql(`set session_replication_role = replica;
do $cleanup$
declare t text; v_provider text := ${lit(officeId)};
begin
  for t in select c.table_name from information_schema.columns c
    join information_schema.tables tb on tb.table_schema=c.table_schema and tb.table_name=c.table_name and tb.table_type='BASE TABLE'
    where c.table_schema='public' and c.column_name='provider_id' and c.data_type='text' and c.table_name <> 'providers' loop
    execute format('delete from public.%I where provider_id = $1', t) using v_provider;
  end loop;
  delete from public.billing_connect_guards where provider_id = v_provider;
  delete from public.practice_launch where provider_id = v_provider;
  delete from public.staff_role_assignments where email = ${lit(ownerEmail)};
  delete from public.providers where provider_id = v_provider;
end $cleanup$;`).catch((error) => console.error(`  !!  office cleanup failed: ${error}`));
    const left = await svc("GET", `/rest/v1/providers?provider_id=eq.${enc(officeId)}&select=provider_id`);
    if (Array.isArray(left.json) && left.json.length > 0) console.error("  !!  the office row is still present");
  }
  if (ownerUserId) {
    const result = await svc("DELETE", `/auth/v1/admin/users/${ownerUserId}`);
    if (result.status >= 300) console.error(`  !!  owner login cleanup failed (${result.status})`);
  }
  console.log("  ok  fixtures removed");
}

async function main() {
  const owner = await createFixtures();

  console.log("\n1. a brand-new office is refused everywhere but the setup rail");
  const launch = await api(owner, "/office/launch");
  check("the setup rail answers the owner", launch.status === 200, `${launch.status} ${brief(launch.json).slice(0, 120)}`);
  const identity = String(launch.json?.billingScope ?? "");
  const [mode, platformAccountId] = identity.split(":");
  check("the response names the current payment mode", Boolean(mode && platformAccountId), identity);
  check("setup is required and not complete", launch.json?.required === true && launch.json?.completedAt === null);
  const roster = await api(owner, `/office/roster?office=${enc(officeId)}`);
  check("an ordinary office route is refused by the server", roster.status === 403, `${roster.status}`);
  const snapshot = await api(owner, "/billing/office/access");
  check("the access setup rail itself stays reachable", snapshot.status === 200, `${snapshot.status}`);
  check("the snapshot reports incomplete setup", snapshot.json?.complete === false, brief(snapshot.json?.steps).slice(0, 160));

  console.log("\n2. an office that already connected Stripe still owes the new steps");
  // The connect guard owns that table: a fixture connection attaches the same
  // way a real one does, through a claimed operation.
  const guardArgs = { p_provider_id: officeId, p_mode: mode, p_platform: platformAccountId, p_deployment: process.env.BILLING_DEPLOYMENT_ID };
  const token = randomUUID();
  const claim = await svc("POST", "/rest/v1/rpc/guard_office_connect", { ...guardArgs, p_action: "claim", p_token: token });
  check("the connect operation was claimed", claim.status < 300, `${claim.status} ${brief(claim.json)}`);
  const attach = await svc("POST", "/rest/v1/rpc/guard_office_connect", {
    ...guardArgs, p_action: "attach", p_token: token, p_generation: claim.json?.generation ?? 0,
    p_account: {
      stripe_account_id: `acct_qa_${stamp}`, origin: "oauth", dashboard_type: "express",
      charges_enabled: true, payouts_enabled: true, details_submitted: true,
      requirements: {}, capabilities: {}, livemode: mode === "live",
      tax_enabled: false, stripe_customer_emails: "off",
    },
  });
  check("the fixture connection attached", attach.status < 300, `${attach.status} ${brief(attach.json)}`);
  const connected = await svc("GET", `/rest/v1/billing_connected_accounts?provider_id=eq.${enc(officeId)}&select=charges_enabled`);
  check("the connected account fixture landed", connected.json?.[0]?.charges_enabled === true, `${connected.status} ${brief(connected.json)}`);
  const completion = await svc("POST", "/rest/v1/practice_launch_completions", {
    provider_id: officeId, stripe_mode: mode, platform_account_id: platformAccountId, completed_at: new Date().toISOString(),
  });
  check("the pre-existing launch completion landed", completion.status === 201, `${completion.status} ${brief(completion.json)}`);
  const migrated = await api(owner, "/office/launch");
  check("connect counts as done but setup does not", migrated.json?.payments?.state === "ready" && migrated.json?.completedAt === null,
    `${migrated.json?.payments?.state} / ${migrated.json?.completedAt}`);
  check("the remaining steps are the bank account and both cards",
    Array.isArray(migrated.json?.accessSetup?.missing) && migrated.json.accessSetup.missing.length === 3, brief(migrated.json?.accessSetup?.missing));
  const rosterMigrated = await api(owner, `/office/roster?office=${enc(officeId)}`);
  check("the already-connected office is still refused", rosterMigrated.status === 403, `${rosterMigrated.status}`);

  console.log("\n3. instruments, plan and disclosure open the workspace");
  const identityColumns = { stripe_mode: mode, stripe_platform_account_id: platformAccountId };
  const acknowledged = new Date().toISOString();
  // The office's row already exists: reading the snapshot above created it.
  const subscription = await svc("PATCH", `/rest/v1/billing_office_access_subscriptions?provider_id=eq.${enc(officeId)}`, {
    state: "included_period", plan: "yearly",
    plan_selected_at: acknowledged, disclosure_acknowledged_at: acknowledged, disclosure_acknowledged_by: ownerUserId,
    disclosure_version: 1, setup_completed_at: acknowledged,
  });
  const subscriptionId = subscription.json?.[0]?.id;
  check("the office's access subscription carries a plan and the disclosure", typeof subscriptionId === "string", `${subscription.status} ${brief(subscription.json)}`);
  const rows = [
    { subscription_id: subscriptionId, provider_id: officeId, slot: "bank", kind: "bank", stripe_payment_method_id: `pm_qa_bank_${stamp}`, bank_name: "QA Bank", last4: "6789", verification_status: "verified", ...identityColumns },
    { subscription_id: subscriptionId, provider_id: officeId, slot: "card_primary", kind: "card", stripe_payment_method_id: `pm_qa_card1_${stamp}`, fingerprint: `fp_qa_1_${stamp}`, brand: "visa", last4: "4242", exp_month: 4, exp_year: 2030, verification_status: "verified", ...identityColumns },
    { subscription_id: subscriptionId, provider_id: officeId, slot: "card_backup", kind: "card", stripe_payment_method_id: `pm_qa_card2_${stamp}`, fingerprint: `fp_qa_2_${stamp}`, brand: "mastercard", last4: "4444", exp_month: 5, exp_year: 2031, verification_status: "verified", ...identityColumns },
  ];
  let landed = 0;
  for (const row of rows) {
    const inserted = await svc("POST", "/rest/v1/billing_office_access_instruments", row);
    if (inserted.status === 201) landed += 1; else console.error(`  !!  ${row.slot} insert failed (${inserted.status}): ${brief(inserted.json)}`);
  }
  check("all three instruments landed", landed === 3, `${landed}/3`);
  const open = await api(owner, `/office/roster?office=${enc(officeId)}`);
  check("the owner now reads an ordinary office route", open.status === 200, `${open.status}`);
  const complete = await api(owner, "/office/launch");
  check("setup reads complete", typeof complete.json?.completedAt === "string" && complete.json?.accessSetup?.complete === true, brief(complete.json?.accessSetup));

  console.log("\n4. the pending-bank window admits the office, then expires");
  const bankFilter = `/rest/v1/billing_office_access_instruments?provider_id=eq.${enc(officeId)}&slot=eq.bank`;
  const future = new Date(Date.now() + 36 * 3600 * 1000).toISOString();
  await svc("PATCH", bankFilter, { verification_status: "pending", verification_deadline: future });
  const pending = await api(owner, `/office/roster?office=${enc(officeId)}`);
  const pendingLaunch = await api(owner, "/office/launch");
  check("an unverified bank account keeps the office in during the window", pending.status === 200, `${pending.status}`);
  check("the deadline is shown while the window runs",
    pendingLaunch.json?.accessSetup?.bankVerificationPending === true && pendingLaunch.json?.accessSetup?.bankVerificationOverdue === false,
    brief(pendingLaunch.json?.accessSetup));
  const past = new Date(Date.now() - 60 * 1000).toISOString();
  await svc("PATCH", bankFilter, { verification_deadline: past });
  const expired = await api(owner, `/office/roster?office=${enc(officeId)}`);
  const expiredLaunch = await api(owner, "/office/launch");
  check("the block returns once the 48-hour window passes unverified", expired.status === 403, `${expired.status}`);
  check("the setup rail says the window expired",
    expiredLaunch.json?.accessSetup?.bankVerificationOverdue === true && expiredLaunch.json?.completedAt === null,
    brief(expiredLaunch.json?.accessSetup));
  const stillReachable = await api(owner, "/billing/office/access");
  check("the office can still reach the rail that fixes it", stillReachable.status === 200, `${stillReachable.status}`);
}

main()
  .catch((error) => { failures += 1; console.error(`\n  !!  ${error instanceof Error ? error.message : String(error)}`); })
  .finally(async () => {
    console.log("\ncleanup");
    await cleanup().catch((error) => console.error(`  !!  cleanup threw: ${error}`));
    if (failures > 0) {
      console.error(`\nOffice access live gate: ${failures} check(s) failed.`);
      process.exit(1);
    }
    console.log("\nOffice access live gate: refusal, migration, admission and the pending-bank window all held.");
  });
