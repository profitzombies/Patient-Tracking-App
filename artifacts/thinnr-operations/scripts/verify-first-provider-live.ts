/**
 * Live first-provider walk-through: what a brand-new office owner meets on
 * day one, driven over the real HTTP surface against the shared Supabase
 * project, the running api-server (STAFF_API_BASE, default the preview proxy
 * at http://localhost:80) and Stripe in TEST mode.
 *
 *   1. A new office is held behind practice setup and has no Stripe account,
 *      so Stripe's embedded onboarding cannot load yet (account session 409).
 *   2. Both ways to get an account are offered: the OAuth start URL points at
 *      Stripe with the production callback, and "Start setup" creates a real
 *      test connected account, after which the embedded onboarding loads.
 *   3. Stripe's webhook moves the office's stored account state on its own:
 *      a change made directly in Stripe reaches the shared database with no
 *      manual refresh (this proves the deployed webhook endpoint end to end).
 *   4. HQ can open the workspace for a test office without any charge, and
 *      turning that waiver off closes it again.
 *
 * Refuses to run unless payments are in Test mode. Everything it creates
 * (auth users, office, Stripe test account, ledgers) is removed in `finally`.
 */
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const MANAGEMENT_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const STRIPE_TEST_KEY = process.env.STRIPE_TEST_SECRET_KEY;
const API_BASE = (process.env.STAFF_API_BASE ?? 'http://localhost:80').replace(/\/$/, '');
const DEPLOYMENT_ID = process.env.BILLING_DEPLOYMENT_ID?.trim();
const WEBHOOK_WAIT_MS = Number(process.env.WEBHOOK_WAIT_MS || 90_000);

if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY || !MANAGEMENT_TOKEN || !STRIPE_TEST_KEY || !DEPLOYMENT_ID) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY / SUPABASE_ACCESS_TOKEN / STRIPE_TEST_SECRET_KEY / BILLING_DEPLOYMENT_ID.');
  process.exit(1);
}

const BASE = SUPABASE_URL.replace(/\/$/, '');
const PROJECT_REF = new URL(BASE).hostname.split('.')[0];
const SVC_HEADERS: Record<string, string> = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const enc = encodeURIComponent;
const brief = (value: unknown) => JSON.stringify(value)?.slice(0, 300) ?? '';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const lit = (value: string) => `'${value.replace(/'/g, "''")}'`;

async function svc(method: string, path: string, body?: unknown, prefer = 'return=representation'): Promise<{ status: number; json: any }> {
  const response = await fetch(`${BASE}${path}`, {
    method, headers: { ...SVC_HEADERS, Prefer: prefer }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* empty body */ }
  return { status: response.status, json };
}

async function managementQuery(query: string): Promise<any[]> {
  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (response.status >= 300) throw new Error(`management query failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  return response.json().catch(() => []);
}

async function stripe(method: string, path: string, form?: Record<string, string>): Promise<{ status: number; json: any }> {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${STRIPE_TEST_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

async function signIn(email: string, password: string): Promise<string> {
  const response = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON_KEY!, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  const json: any = await response.json();
  if (!json.access_token) throw new Error(`sign-in failed for ${email}: ${brief(json)}`);
  return json.access_token;
}

async function api(token: string | null, path: string, init: RequestInit = {}): Promise<{ status: number; json: any }> {
  const response = await fetch(`${API_BASE}/api${path}`, {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: response.status, json };
}

// ---------------------------------------------------------------- fixtures
const stamp = Date.now();
const password = `Qa-${stamp}!fp`;
const hqEmail = `qa-first-provider-hq-${stamp}@thinnr-qa.example.com`;
const ownerEmail = `qa-first-provider-owner-${stamp}@thinnr-qa.example.com`;
const officeId = `qa-first-provider-${stamp}`;
const ids: { hqUserId: string | null; ownerUserId: string | null; officeCreated: boolean; stripeAccount: string | null } = {
  hqUserId: null, ownerUserId: null, officeCreated: false, stripeAccount: null,
};

async function createUser(email: string): Promise<string> {
  const created = await svc('POST', '/auth/v1/admin/users', { email, password, email_confirm: true, app_metadata: { thinnr_provisioned: 'true' } });
  if (typeof created.json?.id !== 'string') throw new Error(`could not create auth user ${email}: ${brief(created.json)}`);
  return created.json.id;
}

async function createFixtures(): Promise<{ hq: string; owner: string }> {
  await svc('POST', '/rest/v1/staff_role_assignments', { email: hqEmail, role: 'hq_admin' });
  ids.hqUserId = await createUser(hqEmail);
  const membership = await svc('POST', '/rest/v1/hq_memberships', {
    email: hqEmail, auth_user_id: ids.hqUserId, status: 'active', department_role: 'admin',
    display_name: 'QA First Provider HQ', activated_at: new Date().toISOString(),
  });
  if (membership.status !== 201) throw new Error(`HQ membership failed (${membership.status}): ${brief(membership.json)}`);
  ids.ownerUserId = await createUser(ownerEmail);
  const office = await svc('POST', '/rest/v1/providers', {
    provider_id: officeId, office_name: 'QA First Provider Practice', provider_name: 'QA First Provider',
    email: ownerEmail, auth_user_id: ids.ownerUserId, access_disabled: false, created_at: new Date().toISOString(),
    phone: '6175550123', address_line_1: '1 Sample Street', city: 'Boston', state: 'MA', postal_code: '02108',
  });
  if (office.status !== 201) throw new Error(`office insert failed (${office.status}): ${brief(office.json)}`);
  ids.officeCreated = true;
  return { hq: await signIn(hqEmail, password), owner: await signIn(ownerEmail, password) };
}

/** Cleanup never passes silently: every failed or unverified removal counts. */
function cleanupProblem(what: string) {
  failures += 1;
  console.error(`FAIL  cleanup — ${what}`);
}

async function cleanup() {
  console.log('\nCleanup');
  if (ids.stripeAccount) {
    const removed = await stripe('DELETE', `/accounts/${ids.stripeAccount}`);
    if (removed.json?.deleted) console.log('  ok  Stripe test account deleted');
    else cleanupProblem(`Stripe test account ${ids.stripeAccount} not deleted: ${brief(removed.json)}`);
  }
  if (ids.officeCreated) {
    // Every public table with a provider_id column (audit events included).
    const officeTables = `select c.table_name from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
    where c.table_schema = 'public' and c.column_name = 'provider_id'`;
    try {
      // Replica role lets the append-only ledgers and FK order be ignored for
      // this one throwaway office. Only rows whose provider_id is exactly the
      // generated office id (qa-first-provider-<timestamp>) are touched.
      await managementQuery(`
begin;
set local session_replication_role = replica;
do $$ declare r record; begin
  for r in ${officeTables} and c.table_name <> 'providers'
  loop execute format('delete from public.%I where provider_id::text = %L', r.table_name, ${lit(officeId)}); end loop;
end $$;
${ids.stripeAccount ? `delete from public.billing_webhook_events where account = ${lit(ids.stripeAccount)};` : ''}
delete from public.providers where provider_id = ${lit(officeId)};
commit;`);
      // Replica role skips FK cascades, so prove nothing naming the office is left.
      const remaining = await managementQuery(`
select table_name, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I where provider_id::text = %L', table_name, ${lit(officeId)}), false, true, '')))[1]::text::int as n
from (${officeTables}) t`);
      const stuck = (remaining ?? []).filter((row: any) => Number(row.n) > 0);
      if (!Array.isArray(remaining) || !remaining.length) cleanupProblem('could not verify office rows were removed');
      else if (stuck.length) cleanupProblem(`rows still name the office: ${brief(stuck)}`);
      else console.log(`  ok  office and every row naming it removed (${remaining.length} tables checked)`);
    } catch (error) {
      cleanupProblem(`office cleanup failed: ${(error as Error).message}`);
    }
  }
  const membership = await svc('DELETE', `/rest/v1/hq_memberships?email=eq.${enc(hqEmail)}`, undefined, 'return=minimal');
  if (membership.status >= 300) cleanupProblem(`HQ membership delete answered ${membership.status}`);
  const roles = await svc('DELETE', `/rest/v1/staff_role_assignments?email=in.(${[hqEmail, ownerEmail].map(enc).join(',')})`, undefined, 'return=minimal');
  if (roles.status >= 300) cleanupProblem(`role assignment delete answered ${roles.status}`);
  for (const userId of [ids.hqUserId, ids.ownerUserId].filter((value): value is string => Boolean(value))) {
    const res = await svc('DELETE', `/auth/v1/admin/users/${userId}`);
    if (res.status >= 300 && res.status !== 404) cleanupProblem(`auth user ${userId} delete answered ${res.status}: ${brief(res.json)}`);
    const still = await svc('GET', `/auth/v1/admin/users/${userId}`);
    if (still.status !== 404) cleanupProblem(`auth user ${userId} still exists (${still.status})`);
  }
  const hqLeft = await svc('GET', `/rest/v1/hq_memberships?email=eq.${enc(hqEmail)}&select=email`);
  if (!Array.isArray(hqLeft.json) || hqLeft.json.length) cleanupProblem(`HQ membership still present: ${brief(hqLeft.json)}`);
  if (ids.stripeAccount) {
    const account = await stripe('GET', `/accounts/${ids.stripeAccount}`);
    if (account.status < 400) cleanupProblem(`Stripe test account still readable (${account.status})`);
  }
  console.log('  ..  fixture removal checked');
}

async function main() {
  const health = await api(null, '/healthz');
  if (health.status >= 400) throw new Error(`api-server is not answering at ${API_BASE}/api (${health.status}).`);
  // Refuse before creating anything (including a privileged HQ user) unless
  // this deployment's stored payment mode is Test; a missing row means Test.
  const modeRow = await svc('GET', `/rest/v1/billing_mode_state?deployment_id=eq.${enc(DEPLOYMENT_ID!)}&select=mode&limit=1`);
  const storedMode = modeRow.status < 300 && Array.isArray(modeRow.json) ? (modeRow.json[0]?.mode ?? 'test') : null;
  if (storedMode !== 'test') throw new Error(`payments are not in Test mode (${storedMode ?? `unreadable, ${modeRow.status}`}); refusing to create anything.`);
  const { hq, owner } = await createFixtures();

  console.log('\nA new office is held behind setup with no Stripe account');
  const launch = await api(owner, '/office/launch');
  check('launch state answers 200', launch.status === 200, `${launch.status} ${brief(launch.json)}`);
  const scope: string = launch.json?.billingScope ?? '';
  if (!scope.startsWith('test:')) throw new Error(`payments are not in Test mode (${scope || 'no scope'}); refusing to create Stripe accounts.`);
  check('setup is not complete', launch.json?.completedAt === null, brief(launch.json?.completedAt));
  check('payments are not started', launch.json?.payments?.state === 'not_started', brief(launch.json?.payments));
  const access = await api(owner, '/billing/office/access');
  check('the setup snapshot reports the connection as not started', access.json?.connect?.state === 'not_started', `${access.status} ${brief(access.json?.connect)}`);
  const ordinary = await api(owner, '/office/roster');
  check('ordinary office routes are gated', ordinary.status === 403 || ordinary.status === 423, `${ordinary.status} ${brief(ordinary.json)}`);
  const earlySession = await api(owner, '/billing/office/connect/account-session', { method: 'POST', body: JSON.stringify({ components: ['account_onboarding'] }) });
  check('embedded onboarding cannot load before an account exists (why the setup screen must offer "Start setup")', earlySession.status === 409, `${earlySession.status} ${brief(earlySession.json)}`);

  console.log('\nThe existing-account (OAuth) path');
  const status = await api(owner, '/billing/office/status');
  check('OAuth is available to the office', status.json?.oauth_available === true, `${status.status} ${brief(status.json)}`);
  const oauth = await api(owner, '/billing/office/connect/oauth/start', { headers: { 'X-Billing-Scope': scope } });
  const oauthUrl = oauth.json?.url ? new URL(oauth.json.url) : null;
  check('OAuth start answers with a Stripe authorize URL', oauthUrl?.origin === 'https://connect.stripe.com' && oauthUrl.pathname === '/oauth/authorize', `${oauth.status} ${brief(oauth.json)}`);
  check('the test Connect client id is used', (oauthUrl?.searchParams.get('client_id') ?? '').startsWith('ca_'), brief(oauthUrl?.searchParams.get('client_id')));
  const redirect = oauthUrl?.searchParams.get('redirect_uri') ?? '';
  check('the callback is the production app, not the dev domain', redirect.endsWith('/api/billing/oauth/callback') && !redirect.includes('replit.dev'), redirect);
  console.log(`      callback to list in Stripe: ${redirect}`);
  const wrongScope = await api(owner, '/billing/office/connect/oauth/start', { headers: { 'X-Billing-Scope': 'live:acct_wrong' } });
  check('a stale payment-mode scope is refused', wrongScope.status === 409, `${wrongScope.status}`);

  console.log('\nThe new-account (embedded onboarding) path');
  const created = await api(owner, '/billing/office/connect/create', { method: 'POST', body: '{}', headers: { 'X-Billing-Scope': scope } });
  ids.stripeAccount = created.json?.account?.stripe_account_id ?? null;
  check('Start setup creates a Stripe test account', created.status < 300 && Boolean(ids.stripeAccount?.startsWith('acct_')), `${created.status} ${brief(created.json)}`);
  const after = await api(owner, '/office/launch');
  check('the launch screen now asks for Stripe\'s details', after.json?.payments?.state === 'action_required', brief(after.json?.payments));
  const accessAfter = await api(owner, '/billing/office/access');
  check('the setup snapshot moved off not started', accessAfter.json?.connect?.state === 'action_required', brief(accessAfter.json?.connect));
  const session = await api(owner, '/billing/office/connect/account-session', { method: 'POST', body: JSON.stringify({ components: ['account_onboarding'] }) });
  check('embedded onboarding loads for the new account', session.status === 200 && typeof session.json?.client_secret === 'string', `${session.status} ${brief(Object.keys(session.json ?? {}))}`);
  const again = await api(owner, '/billing/office/connect/create', { method: 'POST', body: '{}', headers: { 'X-Billing-Scope': scope } });
  check('a second Start setup cannot create a duplicate account', again.status === 409, `${again.status}`);

  console.log('\nStripe webhooks update the office without a manual refresh');
  if (ids.stripeAccount) {
    const read = async () => (await svc('GET', `/rest/v1/billing_connected_accounts?provider_id=eq.${enc(officeId)}&select=last_synced_at,updated_at`)).json?.[0];
    const before = await read();
    await sleep(1500);
    const touched = await stripe('POST', `/accounts/${ids.stripeAccount}`, { 'metadata[qa_probe]': String(stamp) });
    check('the account can be changed directly in Stripe', touched.status === 200, `${touched.status} ${brief(touched.json?.error)}`);
    const deadline = Date.now() + WEBHOOK_WAIT_MS;
    let moved = false;
    while (Date.now() < deadline) {
      const now = await read();
      if (now && (now.last_synced_at !== before?.last_synced_at || now.updated_at !== before?.updated_at)) { moved = true; break; }
      await sleep(3000);
    }
    check(`the office's stored account synced within ${WEBHOOK_WAIT_MS / 1000}s`, moved, `stored row unchanged: ${brief(before)}`);
    const events = await svc('GET', `/rest/v1/billing_webhook_events?account=eq.${enc(ids.stripeAccount)}&type=eq.account.updated&select=kind,livemode,processed_at,error`);
    const processed = (events.json ?? []).filter((event: any) => event.processed_at && !event.error);
    check('the sync came from a processed Connect account.updated webhook', processed.some((event: any) => event.kind === 'connect' && event.livemode === false), brief(events.json));
  }

  console.log('\nHQ can open a test office without any charge');
  const hqView = await api(hq, `/office/launch?office=${enc(officeId)}`);
  check('HQ reads the office setup', hqView.status === 200, `${hqView.status} ${brief(hqView.json)}`);
  const waived = await api(hq, `/office/launch/override?office=${enc(officeId)}`, {
    method: 'POST', body: JSON.stringify({ expectedVersion: hqView.json?.version, enabled: true, note: 'QA first-provider walk-through' }),
  });
  check('HQ waiver answers 200', waived.status === 200, `${waived.status} ${brief(waived.json)}`);
  const ownerAfterWaiver = await api(owner, '/office/launch');
  check('the office reads as set up', typeof ownerAfterWaiver.json?.completedAt === 'string', brief(ownerAfterWaiver.json?.completedAt));
  check('the waiver still reports the real missing pieces', ownerAfterWaiver.json?.payments?.state !== 'ready' && ownerAfterWaiver.json?.accessSetup?.complete === false, brief({ p: ownerAfterWaiver.json?.payments, a: ownerAfterWaiver.json?.accessSetup?.complete }));
  const openRoute = await api(owner, '/office/roster');
  check('ordinary office routes open', openRoute.status === 200, `${openRoute.status} ${brief(openRoute.json)}`);
  const charges = await svc('GET', `/rest/v1/billing_office_access_attempts?provider_id=eq.${enc(officeId)}&select=id`);
  check('no access charge was attempted', Array.isArray(charges.json) && charges.json.length === 0, brief(charges.json));
  const ownerTries = await api(owner, '/office/launch/override', { method: 'POST', body: JSON.stringify({ expectedVersion: ownerAfterWaiver.json?.version, enabled: true }) });
  check('the office itself cannot waive setup', ownerTries.status === 403, `${ownerTries.status}`);
  const reclosed = await api(hq, `/office/launch/override?office=${enc(officeId)}`, {
    method: 'POST', body: JSON.stringify({ expectedVersion: waived.json?.version, enabled: false }),
  });
  check('HQ can turn the waiver off', reclosed.status === 200 && reclosed.json?.completedAt === null, `${reclosed.status} ${brief(reclosed.json?.completedAt)}`);
  const gatedAgain = await api(owner, '/office/roster');
  check('the office is gated again', gatedAgain.status === 403 || gatedAgain.status === 423, `${gatedAgain.status}`);
}

try {
  await main();
} catch (error) {
  failures += 1;
  console.error(`\nFAIL  harness error — ${(error as Error).message}`);
} finally {
  await cleanup();
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nFirst provider live: setup hold, OAuth start, embedded account creation, webhook sync, and HQ no-charge waiver all passed.');
