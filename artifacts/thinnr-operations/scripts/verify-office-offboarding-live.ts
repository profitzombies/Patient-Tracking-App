/**
 * Live office offboarding: the full stepper against the shared dev Supabase
 * project and the running api-server (STAFF_API_BASE, default the preview
 * proxy at http://localhost:80).
 *
 * The stepper, seal job and patient gate are proven with route fakes and a
 * throwaway PostgreSQL cluster elsewhere; this harness drives the real thing
 * end to end with disposable fixtures:
 *
 *   - a throwaway HQ admin (staff_role_assignments + auth user + active
 *     hq_memberships row) whose fresh-code proof is written straight onto the
 *     session's auth_sign_ins ledger row, exactly as the re-auth sheet would;
 *   - a throwaway office with its owner login (providers.auth_user_id) and one
 *     claimed patient (patients.auth_user_id) — both real GoTrue users.
 *
 * It then walks start → bundle → handover (destroy) → seal → complete through
 * the same HTTP calls the HQ stepper makes and asserts the lock-outs:
 *   staff:   the owner's pre-start token worked on an office route, is refused
 *            after start (sessions revoked), a fresh GoTrue sign-in is refused
 *            by every office route, and the staff code request answers with
 *            the neutral body while recording NO send for that email;
 *   patient: whoami and a bearer data route go from 200 to 403 `program_ended`
 *            with the exact neutral message (the mobile app routes that code to
 *            the program-ended screen); after the seal the login is destroyed
 *            and never answers 200 again;
 *   HQ:      the office is absent from the Accounts default filter and present
 *            under Offboarded; the destruction certificate downloads and, once
 *            the purge has run, lists the patient's tombstone.
 *
 * The destroy hand-over schedules the purge 30 days out; the harness backdates
 * that retain-until so the api-server's privacy worker (30 s cadence in dev)
 * purges within the run. Fixtures are removed in `finally` — ledgers through
 * the management API (append-only tables), entities through PostgREST with
 * foreign keys enforced so a missed table fails loudly instead of orphaning.
 *
 * Never call the staff login/start route BEFORE offboarding: the email
 * directory would match the owner and a real message would go out.
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

async function signIn(email: string, password: string): Promise<string> {
  const response = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json: any = await response.json();
  if (!json.access_token) throw new Error(`sign-in failed for ${email}: ${brief(json)}`);
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

async function createUser(email: string, password: string, appMetadata: Record<string, string>): Promise<string> {
  const created = await svc('POST', '/auth/v1/admin/users', { email, password, email_confirm: true, app_metadata: appMetadata });
  const id = created.json?.id;
  if (typeof id !== 'string') throw new Error(`could not create auth user ${email}: ${brief(created.json)}`);
  return id;
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
const password = `Qa-${stamp}!offb`;
const hqEmail = `qa-offboarding-hq-${stamp}@thinnr-qa.example.com`;
const ownerEmail = `qa-offboarding-owner-${stamp}@thinnr-qa.example.com`;
const patientEmail = `qa-offboarding-patient-${stamp}@thinnr-qa.example.com`;
const officeId = `qa-offboarding-${stamp}`;
const patientId = crypto.randomUUID();
const ids: { hqUserId: string | null; ownerUserId: string | null; patientUserId: string | null; officeCreated: boolean } = {
  hqUserId: null, ownerUserId: null, patientUserId: null, officeCreated: false,
};

async function createFixtures(): Promise<{ hq: string; owner: string; patient: string }> {
  // HQ admin: role assignment first so the signup trigger scopes the profile.
  await svc('POST', '/rest/v1/staff_role_assignments', { email: hqEmail, role: 'hq_admin' });
  ids.hqUserId = await createUser(hqEmail, password, { thinnr_provisioned: 'true' });
  const membership = await svc('POST', '/rest/v1/hq_memberships', {
    email: hqEmail, auth_user_id: ids.hqUserId, status: 'active', department_role: 'admin',
    display_name: 'QA Offboarding', activated_at: new Date().toISOString(),
  });
  if (membership.status !== 201) throw new Error(`HQ membership failed (${membership.status}): ${brief(membership.json)}`);

  // Office owner + claimed patient are plain GoTrue users linked by id.
  ids.ownerUserId = await createUser(ownerEmail, password, { thinnr_provisioned: 'true' });
  ids.patientUserId = await createUser(patientEmail, password, { thinnr_claim: 'true' });
  const office = await svc('POST', '/rest/v1/providers', {
    provider_id: officeId, office_name: 'QA Offboarding Office', provider_name: 'QA Offboarding Provider',
    email: ownerEmail, auth_user_id: ids.ownerUserId, access_disabled: false, created_at: new Date().toISOString(),
  });
  if (office.status !== 201) throw new Error(`office insert failed (${office.status}): ${brief(office.json)}`);
  ids.officeCreated = true;
  const patient = await svc('POST', '/rest/v1/patients', {
    id: patientId, provider_id: officeId, name: 'QA Offboarding Patient', email: patientEmail,
    activation_status: 'activated', auth_user_id: ids.patientUserId, claimed_at: new Date().toISOString(),
    created_at: new Date().toISOString(), starting_weight: 200, current_weight: 195,
  });
  if (patient.status !== 201) throw new Error(`patient insert failed (${patient.status}): ${brief(patient.json)}`);

  const hq = await signIn(hqEmail, password);
  // Fresh-code proof for the HQ session: the same ledger row the re-auth
  // sheet stamps, minted here without an email code.
  const ledger = await svc('POST', '/rest/v1/auth_sign_ins', {
    user_id: ids.hqUserId, realm: 'staff', method: 'email_code', platform: 'web',
    device_fingerprint: `qa-offboarding-${stamp}`.slice(0, 64), session_id: sessionIdOf(hq),
    code_verified_at: new Date().toISOString(),
  });
  if (ledger.status !== 201) throw new Error(`fresh-code ledger row failed (${ledger.status}): ${brief(ledger.json)}`);
  return { hq, owner: await signIn(ownerEmail, password), patient: await signIn(patientEmail, password) };
}

async function cleanup() {
  console.log('\nCleanup');
  const users = [ids.hqUserId, ids.ownerUserId, ids.patientUserId].filter((v): v is string => Boolean(v));
  // Append-only ledgers first (their triggers reject deletes): management API,
  // one transaction, triggers off. Only rows tied to THIS run are named.
  try {
    await managementQuery(`
begin;
set local session_replication_role = replica;
delete from public.admin_audit_events where provider_id = ${lit(officeId)}${users.length ? ` or actor_user_id in (${users.map(lit).join(',')})` : ''};
delete from public.patient_tombstones where provider_id = ${lit(officeId)} or id = ${lit(patientId)};
delete from public.patient_deletion_requests where patient_id = ${lit(patientId)};
delete from public.auth_session_revocations where ${users.length ? `user_id in (${users.map(lit).join(',')})` : 'false'};
delete from public.claim_verifications where identifier in (${[hqEmail, ownerEmail, patientEmail].map(lit).join(',')});
commit;`);
    console.log('  ok  ledgers cleared');
  } catch (error) {
    console.error(`  !!  ledger cleanup failed: ${(error as Error).message}`);
  }
  // Entities with foreign keys enforced: a table this harness forgot fails
  // here loudly rather than leaving orphans behind a disabled trigger.
  const steps: Array<[string, string]> = [
    ['data_exports', `/rest/v1/data_exports?provider_id=eq.${enc(officeId)}`],
    ['provider_offboardings', `/rest/v1/provider_offboardings?provider_id=eq.${enc(officeId)}`],
    ['patients', `/rest/v1/patients?id=eq.${patientId}`],
    ['team_members', `/rest/v1/team_members?provider_id=eq.${enc(officeId)}`],
    ['providers', `/rest/v1/providers?provider_id=eq.${enc(officeId)}`],
    ['hq_memberships', `/rest/v1/hq_memberships?email=eq.${enc(hqEmail)}`],
    ['staff_role_assignments', `/rest/v1/staff_role_assignments?email=in.(${[hqEmail, ownerEmail].map(enc).join(',')})`],
  ];
  for (const [label, path] of steps) {
    const res = await svc('DELETE', path, undefined, 'return=minimal');
    if (res.status >= 300) console.error(`  !!  ${label} cleanup failed (${res.status}): ${brief(res.json)}`);
  }
  for (const userId of users) {
    const res = await svc('DELETE', `/auth/v1/admin/users/${userId}`);
    // The seal destroys the patient login itself; a 404 there is the expected outcome.
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

async function accountsByFilter(hq: string): Promise<{ all: any[]; mine: any }> {
  const res = await api(hq, '/provider-accounts');
  if (res.status !== 200) throw new Error(`accounts read failed (${res.status}): ${brief(res.json)}`);
  const all: any[] = res.json?.accounts ?? [];
  return { all, mine: all.find((a) => a.providerId === officeId) ?? null };
}

async function main() {
  const tokens = await createFixtures();
  const { hq, owner } = tokens;
  let patient = tokens.patient;

  console.log('\n1. Before offboarding: staff and patient are in');
  const ownerRoster = await api(owner, '/office/roster');
  check('owner token reads the office roster (200)', ownerRoster.status === 200, `${ownerRoster.status} ${brief(ownerRoster.json)}`);
  const whoBefore = await api(patient, '/claim/whoami');
  check('patient whoami is 200 kind=patient', whoBefore.status === 200 && whoBefore.json?.kind === 'patient', `${whoBefore.status} ${brief(whoBefore.json)}`);
  // A brand-new claimed patient has not accepted the current consent version
  // yet, so the data rail answers 403 CONSENT_REQUIRED: identity resolved, the
  // office still open. Anything program_ended here would be the bug.
  const dataBefore = await api(patient, '/patient-data/profile');
  check('patient bearer data route resolves identity (200 or consent gate, never program_ended)', dataBefore.status === 200 || (dataBefore.status === 403 && dataBefore.json?.code === 'CONSENT_REQUIRED'), `${dataBefore.status} ${brief(dataBefore.json)}`);
  const initial = await state(hq);
  check('office starts active with no offboarding record', initial.status === 'active' && initial.started === null, brief(initial));
  const accountsBefore = await accountsByFilter(hq);
  check('office listed as active in Accounts before the stepper', accountsBefore.mine?.status === 'active', brief(accountsBefore.mine));

  console.log('\n2. Step 1 — start (staff access ends)');
  const started = await post(hq, `${OFFBOARDING}/start`);
  check('start is 201 and the office is offboarding', started.status === 201 && started.json?.status === 'offboarding', `${started.status} ${brief(started.json)}`);
  check('start reports the owner session revoked', Number(started.json?.started?.sessionsRevoked) >= 1, brief(started.json?.started));
  const again = await post(hq, `${OFFBOARDING}/start`);
  check('repeating start is idempotent (200, still offboarding)', again.status === 200 && again.json?.status === 'offboarding', `${again.status}`);
  const ownerAfter = await api(owner, '/office/roster');
  check('owner pre-start token is refused on office routes', ownerAfter.status === 401 || ownerAfter.status === 403, `${ownerAfter.status} ${brief(ownerAfter.json)}`);
  const ownerFresh = await signIn(ownerEmail, password);
  const freshRoster = await api(ownerFresh, '/office/roster');
  check('a fresh owner sign-in is refused by office routes (403, program-ended wording)', freshRoster.status === 403 && /program has ended/i.test(String(freshRoster.json?.error ?? '')), `${freshRoster.status} ${brief(freshRoster.json)}`);
  const freshAnalytics = await api(ownerFresh, '/office/analytics?start=2026-08-08&end=2026-09-06');
  check('office analytics also refuse the fresh owner token', freshAnalytics.status === 403 || freshAnalytics.status === 401, `${freshAnalytics.status}`);
  const loginStart = await post(hq, '/auth/login/start', { realm: 'staff', identifier: ownerEmail });
  check('staff code request answers with the neutral body', loginStart.status === 200 && loginStart.json?.ok === true && loginStart.json?.message === NEUTRAL_LOGIN_MESSAGE, `${loginStart.status} ${brief(loginStart.json)}`);
  const sends = await svc('GET', `/rest/v1/claim_verifications?identifier=eq.${enc(ownerEmail)}&select=id`);
  check('…and the directory recorded NO send for the offboarding office\u2019s owner', sends.status === 200 && Array.isArray(sends.json) && sends.json.length === 0, brief(sends.json));

  console.log('\n3. Patient gate while offboarding (program-ended screen contract)');
  const whoAfter = await api(patient, '/claim/whoami');
  check('patient whoami → 403 program_ended with the neutral message', whoAfter.status === 403 && whoAfter.json?.code === 'program_ended' && whoAfter.json?.error === PROGRAM_ENDED_MESSAGE, `${whoAfter.status} ${brief(whoAfter.json)}`);
  const dataAfter = await api(patient, '/patient-data/profile');
  check('patient bearer data route → 403 program_ended with the neutral message', dataAfter.status === 403 && dataAfter.json?.code === 'program_ended' && dataAfter.json?.error === PROGRAM_ENDED_MESSAGE, `${dataAfter.status} ${brief(dataAfter.json)}`);
  check('program-ended body carries no office or chart details', !JSON.stringify(dataAfter.json ?? {}).includes(officeId) && !JSON.stringify(dataAfter.json ?? {}).includes('QA Offboarding'), brief(dataAfter.json));

  console.log('\n4. Accounts filters');
  const accountsMid = await accountsByFilter(hq);
  check('Accounts row carries status=offboarding while in progress', accountsMid.mine?.status === 'offboarding' && accountsMid.mine?.offboarding?.status === 'offboarding', brief(accountsMid.mine));

  console.log('\n5. Step 2 — bundle');
  const bundle = await post(hq, `${OFFBOARDING}/bundle`, { includeTombstones: true });
  check('bundle request accepted (202) with a job id', bundle.status === 202 && typeof bundle.json?.bundle?.id === 'string', `${bundle.status} ${brief(bundle.json)}`);
  const bundleReady = await poll('the office bundle to build', 120_000, 2_000, async () => {
    const s = await state(hq);
    const job = s.bundle;
    if (job?.status === 'ready' || job?.status === 'failed') return s;
    return null;
  });
  check('bundle export job reaches ready', bundleReady?.bundle?.status === 'ready', brief(bundleReady?.bundle));
  const download = await api(hq, `${OFFBOARDING}/bundle/download-url?part=1`);
  check('bundle download url is issued for part 1', download.status === 200 && typeof download.json?.url === 'string', `${download.status} ${brief(download.json)}`);

  console.log('\n6. Step 3 — hand-over (destroy after hand-back)');
  const handover = await post(hq, `${OFFBOARDING}/handover`, {
    receivedBy: 'QA Records Custodian', receivedOn: new Date().toISOString().slice(0, 10), choice: 'destroy',
    letterReference: `QA-LETTER-${stamp}`, note: 'Live harness hand-over.',
  });
  check('hand-over recorded (200/201)', (handover.status === 200 || handover.status === 201) && handover.json?.handover?.choice === 'destroy', `${handover.status} ${brief(handover.json)}`);

  console.log('\n7. Step 4 — seal (charts closed, logins destroyed)');
  const seal = await post(hq, `${OFFBOARDING}/seal`);
  check('seal accepted (202) and scheduled the destroy date', seal.status === 202 && typeof seal.json?.seal?.retainUntil === 'string', `${seal.status} ${brief(seal.json)}`);
  const sealed = await poll('the seal job to close the chart', 150_000, 3_000, async () => {
    const s = await state(hq);
    return s.seal?.completedAt ? s : null;
  });
  check('seal completes: 1 chart total, 1 sealed, 0 held', sealed?.seal?.progress?.total === 1 && sealed?.seal?.progress?.sealed === 1 && (sealed?.seal?.progress?.held ?? 0) === 0, brief(sealed?.seal));
  const closedRow = await svc('GET', `/rest/v1/patients?id=eq.${patientId}&select=id,auth_user_id,archived_at,record_retain_until`);
  check('sealed chart keeps its row but drops the login link', closedRow.json?.[0] && closedRow.json[0].auth_user_id === null && typeof closedRow.json[0].record_retain_until === 'string', brief(closedRow.json));
  const whoSealed = await api(patient, '/claim/whoami');
  check('patient token no longer answers 200 after the seal', whoSealed.status !== 200, `${whoSealed.status} ${brief(whoSealed.json)}`);
  const retry = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON_KEY!, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: patientEmail, password }),
  });
  check('patient login itself is destroyed (password sign-in refused)', retry.status >= 400, `${retry.status}`);
  patient = '';

  console.log('\n8. Step 5 — complete');
  const complete = await post(hq, `${OFFBOARDING}/complete`);
  check('complete → offboarded', (complete.status === 200 || complete.status === 201) && complete.json?.status === 'offboarded', `${complete.status} ${brief(complete.json)}`);
  const providerRow = await svc('GET', `/rest/v1/providers?provider_id=eq.${enc(officeId)}&select=offboarding_status,access_disabled,offboarded_at`);
  check('providers row is offboarded + access_disabled', providerRow.json?.[0]?.offboarding_status === 'offboarded' && providerRow.json?.[0]?.access_disabled === true, brief(providerRow.json));
  const accountsDone = await accountsByFilter(hq);
  const defaultFilter = accountsDone.all.filter((a) => a.status !== 'offboarded');
  const offboardedFilter = accountsDone.all.filter((a) => a.status === 'offboarded');
  check('offboarded office is absent from the Accounts default filter', !defaultFilter.some((a) => a.providerId === officeId));
  check('offboarded office is present under the Offboarded filter', offboardedFilter.some((a) => a.providerId === officeId));
  const ownerDone = await api(ownerFresh, '/office/roster');
  check('owner stays locked out after completion', ownerDone.status === 403 || ownerDone.status === 401 || ownerDone.status === 404, `${ownerDone.status}`);
  const loginDone = await post(hq, '/auth/login/start', { realm: 'staff', identifier: ownerEmail });
  const sendsDone = await svc('GET', `/rest/v1/claim_verifications?identifier=eq.${enc(ownerEmail)}&select=id`);
  check('staff code request stays neutral with no send after completion', loginDone.status === 200 && loginDone.json?.message === NEUTRAL_LOGIN_MESSAGE && sendsDone.json?.length === 0, `${loginDone.status} ${brief(sendsDone.json)}`);

  console.log('\n9. Certificate (before and after the purge)');
  const certEarly = await api(hq, `${OFFBOARDING}/certificate.csv`);
  check('certificate downloads as CSV', certEarly.status === 200 && (certEarly.headers.get('content-type') ?? '').includes('text/csv'), `${certEarly.status} ${certEarly.headers.get('content-type')}`);
  check('certificate carries the office summary and the tombstone header', certEarly.text.includes(`summary,office_id,${officeId}`) && certEarly.text.includes('tombstone_id,requested_at,purged_at,was_activated,program_id,enrolled_on'), certEarly.text.slice(0, 200));
  check('before the purge the chart is awaiting destruction', /summary,charts_awaiting_destruction,1\b/.test(certEarly.text) && !certEarly.text.includes(patientId), '');
  // The destroy date is 30 days out; pull it into the past so the privacy
  // worker's next drain purges the sealed chart.
  const past = new Date(Date.now() - 60_000).toISOString();
  const request = await svc('PATCH', `/rest/v1/patient_deletion_requests?patient_id=eq.${patientId}&status=eq.closed`, { retain_until: past });
  check('closed deletion request found and its destroy date backdated', request.status === 200 && Array.isArray(request.json) && request.json.length === 1, `${request.status} ${brief(request.json)}`);
  await svc('PATCH', `/rest/v1/patients?id=eq.${patientId}`, { record_retain_until: past });
  const certFinal = await poll('the purge to leave a tombstone', 120_000, 5_000, async () => {
    const cert = await api(hq, `${OFFBOARDING}/certificate.csv`);
    return cert.status === 200 && cert.text.includes(patientId) ? cert : null;
  });
  check('after the purge the certificate lists the tombstone (former patient id)', certFinal !== null, '');
  if (certFinal) {
    const line = certFinal.text.split('\n').find((l) => l.startsWith(patientId)) ?? '';
    const cells = line.split(',');
    check('tombstone row: purged_at set, was_activated true', cells.length >= 4 && /^\d{4}-/.test(cells[2] ?? '') && cells[3] === 'true', line);
    check('certificate summary now counts 1 destroyed, 0 awaiting', /summary,charts_destroyed,1\b/.test(certFinal.text) && /summary,charts_awaiting_destruction,0\b/.test(certFinal.text), certFinal.text.split('\n').filter((l) => l.includes('charts_')).join(' | '));
    check('certificate holds no patient name or email', !certFinal.text.includes('QA Offboarding Patient') && !certFinal.text.includes(patientEmail), '');
  }
  const purgedRow = await svc('GET', `/rest/v1/patients?id=eq.${patientId}&select=id`);
  check('patient row is gone after the purge', purgedRow.status === 200 && purgedRow.json?.length === 0, brief(purgedRow.json));
  const audit = await svc('GET', `/rest/v1/admin_audit_events?provider_id=eq.${enc(officeId)}&select=action&order=occurred_at.asc`);
  const actions: string[] = Array.isArray(audit.json) ? audit.json.map((r: any) => r.action) : [];
  check('every step and the certificate download are audited', ['office_offboarding_started', 'office_offboarding_bundle_requested', 'office_offboarding_handover_recorded', 'office_offboarding_seal_started', 'office_offboarding_completed', 'office_destruction_certificate_downloaded'].every((a) => actions.includes(a)), actions.join(','));
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
    console.log('\nAll office offboarding live checks passed.');
  });
