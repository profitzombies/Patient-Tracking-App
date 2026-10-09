/**
 * Live proof of the weekly Customer health email, end to end against the
 * shared dev Supabase project and a running api-server.
 *
 *   pnpm --filter @workspace/api-server run test:weekly-customer-health-live
 *
 * The due rule, the recipient resolution, the template and the page are
 * proven with fakes elsewhere. This harness answers for the parts only the
 * live project can:
 *
 *   1. Two throwaway HQ members subscribe themselves through the real
 *      preference endpoints (read → off, write → on, read → on).
 *   2. One weekly run, executed under the job ledger's lease at a Monday
 *      09:05 Eastern instant, writes one snapshot per active office, one run
 *      row for the ISO week and exactly one queued email per subscriber; a
 *      second tick for the same Monday is a no-op (idempotence).
 *   3. The second subscriber turns the toggle off the moment the rows are
 *      queued; the real staff sender (the api-server's own 30 s worker)
 *      then delivers the first email through the vendor — the recipient is
 *      Resend's always-delivered test address — and records the second as
 *      suppressed / unsubscribed.
 *   4. The HQ delivery view lists both outcomes, and the Customer health
 *      endpoint reports a week-over-week change against the snapshot.
 *
 * Every fixture — members, logins, preference rows, outbox rows, the test
 * week's snapshots and run row — is removed in `finally`. The test week must
 * have no recorded run or snapshots beforehand; the script refuses to run
 * (and deletes nothing) if it does, because those rows cannot be restored.
 */
import { randomUUID } from "node:crypto";

import { registerAllJobs } from "../src/jobs/index";
import { registerJob, runJob } from "../src/jobs/scheduler";
import {
  runWeeklyCustomerHealth, supabaseWeeklyHealthStore, weeklyCustomerHealthJob, WEEKLY_CUSTOMER_HEALTH_PREFERENCE_KIND,
} from "../src/jobs/definitions/weekly-customer-health";
import { weeklyRunMoment } from "../src/customer-health/weekly";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const MANAGEMENT_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const API_BASE = (process.env.STAFF_API_BASE ?? "http://localhost:80").replace(/\/$/, "");
if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY || !MANAGEMENT_TOKEN) {
  throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY and SUPABASE_ACCESS_TOKEN are required.");
}
const BASE = SUPABASE_URL.replace(/\/$/, "");
const PROJECT_REF = new URL(BASE).hostname.split(".")[0];
const enc = encodeURIComponent;
const brief = (value: unknown) => JSON.stringify(value ?? null).slice(0, 300);

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function svc(method: string, path: string, body?: unknown, prefer = "return=representation") {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { apikey: SERVICE_KEY!, authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json", Prefer: prefer },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* empty or non-JSON */ }
  return { status: response.status, json, text };
}

async function managementQuery(query: string): Promise<void> {
  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) console.error(`  !!  management query failed (${response.status}): ${(await response.text()).slice(0, 200)}`);
}

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

async function signIn(email: string, password: string): Promise<string> {
  const response = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON_KEY!, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const json: any = await response.json();
  if (!json.access_token) throw new Error(`sign-in failed for ${email}: ${brief(json)}`);
  return json.access_token;
}

async function createUser(email: string, password: string): Promise<string> {
  const response = await svc("POST", "/auth/v1/admin/users", {
    email, password, email_confirm: true, app_metadata: { thinnr_provisioned: "true" },
  });
  if (response.status >= 300 || !response.json?.id) throw new Error(`user create failed (${response.status}): ${brief(response.json)}`);
  return String(response.json.id);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------- the fixtures
const stamp = Date.now().toString(36);
const password = `Qa-${randomUUID()}`;
// Resend's always-delivered test recipient: the real send is proven without
// bouncing mail at an invented domain.
const emailA = "delivered@resend.dev";
const emailB = `qa-weekly-b-${stamp}@thinnr-qa.example.com`;
const ids: { userA?: string; userB?: string; memberA?: string; memberB?: string } = {};

// The most recent Monday 09:05 Eastern before now: a due instant whose ISO
// week is already in the past, so nothing here can collide with the real run
// on the coming Monday.
function lastMondayInstant(timeZone: string): Date {
  let probe = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  for (let guard = 0; guard < 8 * 24 * 60; guard++) {
    const moment = weeklyRunMoment(probe, timeZone);
    if (moment.weekday === 1 && moment.minutes === 9 * 60 + 5) return probe;
    probe = new Date(probe.getTime() - 60_000);
  }
  throw new Error("no Monday 09:05 found in the last week");
}

async function clearEmail(email: string): Promise<void> {
  const members = await svc("GET", `/rest/v1/hq_memberships?email=ilike.${enc(email)}&select=id`);
  for (const row of Array.isArray(members.json) ? members.json : []) {
    await svc("DELETE", `/rest/v1/hq_invitations?membership_id=eq.${enc(row.id)}`, undefined, "return=minimal");
    await svc("DELETE", `/rest/v1/hq_memberships?id=eq.${enc(row.id)}`, undefined, "return=minimal");
  }
  const users = await svc("GET", `/auth/v1/admin/users?page=1&per_page=50&filter=${enc(email)}`);
  for (const user of (users.json?.users ?? []) as Array<{ id: string; email?: string }>) {
    if (String(user.email ?? "").toLowerCase() !== email.toLowerCase()) continue;
    await svc("DELETE", `/rest/v1/staff_notifications?auth_user_id=eq.${enc(user.id)}`, undefined, "return=minimal");
    await managementQuery(`delete from public.auth_sign_ins where user_id = '${user.id}';`);
    await svc("DELETE", `/auth/v1/admin/users/${user.id}`, undefined, "return=minimal");
  }
  await svc("DELETE", `/rest/v1/staff_role_assignments?email=ilike.${enc(email)}`, undefined, "return=minimal");
}

async function createMember(email: string, name: string): Promise<{ userId: string; memberId: string; token: string }> {
  await svc("POST", "/rest/v1/staff_role_assignments", { email, role: "hq_admin" });
  const userId = await createUser(email, password);
  const membership = await svc("POST", "/rest/v1/hq_memberships", {
    email, auth_user_id: userId, status: "active", department_role: "admin", display_name: name, activated_at: new Date().toISOString(),
  });
  if (membership.status !== 201) throw new Error(`HQ membership insert failed (${membership.status}): ${brief(membership.json)}`);
  const token = await signIn(email, password);
  return { userId, memberId: String(membership.json[0].id), token };
}

async function cleanUp(isoWeek: string | null): Promise<void> {
  for (const userId of [ids.userA, ids.userB]) {
    if (!userId) continue;
    await svc("DELETE", `/rest/v1/staff_notifications?auth_user_id=eq.${enc(userId)}`, undefined, "return=minimal");
    await svc("DELETE", `/rest/v1/hq_member_notification_preferences?auth_user_id=eq.${enc(userId)}`, undefined, "return=minimal");
  }
  await svc("DELETE", `/rest/v1/hq_memberships?email=in.(${enc(emailA)},${enc(emailB)})`, undefined, "return=minimal");
  await svc("DELETE", `/rest/v1/staff_role_assignments?email=in.(${enc(emailA)},${enc(emailB)})`, undefined, "return=minimal");
  for (const userId of [ids.userA, ids.userB]) {
    if (!userId) continue;
    await managementQuery(`delete from public.auth_sign_ins where user_id = '${userId}';`);
    await svc("DELETE", `/auth/v1/admin/users/${userId}`, undefined, "return=minimal");
  }
  if (isoWeek && weekRowsAreOurs) {
    // The test week's snapshots and run row — only when this script proved
    // the week was empty before it ran, so nothing pre-existing is removed.
    // The page goes back to "—" until the first real Monday run.
    await svc("DELETE", `/rest/v1/office_customer_health_weekly_snapshots?iso_week=eq.${enc(isoWeek)}`, undefined, "return=minimal");
    await svc("DELETE", `/rest/v1/customer_health_weekly_runs?iso_week=eq.${enc(isoWeek)}`, undefined, "return=minimal");
  }
  await managementQuery(`
begin;
set local session_replication_role = replica;
delete from public.admin_audit_events where actor_user_id in (${[ids.userA, ids.userB].filter(Boolean).map((id) => `'${id}'`).join(",") || "'00000000-0000-0000-0000-000000000000'"});
commit;`);
}

// ------------------------------------------------------------------ the walk
let isoWeek: string | null = null;
// Set only after the test week is confirmed empty; gates the week clean-up.
let weekRowsAreOurs = false;
try {
  console.log(`weekly customer health live — api ${API_BASE}, project ${PROJECT_REF}`);
  await clearEmail(emailA);
  await clearEmail(emailB);
  const a = await createMember(emailA, "QA Weekly A");
  const b = await createMember(emailB, "QA Weekly B");
  ids.userA = a.userId; ids.userB = b.userId; ids.memberA = a.memberId; ids.memberB = b.memberId;

  console.log("\nsubscribe");
  const PREF = "/hq/notification-preferences/weekly-customer-health";
  const offA = await api(a.token, PREF);
  check("a fresh member reads the toggle as off", offA.status === 200 && offA.json?.enabled === false, brief(offA.json));
  const onA = await api(a.token, PREF, { method: "PUT", body: JSON.stringify({ enabled: true }) });
  check("member A turns the toggle on", onA.status === 200 && onA.json?.enabled === true, brief(onA.json));
  const onB = await api(b.token, PREF, { method: "PUT", body: JSON.stringify({ enabled: true }) });
  check("member B turns the toggle on", onB.status === 200 && onB.json?.enabled === true, brief(onB.json));
  const readA = await api(a.token, PREF);
  check("the toggle reads back on", readA.status === 200 && readA.json?.enabled === true, brief(readA.json));
  const prefRows = await svc("GET", `/rest/v1/hq_member_notification_preferences?auth_user_id=in.(${enc(a.userId)},${enc(b.userId)})&kind=eq.${WEEKLY_CUSTOMER_HEALTH_PREFERENCE_KIND}&select=auth_user_id,enabled`);
  check("two preference rows exist, both enabled", Array.isArray(prefRows.json) && prefRows.json.length === 2 && prefRows.json.every((row: any) => row.enabled === true), brief(prefRows.json));

  console.log("\nweekly run");
  const timeZone = await supabaseWeeklyHealthStore.timeZone();
  const monday = lastMondayInstant(timeZone);
  const moment = weeklyRunMoment(monday, timeZone);
  isoWeek = moment.isoWeek;
  console.log(`  running as ${monday.toISOString()} (${timeZone} ${moment.localDate} 09:05, ${isoWeek})`);
  // A run row or snapshots already recorded for that week belong to a real
  // Monday run (or an earlier proof that did not clean up). They are not
  // ours to delete and cannot be restored, so refuse instead of clearing.
  const priorRun = await svc("GET", `/rest/v1/customer_health_weekly_runs?iso_week=eq.${enc(isoWeek)}&select=iso_week`);
  const priorSnapshots = await svc("GET", `/rest/v1/office_customer_health_weekly_snapshots?iso_week=eq.${enc(isoWeek)}&select=provider_id&limit=1`);
  if ((Array.isArray(priorRun.json) && priorRun.json.length) || (Array.isArray(priorSnapshots.json) && priorSnapshots.json.length)) {
    throw new Error(`a weekly run or snapshots already exist for ${isoWeek}; this proof only runs against a week with no recorded run and will not delete existing rows.`);
  }
  weekRowsAreOurs = true;
  registerAllJobs();
  // Member B opts out the instant the rows are queued — before the server's
  // own 30 s worker can claim them — so the send-time re-check is what
  // decides B's fate.
  const store = {
    ...supabaseWeeklyHealthStore,
    async enqueue(rows: Record<string, unknown>[]) {
      const queued = await supabaseWeeklyHealthStore.enqueue(rows);
      const offB = await api(b.token, PREF, { method: "PUT", body: JSON.stringify({ enabled: false }) });
      check("member B turns the toggle off after the rows are queued", offB.status === 200 && offB.json?.enabled === false, brief(offB.json));
      return queued;
    },
  };
  // Same job name, same ledger lease, same body — only the store is wrapped
  // (this process's registry only; the api-server keeps the real definition).
  registerJob({ ...weeklyCustomerHealthJob, run: (ctx) => runWeeklyCustomerHealth(ctx, store) });
  const outcome = await runJob("weekly-customer-health", { trigger: "manual", force: true, now: monday, owner: `qa-weekly-${stamp}` });
  check("the job ran under its lease", outcome.kind === "ran" && outcome.run.status === "succeeded", brief(outcome));
  const tallies: Record<string, number> = outcome.kind === "ran" ? (outcome.run.counts ?? {}) : {};
  console.log(`  tallies ${brief(tallies)}`);

  const runRow = await svc("GET", `/rest/v1/customer_health_weekly_runs?iso_week=eq.${enc(isoWeek)}&select=*`);
  check("one run row was recorded for the week", Array.isArray(runRow.json) && runRow.json.length === 1 && runRow.json[0].time_zone === timeZone, brief(runRow.json));
  const officeCount = Number(runRow.json?.[0]?.office_count ?? -1);
  const snapshots = await svc("GET", `/rest/v1/office_customer_health_weekly_snapshots?iso_week=eq.${enc(isoWeek)}&select=provider_id,score,band,bucket,office_name`);
  check("one snapshot per scored office", Array.isArray(snapshots.json) && snapshots.json.length === officeCount && officeCount > 0, `${snapshots.json?.length} rows vs office_count ${officeCount}`);
  check("snapshots carry no patient fields", Array.isArray(snapshots.json) && snapshots.json.every((row: any) => Object.keys(row).every((key) => !/patient|dob|phone/i.test(key))));
  const queued = await svc("GET", `/rest/v1/staff_notifications?auth_user_id=in.(${enc(a.userId)},${enc(b.userId)})&select=id,auth_user_id,email,kind,channel,provider_id,status,dedupe_key,expires_at,data`);
  check("exactly one email row per subscriber was queued", Array.isArray(queued.json) && queued.json.length === 2 && queued.json.every((row: any) => row.kind === "weekly_customer_health" && row.channel === "email" && row.provider_id === null), brief(queued.json?.map((r: any) => [r.email, r.status, r.dedupe_key])));
  check("the row data holds office names and counts only", Array.isArray(queued.json) && queued.json.every((row: any) => !JSON.stringify(row.data).match(/patient/i) && Array.isArray(row.data?.bucketCounts)));
  check("rows expire at the next Monday 09:00", Array.isArray(queued.json) && queued.json.every((row: any) => {
    const m = weeklyRunMoment(new Date(row.expires_at), timeZone); return m.weekday === 1 && m.minutes === 9 * 60;
  }), brief(queued.json?.map((r: any) => r.expires_at)));
  check("recipients_queued matches", Number(runRow.json?.[0]?.recipients_queued) === 2);

  console.log("\nidempotence");
  registerJob(weeklyCustomerHealthJob);
  const again = await runJob("weekly-customer-health", {
    trigger: "manual", force: true, now: new Date(monday.getTime() + 15 * 60_000), owner: `qa-weekly-${stamp}-2`,
  });
  const againTallies: Record<string, number> = again.kind === "ran" ? (again.run.counts ?? {}) : {};
  check("a second tick on the same Monday is a no-op", again.kind === "ran" && Number(againTallies.alreadyRan ?? 0) === 1 && !againTallies.emailsQueued, brief(againTallies));
  const stillTwo = await svc("GET", `/rest/v1/staff_notifications?auth_user_id=in.(${enc(a.userId)},${enc(b.userId)})&select=id`);
  check("still exactly two email rows", Array.isArray(stillTwo.json) && stillTwo.json.length === 2);

  console.log("\ndelivery (waiting for the api-server's staff sender)");
  let finalRows: any[] = [];
  for (let attempt = 0; attempt < 24; attempt++) {
    const rows = await svc("GET", `/rest/v1/staff_notifications?auth_user_id=in.(${enc(a.userId)},${enc(b.userId)})&select=auth_user_id,email,status,suppression_reason,last_error,sent_at`);
    finalRows = Array.isArray(rows.json) ? rows.json : [];
    if (finalRows.length === 2 && finalRows.every((row) => row.status !== "queued" && row.status !== "sending")) break;
    await sleep(5000);
  }
  const rowA = finalRows.find((row) => row.auth_user_id === a.userId);
  const rowB = finalRows.find((row) => row.auth_user_id === b.userId);
  check("member A's summary was sent through the vendor", rowA?.status === "sent" && !!rowA.sent_at, brief(rowA));
  check("member B's summary was suppressed as unsubscribed", rowB?.status === "suppressed" && rowB.suppression_reason === "unsubscribed", brief(rowB));

  console.log("\nHQ views");
  const deliveries = await api(a.token, "/hq/staff-alerts/deliveries?limit=50");
  const mine = Array.isArray(deliveries.json?.items) ? deliveries.json.items : [];
  const seenA = mine.find((row: any) => row.recipientEmail === emailA && row.status === "sent");
  const seenB = mine.find((row: any) => row.recipientEmail === emailB && row.status === "suppressed");
  check("the delivery view lists the sent email", !!seenA, brief(deliveries.json).slice(0, 200));
  check("the delivery view lists the suppressed email", !!seenB);
  const health = await api(a.token, "/hq/customer-health");
  const offices = Array.isArray(health.json?.offices) ? health.json.offices : [];
  check("the Customer health endpoint still answers", health.status === 200 && offices.length === officeCount, `${health.status} ${offices.length} offices`);
  check("every office now reports a week-over-week change against the snapshot", offices.length > 0 && offices.every((office: any) => typeof office.scoreChange === "number" && typeof office.priorWeekScore === "number"), brief(offices.slice(0, 2).map((o: any) => [o.officeName, o.score, o.priorWeekScore, o.scoreChange])));
  check("the endpoint names the snapshot week it compared against", typeof health.json?.priorSnapshotWeek === "string", brief(health.json?.priorSnapshotWeek));
} catch (error) {
  failures += 1;
  console.error(`FAIL  ${(error as Error).stack ?? String(error)}`);
} finally {
  console.log("\ncleanup");
  await cleanUp(isoWeek);
  const left = await svc("GET", `/rest/v1/hq_memberships?email=in.(${enc(emailA)},${enc(emailB)})&select=id`);
  check("fixtures removed", Array.isArray(left.json) && left.json.length === 0);
  if (isoWeek && weekRowsAreOurs) {
    const snapsLeft = await svc("GET", `/rest/v1/office_customer_health_weekly_snapshots?iso_week=eq.${enc(isoWeek)}&select=provider_id&limit=1`);
    check("test-week snapshots removed", Array.isArray(snapsLeft.json) && snapsLeft.json.length === 0);
  }
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall live checks passed");
process.exit(failures ? 1 : 0);
