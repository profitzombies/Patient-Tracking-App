/**
 * Live proof of the whole-office record bundle against the real Supabase
 * project, the real object storage bucket, and the running dev api-server.
 *
 * Fixtures: a throwaway HQ admin (with the fresh-code ledger stamp the export
 * routes demand), a QA office, four patients in creation order (check-ins, a
 * staff weight, one progress photo written to object storage), and one
 * purged-patient tombstone. Everything is removed at the end; leftovers from
 * an aborted earlier run are swept first.
 *
 * Phase A — build + download through the real routes:
 *   POST /api/exports {kind: office_bundle, includeTombstones} → the server's
 *   own job (signalled by the request; nudged with the HQ run-now route when
 *   the shared dev database has other work queued ahead) packs it → poll
 *   /api/exports/:id to ready → download every ?part=N through the signed
 *   URL route → unzip → every manifest.json file entry present in its named
 *   part with the listed size and SHA-256, office/*.csv + tombstones.csv +
 *   README.txt present, per-part checksums, sidecars gone, audit trail.
 *
 * Phase B — restart-resume, live:
 *   Four tiny patients pack in well under a second, so a wall-clock process
 *   kill mid-bundle is not timeable. The post-crash state is produced with
 *   the REAL builder instead: the harness takes the job's lease (so the
 *   server cannot touch the request), runs runOfficeBundleStep in-process
 *   with a clock that runs out right after the first part lands, and leaves
 *   the row exactly as a crashed or budget-exhausted process would (status
 *   running, part 1 + sidecar written, cursor after patient 1). It then
 *   releases the lease and asks the server — a different process with a
 *   different job owner — to run the job now. The server must resume from the
 *   cursor: part 1 untouched (same object, same checksum), the remaining
 *   patients and the office files in new parts, and the finished bundle
 *   downloads and verifies like Phase A.
 *
 * Requires the api-server workflow (STAFF_API_BASE, default http://localhost:80).
 * Run: pnpm --filter @workspace/thinnr-operations run test:office-bundle-live
 */
import crypto from 'node:crypto';
import JSZip from 'jszip';
import { OFFICE_BUNDLE_KIND, runOfficeBundleStep } from '../../api-server/src/exports/office-bundle';
import { supabaseJobStore } from '../../api-server/src/jobs/store';
import { objectStorage } from '../../api-server/src/lib/objectStorage';

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
const SVC_HEADERS: Record<string, string> = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
const JOB_NAME = 'office-bundle-export';
const QA_PREFIX = 'qa-office-bundle-';
const QA_DOMAIN = '@thinnr-qa.example.com';
const BUILD_TIMEOUT_MS = 240_000;
const OFFICE_CSVS = [
  'office/orders.csv', 'office/payments.csv', 'office/refunds.csv', 'office/shipments.csv',
  'office/subscriptions.csv', 'office/staff-team.csv', 'office/audit-events.csv', 'office/patient-activity.csv',
];

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
const sha256 = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');
const lit = (value: string) => `'${value.replace(/'/g, "''")}'`;

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

async function createUser(email: string, password: string, appMetadata: Record<string, string>): Promise<string> {
  const created = await svc('POST', '/auth/v1/admin/users', { email, password, email_confirm: true, app_metadata: appMetadata });
  const id = created.json?.id;
  if (typeof id !== 'string') throw new Error(`could not create auth user ${email}: ${brief(created.json)}`);
  return id;
}

async function insert(table: string, body: unknown): Promise<any> {
  const res = await svc('POST', `/rest/v1/${table}`, body);
  if (res.status !== 201) throw new Error(`${table} insert failed (${res.status}): ${brief(res.json)}`);
  return res.json;
}

// ---------------------------------------------------------------- fixtures
const stamp = Date.now();
const password = `Qa-${stamp}!bundle`;
const hqEmail = `${QA_PREFIX}hq-${stamp}${QA_DOMAIN}`;
const ownerEmail = `${QA_PREFIX}owner-${stamp}${QA_DOMAIN}`;
const officeId = `${QA_PREFIX}${stamp}`;
const officeName = 'QA Bundle Office';
const patientIds = [0, 1, 2, 3].map(() => crypto.randomUUID());
const tombstoneId = crypto.randomUUID();
const photoObjectPath = `/objects/patient-media/${patientIds[0]}/progress-${crypto.randomUUID()}`;
const photoBytes = crypto.randomBytes(1_536);
const ids: { hqUserId: string | null; ownerUserId: string | null } = { hqUserId: null, ownerUserId: null };
const exportIds: string[] = [];

async function createFixtures(): Promise<string> {
  await svc('POST', '/rest/v1/staff_role_assignments', { email: hqEmail, role: 'hq_admin' });
  ids.hqUserId = await createUser(hqEmail, password, { thinnr_provisioned: 'true' });
  await insert('hq_memberships', {
    email: hqEmail, auth_user_id: ids.hqUserId, status: 'active', department_role: 'admin',
    display_name: 'QA Bundle HQ', activated_at: new Date().toISOString(),
  });
  ids.ownerUserId = await createUser(ownerEmail, password, { thinnr_provisioned: 'true' });
  await insert('providers', {
    provider_id: officeId, office_name: officeName, provider_name: 'QA Bundle Provider',
    email: ownerEmail, auth_user_id: ids.ownerUserId, access_disabled: false, created_at: new Date().toISOString(),
  });
  // Creation order is the bundle's pack order: stagger created_at so the
  // cursor semantics in Phase B are unambiguous.
  const base = Date.now() - 60 * 60_000;
  await insert('patients', patientIds.map((id, index) => ({
    id, provider_id: officeId, name: `QA Bundle Patient ${index + 1}`, email: `${QA_PREFIX}patient-${index + 1}-${stamp}${QA_DOMAIN}`,
    activation_status: index === 3 ? 'invited' : 'activated', created_at: new Date(base + index * 60_000).toISOString(),
    starting_weight: 210 + index, current_weight: 200 + index,
  })));
  await insert('patient_check_ins', [
    { patient_id: patientIds[0], check_in_id: `qa_ci_${stamp}_1`, date_key: '2026-09-01', weight: 208.4, mood: 4, side_effects: ['nausea'], notes: 'QA check-in one' },
    { patient_id: patientIds[0], check_in_id: `qa_ci_${stamp}_2`, date_key: '2026-09-08', weight: 206.1, mood: 5, side_effects: [], notes: null },
    { patient_id: patientIds[1], check_in_id: `qa_ci_${stamp}_3`, date_key: '2026-09-03', weight: 209.0, mood: 3, side_effects: [], notes: null },
  ]);
  await insert('patient_staff_weights', [
    { weight_id: crypto.randomUUID(), provider_id: officeId, patient_id: patientIds[1], date_key: '2026-09-10', weight: 205.5, note: 'QA office scale', recorded_by: ids.hqUserId, recorded_by_name: 'QA Bundle HQ' },
    { weight_id: crypto.randomUUID(), provider_id: officeId, patient_id: patientIds[2], date_key: '2026-09-11', weight: 201.2, note: null, recorded_by: ids.hqUserId, recorded_by_name: 'QA Bundle HQ' },
  ]);
  await objectStorage.saveBuffer(photoObjectPath, photoBytes, 'image/jpeg');
  await insert('patient_media', { object_path: photoObjectPath, patient_id: patientIds[0], kind: 'progress', content_type: 'image/jpeg', size_bytes: photoBytes.byteLength });
  await insert('patient_progress_photos', { patient_id: patientIds[0], photo_id: `qa_photo_${stamp}`, date_key: '2026-09-08', label: 'Week 1 front', angle: 'front', object_path: photoObjectPath });
  await insert('patient_tombstones', {
    id: tombstoneId, provider_id: officeId, requested_at: '2026-08-01T12:00:00.000Z', purged_at: '2026-08-31T12:00:00.000Z',
    was_activated: true, program_id: 'thinnr', enrolled_on: '2026-05-04',
  });

  const hq = await signIn(hqEmail, password);
  // Fresh-code proof: the same ledger row the re-auth sheet stamps.
  await insert('auth_sign_ins', {
    user_id: ids.hqUserId, realm: 'staff', method: 'email_code', platform: 'web',
    device_fingerprint: officeId.slice(0, 64), session_id: sessionIdOf(hq), code_verified_at: new Date().toISOString(),
  });
  return hq;
}

async function removeOffice(office: string, emails: string[], userIds: string[], exportRows: string[]) {
  for (const exportId of exportRows) {
    for (const path of await objectStorage.listObjectPaths(`/objects/exports/${exportId}/`).catch(() => [] as string[])) {
      await objectStorage.deleteObjectStrict(path).catch((error: unknown) => console.error(`  !!  object ${path} not removed: ${(error as Error).message}`));
    }
  }
  const patients = await svc('GET', `/rest/v1/patients?provider_id=eq.${enc(office)}&select=id`);
  const patientRows: string[] = Array.isArray(patients.json) ? patients.json.map((row: any) => row.id) : [];
  for (const patientId of patientRows) {
    for (const path of await objectStorage.listObjectPaths(`/objects/patient-media/${patientId}/`).catch(() => [] as string[])) {
      await objectStorage.deleteObjectStrict(path).catch((error: unknown) => console.error(`  !!  object ${path} not removed: ${(error as Error).message}`));
    }
  }
  // Append-only ledgers: management API, one transaction, triggers off.
  try {
    await managementQuery(`
begin;
set local session_replication_role = replica;
delete from public.admin_audit_events where provider_id = ${lit(office)}${userIds.length ? ` or actor_user_id in (${userIds.map(lit).join(',')})` : ''};
delete from public.patient_tombstones where provider_id = ${lit(office)};
delete from public.analytics_events where provider_id = ${lit(office)};
delete from public.auth_session_revocations where ${userIds.length ? `user_id in (${userIds.map(lit).join(',')})` : 'false'};
delete from public.claim_verifications where ${emails.length ? `identifier in (${emails.map(lit).join(',')})` : 'false'};
commit;`);
  } catch (error) {
    console.error(`  !!  ledger cleanup failed: ${(error as Error).message}`);
  }
  const steps: Array<[string, string]> = [
    ['data_exports', `/rest/v1/data_exports?provider_id=eq.${enc(office)}`],
    ['patient_media', `/rest/v1/patient_media?patient_id=in.(${patientRows.join(',') || crypto.randomUUID()})`],
    ['patients', `/rest/v1/patients?provider_id=eq.${enc(office)}`],
    ['team_members', `/rest/v1/team_members?provider_id=eq.${enc(office)}`],
    ['providers', `/rest/v1/providers?provider_id=eq.${enc(office)}`],
    ['hq_memberships', `/rest/v1/hq_memberships?email=in.(${emails.map(enc).join(',')})`],
    ['staff_role_assignments', `/rest/v1/staff_role_assignments?email=in.(${emails.map(enc).join(',')})`],
  ];
  for (const [label, path] of steps) {
    const res = await svc('DELETE', path, undefined, 'return=minimal');
    if (res.status >= 300) console.error(`  !!  ${label} cleanup failed (${res.status}): ${brief(res.json)}`);
  }
  for (const userId of userIds) {
    const res = await svc('DELETE', `/auth/v1/admin/users/${userId}`);
    if (res.status >= 300 && res.status !== 404) console.error(`  !!  auth user ${userId} cleanup failed (${res.status}): ${brief(res.json)}`);
  }
}

/** Leftovers of an aborted earlier run (same naming scheme) go first. */
async function sweepStaleFixtures() {
  const offices = await svc('GET', `/rest/v1/providers?provider_id=like.${enc(`${QA_PREFIX}%`)}&select=provider_id`);
  const staleOffices: string[] = Array.isArray(offices.json) ? offices.json.map((row: any) => row.provider_id) : [];
  const users = (await managementQuery(`select id::text as id, email from auth.users where email like ${lit(`${QA_PREFIX}%${QA_DOMAIN}`)}`)) as Array<{ id: string; email: string }> | null;
  const staleUsers = Array.isArray(users) ? users : [];
  if (staleOffices.length === 0 && staleUsers.length === 0) return;
  console.log(`  sweeping stale fixtures: ${staleOffices.length} office(s), ${staleUsers.length} user(s)`);
  for (const office of staleOffices) {
    const rows = await svc('GET', `/rest/v1/data_exports?provider_id=eq.${enc(office)}&select=id`);
    await removeOffice(office, staleUsers.map((user) => user.email), [], Array.isArray(rows.json) ? rows.json.map((row: any) => row.id) : []);
  }
  for (const user of staleUsers) await svc('DELETE', `/auth/v1/admin/users/${user.id}`);
  await svc('DELETE', `/rest/v1/hq_memberships?email=like.${enc(`${QA_PREFIX}%`)}`, undefined, 'return=minimal');
  await svc('DELETE', `/rest/v1/staff_role_assignments?email=like.${enc(`${QA_PREFIX}%`)}`, undefined, 'return=minimal');
}

// ---------------------------------------------------------------- helpers
async function readRow(exportId: string): Promise<any> {
  const res = await svc('GET', `/rest/v1/data_exports?id=eq.${exportId}&select=*&limit=1`);
  if (res.status >= 300 || !Array.isArray(res.json) || !res.json[0]) throw new Error(`export row ${exportId} unreadable (${res.status})`);
  return res.json[0];
}

async function runNow(hq: string): Promise<{ status: number; json: any }> {
  const res = await api(hq, `/hq/system-health/jobs/${JOB_NAME}/run`, { method: 'POST', body: JSON.stringify({}) });
  if (res.status !== 200 && res.status !== 202 && res.status !== 409) throw new Error(`run-now failed (${res.status}): ${res.text.slice(0, 200)}`);
  return res;
}

/**
 * Poll the export through the HQ route until it is ready. The request itself
 * signals the job; when the shared dev database has other bundles queued
 * ahead of ours (the job packs the oldest first), nudge with run-now until
 * ours moves.
 */
async function waitForReady(hq: string, exportId: string): Promise<{ dto: any; stages: string[] }> {
  const deadline = Date.now() + BUILD_TIMEOUT_MS;
  const stages: string[] = [];
  let lastNudge = 0;
  let lastSignature = '';
  for (;;) {
    const res = await api(hq, `/exports/${exportId}`);
    if (res.status !== 200) throw new Error(`GET /exports/${exportId} → ${res.status}: ${res.text.slice(0, 200)}`);
    const dto = res.json.job;
    const signature = `${dto.status}:${dto.progress?.stage ?? '-'}:${dto.progress?.partsDone ?? '-'}:${dto.progress?.patientsDone ?? '-'}`;
    if (signature !== lastSignature) {
      stages.push(signature);
      lastSignature = signature;
    }
    if (dto.status === 'ready') return { dto, stages };
    if (dto.status === 'failed' || dto.status === 'cancelled' || dto.status === 'expired') throw new Error(`export ${exportId} ended ${dto.status}: ${dto.error ?? ''}`);
    if (Date.now() >= deadline) throw new Error(`export ${exportId} not ready after ${BUILD_TIMEOUT_MS / 1000}s (last ${signature})`);
    if (Date.now() - lastNudge > 8_000) {
      lastNudge = Date.now();
      const nudge = await runNow(hq);
      console.log(`  … ${signature}; run-now → ${nudge.status}${nudge.json?.run?.counts ? ` ${brief(nudge.json.run.counts)}` : ''}`);
    }
    await sleep(1_500);
  }
}

interface DownloadedPart { part: number; fileName: string; bytes: Buffer; entries: Map<string, Buffer> }

async function downloadParts(hq: string, exportId: string, parts: Array<{ part: number; fileName: string; sizeBytes: number }>): Promise<DownloadedPart[]> {
  const out: DownloadedPart[] = [];
  for (const part of parts) {
    const link = await api(hq, `/exports/${exportId}/download-url?part=${part.part}`);
    check(`part ${part.part}: download-url → 200 with url + fileName`, link.status === 200 && typeof link.json?.url === 'string' && link.json.fileName === part.fileName, `${link.status} ${brief(link.json)}`);
    const url: string = link.json?.url?.startsWith('/') ? `${API_BASE}${link.json.url}` : link.json?.url;
    const response = await fetch(url);
    const bytes = Buffer.from(await response.arrayBuffer());
    check(`part ${part.part}: signed URL serves ${part.sizeBytes} bytes`, response.status === 200 && bytes.byteLength === part.sizeBytes, `${response.status}, ${bytes.byteLength} bytes`);
    const zip = await JSZip.loadAsync(bytes);
    const entries = new Map<string, Buffer>();
    for (const [name, file] of Object.entries(zip.files)) {
      if (!file.dir) entries.set(name, Buffer.from(await file.async('uint8array')));
    }
    out.push({ part: part.part, fileName: part.fileName, bytes, entries });
  }
  return out;
}

/** Manifest-driven integrity checks shared by both phases. */
async function verifyBundle(label: string, exportId: string, dto: any, parts: DownloadedPart[], expect: { includeTombstones: boolean }): Promise<any> {
  const last = parts[parts.length - 1];
  const manifestBytes = last?.entries.get('manifest.json');
  check(`${label}: manifest.json rides the last part`, Boolean(manifestBytes));
  if (!manifestBytes) return null;
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  check(`${label}: manifest identifies this bundle`, manifest.format === 'thinnr-office-bundle/1' && manifest.exportId === exportId && manifest.officeId === officeId && manifest.officeName === officeName, brief({ format: manifest.format, exportId: manifest.exportId, officeId: manifest.officeId }));
  check(`${label}: manifest counts 4 patients in, 4 total, ${parts.length} parts`, manifest.patientsTotal === 4 && manifest.patientsIncluded === 4 && manifest.partCount === parts.length, brief({ total: manifest.patientsTotal, included: manifest.patientsIncluded, partCount: manifest.partCount }));
  check(`${label}: includeTombstones=${expect.includeTombstones} recorded`, manifest.includeTombstones === expect.includeTombstones && manifest.tombstoneCount === (expect.includeTombstones ? 1 : null), brief({ includeTombstones: manifest.includeTombstones, tombstoneCount: manifest.tombstoneCount }));

  const byPart = new Map(parts.map((part) => [part.part, part]));
  let mismatches: string[] = [];
  for (const entry of manifest.files as Array<{ file: string; part: number; sizeBytes: number; sha256: string }>) {
    const bytes = byPart.get(entry.part)?.entries.get(entry.file);
    if (!bytes) mismatches.push(`${entry.file} missing from part ${entry.part}`);
    else if (bytes.byteLength !== entry.sizeBytes) mismatches.push(`${entry.file} size ${bytes.byteLength} ≠ ${entry.sizeBytes}`);
    else if (sha256(bytes) !== entry.sha256) mismatches.push(`${entry.file} sha mismatch`);
  }
  check(`${label}: every manifest file entry (${manifest.files.length}) present in its part with matching size + sha256`, mismatches.length === 0, mismatches.slice(0, 5).join('; '));
  const listed = new Set((manifest.files as Array<{ file: string }>).map((entry) => entry.file));
  listed.add('manifest.json');
  const unlisted = parts.flatMap((part) => [...part.entries.keys()].filter((name) => !listed.has(name)).map((name) => `part ${part.part}: ${name}`));
  check(`${label}: no ZIP entry outside the manifest`, unlisted.length === 0, unlisted.slice(0, 5).join('; '));
  const totalEntries = parts.reduce((sum, part) => sum + part.entries.size, 0);
  check(`${label}: manifest fileCount ${manifest.fileCount} = ZIP entries ${totalEntries}`, manifest.fileCount === totalEntries);

  const missingCsvs = OFFICE_CSVS.filter((name) => !last.entries.has(name));
  check(`${label}: office/*.csv all present in the last part`, missingCsvs.length === 0, missingCsvs.join(', '));
  check(`${label}: README.txt present`, last.entries.has('README.txt'));
  const tombstones = last.entries.get('office/tombstones.csv');
  if (expect.includeTombstones) {
    check(`${label}: office/tombstones.csv lists the purged patient marker`, Boolean(tombstones) && tombstones!.toString('utf8').includes(tombstoneId), tombstones ? tombstones.toString('utf8').slice(0, 200) : 'missing');
  } else {
    check(`${label}: no office/tombstones.csv when not requested`, !tombstones);
  }
  const patientsCsv = last.entries.get('office/patient-activity.csv')?.toString('utf8') ?? '';
  check(`${label}: office/patient-activity.csv names the QA patients`, patientIds.every((id) => patientsCsv.includes(id)) || patientsCsv.includes('QA Bundle Patient 1'), patientsCsv.slice(0, 160));

  const manifestPatients = (manifest.patients as Array<{ patientId: string; parts: number[]; fileCount: number }>);
  check(`${label}: manifest.patients = the 4 QA patients in creation order`, manifestPatients.map((p) => p.patientId).join(',') === patientIds.join(','), manifestPatients.map((p) => p.patientId).join(','));
  const perPatientFiles = patientIds.map((id) => (manifest.files as Array<{ file: string }>).filter((entry) => entry.file.startsWith(`patients/${id}/`)).length);
  check(`${label}: each patient folder has files (${perPatientFiles.join('/')})`, perPatientFiles.every((count) => count > 0));
  const photoEntry = (manifest.files as Array<{ file: string; sha256: string }>).find((entry) => entry.file.startsWith(`patients/${patientIds[0]}/`) && entry.sha256 === sha256(photoBytes));
  check(`${label}: progress photo bytes ride patient 1's folder byte-for-byte`, Boolean(photoEntry), photoEntry?.file ?? 'no entry with the photo checksum');

  // Whole-part checksums: manifest for every part but the last, row for all.
  const row = await readRow(exportId);
  const rowParts: Array<{ part: number; objectPath: string; sizeBytes: number; sha256: string }> = row.parts ?? [];
  const partShas = parts.map((part) => ({ part: part.part, sha: sha256(part.bytes) }));
  const manifestPartMismatch = (manifest.parts as Array<{ part: number; sha256: string | null; sizeBytes: number | null }>)
    .filter((entry) => entry.part !== parts.length)
    .filter((entry) => entry.sha256 !== partShas.find((p) => p.part === entry.part)?.sha);
  check(`${label}: manifest.parts sha256 matches every downloaded non-final part`, manifestPartMismatch.length === 0, brief(manifestPartMismatch));
  check(`${label}: manifest lists the final part with sha256 null (unknowable before it is written)`, manifest.parts[parts.length - 1]?.sha256 === null && manifest.parts[parts.length - 1]?.part === parts.length);
  const rowMismatch = rowParts.filter((entry) => entry.sha256 !== partShas.find((p) => p.part === entry.part)?.sha);
  check(`${label}: data_exports.parts sha256 matches every downloaded part`, rowParts.length === parts.length && rowMismatch.length === 0, brief(rowMismatch.map((entry) => entry.part)));
  check(`${label}: row ready, object_path = part 1, size_bytes = sum of parts`, row.status === 'ready' && row.object_path === rowParts[0]?.objectPath && row.size_bytes === rowParts.reduce((sum, entry) => sum + entry.sizeBytes, 0), brief({ status: row.status, size: row.size_bytes }));
  check(`${label}: download_count counts one per part downloaded`, row.download_count === parts.length, String(row.download_count));
  check(`${label}: dto.parts mirrors the row (part, fileName, sizeBytes, fileCount)`, JSON.stringify(dto.parts) === JSON.stringify(rowParts.map((entry) => ({ part: entry.part, fileName: (entry as any).fileName, sizeBytes: entry.sizeBytes, fileCount: (entry as any).fileCount }))));

  const objects = await objectStorage.listObjectPaths(`/objects/exports/${exportId}/`);
  const expected = new Set(rowParts.map((entry) => entry.objectPath));
  check(`${label}: storage prefix holds exactly the ${parts.length} parts (sidecars removed)`, objects.length === expected.size && objects.every((path) => expected.has(path)), brief(objects));
  return manifest;
}

async function auditActions(exportId: string): Promise<Array<{ action: string; metadata: any; actor_user_id: string }>> {
  const res = await svc('GET', `/rest/v1/admin_audit_events?provider_id=eq.${enc(officeId)}&target_id=eq.${exportId}&select=action,metadata,actor_user_id&order=occurred_at.asc`);
  return Array.isArray(res.json) ? res.json : [];
}

// ---------------------------------------------------------------- phases
async function phaseA(hq: string) {
  console.log('\nPhase A — request, build through the server job, download, verify');
  const requested = await api(hq, '/exports', { method: 'POST', body: JSON.stringify({ kind: OFFICE_BUNDLE_KIND, office: officeId, includeTombstones: true }) });
  check('POST /exports office_bundle → 202 queued', requested.status === 202 && requested.json?.job?.status === 'queued' && requested.json.job.kind === OFFICE_BUNDLE_KIND, `${requested.status} ${requested.text.slice(0, 200)}`);
  const exportId: string = requested.json.job.id;
  exportIds.push(exportId);
  check('request DTO carries includeTombstones + office scope', requested.json.job.includeTombstones === true && requested.json.job.scope?.providerId === officeId && requested.json.job.scope?.officeName === officeName, brief(requested.json.job.scope));

  const { dto, stages } = await waitForReady(hq, exportId);
  console.log(`  … progress seen: ${stages.join(' → ')}`);
  check('export reaches ready with downloadable parts', dto.status === 'ready' && dto.downloadable === true && Array.isArray(dto.parts) && dto.parts.length >= 2, brief({ status: dto.status, parts: dto.parts?.length }));
  check('progress block is cleared once the bundle is ready (only queued/running carry it)', dto.progress === null, brief(dto.progress));
  check('4 patients under the 50-per-part default pack into 2 parts (patients + office)', dto.parts.length === 2, String(dto.parts.length));

  const parts = await downloadParts(hq, exportId, dto.parts);
  await verifyBundle('A', exportId, dto, parts, { includeTombstones: true });

  const noPart = await api(hq, `/exports/${exportId}/download-url?part=${dto.parts.length + 1}`);
  check('download-url for a part that does not exist → 404', noPart.status === 404, String(noPart.status));
  const audit = await auditActions(exportId);
  const downloaded = audit.filter((event) => event.action === 'office_bundle_export_downloaded').map((event) => event.metadata?.part).sort();
  check('audit: office_bundle_export_requested by the HQ user', audit.some((event) => event.action === 'office_bundle_export_requested' && event.actor_user_id === ids.hqUserId), brief(audit.map((e) => e.action)));
  check('audit: one office_bundle_export_downloaded per part', JSON.stringify(downloaded) === JSON.stringify(dto.parts.map((part: any) => part.part)), brief(downloaded));
}

async function phaseB(hq: string) {
  console.log('\nPhase B — staged crash after part 1, then the server resumes from the cursor');
  const owner = `${QA_PREFIX}harness:${process.pid}:${stamp}`;
  let leased = false;
  for (let attempt = 0; attempt < 20 && !leased; attempt += 1) {
    leased = await supabaseJobStore.acquireLease(JOB_NAME, owner, 600);
    if (!leased) await sleep(3_000);
  }
  check('harness holds the office-bundle-export lease (server cannot pick the request up)', leased);
  if (!leased) return;
  let exportId = '';
  try {
    const requested = await api(hq, '/exports', { method: 'POST', body: JSON.stringify({ kind: OFFICE_BUNDLE_KIND, office: officeId, includeTombstones: false }) });
    check('second POST /exports → 202 queued', requested.status === 202 && requested.json?.job?.status === 'queued', `${requested.status} ${requested.text.slice(0, 200)}`);
    exportId = requested.json.job.id;
    exportIds.push(exportId);
    await sleep(2_500);
    const held = await readRow(exportId);
    check('while the lease is held the server leaves the request queued', held.status === 'queued', held.status);

    // The step packs the oldest queued/running bundle in the whole project;
    // in the shared dev database that must be ours or the staging below
    // would act on someone else's request.
    const scan = await svc('GET', `/rest/v1/data_exports?kind=eq.${OFFICE_BUNDLE_KIND}&status=in.(running,queued)&expires_at=gt.${enc(new Date().toISOString())}&select=id,provider_id,status,created_at&order=status.desc,created_at.asc&limit=1`);
    const first = scan.json?.[0];
    check('our request is the next bundle the job would pick', first?.id === exportId, `blocking row: ${brief(first)}`);
    if (first?.id !== exportId) return;

    // Real builder, one patient per part, clock that runs out the moment the
    // first part lands: the row is left exactly as a mid-bundle crash or a
    // spent budget leaves it.
    let crashed = false;
    const tallies: Record<string, number> = {};
    const step = await runOfficeBundleStep({
      dryRun: false,
      tally: (key, by = 1) => {
        tallies[key] = (tallies[key] ?? 0) + by;
        if (key === 'partsWritten') crashed = true;
      },
      log: (event, detail) => console.log(`  … builder ${event} ${detail ? brief(detail) : ''}`),
      checkpoint: () => undefined,
      deps: {
        patientsPerPart: 1,
        runBudgetMs: 60_000,
        now: () => new Date(Date.now() + (crashed ? 3_600_000 : 0)),
      },
    });
    check('in-process step claims our row and stops with work remaining', step.jobId === exportId && step.moreWork === true, brief({ step, tallies }));
    check('exactly one part landed before the "crash"', tallies.partsWritten === 1 && tallies.bundlePatientsDone === 1, brief(tallies));

    const stalled = await readRow(exportId);
    const bundle = stalled.params?.bundle ?? {};
    const part1 = stalled.parts?.[0];
    check('row left running with part 1 committed and the cursor after patient 1', stalled.status === 'running' && Array.isArray(stalled.parts) && stalled.parts.length === 1 && bundle.stage === 'patients' && bundle.patientsDone === 1 && bundle.cursor?.id === patientIds[0], brief({ status: stalled.status, parts: stalled.parts?.length, bundle }));
    check('one file-list sidecar recorded for part 1', Array.isArray(bundle.fileLists) && bundle.fileLists.length === 1, brief(bundle.fileLists));
    const stalledObjects = await objectStorage.listObjectPaths(`/objects/exports/${exportId}/`);
    check('storage holds part 1 + its sidecar', stalledObjects.length === 2 && stalledObjects.includes(part1?.objectPath) && stalledObjects.includes(bundle.fileLists?.[0]), brief(stalledObjects));
    const mid = await api(hq, `/exports/${exportId}`);
    check('HQ route shows the stalled bundle: running, stage patients, 1/4 patients, 1 part, no download', mid.status === 200 && mid.json.job.status === 'running' && mid.json.job.progress?.stage === 'patients' && mid.json.job.progress.patientsDone === 1 && mid.json.job.progress.patientsTotal === 4 && mid.json.job.progress.partsDone === 1 && mid.json.job.parts === null && mid.json.job.downloadable === false, brief(mid.json.job.progress));
    const early = await api(hq, `/exports/${exportId}/download-url`);
    check('download-url before ready → 409', early.status === 409, String(early.status));

    // "Restart": release the lease; the server (another process, another
    // job owner) runs the job now and must continue from the cursor.
    await supabaseJobStore.releaseLease(JOB_NAME, owner);
    leased = false;
    const resumed = await runNow(hq);
    const tally = resumed.json?.run?.counts ?? null;
    console.log(`  … run-now → ${resumed.status} ${tally ? brief(tally) : brief(resumed.json)}`);
    check('server run-now takes the running bundle (seen, not re-claimed)', resumed.status === 202 || (resumed.status === 200 && tally?.bundlesSeen === 1 && !tally.bundlesClaimed), brief(resumed.json));
    const { dto, stages } = await waitForReady(hq, exportId);
    console.log(`  … progress seen: ${stages.join(' → ')}`);
    check('resumed bundle reaches ready', dto.status === 'ready' && Array.isArray(dto.parts));
    const final = await readRow(exportId);
    const finalPart1 = final.parts?.[0];
    check('part 1 survived the resume untouched (same object, size, sha256)', finalPart1?.objectPath === part1?.objectPath && finalPart1?.sha256 === part1?.sha256 && finalPart1?.sizeBytes === part1?.sizeBytes, brief({ before: part1, after: finalPart1 }));
    check('resume packed patients 2-4 into part 2 and the office files into part 3', final.parts?.length === 3 && final.attempts === 1, brief({ parts: final.parts?.length, attempts: final.attempts }));
    check('row keeps its single claim (started_at from the staged run, attempts 1)', final.attempts === 1 && final.started_at === stalled.started_at);

    const parts = await downloadParts(hq, exportId, dto.parts);
    const manifest = await verifyBundle('B', exportId, dto, parts, { includeTombstones: false });
    if (manifest) {
      const placement = (manifest.patients as Array<{ patientId: string; parts: number[] }>).map((p) => `${patientIds.indexOf(p.patientId) + 1}:${p.parts.join('+')}`);
      check('manifest places patient 1 in part 1 (from the staged run) and 2-4 in part 2 (from the resume)', placement.join(' ') === '1:1 2:2 3:2 4:2', placement.join(' '));
      check('part 1 sidecar checksums were folded into the manifest', (manifest.files as Array<{ file: string; part: number }>).some((entry) => entry.part === 1 && entry.file.startsWith(`patients/${patientIds[0]}/`)));
    }
    const audit = await auditActions(exportId);
    const downloaded = audit.filter((event) => event.action === 'office_bundle_export_downloaded').map((event) => event.metadata?.part).sort();
    check('audit: one office_bundle_export_downloaded per part of the resumed bundle', JSON.stringify(downloaded) === JSON.stringify([1, 2, 3]), brief(downloaded));
    const runs = await svc('GET', `/rest/v1/admin_audit_events?actor_user_id=eq.${ids.hqUserId}&action=eq.system_job.run&target_id=eq.${JOB_NAME}&select=metadata`);
    check('audit: system_job.run recorded for the HQ run-now', Array.isArray(runs.json) && runs.json.length >= 1, brief(runs.json));
  } finally {
    if (leased) await supabaseJobStore.releaseLease(JOB_NAME, owner).catch(() => undefined);
  }
}

// ---------------------------------------------------------------- main
async function main() {
  const health = await api(null, '/exports');
  if (health.status !== 401) {
    console.error(`api-server at ${API_BASE} is not answering as expected (GET /api/exports → ${health.status}). Start the API Server workflow first.`);
    process.exit(1);
  }
  console.log('Fixtures');
  await sweepStaleFixtures();
  let hq: string | null = null;
  try {
    hq = await createFixtures();
    console.log(`  ok  office ${officeId} with 4 patients, 1 progress photo, 1 tombstone; HQ admin signed in`);
    const estimate = await api(hq, `/exports/office-bundle/estimate?office=${enc(officeId)}`);
    check('estimate route (the account page dialog) counts 4 patients and 1 tombstone', estimate.status === 200 && estimate.json?.patientCount === 4 && estimate.json?.tombstoneCount === 1 && estimate.json?.office?.name === officeName, `${estimate.status} ${brief(estimate.json)}`);
    await phaseA(hq);
    await phaseB(hq);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${(error as Error).stack ?? error}`);
  } finally {
    console.log('\nCleanup');
    await removeOffice(officeId, [hqEmail, ownerEmail], [ids.hqUserId, ids.ownerUserId].filter((v): v is string => Boolean(v)), exportIds);
    const left = await svc('GET', `/rest/v1/data_exports?provider_id=eq.${enc(officeId)}&select=id`);
    const leftObjects = (await Promise.all(exportIds.map((id) => objectStorage.listObjectPaths(`/objects/exports/${id}/`).catch(() => ['?'])))).flat();
    check('cleanup: export rows and objects removed', Array.isArray(left.json) && left.json.length === 0 && leftObjects.length === 0, brief({ rows: left.json?.length, objects: leftObjects }));
    console.log('  ok  fixtures removed');
  }
  console.log(failures === 0 ? '\nverify-office-bundle-live: all checks passed' : `\nverify-office-bundle-live: ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
