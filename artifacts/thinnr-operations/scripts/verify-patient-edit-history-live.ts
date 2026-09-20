/**
 * Live patient edit history: a real staff weight correction shows its prior
 * value on the History tab, end to end, against the shared dev Supabase
 * project and the running api-server (STAFF_API_BASE, default the preview
 * proxy at http://localhost:80).
 *
 * The history ledger is proven with a throwaway PostgreSQL cluster (SQL),
 * route fakes (API) and a scripted fetch (UI) elsewhere. This harness drives
 * the real chain once with disposable fixtures:
 *
 *   signed-in office owner → weight recorded, corrected twice, a second
 *   weigh-in removed, a medication added and stopped → record_admin_audit_event
 *   → record_patient_edit_history → office_patient_edit_history (owner read,
 *   family filter, HQ read with ?office=) → the staff record export ZIP and
 *   the patient's own export both carry edit-history.json with those rows.
 *
 * Fixtures: a throwaway HQ admin, an office with its owner login
 * (providers.auth_user_id) and one claimed patient — all real GoTrue users.
 * The owner's fresh-code proof for the export gate is written straight onto
 * the session's auth_sign_ins ledger row, exactly as the re-auth sheet would.
 *
 * Modes:
 *   (default)   create → exercise → assert → clean up in `finally`
 *   --keep      same, but leave the fixtures in place for a browser session
 *               and write their ids to tmp/patient-edit-history-live.json.
 *               A browser signs in with the emailed code (API restarted with
 *               CLAIM_EMAIL_DELIVERY_MODE=dev + CLAIM_SMS_DELIVERY_MODE=dev so
 *               both codes show inline) and enrols one of BROWSER_PHONES as
 *               the second factor; cleanup removes those rows too.
 *   --cleanup   remove the fixtures a previous --keep run left behind
 *
 * Cleanup removes ledgers through the management API (append-only tables,
 * triggers off, one transaction) and entities through PostgREST with foreign
 * keys enforced, so a table this harness forgot fails loudly.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const MANAGEMENT_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const API_BASE = (process.env.STAFF_API_BASE ?? 'http://localhost:80').replace(/\/$/, '');
const KEEP = process.argv.includes('--keep');
const CLEANUP_ONLY = process.argv.includes('--cleanup');
const STATE_FILE = path.resolve(process.cwd(), 'tmp/patient-edit-history-live.json');

if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY || !MANAGEMENT_TOKEN) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY / SUPABASE_ACCESS_TOKEN in the environment.');
  process.exit(1);
}

const BASE = SUPABASE_URL.replace(/\/$/, '');
const PROJECT_REF = new URL(BASE).hostname.split('.')[0];
const SVC_HEADERS: Record<string, string> = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
const CONSENT_POLICY_VERSION = '2026-09-01';

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
const dayKey = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

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

async function api(token: string | null, path: string, init: RequestInit = {}): Promise<{ status: number; json: any; text: string }> {
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
  return { status: response.status, json, text };
}
const send = (token: string, method: string, path: string, body: unknown) => api(token, path, { method, body: JSON.stringify(body) });

async function createUser(email: string, password: string, appMetadata: Record<string, string>): Promise<string> {
  const created = await svc('POST', '/auth/v1/admin/users', { email, password, email_confirm: true, app_metadata: appMetadata });
  const id = created.json?.id;
  if (typeof id !== 'string') throw new Error(`could not create auth user ${email}: ${brief(created.json)}`);
  return id;
}

/** Fresh-code proof for a staff session: the ledger row the re-auth sheet stamps. */
async function stampFreshCode(userId: string, token: string, fingerprint: string) {
  const ledger = await svc('POST', '/rest/v1/auth_sign_ins', {
    user_id: userId, realm: 'staff', method: 'email_code', platform: 'web',
    device_fingerprint: fingerprint.slice(0, 64), session_id: sessionIdOf(token),
    code_verified_at: new Date().toISOString(),
  });
  if (ledger.status !== 201) throw new Error(`fresh-code ledger row failed (${ledger.status}): ${brief(ledger.json)}`);
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

// ------------------------------------------------------------- zip reading
/** Entries of a small ZIP (central directory walk; deflate or stored). */
function zipEntries(buffer: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 70_000); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory record)');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error(`corrupt local header for ${name}`);
    const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(dataStart, dataStart + compressed);
    out.set(name, method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

async function downloadZip(url: string): Promise<Map<string, Buffer>> {
  const response = await fetch(url);
  if (response.status !== 200) throw new Error(`archive download failed (${response.status})`);
  return zipEntries(Buffer.from(await response.arrayBuffer()));
}

function editHistoryRows(entries: Map<string, Buffer>): any[] | null {
  const name = [...entries.keys()].find((key) => key === 'edit-history.json' || key.endsWith('/edit-history.json'));
  if (!name) return null;
  const parsed = JSON.parse(entries.get(name)!.toString('utf8'));
  return Array.isArray(parsed) ? parsed : null;
}

// ---------------------------------------------------------------- fixtures
interface Fixture {
  stamp: number;
  password: string;
  hqEmail: string;
  ownerEmail: string;
  patientEmail: string;
  officeId: string;
  patientId: string;
  hqUserId: string | null;
  ownerUserId: string | null;
  patientUserId: string | null;
}

const OWNER_NAME = 'Dr. QA Historian';
/** Fake phones a browser session enrols as the staff second factor under CLAIM_SMS_DELIVERY_MODE=dev (owner, HQ). */
const BROWSER_PHONES = ['+15550100201', '+15550100202'];
const HQ_NAME = 'QA History HQ';

function newFixture(): Fixture {
  const stamp = Date.now();
  return {
    stamp,
    password: `Qa-${stamp}!hist`,
    hqEmail: `qa-history-hq-${stamp}@thinnr-qa.example.com`,
    ownerEmail: `qa-history-owner-${stamp}@thinnr-qa.example.com`,
    patientEmail: `qa-history-patient-${stamp}@thinnr-qa.example.com`,
    officeId: `qa-history-${stamp}`,
    patientId: crypto.randomUUID(),
    hqUserId: null,
    ownerUserId: null,
    patientUserId: null,
  };
}

async function createFixtures(f: Fixture): Promise<{ hq: string; owner: string; patient: string }> {
  await svc('POST', '/rest/v1/staff_role_assignments', { email: f.hqEmail, role: 'hq_admin' });
  f.hqUserId = await createUser(f.hqEmail, f.password, { thinnr_provisioned: 'true' });
  const membership = await svc('POST', '/rest/v1/hq_memberships', {
    email: f.hqEmail, auth_user_id: f.hqUserId, status: 'active', department_role: 'admin',
    display_name: HQ_NAME, activated_at: new Date().toISOString(),
  });
  if (membership.status !== 201) throw new Error(`HQ membership failed (${membership.status}): ${brief(membership.json)}`);

  f.ownerUserId = await createUser(f.ownerEmail, f.password, { thinnr_provisioned: 'true' });
  f.patientUserId = await createUser(f.patientEmail, f.password, { thinnr_claim: 'true' });
  const office = await svc('POST', '/rest/v1/providers', {
    provider_id: f.officeId, office_name: 'QA History Office', provider_name: OWNER_NAME,
    email: f.ownerEmail, auth_user_id: f.ownerUserId, access_disabled: false, created_at: new Date().toISOString(),
  });
  if (office.status !== 201) throw new Error(`office insert failed (${office.status}): ${brief(office.json)}`);
  const patient = await svc('POST', '/rest/v1/patients', {
    id: f.patientId, provider_id: f.officeId, name: 'QA History Patient', email: f.patientEmail,
    activation_status: 'activated', auth_user_id: f.patientUserId, claimed_at: new Date().toISOString(),
    created_at: new Date().toISOString(), starting_weight: 205, current_weight: 205,
  });
  if (patient.status !== 201) throw new Error(`patient insert failed (${patient.status}): ${brief(patient.json)}`);

  const hq = await signIn(f.hqEmail, f.password);
  const owner = await signIn(f.ownerEmail, f.password);
  await stampFreshCode(f.ownerUserId, owner, `qa-history-owner-${f.stamp}`);
  return { hq, owner, patient: await signIn(f.patientEmail, f.password) };
}

async function cleanup(f: Fixture) {
  console.log('\nCleanup');
  const users = [f.hqUserId, f.ownerUserId, f.patientUserId].filter((v): v is string => Boolean(v));
  const userList = users.map(lit).join(',');
  // Append-only ledgers and trigger-guarded rows first: management API, one
  // transaction, triggers off. Only rows tied to THIS run are named.
  try {
    await managementQuery(`
begin;
set local session_replication_role = replica;
delete from public.patient_edit_history where patient_id = ${lit(f.patientId)};
delete from public.admin_audit_events where provider_id = ${lit(f.officeId)}${users.length ? ` or actor_user_id in (${userList})` : ''} or target_id = ${lit(f.patientId)};
delete from public.patient_staff_weights where patient_id = ${lit(f.patientId)};
delete from public.patient_medication_dose_logs where patient_id = ${lit(f.patientId)};
delete from public.patient_medications where patient_id = ${lit(f.patientId)};
delete from public.patient_consents where patient_id = ${lit(f.patientId)};
delete from public.patient_data_exports where patient_id = ${lit(f.patientId)};
delete from public.data_exports where provider_id = ${lit(f.officeId)}${users.length ? ` or requested_by in (${userList})` : ''};
delete from public.patient_tombstones where provider_id = ${lit(f.officeId)} or id = ${lit(f.patientId)};
delete from public.auth_sign_ins where ${users.length ? `user_id in (${userList})` : 'false'};
delete from public.staff_second_factors where staff_ref = ${lit(f.officeId)} or staff_ref in (select id::text from public.hq_memberships where email = ${lit(f.hqEmail)});
delete from public.claim_verifications where identifier in (${[f.hqEmail, f.ownerEmail, f.patientEmail, ...BROWSER_PHONES].map(lit).join(',')});
commit;`);
    console.log('  ok  ledgers cleared');
  } catch (error) {
    console.error(`  !!  ledger cleanup failed: ${(error as Error).message}`);
  }
  const steps: Array<[string, string]> = [
    ['patients', `/rest/v1/patients?id=eq.${f.patientId}`],
    ['team_members', `/rest/v1/team_members?provider_id=eq.${enc(f.officeId)}`],
    ['training_viewers', `/rest/v1/training_viewers?auth_user_id=in.(${users.join(',')})`],
    ['profiles', `/rest/v1/profiles?id=in.(${users.join(',')})`],
    ['providers', `/rest/v1/providers?provider_id=eq.${enc(f.officeId)}`],
    ['hq_memberships', `/rest/v1/hq_memberships?email=eq.${enc(f.hqEmail)}`],
    ['staff_role_assignments', `/rest/v1/staff_role_assignments?email=in.(${[f.hqEmail, f.ownerEmail].map(enc).join(',')})`],
  ];
  for (const [label, path] of steps) {
    const res = await svc('DELETE', path, undefined, 'return=minimal');
    // 404 = the table is not exposed under this name; the auth-user delete
    // below cascades whatever hangs off auth.users.
    if (res.status >= 300 && res.status !== 404) console.error(`  !!  ${label} cleanup failed (${res.status}): ${brief(res.json)}`);
  }
  for (const userId of users) {
    const res = await svc('DELETE', `/auth/v1/admin/users/${userId}`);
    if (res.status >= 300 && res.status !== 404) console.error(`  !!  auth user ${userId} cleanup failed (${res.status}): ${brief(res.json)}`);
  }
  const left = await svc('GET', `/rest/v1/patients?id=eq.${f.patientId}&select=id`);
  const officeLeft = await svc('GET', `/rest/v1/providers?provider_id=eq.${enc(f.officeId)}&select=provider_id`);
  if (left.json?.length || officeLeft.json?.length) console.error('  !!  fixture rows still present after cleanup');
  else console.log('  ok  fixtures removed');
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
}

// ------------------------------------------------------------------ checks
const num = (value: unknown) => (typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN);
const fieldOf = (change: any, field: string) => (change?.fields ?? []).find((f: any) => f.field === field) ?? null;

async function main(f: Fixture) {
  const tokens = await createFixtures(f);
  const { hq, owner, patient } = tokens;
  const PATIENT = `/office/patients/${f.patientId}`;

  console.log('\n1. Owner records a weight and corrects it twice');
  const first = await send(owner, 'POST', `${PATIENT}/weights`, { dateKey: dayKey(3), weight: 201.4, note: 'Clinic scale' });
  check('weigh-in recorded (201)', first.status === 201 && typeof first.json?.weight?.id === 'string', `${first.status} ${brief(first.json)}`);
  const weightId: string = first.json?.weight?.id;
  const v1 = first.json?.weight?.version ?? null;
  const second = await send(owner, 'PATCH', `${PATIENT}/weights/${weightId}`, { weight: 199.8, expectedVersion: v1 });
  check('first correction lands (200)', second.status === 200 && num(second.json?.weight?.weight) === 199.8, `${second.status} ${brief(second.json)}`);
  const third = await send(owner, 'PATCH', `${PATIENT}/weights/${weightId}`, { weight: 198.6, expectedVersion: second.json?.weight?.version ?? null });
  check('second correction lands (200)', third.status === 200 && num(third.json?.weight?.weight) === 198.6, `${third.status} ${brief(third.json)}`);
  const stale = await send(owner, 'PATCH', `${PATIENT}/weights/${weightId}`, { weight: 150, expectedVersion: v1 });
  check('a stale correction is refused (409 record_changed) and writes no history', stale.status === 409 && stale.json?.code === 'record_changed', `${stale.status} ${brief(stale.json)}`);

  console.log('\n2. A second weigh-in is removed; a medication is added and stopped');
  const extra = await send(owner, 'POST', `${PATIENT}/weights`, { dateKey: dayKey(2), weight: 197.2, note: 'Wrong patient' });
  check('second weigh-in recorded (201)', extra.status === 201, `${extra.status} ${brief(extra.json)}`);
  const extraId: string = extra.json?.weight?.id;
  const removed = await send(owner, 'DELETE', `${PATIENT}/weights/${extraId}`, { expectedVersion: extra.json?.weight?.version ?? null });
  check('second weigh-in removed (200)', removed.status === 200 && removed.json?.deleted === true, `${removed.status} ${brief(removed.json)}`);
  // The route mints the medication id itself; the response carries it.
  const added = await send(owner, 'POST', `${PATIENT}/medications`, {
    medication: { name: 'QA Semaglutide', form: 'injection', dose: '0.25 mg', scheduleKind: 'weekly', weekday: 1, times: ['08:00'], notes: null, startDate: dayKey(10), stopDate: null },
  });
  check('medication added (201)', added.status === 201 && typeof added.json?.medication?.id === 'string', `${added.status} ${brief(added.json)}`);
  const medicationId: string = added.json?.medication?.id;
  const stopped = await send(owner, 'PATCH', `${PATIENT}/medications/${medicationId}`, { expectedVersion: added.json?.medication?.version ?? null, stopDate: dayKey(0) });
  check('medication stopped (200)', stopped.status === 200 && stopped.json?.medication?.stopDate === dayKey(0), `${stopped.status} ${brief(stopped.json)}`);

  console.log('\n3. History read by the owner (All)');
  const all = await api(owner, `${PATIENT}/history`);
  check('history answers 200 with a page', all.status === 200 && Array.isArray(all.json?.changes), `${all.status} ${brief(all.json)}`);
  const changes: any[] = all.json?.changes ?? [];
  check('seven changes recorded (weight create, 2 corrections, extra create + removal, medication create + stop)', all.json?.total === 7 && changes.length === 7, `total=${all.json?.total} changes=${changes.length} kinds=${changes.map((c) => `${c.family}:${c.changeKind}`).join(',')}`);
  const corrections = changes.filter((c) => c.family === 'weight' && c.recordId === weightId && c.changeKind === 'update');
  const priorWeights = corrections.map((c) => num(fieldOf(c, 'weight')?.old)).sort((a, b) => a - b);
  check('both prior weights are on the ledger (199.8 and 201.4)', priorWeights.length === 2 && priorWeights[0] === 199.8 && priorWeights[1] === 201.4, brief(corrections));
  check('corrections read newest first: 199.8 → 198.6 above 201.4 → 199.8', corrections.length === 2 && num(fieldOf(corrections[0], 'weight')?.old) === 199.8 && num(fieldOf(corrections[0], 'weight')?.new) === 198.6 && num(fieldOf(corrections[1], 'weight')?.new) === 199.8, brief(corrections.map((c) => c.fields)));
  check('every staff change carries the owner display name and actor kind provider', changes.every((c) => c.actorKind === 'provider' && c.actorName === OWNER_NAME), brief(changes.map((c) => [c.actorKind, c.actorName])));
  check('every change is paired with a numeric audit event id', changes.every((c) => Number.isInteger(c.auditEventId) && c.auditEventId > 0), brief(changes.map((c) => c.auditEventId)));
  const removal = changes.find((c) => c.family === 'weight' && c.recordId === extraId && c.changeKind === 'delete');
  check('the removed weigh-in keeps its values (197.2, note, date)', num(fieldOf(removal, 'weight')?.old) === 197.2 && fieldOf(removal, 'weight')?.new === null && fieldOf(removal, 'note')?.old === 'Wrong patient' && fieldOf(removal, 'dateKey')?.old === dayKey(2), brief(removal));
  const medicationStop = changes.find((c) => c.family === 'medication' && c.changeKind === 'update');
  const medicationCreate = changes.find((c) => c.family === 'medication' && c.changeKind === 'create');
  check('medication stop records stopDate empty → today', fieldOf(medicationStop, 'stopDate')?.old === null && fieldOf(medicationStop, 'stopDate')?.new === dayKey(0) && medicationStop?.fields?.length === 1, brief(medicationStop));
  check('medication add records name, form, dose and schedule as new values', fieldOf(medicationCreate, 'name')?.new === 'QA Semaglutide' && fieldOf(medicationCreate, 'dose')?.new === '0.25 mg' && fieldOf(medicationCreate, 'form')?.new === 'injection', brief(medicationCreate));

  console.log('\n4. Family filter, paging and HQ drill-in');
  const weights = await api(owner, `${PATIENT}/history?family=weight`);
  check('Weigh-ins filter returns the five weight changes only', weights.status === 200 && weights.json?.total === 5 && (weights.json?.changes ?? []).every((c: any) => c.family === 'weight'), `${weights.status} ${brief(weights.json)}`);
  const medications = await api(owner, `${PATIENT}/history?family=medication`);
  check('Medications filter returns the two medication changes only', medications.status === 200 && medications.json?.total === 2 && (medications.json?.changes ?? []).every((c: any) => c.family === 'medication'), `${medications.status} ${brief(medications.json)}`);
  const paged = await api(owner, `${PATIENT}/history?limit=3`);
  check('limit=3 pages with nextOffset=3 and the full total', paged.status === 200 && paged.json?.changes?.length === 3 && paged.json?.nextOffset === 3 && paged.json?.total === 7, `${paged.status} ${brief(paged.json)}`);
  const hqRead = await api(hq, `${PATIENT}/history?office=${enc(f.officeId)}`);
  check('HQ reads the same seven changes with ?office=', hqRead.status === 200 && hqRead.json?.total === 7 && hqRead.json?.changes?.[0]?.changeId === changes[0]?.changeId, `${hqRead.status} ${brief(hqRead.json)}`);
  const hqBare = await api(hq, `${PATIENT}/history`);
  check('HQ without ?office= is refused', hqBare.status >= 400 && hqBare.status < 500, `${hqBare.status} ${brief(hqBare.json)}`);
  const patientRead = await api(patient, `${PATIENT}/history`);
  check('a patient token cannot read the office history', patientRead.status === 401 || patientRead.status === 403, `${patientRead.status}`);

  console.log('\n5. Audit pairing (ids only, never values)');
  const auditIds = changes.map((c) => c.auditEventId).filter((id) => Number.isInteger(id));
  const audit = await svc('GET', `/rest/v1/admin_audit_events?id=in.(${auditIds.join(',')})&select=id,action,provider_id,target_id,metadata`);
  const auditRows: any[] = Array.isArray(audit.json) ? audit.json : [];
  check('every paired audit row exists for this office and patient', auditRows.length === auditIds.length && auditRows.every((r) => r.provider_id === f.officeId && r.target_id === f.patientId), `${audit.status} ${brief(auditRows)}`);
  const auditText = JSON.stringify(auditRows);
  check('audit metadata never carries the weights, the medication name or the dose', !auditText.includes('201.4') && !auditText.includes('199.8') && !auditText.includes('QA Semaglutide') && !auditText.includes('0.25 mg'), auditText.slice(0, 300));
  check('audit actions name the correction and the stop', auditRows.some((r) => /weight.*(correct|updat)/i.test(r.action)) && auditRows.some((r) => /medication_stopped/.test(r.action)), auditRows.map((r) => r.action).join(','));

  console.log('\n6. Staff record export carries edit-history.json');
  const requested = await send(owner, 'POST', '/exports', { kind: 'patient_record', patientId: f.patientId });
  check('owner requests the patient record export (202)', requested.status === 202 && typeof requested.json?.job?.id === 'string', `${requested.status} ${brief(requested.json)}`);
  const jobId: string | undefined = requested.json?.job?.id;
  const readyJob = jobId ? await poll('the staff record export to build', 120_000, 2_000, async () => {
    const res = await api(owner, `/exports/${jobId}`);
    const job = res.json?.job;
    return job?.status === 'ready' || job?.status === 'failed' || job?.status === 'expired' ? job : null;
  }) : null;
  check('staff export reaches ready', readyJob?.status === 'ready', brief(readyJob));
  if (readyJob?.status === 'ready') {
    const link = await api(owner, `/exports/${jobId}/download-url?part=1`);
    check('download url issued for part 1', link.status === 200 && typeof link.json?.url === 'string', `${link.status} ${brief(link.json)}`);
    if (typeof link.json?.url === 'string') {
      const rows = editHistoryRows(await downloadZip(link.json.url));
      check('staff ZIP contains edit-history.json', Array.isArray(rows), '');
      const weightRows = (rows ?? []).filter((r) => r.family === 'weight' && r.field === 'weight' && r.change_kind === 'update');
      const olds = weightRows.map((r) => num(r.old_value)).sort((a, b) => a - b);
      check('staff edit-history.json lists both prior weights with the owner name', olds.length === 2 && olds[0] === 199.8 && olds[1] === 201.4 && weightRows.every((r) => r.actor_name === OWNER_NAME), brief(weightRows));
      check('staff edit-history.json lists the medication stop and the removed weigh-in', (rows ?? []).some((r) => r.family === 'medication' && r.field === 'stopDate' && r.new_value === dayKey(0)) && (rows ?? []).some((r) => r.change_kind === 'delete' && r.field === 'weight' && num(r.old_value) === 197.2), brief((rows ?? []).map((r) => [r.family, r.field, r.change_kind])));
    }
  }

  console.log('\n7. Patient self-export carries the same rows');
  const consent = await send(patient, 'PUT', '/patient-data/consent', { policyVersion: CONSENT_POLICY_VERSION, terms: true, privacy: true, healthData: true, photoAnalysis: false, platform: 'web' });
  check('patient accepts the current consent (200)', consent.status === 200, `${consent.status} ${brief(consent.json)}`);
  const selfRequested = await send(patient, 'POST', '/patient-data/export', {});
  check('patient requests their export (202)', selfRequested.status === 202 && typeof selfRequested.json?.export?.id === 'string', `${selfRequested.status} ${brief(selfRequested.json)}`);
  const selfReady = await poll('the patient export to build', 120_000, 2_000, async () => {
    const res = await api(patient, '/patient-data/export');
    const job = res.json?.export;
    return job?.status === 'ready' || job?.status === 'failed' ? job : null;
  });
  check('patient export reaches ready', selfReady?.status === 'ready', brief(selfReady));
  if (selfReady?.status === 'ready') {
    const link = await api(patient, `/patient-data/export/${selfReady.id}/download-url`);
    check('patient download url issued', link.status === 200 && typeof link.json?.url === 'string', `${link.status} ${brief(link.json)}`);
    if (typeof link.json?.url === 'string') {
      const rows = editHistoryRows(await downloadZip(link.json.url));
      check('patient ZIP contains edit-history.json', Array.isArray(rows), '');
      const olds = (rows ?? []).filter((r) => r.family === 'weight' && r.field === 'weight' && r.change_kind === 'update').map((r) => num(r.old_value)).sort((a, b) => a - b);
      check('patient edit-history.json lists both prior weights', olds.length === 2 && olds[0] === 199.8 && olds[1] === 201.4, brief(olds));
      check('patient edit-history.json lists the medication stop', (rows ?? []).some((r) => r.family === 'medication' && r.field === 'stopDate' && r.new_value === dayKey(0)), '');
      check('patient edit-history.json names the staff member who made the change', (rows ?? []).some((r) => r.actor_name === OWNER_NAME), '');
    }
  }
}

async function run() {
  if (CLEANUP_ONLY) {
    if (!fs.existsSync(STATE_FILE)) {
      console.error(`No kept fixtures at ${STATE_FILE}.`);
      process.exit(1);
    }
    await cleanup(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Fixture);
    return;
  }
  const fixture = newFixture();
  try {
    await main(fixture);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  harness error — ${(error as Error).stack ?? error}`);
  } finally {
    if (KEEP) {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(fixture, null, 2));
      console.log(`\nFixtures kept (remove with --cleanup):\n  office ${fixture.officeId}\n  patient ${fixture.patientId}\n  owner ${fixture.ownerEmail}\n  hq ${fixture.hqEmail}\n  state ${STATE_FILE}`);
    } else {
      await cleanup(fixture);
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll patient edit history live checks passed.');
}

void run();
