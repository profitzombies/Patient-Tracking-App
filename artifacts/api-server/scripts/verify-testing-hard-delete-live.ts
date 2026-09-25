/**
 * Live proof for the HQ testing override (permanent delete of an office or a
 * patient). Drives the real api-server (STAFF_API_BASE, default the preview
 * proxy at http://localhost:80) against the shared dev Supabase project and
 * Stripe TEST mode with a throwaway office:
 *
 *   - owner + teammate logins, a teammate who is also an HQ member (must keep
 *     their HQ login), two patients with logins, a stored patient file,
 *     audit rows and a legal hold (append-only / hold protections);
 *   - a THINNR-created Stripe test connected account, a platform customer
 *     with a saved card on the office's THINNR plan.
 *
 * Then: office staff / patients are refused; a stale code is refused; the
 * patient delete erases one patient; the office delete erases the rest.
 * Afterwards every public table is scanned for the target ids, logins and
 * files are checked, Stripe objects are checked, and a deleted email signs up
 * again as a brand-new user.
 *
 *   pnpm --filter @workspace/api-server exec tsx scripts/verify-testing-hard-delete-live.ts
 */
import { randomBytes, randomUUID } from "node:crypto";
import { getBillingModeStatus } from "../src/billing/mode-state";
import { runWithBillingIdentity } from "../src/billing/stripe-environment";
import { getStripe } from "../src/billing/stripe-client";
import { createInAppAccount } from "../src/billing/accounts";
import { objectStorage } from "../src/lib/objectStorage";
import { hardDeleteProvider } from "../src/testing-delete/hard-delete";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const MANAGEMENT_TOKEN = process.env.SUPABASE_ACCESS_TOKEN!;
const API = `${process.env.STAFF_API_BASE ?? "http://localhost:80"}/api`;
if (process.env.NODE_ENV === "production") throw new Error("never run against production");
if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY || !MANAGEMENT_TOKEN) throw new Error("Supabase env is required");
const PROJECT_REF = new URL(SUPABASE_URL).hostname.split(".")[0];

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok" : "FAIL"}  ${label}${ok || !detail ? "" : ` — ${detail}`}`);
}
const brief = (value: unknown) => JSON.stringify(value ?? null).slice(0, 400);
const lit = (value: string) => `'${value.replace(/'/g, "''")}'`;

async function sql<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: "POST", headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ query }), signal: AbortSignal.timeout(60_000),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`SQL failed (${response.status}): ${brief(json)}`);
  return json as T[];
}
async function svc(method: string, path: string, body?: unknown) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method, headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json", Prefer: "return=representation" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}
async function api(method: string, path: string, token: string, body?: unknown) {
  const response = await fetch(`${API}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json().catch(() => null)) as any };
}

const run = randomUUID().slice(0, 8);
const providerId = `qa-hard-delete-${run}`;
const officeName = `QA Hard Delete ${run}`;
type Login = { email: string; password: string; id: string; token: string; sessionId: string };
const logins: Record<string, Login> = {};
const patients: Record<string, string> = {};
let officeCreated = false;

async function createLogin(role: string): Promise<Login> {
  const email = `qa-hd-${role}-${run}@example.com`;
  const password = randomBytes(24).toString("base64url");
  const created = await svc("POST", "/auth/v1/admin/users", { email, password, email_confirm: true });
  const id = created.json?.id ?? created.json?.user?.id;
  if (!id) throw new Error(`login create failed for ${role}: ${brief(created.json)}`);
  const grant = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON_KEY, "content-type": "application/json" }, body: JSON.stringify({ email, password }),
  });
  const session = (await grant.json()) as { access_token?: string };
  if (!session.access_token) throw new Error(`sign-in failed for ${role}`);
  const claims = JSON.parse(Buffer.from(session.access_token.split(".")[1]!, "base64url").toString());
  const login = { email, password, id, token: session.access_token, sessionId: String(claims.session_id) };
  logins[role] = login;
  return login;
}

async function stampFreshCode(login: Login, minutesAgo = 0) {
  const at = `now() - interval '${minutesAgo} minutes'`;
  await sql(`update public.auth_sign_ins set code_verified_at=${at}, revoked_at=null where session_id=${lit(login.sessionId)};
    insert into public.auth_sign_ins(user_id,realm,method,platform,device_fingerprint,session_id,code_verified_at)
      select ${lit(login.id)},'staff','email_code','web','qa-hard-delete',${lit(login.sessionId)},${at}
      where not exists (select 1 from public.auth_sign_ins where session_id=${lit(login.sessionId)})`);
}

async function setup() {
  for (const role of ["owner", "teammate", "hqTeammate", "hqAdmin", "patientA", "patientB"]) await createLogin(role);
  const { owner, teammate, hqTeammate, hqAdmin, patientA, patientB } = logins as Record<string, Login>;
  patients.A = randomUUID();
  patients.B = randomUUID();
  await sql(`begin;
    insert into public.providers(provider_id,provider_name,office_name,email,access_disabled,auth_user_id,claimed_at,phone,address_line_1,city,state,postal_code)
      values (${lit(providerId)},'QA Hard Delete Owner',${lit(officeName)},${lit(owner.email)},false,${lit(owner.id)},now(),'(202) 555-0199','1 Example Way','Boston','MA','02108');
    insert into public.team_members(id,provider_id,name,email,activation_status,office_role,auth_user_id,claimed_at) values
      (gen_random_uuid(),${lit(providerId)},'QA Teammate',${lit(teammate.email)},'activated','staff',${lit(teammate.id)},now()),
      (gen_random_uuid(),${lit(providerId)},'QA HQ Teammate',${lit(hqTeammate.email)},'activated','staff',${lit(hqTeammate.id)},now());
    insert into public.hq_memberships(auth_user_id,email,display_name,department_role,status,activated_at) values
      (${lit(hqAdmin.id)},${lit(hqAdmin.email)},'QA HQ Admin','admin','active',now()),
      (${lit(hqTeammate.id)},${lit(hqTeammate.email)},'QA HQ Teammate','support','active',now());
    select public.provision_staff_login(${lit(owner.id)}::uuid,${lit(owner.email)},'QA Hard Delete Owner',${lit(providerId)});
    select public.provision_staff_login(${lit(teammate.id)}::uuid,${lit(teammate.email)},'QA Teammate',${lit(providerId)});
    insert into public.patients(id,provider_id,name,first_name,last_name,email,activation_status,auth_user_id,claimed_at,created_at) values
      (${lit(patients.A)},${lit(providerId)},'Ava Deletetest','Ava','Deletetest',${lit(patientA.email)},'activated',${lit(patientA.id)},now(),now()),
      (${lit(patients.B)},${lit(providerId)},'Ben Deletetest','Ben','Deletetest',${lit(patientB.email)},'activated',${lit(patientB.id)},now(),now());
    insert into public.admin_audit_events(action,actor_user_id,actor_kind,provider_id,target_kind,target_id) values
      ('qa.hard_delete.fixture',${lit(owner.id)},'provider',${lit(providerId)},'patient',${lit(patients.B)}),
      ('qa.hard_delete.fixture',${lit(owner.id)},'provider',${lit(providerId)},'provider',${lit(providerId)});
    insert into public.legal_holds(target_kind,target_id,reason) values ('patient',${lit(patients.B)},'QA hard delete fixture'),
      ('provider',${lit(providerId)},'QA hard delete fixture');
    commit;`);
  officeCreated = true;

  // Stored files for both patients.
  await objectStorage.saveBuffer(`/objects/patient-media/${patients.A}/qa/a.txt`, Buffer.from("qa"), "text/plain");
  await objectStorage.saveBuffer(`/objects/patient-media/${patients.B}/qa/b.txt`, Buffer.from("qa"), "text/plain");

  // Stripe (TEST): a THINNR-created connected account + a saved card on the THINNR plan.
  const mode = await getBillingModeStatus();
  if (mode.mode !== "test") throw new Error("HQ billing mode must be Test for this proof");
  const identity = { mode: mode.mode, platformAccountId: mode.platformAccountId };
  const account = await runWithBillingIdentity(identity, () => createInAppAccount(providerId, owner.id));
  const stripe = await runWithBillingIdentity(identity, () => getStripe("test"));
  const customer = await stripe.customers.create({ email: owner.email, metadata: { thinnr_provider_id: providerId } });
  const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id });
  const [plan] = await sql<{ id: string }>(`insert into public.billing_office_access_subscriptions(provider_id,stripe_mode,stripe_platform_account_id,stripe_customer_id)
    values (${lit(providerId)},'test',${lit(identity.platformAccountId)},${lit(customer.id)}) returning id`);
  await sql(`insert into public.billing_office_access_instruments(subscription_id,provider_id,slot,kind,stripe_payment_method_id,stripe_mode,stripe_platform_account_id)
    values (${lit(plan!.id)},${lit(providerId)},'card_primary','card',${lit(pm.id)},'test',${lit(identity.platformAccountId)})`);
  return { stripe, accountId: account.stripe_account_id, customerId: customer.id, paymentMethodId: pm.id };
}

async function leftovers(ids: string[]): Promise<Array<{ t: string; c: string; n: number }>> {
  const array = `array[${ids.map(lit).join(",")}]::text[]`;
  return sql(`select t, c, n from (
    select c.table_name t, c.column_name c,
      (xpath('/row/n/text()', query_to_xml(format('select count(*) n from public.%I where %I::text = any(%s)', c.table_name, c.column_name, ${lit(array)}), false, true, '')))[1]::text::int n
    from information_schema.columns c join information_schema.tables tb on tb.table_schema=c.table_schema and tb.table_name=c.table_name and tb.table_type='BASE TABLE'
    where c.table_schema='public' and c.data_type in ('text','uuid','character varying')
      and (c.column_name like '%id' or c.column_name like '%_ref' or c.column_name in ('email','identifier','account_code','provider_account_code'))
  ) s where n > 0 and t <> 'auth_session_revocations'`);
}

/**
 * Sign-out list rows are the one deliberate exception: they hold only the
 * (now dead) user and session ids, expire on their own at the token horizon,
 * and keep any still-unexpired access token from verifying locally.
 */
async function revocationsAreOnlyExpiringSignOuts(userIds: string[]) {
  const rows = await sql<{ bad: number; total: number }>(`select count(*) filter (where expires_at > now() + interval '8 days' or reason <> 'purge')::int bad,
    count(*)::int total from public.auth_session_revocations where user_id::text = any(array[${userIds.map(lit).join(",")}]::text[])`);
  return rows[0]!;
}

async function authUserExists(id: string) {
  return (await svc("GET", `/auth/v1/admin/users/${id}`)).status === 200;
}

async function main() {
  console.log(`HQ testing hard delete — live proof (${providerId})`);
  const fx = await setup();
  const { owner, teammate, hqTeammate, hqAdmin, patientA, patientB } = logins as Record<string, Login>;
  check("fixture: THINNR-created Stripe test account attached", fx.accountId.startsWith("acct_"));

  // Preview
  const preview = await api("GET", `/hq/testing-delete/providers/${providerId}`, hqAdmin.token);
  check("HQ admin sees the provider preview", preview.status === 200 && preview.json?.patients === 2 &&
    preview.json?.staffLogins === 2 && preview.json?.hqMembersKept === 1 && preview.json?.stripeAccounts?.length === 1 &&
    preview.json?.accessPlan?.savedPaymentMethods === 1, brief(preview));

  // Refusals
  for (const [who, token] of [["office owner", owner.token], ["office staff", teammate.token], ["patient", patientA.token]] as const) {
    const res = await api("POST", `/hq/testing-delete/providers/${providerId}`, token, { confirmName: officeName });
    check(`${who} is refused (${res.status}: ${res.json?.error})`, res.status === 401 || res.status === 403, brief(res));
    const res2 = await api("POST", `/hq/testing-delete/patients/${patients.B}`, token, { confirmName: "Ben Deletetest" });
    check(`${who} is refused on patient delete (${res2.status})`, res2.status === 401 || res2.status === 403, brief(res2));
  }
  const support = await api("POST", `/hq/testing-delete/patients/${patients.B}`, hqTeammate.token, { confirmName: "Ben Deletetest" });
  check(`HQ support (no provider-management) is refused (${support.status})`, support.status === 403, brief(support));

  // Fresh code gate
  const stale = await api("POST", `/hq/testing-delete/patients/${patients.B}`, hqAdmin.token, { confirmName: "Ben Deletetest" });
  check("HQ admin without a fresh code gets REAUTH_REQUIRED", stale.status === 401 && String(stale.json?.code).toUpperCase() === "REAUTH_REQUIRED", brief(stale));
  await stampFreshCode(hqAdmin, 30);
  const old = await api("POST", `/hq/testing-delete/patients/${patients.B}`, hqAdmin.token, { confirmName: "Ben Deletetest" });
  check("a 30-minute-old code is not fresh", old.status === 401, brief(old));
  await stampFreshCode(hqAdmin);
  const wrongName = await api("POST", `/hq/testing-delete/patients/${patients.B}`, hqAdmin.token, { confirmName: "Ben" });
  check("wrong typed name is refused", wrongName.status === 400, brief(wrongName));

  // Patient delete
  const patientRes = await api("POST", `/hq/testing-delete/patients/${patients.B}`, hqAdmin.token, { confirmName: "ben  deletetest" });
  check("patient delete succeeds", patientRes.status === 200 && patientRes.json?.logins?.deleted === 1 && patientRes.json?.files?.deleted >= 1,
    brief(patientRes));
  const patientLeft = await leftovers([patients.B, patientB.id, patientB.email]);
  check("no row anywhere references the deleted patient", patientLeft.length === 0, brief(patientLeft));
  check("the patient's login is gone", !(await authUserExists(patientB.id)));
  const patientRevocations = await revocationsAreOnlyExpiringSignOuts([patientB.id]);
  check("only self-expiring sign-out entries remain for the patient's login", patientRevocations.bad === 0, brief(patientRevocations));
  check("the patient's file is gone", (await objectStorage.listObjectPaths(`/objects/patient-media/${patients.B}/`)).length === 0);
  check("the other patient is untouched", (await sql(`select 1 from public.patients where id=${lit(patients.A)}`)).length === 1);

  // Provider delete
  const providerRes = await api("POST", `/hq/testing-delete/providers/${providerId}`, hqAdmin.token, { confirmName: officeName.toLowerCase() });
  check("provider delete succeeds", providerRes.status === 200, brief(providerRes));
  const outcomes = (providerRes.json?.stripe ?? []) as Array<Record<string, unknown>>;
  console.log(`      stripe outcomes: ${brief(outcomes)}`);
  console.log(`      logins: ${brief(providerRes.json?.logins)} files: ${brief(providerRes.json?.files)}`);
  check("Stripe: connected account reported deleted", outcomes.some((o) => o.kind === "connected_account" && o.result === "deleted"));
  check("Stripe: saved card reported removed", outcomes.some((o) => o.kind === "access_payment_method" && o.result === "removed"));
  check("Stripe: plan customer reported deleted", outcomes.some((o) => o.kind === "access_customer" && o.result === "deleted"));
  check("Stripe: THINNR plan reported cancelled", outcomes.some((o) => o.kind === "access_plan" && o.result === "cancelled"));
  check("logins: owner, teammate, patient deleted; HQ teammate kept",
    providerRes.json?.logins?.deleted === 3 && providerRes.json?.logins?.keptHqMembers === 1, brief(providerRes.json?.logins));

  const all = [providerId, patients.A, patients.B, owner.id, teammate.id, patientA.id, patientB.id,
    owner.email, teammate.email, patientA.email, patientB.email];
  const left = await leftovers(all);
  check("no row anywhere references the office, its staff or patients", left.length === 0, brief(left));
  const revocations = await revocationsAreOnlyExpiringSignOuts([owner.id, teammate.id, patientA.id, patientB.id]);
  check("only self-expiring sign-out entries remain for deleted logins", revocations.bad === 0, brief(revocations));
  for (const [role, login] of Object.entries({ owner, teammate, patientA })) {
    check(`${role} login is gone`, !(await authUserExists(login.id)));
  }
  check("HQ teammate keeps their login", await authUserExists(hqTeammate.id));
  check("HQ teammate keeps their HQ membership",
    (await sql(`select 1 from public.hq_memberships where auth_user_id=${lit(hqTeammate.id)} and status='active'`)).length === 1);
  check("HQ teammate's office membership is gone",
    (await sql(`select 1 from public.team_members where auth_user_id=${lit(hqTeammate.id)}`)).length === 0);
  check("patient files are gone", (await objectStorage.listObjectPaths(`/objects/patient-media/${patients.A}/`)).length === 0);
  const officeLeft = await sql(`select count(*)::int n from public.providers where provider_id=${lit(providerId)}`);
  check("office row gone", officeLeft[0]?.n === 0);

  const account = await fx.stripe.accounts.retrieve(fx.accountId).then((a) => a, (e) => e);
  check("Stripe connected account no longer retrievable", (account as any)?.deleted === true || (account as any)?.code === "resource_missing" ||
    (account as any)?.statusCode === 403 || (account as any)?.statusCode === 404, brief((account as any)?.message ?? account));
  const customer = await fx.stripe.customers.retrieve(fx.customerId).then((c) => c, (e) => e);
  check("Stripe plan customer is deleted", (customer as any)?.deleted === true, brief(customer));

  // Emails can sign up again as brand-new users.
  const again = await svc("POST", "/auth/v1/admin/users", { email: owner.email, password: randomBytes(24).toString("base64url"), email_confirm: true });
  const againId = again.json?.id ?? again.json?.user?.id;
  check("the owner's email can sign up again as a new user", Boolean(againId) && againId !== owner.id, brief(again.json));
  if (againId) await svc("DELETE", `/auth/v1/admin/users/${againId}`);
}

async function cleanup() {
  // Only if the proof failed midway: use the engine itself, then the HQ logins.
  if (officeCreated && (await sql(`select 1 from public.providers where provider_id=${lit(providerId)}`)).length > 0) {
    await hardDeleteProvider(providerId).catch((error) => console.error(`  !!  engine cleanup failed: ${error}`));
  }
  for (const role of ["hqAdmin", "hqTeammate"]) {
    const login = logins[role];
    if (!login) continue;
    await sql(`delete from public.auth_sign_ins where user_id=${lit(login.id)};
      delete from public.hq_memberships where auth_user_id=${lit(login.id)} and is_protected_owner=false;
      delete from public.profiles where id=${lit(login.id)};`).catch((error) => console.error(`  !!  ${role} cleanup: ${error}`));
    await svc("DELETE", `/auth/v1/admin/users/${login.id}`);
  }
  console.log("  ok  HQ fixture logins removed");
}

main()
  .catch((error) => { failures += 1; console.error(`  FAIL  ${error instanceof Error ? error.stack : error}`); })
  .finally(async () => {
    await cleanup();
    console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  });
