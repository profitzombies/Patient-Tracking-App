/**
 * Live patient invitation: what an office's first invited patient receives.
 *
 * Against the shared Supabase project and a running api-server
 * (STAFF_API_BASE, default the preview proxy at http://localhost:80):
 *   1. A throwaway office is opened with the HQ setup override (no charge).
 *   2. The office owner invites a throwaway patient from the roster route.
 *   3. The invitation answers "sent" and the patient row records
 *      invite_email_status = sent.
 *   4. The email that actually went out (read back from Resend) carries the
 *      expected app link — by default the published Expo Go page — and the
 *      Expo Go + "Create New Account → I have an invitation" steps.
 *
 * The patient address is Resend's delivered+<label>@resend.dev test inbox, so
 * no real person is emailed and sender reputation is untouched. No SMS is
 * sent (invitations only email). Everything created is removed in `finally`
 * and leftovers fail the run.
 *
 * The link comes from the API's own settings: the development workspace
 * links its Expo preview, so point STAFF_API_BASE at the published site
 * (https://app.trythinnr.com) after a republish, or at a local api-server
 * started with NODE_ENV=production and PATIENT_INVITE_URL set.
 * EXPECTED_PATIENT_APP_URL overrides the expected link.
 */
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const MANAGEMENT_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const RESEND_KEY = process.env.RESEND_API_KEY;
const API_BASE = (process.env.STAFF_API_BASE ?? 'http://localhost:80').replace(/\/$/, '');
const EXPECTED_LINK = process.env.EXPECTED_PATIENT_APP_URL?.trim() || 'https://app.trythinnr.com/thinnr-mobile/';
const EMAIL_WAIT_MS = Number(process.env.EMAIL_WAIT_MS || 30_000);

if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY || !MANAGEMENT_TOKEN || !RESEND_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY / SUPABASE_ACCESS_TOKEN / RESEND_API_KEY.');
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

async function resend(path: string): Promise<{ status: number; json: any }> {
  const response = await fetch(`https://api.resend.com${path}`, { headers: { Authorization: `Bearer ${RESEND_KEY}` } });
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
const password = `Qa-${stamp}!pi`;
const hqEmail = `qa-patient-invite-hq-${stamp}@thinnr-qa.example.com`;
const ownerEmail = `qa-patient-invite-owner-${stamp}@thinnr-qa.example.com`;
const officeId = `qa-patient-invite-${stamp}`;
const patientEmail = `delivered+thinnr-invite-${stamp}@resend.dev`;
const patientPhone = `617555${String(stamp % 10_000).padStart(4, '0')}`;
const ids: { hqUserId: string | null; ownerUserId: string | null; officeCreated: boolean; patientId: string | null } = {
  hqUserId: null, ownerUserId: null, officeCreated: false, patientId: null,
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
    display_name: 'QA Patient Invite HQ', activated_at: new Date().toISOString(),
  });
  if (membership.status !== 201) throw new Error(`HQ membership failed (${membership.status}): ${brief(membership.json)}`);
  ids.ownerUserId = await createUser(ownerEmail);
  const office = await svc('POST', '/rest/v1/providers', {
    provider_id: officeId, office_name: 'QA Patient Invite Practice', provider_name: 'QA Patient Invite',
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

/** Row counts per public table whose `column` equals `value`, over every table carrying that column. */
function countsSql(column: string, value: string): string {
  return `select table_name, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I where %I::text = %L', table_name, ${lit(column)}, ${lit(value)}), false, true, '')))[1]::text::int as n
from (${tablesWith(column)}) t`;
}

function tablesWith(column: string): string {
  return `select c.table_name from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
    where c.table_schema = 'public' and c.column_name = ${lit(column)}`;
}

async function cleanup() {
  console.log('\nCleanup');
  const patientTargets: Array<[string, string]> = [];
  if (ids.patientId) patientTargets.push(['patient_id', ids.patientId]);
  const officeTargets: Array<[string, string]> = ids.officeCreated ? [['provider_id', officeId]] : [];
  if (patientTargets.length || officeTargets.length) {
    try {
      // Replica role lets append-only ledgers and FK order be ignored for this
      // one throwaway office and patient. Only rows naming exactly the
      // generated ids (qa-patient-invite-<timestamp> and its patient) go.
      await managementQuery(`
begin;
set local session_replication_role = replica;
do $$ declare r record; begin
${[...patientTargets, ...officeTargets].map(([column, value]) => `  for r in ${tablesWith(column)} and c.table_name not in ('providers', 'patients')
  loop execute format('delete from public.%I where %I::text = %L', r.table_name, ${lit(column)}, ${lit(value)}); end loop;`).join('\n')}
end $$;
${ids.patientId ? `delete from public.patients where id::text = ${lit(ids.patientId)};` : ''}
delete from public.patients where provider_id = ${lit(officeId)};
delete from public.providers where provider_id = ${lit(officeId)};
commit;`);
      for (const [column, value] of [...officeTargets, ...patientTargets]) {
        const remaining = await managementQuery(countsSql(column, value));
        const stuck = (remaining ?? []).filter((row: any) => Number(row.n) > 0);
        if (!Array.isArray(remaining) || !remaining.length) cleanupProblem(`could not verify ${column} rows were removed`);
        else if (stuck.length) cleanupProblem(`rows still name ${column} ${value}: ${brief(stuck)}`);
        else console.log(`  ok  every row naming the ${column === 'provider_id' ? 'office' : 'patient'} removed (${remaining.length} tables checked)`);
      }
      if (ids.patientId) {
        const patientLeft = await managementQuery(`select count(*)::int as n from public.patients where id::text = ${lit(ids.patientId)} or lower(email) = ${lit(patientEmail)}`);
        if (Number(patientLeft?.[0]?.n) !== 0) cleanupProblem(`patient row still present: ${brief(patientLeft)}`);
      }
    } catch (error) {
      cleanupProblem(`office/patient cleanup failed: ${(error as Error).message}`);
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
  const rolesLeft = await svc('GET', `/rest/v1/staff_role_assignments?email=in.(${[hqEmail, ownerEmail].map(enc).join(',')})&select=email`);
  if (!Array.isArray(rolesLeft.json) || rolesLeft.json.length) cleanupProblem(`role assignments still present: ${brief(rolesLeft.json)}`);
  console.log('  ..  fixture removal checked');
}

/** The invitation email as Resend recorded it, found by its unique test address. */
async function sentInvitation(): Promise<any | null> {
  const deadline = Date.now() + EMAIL_WAIT_MS;
  while (Date.now() < deadline) {
    const list = await resend('/emails?limit=50');
    if (list.status >= 300) throw new Error(`Resend email list answered ${list.status}: ${brief(list.json)}`);
    const match = (list.json?.data ?? []).find((email: any) => (email.to ?? []).map((to: string) => to.toLowerCase()).includes(patientEmail));
    if (match) {
      const full = await resend(`/emails/${enc(match.id)}`);
      if (full.status >= 300) throw new Error(`Resend email read answered ${full.status}: ${brief(full.json)}`);
      return full.json;
    }
    await sleep(3000);
  }
  return null;
}

async function main() {
  const health = await api(null, '/healthz');
  if (health.status >= 400) throw new Error(`api-server is not answering at ${API_BASE}/api (${health.status}).`);
  console.log(`API: ${API_BASE} · expected app link: ${EXPECTED_LINK}`);
  const { hq, owner } = await createFixtures();

  console.log('\nThe office is opened with the HQ setup override');
  const hqView = await api(hq, `/office/launch?office=${enc(officeId)}`);
  check('HQ reads the office setup', hqView.status === 200, `${hqView.status} ${brief(hqView.json)}`);
  const waived = await api(hq, `/office/launch/override?office=${enc(officeId)}`, {
    method: 'POST', body: JSON.stringify({ expectedVersion: hqView.json?.version, enabled: true, note: 'QA patient invitation walk-through' }),
  });
  check('HQ override answers 200', waived.status === 200, `${waived.status} ${brief(waived.json)}`);
  const roster = await api(owner, '/office/roster');
  check('the roster opens for the owner', roster.status === 200, `${roster.status} ${brief(roster.json)}`);

  console.log('\nThe owner invites a patient from the roster');
  const invited = await api(owner, '/office/invitations', {
    method: 'POST', body: JSON.stringify({ firstName: 'Qa', lastName: 'Invitee', email: patientEmail, phone: patientPhone }),
  });
  ids.patientId = invited.json?.patient?.id ?? null;
  check('the invitation is created', invited.status === 201 && typeof ids.patientId === 'string', `${invited.status} ${brief(invited.json)}`);
  check('the invitation email reports sent', invited.json?.invitation === 'sent', brief(invited.json?.invitation));
  if (!ids.patientId) {
    const row = await svc('GET', `/rest/v1/patients?provider_id=eq.${enc(officeId)}&select=id`);
    ids.patientId = row.json?.[0]?.id ?? null;
    return;
  }
  const stored = await svc('GET', `/rest/v1/patients?id=eq.${enc(ids.patientId)}&select=provider_id,activation_status,invite_email_status`);
  check('the patient row records the email as sent', stored.json?.[0]?.invite_email_status === 'sent' && stored.json?.[0]?.provider_id === officeId,
    brief(stored.json));

  console.log('\nThe email that went out');
  const email = await sentInvitation();
  check(`Resend recorded the invitation within ${EMAIL_WAIT_MS / 1000}s`, Boolean(email), 'no email to the test address');
  if (!email) return;
  const html = String(email.html ?? '');
  const text = String(email.text ?? '');
  check('the button links the expected app page', html.includes(`href="${EXPECTED_LINK}"`), EXPECTED_LINK);
  check('the plain-text copy carries the same link', text.includes(EXPECTED_LINK), text.slice(0, 300));
  check('no development preview address is linked', !/replit\.dev|repl\.co/i.test(html + text));
  check('the steps start with installing Expo Go', text.includes('Expo Go') && text.includes('apps.apple.com') && text.includes('play.google.com'));
  check('the patient is sent to Create New Account → I have an invitation, not Log In',
    text.includes('“Create New Account”') && text.includes('“I have an invitation”') && text.includes('Do not tap “Log In”'));
  check('the email no longer claims there is no password', !/no password/i.test(html + text) && /create your password/i.test(text));
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
console.log('\nPatient invite live: invitation sent, recorded as sent, linked to the Expo Go page, and fully cleaned up.');
