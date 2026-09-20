/**
 * Live office reactivation: an offboarded office in the shared dev Supabase
 * project flips back to active through the running api-server (STAFF_API_BASE,
 * default the preview proxy at http://localhost:80).
 *
 * The reopen RPC, the route and the HQ panel are proven with a throwaway
 * PostgreSQL cluster, route fakes and an RTR suite elsewhere; this harness
 * drives the real thing end to end with disposable fixtures:
 *
 *   - a throwaway HQ admin (staff_role_assignments + auth user + active
 *     hq_memberships row) with the fresh-code proof stamped straight onto the
 *     session's auth_sign_ins ledger row, exactly as the re-auth sheet would;
 *   - a throwaway office with its owner login, one office staff member whose
 *     first sign-in is the real emailed-code rail, and TWO claimed patients.
 *
 * Scenario A — reactivation after a clean offboarding
 *   start → bundle → handover (destroy) → seal → complete, then
 *   POST /provider-accounts/:id/offboarding/reactivate. Asserts: the providers
 *   row is active with access_disabled false, an `office_reactivated` audit
 *   row landed, both charts carry reopened_at (closed_at / archived_at /
 *   record_retain_until cleared), a fresh owner sign-in reads office routes
 *   again (403 program-ended → 200), the staff member's emailed-code login
 *   goes from "neutral, no send" while offboarded to a real session that
 *   reads the roster, the reactivate call is idempotent, and a reopened
 *   patient's retired login answers 404 `reenroll_required` on the patient
 *   data rail (the code the mobile app routes to the re-enroll screen).
 *
 *   The seal destroyed the patient's GoTrue user, so no real token for that
 *   identity can exist any more. To present the retired identity to the API
 *   the harness recreates the GoTrue user under its ORIGINAL id (GoTrue admin
 *   create accepts an explicit id) and signs in — the only way to obtain a
 *   GoTrue-signed bearer for that auth_user_id. Before reactivation the same
 *   bearer answers 404 `account_closed`; after it, `reenroll_required`.
 *
 * Scenario B — refusal once a chart is gone
 *   The same office is offboarded a second time; one sealed chart's destroy
 *   date is backdated so the api-server's privacy worker (30 s cadence in dev)
 *   purges it within the run. Reactivation then answers 409 `charts_destroyed`
 *   with the exact HQ wording ("1 chart sealed by this offboarding was already
 *   destroyed. 1 chart remains sealed until …; it cannot be reopened as a
 *   partial office. Onboard it as a new office instead.") and changes nothing.
 *
 * Fixtures are removed in `finally` — ledgers through the management API
 * (append-only tables), entities through PostgREST with foreign keys enforced
 * so a missed table fails loudly instead of orphaning.
 *
 * Email: the staff member's login/start is called ONLY while the office is
 * offboarded (neutral, no send) and after reactivation (one real send to the
 * throwaway address, same as test:staff-logins). In live email mode the
 * harness never sees that code, so it rewrites the ledger row's hash with a
 * code it knows; caps, attempts and consumption stay real. The owner's login
 * is proven with a direct GoTrue sign-in instead: the org policy requires a
 * texted second factor for office managers, which no harness can complete.
 */
import crypto from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const MANAGEMENT_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const API_BASE = (process.env.STAFF_API_BASE ?? 'http://localhost:80').replace(/\/$/, '');

if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY || !MANAGEMENT_TOKEN) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY / SUPABASE_ACCESS_TOKEN in the environment.');
  process.exit(1);
}

const BASE = SUPABASE_URL.replace(/\/$/, '');
const PROJECT_REF = new URL(BASE).hostname.split('.')[0];
const PROGRAM_ENDED_MESSAGE = 'This program has ended. Contact your provider.';
const REENROLL_REQUIRED_MESSAGE = 'Your office has rejoined THINNR, but this login was retired when the program ended. Contact the office to re-enroll.';
const NEUTRAL_LOGIN_MESSAGE = 'If those details match an account, a sign-in code is on its way. Codes can take a minute to arrive.';
const SVC_HEADERS: Record<string, string> = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const enc = encodeURIComponent;
const brief = (value: unknown) => JSON.stringify(value)?.slice(0, 240) ?? '';
const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

async function svc(method: string, path: string, body?: unknown, prefer = 'return=representation'): Promise<{ status: number; json: any }> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...SVC_HEADERS, Prefer: prefer },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* empty body */ }
  return { status: response.status, json };
}

async function managementQuery(query: string): Promise<any> {
  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await response.text();
  if (response.status >= 300) throw new Error(`management query failed (${response.status}): ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return null; }
}
const lit = (value: string) => `'${value.replace(/'/g, "''")}'`;

async function passwordGrant(email: string, password: string): Promise<{ status: number; json: any }> {
  const response = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

async function signIn(email: string, password: string): Promise<string> {
  const { json } = await passwordGrant(email, password);
  if (!json?.access_token) throw new Error(`sign-in failed for ${email}: ${brief(json)}`);
  return json.access_token;
}

function sessionIdOf(token: string): string {
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  if (typeof payload.session_id !== 'string') throw new Error('token has no session_id claim');
  return payload.session_id;
}

async function api(token: string | null, path: string, init: RequestInit = {}): Promise<{ status: number; json: any; text: string; headers: Headers }> {
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
  return { status: response.status, json, text, headers: response.headers };
}

async function createUser(email: string, password: string, appMetadata: Record<string, string>, id?: string): Promise<string> {
  const created = await svc('POST', '/auth/v1/admin/users', { ...(id ? { id } : {}), email, password, email_confirm: true, app_metadata: appMetadata });
  const createdId = created.json?.id;
  if (typeof createdId !== 'string') throw new Error(`could not create auth user ${email}: ${brief(created.json)}`);
  return createdId;
}

async function poll<T>(label: string, timeoutMs: number, intervalMs: number, read: () => Promise<T | null>): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() >= deadline) {
      console.error(`  … timed out waiting for ${label}`);
      return null;
    }
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------- fixtures
const stamp = Date.now();
const password = `Qa-${stamp}!react`;
const hqEmail = `qa-reactivation-hq-${stamp}@thinnr-qa.example.com`;
const ownerEmail = `qa-reactivation-owner-${stamp}@thinnr-qa.example.com`;
// The one address that receives a real code email after reactivation.
const memberEmail = `qa-reactivation-staff-${stamp}@thinnr-staff-check.com`;
const patientEmails = [1, 2].map((n) => `qa-reactivation-patient${n}-${stamp}@thinnr-qa.example.com`);
const officeId = `qa-reactivation-${stamp}`;
const memberId = crypto.randomUUID();
const patientIds = [crypto.randomUUID(), crypto.randomUUID()];
const ids: { hqUserId: string | null; ownerUserId: string | null; memberUserId: string | null; patientUserIds: string[]; officeCreated: boolean } = {
  hqUserId: null, ownerUserId: null, memberUserId: null, patientUserIds: [], officeCreated: false,
};

async function createFixtures(): Promise<{ hq: string; owner: string; patients: string[] }> {
  // HQ admin: role assignment first so the signup trigger scopes the profile.
  await svc('POST', '/rest/v1/staff_role_assignments', { email: hqEmail, role: 'hq_admin' });
  ids.hqUserId = await createUser(hqEmail, password, { thinnr_provisioned: 'true' });
  const membership = await svc('POST', '/rest/v1/hq_memberships', {
    email: hqEmail, auth_user_id: ids.hqUserId, status: 'active', department_role: 'admin',
    display_name: 'QA Reactivation', activated_at: new Date().toISOString(),
  });
  if (membership.status !== 201) throw new Error(`HQ membership failed (${membership.status}): ${brief(membership.json)}`);

  ids.ownerUserId = await createUser(ownerEmail, password, { thinnr_provisioned: 'true' });
  const office = await svc('POST', '/rest/v1/providers', {
    provider_id: officeId, office_name: 'QA Reactivation Office', provider_name: 'QA Reactivation Provider',
    email: ownerEmail, auth_user_id: ids.ownerUserId, access_disabled: false, created_at: new Date().toISOString(),
  });
  if (office.status !== 201) throw new Error(`office insert failed (${office.status}): ${brief(office.json)}`);
  ids.officeCreated = true;
  // Office staff member: no login yet — the passwordless rail provisions it on the first proven code.
  const member = await svc('POST', '/rest/v1/team_members', {
    id: memberId, provider_id: officeId, name: 'QA Reactivation Staffer', email: memberEmail, activation_status: 'activated', office_role: 'staff',
  });
  if (member.status !== 201) throw new Error(`team member insert failed (${member.status}): ${brief(member.json)}`);

  const patientTokens: string[] = [];
  for (const [index, email] of patientEmails.entries()) {
    const userId = await createUser(email, password, { thinnr_claim: 'true' });
    ids.patientUserIds.push(userId);
    const patient = await svc('POST', '/rest/v1/patients', {
      id: patientIds[index], provider_id: officeId, name: `QA Reactivation Patient ${index + 1}`, email,
      activation_status: 'activated', auth_user_id: userId, claimed_at: new Date().toISOString(),
      created_at: new Date().toISOString(), starting_weight: 200 + index, current_weight: 195 + index,
    });
    if (patient.status !== 201) throw new Error(`patient ${index + 1} insert failed (${patient.status}): ${brief(patient.json)}`);
    patientTokens.push(await signIn(email, password));
  }

  const hq = await signIn(hqEmail, password);
  // Fresh-code proof for the HQ session: the same ledger row the re-auth
  // sheet stamps, minted here without an email code.
  const ledger = await svc('POST', '/rest/v1/auth_sign_ins', {
    user_id: ids.hqUserId, realm: 'staff', method: 'email_code', platform: 'web',
    device_fingerprint: `qa-reactivation-${stamp}`.slice(0, 64), session_id: sessionIdOf(hq),
    code_verified_at: new Date().toISOString(),
  });
  if (ledger.status !== 201) throw new Error(`fresh-code ledger row failed (${ledger.status}): ${brief(ledger.json)}`);
  return { hq, owner: await signIn(ownerEmail, password), patients: patientTokens };
}

async function cleanup() {
  console.log('\nCleanup');
  const allEmails = [hqEmail, ownerEmail, memberEmail, ...patientEmails];
  const emailIn = allEmails.map(enc).join(',');
  // The staff member's login is provisioned by the rail mid-run: find it by email.
  if (!ids.memberUserId) {
    const linked = await svc('GET', `/rest/v1/team_members?id=eq.${memberId}&select=auth_user_id`);
    if (typeof linked.json?.[0]?.auth_user_id === 'string') ids.memberUserId = linked.json[0].auth_user_id;
  }
  const users = [ids.hqUserId, ids.ownerUserId, ids.memberUserId, ...ids.patientUserIds].filter((v): v is string => Boolean(v));
  // Append-only ledgers first (their triggers reject deletes): management API,
  // one transaction, triggers off. Only rows tied to THIS run are named.
  try {
    await managementQuery(`
begin;
set local session_replication_role = replica;
delete from public.admin_audit_events where provider_id = ${lit(officeId)}${users.length ? ` or actor_user_id in (${users.map(lit).join(',')})` : ''};
delete from public.patient_tombstones where provider_id = ${lit(officeId)} or id in (${patientIds.map(lit).join(',')});
delete from public.patient_deletion_requests where patient_id in (${patientIds.map(lit).join(',')});
delete from public.auth_session_revocations where ${users.length ? `user_id in (${users.map(lit).join(',')})` : 'false'};
delete from public.claim_verifications where identifier in (${allEmails.map(lit).join(',')});
commit;`);
    console.log('  ok  ledgers cleared');
  } catch (error) {
    console.error(`  !!  ledger cleanup failed: ${(error as Error).message}`);
  }
  // Entities with foreign keys enforced: a table this harness forgot fails
  // here loudly rather than leaving orphans behind a disabled trigger.
  const viewers = await svc('GET', `/rest/v1/training_viewers?email=in.(${emailIn})&select=id`);
  const viewerIds: string[] = Array.isArray(viewers.json) ? viewers.json.map((row: any) => row.id) : [];
  const steps: Array<[string, string]> = [
    ...(viewerIds.length ? [
      ['training_completions', `/rest/v1/training_completions?viewer_id=in.(${viewerIds.join(',')})`] as [string, string],
      ['training_viewers', `/rest/v1/training_viewers?id=in.(${viewerIds.join(',')})`] as [string, string],
    ] : []),
    ['data_exports', `/rest/v1/data_exports?provider_id=eq.${enc(officeId)}`],
    ['provider_offboardings', `/rest/v1/provider_offboardings?provider_id=eq.${enc(officeId)}`],
    ['patients', `/rest/v1/patients?id=in.(${patientIds.join(',')})`],
    ['team_members', `/rest/v1/team_members?provider_id=eq.${enc(officeId)}`],
    ['providers', `/rest/v1/providers?provider_id=eq.${enc(officeId)}`],
    ['hq_memberships', `/rest/v1/hq_memberships?email=eq.${enc(hqEmail)}`],
    ['staff_role_assignments', `/rest/v1/staff_role_assignments?email=in.(${[hqEmail, ownerEmail, memberEmail].map(enc).join(',')})`],
  ];
  for (const [label, path] of steps) {
    const res = await svc('DELETE', path, undefined, 'return=minimal');
    if (res.status >= 300) console.error(`  !!  ${label} cleanup failed (${res.status}): ${brief(res.json)}`);
  }
  for (const userId of users) {
    const res = await svc('DELETE', `/auth/v1/admin/users/${userId}`);
    // The seal destroys patient logins itself; a 404 there is the expected outcome.
    if (res.status >= 300 && res.status !== 404) console.error(`  !!  auth user ${userId} cleanup failed (${res.status}): ${brief(res.json)}`);
  }
  console.log('  ok  fixtures removed');
}

// ------------------------------------------------------------------ checks
const OFFBOARDING = `/provider-accounts/${enc(officeId)}/offboarding`;

async function state(hq: string) {
  const res = await api(hq, OFFBOARDING);
  if (res.status !== 200) throw new Error(`offboarding state read failed (${res.status}): ${brief(res.json)}`);
  return res.json.offboarding;
}

/** Every step answers with the same `{ offboarding }` envelope the HQ stepper renders. */
const post = async (token: string, path: string, body: unknown = {}) => {
  const res = await api(token, path, { method: 'POST', body: JSON.stringify(body) });
  return { ...res, json: res.json?.offboarding ?? res.json };
};

async function accountRow(hq: string): Promise<any> {
  const res = await api(hq, '/provider-accounts');
  if (res.status !== 200) throw new Error(`accounts read failed (${res.status}): ${brief(res.json)}`);
  const all: any[] = res.json?.accounts ?? [];
  return all.find((a) => a.providerId === officeId) ?? null;
}

async function patientRows() {
  const res = await svc('GET', `/rest/v1/patients?id=in.(${patientIds.join(',')})&select=id,auth_user_id,closed_at,archived_at,record_retain_until,reopened_at&order=created_at.asc`);
  if (res.status !== 200 || !Array.isArray(res.json)) throw new Error(`patient rows read failed (${res.status}): ${brief(res.json)}`);
  return res.json as Array<{ id: string; auth_user_id: string | null; closed_at: string | null; archived_at: string | null; record_retain_until: string | null; reopened_at: string | null }>;
}

async function auditActions(): Promise<string[]> {
  const audit = await svc('GET', `/rest/v1/admin_audit_events?provider_id=eq.${enc(officeId)}&select=action&order=occurred_at.asc`);
  return Array.isArray(audit.json) ? audit.json.map((r: any) => r.action) : [];
}

/** Live email mode never shows the code: rewrite the ledger row's hash with one the harness knows. */
async function obtainCode(requestId: string, devCode: string | undefined): Promise<string> {
  if (devCode) return devCode;
  const KNOWN = '531642';
  const row = await svc('GET', `/rest/v1/claim_verifications?id=eq.${requestId}&select=code_salt`);
  const salt = row.json?.[0]?.code_salt;
  if (typeof salt !== 'string' || salt.length === 0) throw new Error('ledger row has no code salt to rewrite');
  const patched = await svc('PATCH', `/rest/v1/claim_verifications?id=eq.${requestId}`, { code_hash: sha256(salt + KNOWN) });
  if (patched.status >= 300) throw new Error(`code injection failed (${patched.status})`);
  return KNOWN;
}

/** start → bundle → hand-over (destroy) → seal → complete, as the HQ stepper drives it. */
async function offboard(hq: string, cycle: number, charts: number): Promise<void> {
  const started = await post(hq, `${OFFBOARDING}/start`);
  check(`[cycle ${cycle}] start is 201 and the office is offboarding`, started.status === 201 && started.json?.status === 'offboarding', `${started.status} ${brief(started.json)}`);
  const bundle = await post(hq, `${OFFBOARDING}/bundle`, { includeTombstones: true });
  check(`[cycle ${cycle}] bundle request accepted (202)`, bundle.status === 202 && typeof bundle.json?.bundle?.id === 'string', `${bundle.status} ${brief(bundle.json)}`);
  const bundleReady = await poll('the office bundle to build', 120_000, 2_000, async () => {
    const s = await state(hq);
    return s.bundle?.status === 'ready' || s.bundle?.status === 'failed' ? s : null;
  });
  check(`[cycle ${cycle}] bundle export job reaches ready`, bundleReady?.bundle?.status === 'ready', brief(bundleReady?.bundle));
  const handover = await post(hq, `${OFFBOARDING}/handover`, {
    receivedBy: 'QA Records Custodian', receivedOn: new Date().toISOString().slice(0, 10), choice: 'destroy',
    letterReference: `QA-LETTER-${stamp}-${cycle}`, note: 'Live reactivation harness hand-over.',
  });
  check(`[cycle ${cycle}] hand-over recorded (destroy)`, (handover.status === 200 || handover.status === 201) && handover.json?.handover?.choice === 'destroy', `${handover.status} ${brief(handover.json)}`);
  const seal = await post(hq, `${OFFBOARDING}/seal`);
  check(`[cycle ${cycle}] seal accepted (202) with a destroy date`, seal.status === 202 && typeof seal.json?.seal?.retainUntil === 'string', `${seal.status} ${brief(seal.json)}`);
  const sealed = await poll('the seal job to close the charts', 180_000, 3_000, async () => {
    const s = await state(hq);
    return s.seal?.completedAt ? s : null;
  });
  check(`[cycle ${cycle}] seal completes: ${charts} charts sealed, 0 held`, sealed?.seal?.progress?.total === charts && sealed?.seal?.progress?.sealed === charts && (sealed?.seal?.progress?.held ?? 0) === 0, brief(sealed?.seal));
  const complete = await post(hq, `${OFFBOARDING}/complete`);
  check(`[cycle ${cycle}] complete → offboarded`, (complete.status === 200 || complete.status === 201) && complete.json?.status === 'offboarded', `${complete.status} ${brief(complete.json)}`);
}

async function main() {
  const tokens = await createFixtures();
  const { hq, owner } = tokens;

  console.log('\n1. Before offboarding: staff and patients are in');
  const ownerRoster = await api(owner, '/office/roster');
  check('owner token reads the office roster (200)', ownerRoster.status === 200, `${ownerRoster.status} ${brief(ownerRoster.json)}`);
  for (const [index, token] of tokens.patients.entries()) {
    // A brand-new claimed patient has not accepted the current consent version
    // yet: 403 CONSENT_REQUIRED means identity resolved with the office open.
    const data = await api(token, '/patient-data/profile');
    check(`patient ${index + 1} data route resolves identity (200 or consent gate, never program_ended)`, data.status === 200 || (data.status === 403 && data.json?.code === 'CONSENT_REQUIRED'), `${data.status} ${brief(data.json)}`);
  }
  const initial = await state(hq);
  check('office starts active with no offboarding record', initial.status === 'active' && initial.started === null && initial.reactivated === null, brief(initial));
  const notYet = await post(hq, `${OFFBOARDING}/reactivate`);
  check('reactivating an active office is refused (409 not_offboarded)', notYet.status === 409 && notYet.json?.code === 'not_offboarded', `${notYet.status} ${brief(notYet.json)}`);

  console.log('\n2. Scenario A — offboard the office (2 charts)');
  await offboard(hq, 1, 2);
  const sealedRows = await patientRows();
  check('both charts are sealed: login link dropped, closed_at and destroy date set', sealedRows.length === 2 && sealedRows.every((r) => r.auth_user_id === null && typeof r.closed_at === 'string' && typeof r.record_retain_until === 'string' && r.reopened_at === null), brief(sealedRows));
  const offboardedProvider = await svc('GET', `/rest/v1/providers?provider_id=eq.${enc(officeId)}&select=offboarding_status,access_disabled,offboarded_at`);
  check('providers row is offboarded + access_disabled', offboardedProvider.json?.[0]?.offboarding_status === 'offboarded' && offboardedProvider.json?.[0]?.access_disabled === true, brief(offboardedProvider.json));
  const offboardedState = await state(hq);
  check('state carries the reactivation preview: 2 reopenable, nothing destroyed or lapsed, eligible', offboardedState.status === 'offboarded' && offboardedState.reactivation?.reopenable === 2 && offboardedState.reactivation?.destroyed === 0 && offboardedState.reactivation?.lapsed === 0 && offboardedState.reactivation?.eligible === true, brief(offboardedState.reactivation));

  console.log('\n3. While offboarded: staff are locked out, the retired patient login is closed');
  const ownerLocked = await signIn(ownerEmail, password);
  const lockedRoster = await api(ownerLocked, '/office/roster');
  check('a fresh owner sign-in is refused by office routes (403, program-ended wording)', lockedRoster.status === 403 && /program has ended/i.test(String(lockedRoster.json?.error ?? '')), `${lockedRoster.status} ${brief(lockedRoster.json)}`);
  const memberLockedStart = await post(hq, '/auth/login/start', { realm: 'staff', identifier: memberEmail });
  const memberLockedSends = await svc('GET', `/rest/v1/claim_verifications?identifier=eq.${enc(memberEmail)}&select=id`);
  check('staff member code request is neutral with NO send while the office is offboarded', memberLockedStart.status === 200 && memberLockedStart.json?.message === NEUTRAL_LOGIN_MESSAGE && Array.isArray(memberLockedSends.json) && memberLockedSends.json.length === 0, `${memberLockedStart.status} ${brief(memberLockedSends.json)}`);
  const destroyed = await passwordGrant(patientEmails[0], password);
  check('patient 1 login itself was destroyed by the seal (password sign-in refused)', destroyed.status >= 400, `${destroyed.status}`);
  // Present the retired identity: recreate the GoTrue user under its original
  // id (see the header) so the API sees a real bearer for that auth_user_id.
  const retiredId = ids.patientUserIds[0];
  const recreatedId = await createUser(patientEmails[0], password, { thinnr_claim: 'true' }, retiredId);
  check('GoTrue accepts the retired auth user id for the recreated login', recreatedId === retiredId, `${recreatedId} vs ${retiredId}`);
  const retiredPatient = await signIn(patientEmails[0], password);
  const closedData = await api(retiredPatient, '/patient-data/profile');
  check('retired patient bearer → 404 account_closed while the chart is sealed', closedData.status === 404 && closedData.json?.code === 'account_closed', `${closedData.status} ${brief(closedData.json)}`);

  console.log('\n4. Reactivate');
  const reactivated = await post(hq, `${OFFBOARDING}/reactivate`);
  check('reactivate → 200, office active, 2 charts reopened', reactivated.status === 200 && reactivated.json?.status === 'active' && reactivated.json?.reactivated?.charts === 2 && typeof reactivated.json?.reactivated?.at === 'string', `${reactivated.status} ${brief(reactivated.json)}`);
  check('reactivated state reads as a fresh office (next step start, no preview, no stale stepper)', reactivated.json?.nextStep === 'start' && reactivated.json?.reactivation === null && reactivated.json?.started === null && reactivated.json?.seal === null, brief(reactivated.json));
  const activeProvider = await svc('GET', `/rest/v1/providers?provider_id=eq.${enc(officeId)}&select=offboarding_status,access_disabled,offboarded_at,offboarding_started_at`);
  check('providers row: active, access_disabled false, offboarding dates cleared', activeProvider.json?.[0]?.offboarding_status === 'active' && activeProvider.json?.[0]?.access_disabled === false && activeProvider.json?.[0]?.offboarded_at === null && activeProvider.json?.[0]?.offboarding_started_at === null, brief(activeProvider.json));
  const record = await svc('GET', `/rest/v1/provider_offboardings?provider_id=eq.${enc(officeId)}&select=reactivated_at,reactivated_by,reactivated_charts`);
  check('offboarding record carries reactivated_at / by the HQ admin / 2 charts', typeof record.json?.[0]?.reactivated_at === 'string' && record.json?.[0]?.reactivated_by === ids.hqUserId && record.json?.[0]?.reactivated_charts === 2, brief(record.json));
  const auditA = await auditActions();
  check('audit row office_reactivated landed after the completed offboarding', auditA.filter((a) => a === 'office_reactivated').length === 1 && auditA.indexOf('office_offboarding_completed') < auditA.indexOf('office_reactivated'), auditA.join(','));
  const reopenedRows = await patientRows();
  check('both patients carry reopened_at with closed_at / archived_at / destroy date cleared', reopenedRows.length === 2 && reopenedRows.every((r) => typeof r.reopened_at === 'string' && r.closed_at === null && r.archived_at === null && r.record_retain_until === null && r.auth_user_id === null), brief(reopenedRows));
  const requests = await svc('GET', `/rest/v1/patient_deletion_requests?patient_id=in.(${patientIds.join(',')})&select=patient_id,status,closed_at`);
  check('both closure requests are cancelled with their closed_at kept', Array.isArray(requests.json) && requests.json.length === 2 && requests.json.every((r: any) => r.status === 'cancelled' && typeof r.closed_at === 'string'), brief(requests.json));
  const accountsAfter = await accountRow(hq);
  check('Accounts lists the office as active again', accountsAfter?.status === 'active', brief(accountsAfter));
  const repeat = await post(hq, `${OFFBOARDING}/reactivate`);
  check('repeating reactivate is idempotent (200, still one audit row)', repeat.status === 200 && repeat.json?.status === 'active' && (await auditActions()).filter((a) => a === 'office_reactivated').length === 1, `${repeat.status} ${brief(repeat.json)}`);
  const certificateGone = await api(hq, `${OFFBOARDING}/certificate.csv`);
  check('destruction certificate is no longer offered for an active office', certificateGone.status !== 200, `${certificateGone.status}`);

  console.log('\n5. Staff sign in again');
  const ownerBack = await signIn(ownerEmail, password);
  const rosterBack = await api(ownerBack, '/office/roster');
  check('a fresh owner sign-in reads the office roster again (200)', rosterBack.status === 200, `${rosterBack.status} ${brief(rosterBack.json)}`);
  const rosterIds: string[] = Array.isArray(rosterBack.json?.patients) ? rosterBack.json.patients.map((p: any) => p.id) : [];
  check('the reopened charts are back on the roster', patientIds.every((id) => rosterIds.includes(id)), brief(rosterIds));
  const memberStart = await post(hq, '/auth/login/start', { realm: 'staff', identifier: memberEmail });
  check('staff member code request answers ok with a request id', memberStart.status === 200 && memberStart.json?.ok === true && typeof memberStart.json?.requestId === 'string', `${memberStart.status} ${brief(memberStart.json)}`);
  const memberRow = await svc('GET', `/rest/v1/claim_verifications?id=eq.${memberStart.json?.requestId}&select=purpose,account_type,identifier`);
  check('…and the directory now recorded a staff login send for the office member', memberRow.json?.[0]?.purpose === 'login' && memberRow.json?.[0]?.account_type === 'team_member' && memberRow.json?.[0]?.identifier === memberEmail, brief(memberRow.json));
  const code = await obtainCode(memberStart.json.requestId, memberStart.json.devCode);
  const verify = await post(hq, '/auth/login/verify', { requestId: memberStart.json.requestId, code });
  check('the proven code answers with a staff token hash', verify.status === 200 && verify.json?.realm === 'staff' && typeof verify.json?.tokenHash === 'string', `${verify.status} ${brief(verify.json)}`);
  let memberToken: string | null = null;
  if (typeof verify.json?.tokenHash === 'string') {
    const session = await fetch(`${BASE}/auth/v1/verify`, {
      method: 'POST', headers: { apikey: ANON_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'email', token_hash: verify.json.tokenHash }),
    });
    const sessionJson: any = await session.json().catch(() => null);
    memberToken = typeof sessionJson?.access_token === 'string' ? sessionJson.access_token : null;
    ids.memberUserId = typeof sessionJson?.user?.id === 'string' ? sessionJson.user.id : null;
    check('the token hash becomes a real session', memberToken !== null && ids.memberUserId !== null, `${session.status} ${brief(sessionJson)}`);
  }
  if (memberToken) {
    const memberWho = await api(memberToken, '/claim/whoami');
    check('staff session identifies as a team member of the office', memberWho.status === 200 && memberWho.json?.kind === 'team_member' && (memberWho.json?.providerId ?? memberWho.json?.provider_id) === officeId, `${memberWho.status} ${brief(memberWho.json)}`);
    const memberRoster = await api(memberToken, '/office/roster');
    check('staff session reads the office roster (200)', memberRoster.status === 200, `${memberRoster.status} ${brief(memberRoster.json)}`);
    const linked = await svc('GET', `/rest/v1/team_members?id=eq.${memberId}&select=auth_user_id`);
    check('the staff row is linked to the provisioned login', linked.json?.[0]?.auth_user_id === ids.memberUserId, brief(linked.json));
  }

  console.log('\n6. Reopened patient: the retired login must re-enroll');
  const reenroll = await api(retiredPatient, '/patient-data/profile');
  check('retired patient bearer → 404 reenroll_required with the exact message', reenroll.status === 404 && reenroll.json?.code === 'reenroll_required' && reenroll.json?.error === REENROLL_REQUIRED_MESSAGE, `${reenroll.status} ${brief(reenroll.json)}`);
  check('re-enroll body carries no office or chart details', !JSON.stringify(reenroll.json ?? {}).includes(officeId) && !JSON.stringify(reenroll.json ?? {}).includes(patientIds[0]), brief(reenroll.json));

  console.log('\n7. Scenario B — offboard again, destroy one chart, reactivation is refused');
  const firstReopenedAt = reopenedRows.find((r) => r.id === patientIds[0])?.reopened_at ?? null;
  await offboard(hq, 2, 2);
  const secondState = await state(hq);
  check('[cycle 2] preview before the purge: 2 reopenable, eligible', secondState.reactivation?.reopenable === 2 && secondState.reactivation?.destroyed === 0 && secondState.reactivation?.eligible === true, brief(secondState.reactivation));
  // The destroy date is 30 days out; pull patient 2's into the past so the
  // privacy worker's next drain purges that one sealed chart.
  const past = new Date(Date.now() - 60_000).toISOString();
  const backdated = await svc('PATCH', `/rest/v1/patient_deletion_requests?patient_id=eq.${patientIds[1]}&status=eq.closed`, { retain_until: past });
  check('[cycle 2] closed deletion request for patient 2 found and backdated', backdated.status === 200 && Array.isArray(backdated.json) && backdated.json.length === 1, `${backdated.status} ${brief(backdated.json)}`);
  await svc('PATCH', `/rest/v1/patients?id=eq.${patientIds[1]}`, { record_retain_until: past });
  // The purge writes the tombstone first and deletes the row after; wait for
  // the row to be gone, or the preview briefly counts the chart as lapsed too.
  const purged = await poll('the purge to leave a tombstone and drop the row', 150_000, 5_000, async () => {
    const tomb = await svc('GET', `/rest/v1/patient_tombstones?id=eq.${patientIds[1]}&select=id,purged_at`);
    if (typeof tomb.json?.[0]?.purged_at !== 'string') return null;
    const row = await svc('GET', `/rest/v1/patients?id=eq.${patientIds[1]}&select=id`);
    return row.status === 200 && Array.isArray(row.json) && row.json.length === 0 ? tomb.json[0] : null;
  });
  check('[cycle 2] patient 2 chart purged (tombstone with purged_at, row gone)', purged !== null, '');
  const remaining = await patientRows();
  check('[cycle 2] patient 1 remains sealed (closed_at set, reopened_at still the cycle-1 stamp)', remaining.length === 1 && remaining[0].id === patientIds[0] && typeof remaining[0].closed_at === 'string' && remaining[0].reopened_at === firstReopenedAt, brief(remaining));
  const refusedState = await state(hq);
  check('[cycle 2] preview after the purge: 1 reopenable, 1 destroyed, not eligible', refusedState.reactivation?.reopenable === 1 && refusedState.reactivation?.destroyed === 1 && refusedState.reactivation?.lapsed === 0 && refusedState.reactivation?.eligible === false, brief(refusedState.reactivation));
  const refused = await post(hq, `${OFFBOARDING}/reactivate`);
  const retainDay = typeof refused.json?.reactivation?.earliestRetainUntil === 'string' ? refused.json.reactivation.earliestRetainUntil.slice(0, 10) : '';
  const expectedRefusal = `This office cannot be reactivated: 1 chart sealed by this offboarding was already destroyed. 1 chart remains sealed until ${retainDay}; it cannot be reopened as a partial office. Onboard it as a new office instead.`;
  check('reactivate → 409 charts_destroyed', refused.status === 409 && refused.json?.code === 'charts_destroyed', `${refused.status} ${brief(refused.json)}`);
  check('refusal names the destroyed chart, the remaining sealed chart and its date', /^\d{4}-\d{2}-\d{2}$/.test(retainDay) && refused.json?.error === expectedRefusal, `${brief(refused.json?.error)} vs ${expectedRefusal}`);
  check('refusal preview: 1 reopenable, 1 destroyed, eligible false', refused.json?.reactivation?.reopenable === 1 && refused.json?.reactivation?.destroyed === 1 && refused.json?.reactivation?.eligible === false, brief(refused.json?.reactivation));
  const stillOff = await svc('GET', `/rest/v1/providers?provider_id=eq.${enc(officeId)}&select=offboarding_status,access_disabled`);
  const stillSealed = await patientRows();
  check('refusal changes nothing: office stays offboarded + disabled, patient 1 stays sealed', stillOff.json?.[0]?.offboarding_status === 'offboarded' && stillOff.json?.[0]?.access_disabled === true && stillSealed.length === 1 && typeof stillSealed[0]?.closed_at === 'string' && stillSealed[0]?.reopened_at === firstReopenedAt, `${brief(stillOff.json)} ${brief(stillSealed)}`);
  const auditB = await auditActions();
  check('no second office_reactivated audit row after the refusal', auditB.filter((a) => a === 'office_reactivated').length === 1, auditB.join(','));
  const ownerStillOut = await api(await signIn(ownerEmail, password), '/office/roster');
  check('owner stays locked out after the refused reactivation', ownerStillOut.status === 403, `${ownerStillOut.status} ${brief(ownerStillOut.json)}`);
}

main()
  .catch((error) => {
    failures += 1;
    console.error(`FAIL  harness error — ${(error as Error).stack ?? error}`);
  })
  .finally(async () => {
    await cleanup();
    if (failures > 0) {
      console.error(`\n${failures} check(s) failed.`);
      process.exit(1);
    }
    console.log('\nAll office reactivation live checks passed.');
  });
