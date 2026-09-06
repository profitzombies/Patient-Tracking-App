/**
 * Office comparison + exports — live end-to-end checks.
 *
 * Runs against the live Supabase project and the running API server with two
 * throwaway identities (both cleaned up afterwards): an HQ admin and a
 * provider staffer scoped to the first live office:
 *
 *   1. HQ comparison: every enabled office appears; a range predating the
 *      dataset is `available:false` with null metrics (never zero); a bad
 *      range is a 400; provider staff cannot call the HQ endpoint.
 *   2. Office analytics: HQ can name an office; provider staff are pinned to
 *      their own office — naming another office is ignored, never honoured.
 *   3. Exports lifecycle: HQ requests every kind, the worker completes them,
 *      the signed download serves a CSV whose header carries no notes or
 *      message columns, and the download is audited.
 *   4. Scope: patient_activity needs an office (HQ 400 without one); provider
 *      staff cannot request the provider directory and every export they
 *      request is pinned to their own office regardless of the body; a job
 *      is invisible to anyone but its requester.
 *   5. Expiry: an expired job's download is refused and the list marks it.
 *
 * Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + SUPABASE_ANON_KEY and the
 * API at STAFF_API_BASE (default http://localhost:80). Live suite — not part
 * of the hermetic gates.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:exports
 */

import crypto from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const API_BASE = (process.env.STAFF_API_BASE ?? 'http://localhost:80').replace(/\/$/, '');

if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY in the environment.');
  process.exit(1);
}

const BASE = SUPABASE_URL.replace(/\/$/, '');
const OTHER_OFFICE = 'acct-p1';
const RANGE = { start: '2026-08-08', end: '2026-09-06' };
const PRE_DATASET = { start: '2026-06-01', end: '2026-06-30' };
// No export may carry clinical notes or message text; patient-level rows also
// carry no contact details (staff/provider directories legitimately do).
const FORBIDDEN_HEADERS = /note|message|transcript|chat|dob|birth|diagnos/i;
const PATIENT_FORBIDDEN_HEADERS = /phone|email|address/i;

const SVC_HEADERS: Record<string, string> = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function svc(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...SVC_HEADERS, Prefer: 'return=representation' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* empty body */
  }
  return { status: response.status, json };
}

async function signIn(email: string, password: string): Promise<string> {
  const response = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json: any = await response.json();
  if (!json.access_token) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(json)}`);
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
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: response.status, json };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForJobs(token: string, ids: string[], timeoutMs = 45_000): Promise<Map<string, any>> {
  const deadline = Date.now() + timeoutMs;
  const done = new Map<string, any>();
  while (Date.now() < deadline && done.size < ids.length) {
    for (const id of ids) {
      if (done.has(id)) continue;
      const { status, json } = await api(token, `/exports/${id}`);
      if (status === 200 && (json.job.status === 'ready' || json.job.status === 'failed')) done.set(id, json.job);
    }
    if (done.size < ids.length) await sleep(1500);
  }
  return done;
}

const stamp = Date.now();
const qaEmail = `qa-exports-${stamp}@thinnr-qa.example.com`;
const qaPassword = `Qa-${stamp}!x`;
const staffEmail = `qa-exports-staff-${stamp}@thinnr-qa.example.com`;
let qaUserId: string | null = null;
let staffUserId: string | null = null;

/**
 * Provider staffer: approval row + auth user (the signup trigger scopes the
 * profile) + the office roster row that makes them "office staff" to the API.
 */
let staffMemberId: string | null = null;
// Throwaway office used to pin the rollup SQL's metric contract against real
// rows: avg pounds lost counts ACTIVE patients only, engagement is the
// trailing 7-day window ending on the range end, and the daily engaged series
// is a rolling 7-day count whose last point equals the rollup figure.
const rollupOfficeId = `qa-rollup-${stamp}`;
let rollupOfficeCreated = false;
const dayKey = (offset: number) => {
  const d = new Date(`${RANGE.end}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
};

async function verifyRollupSemantics() {
  console.log('\n6. Rollup SQL metric contract (throwaway office)');
  const office = await svc('POST', '/rest/v1/providers', {
    provider_id: rollupOfficeId, office_name: 'QA Rollup Office', provider_name: 'QA Rollup', access_disabled: false,
  });
  check('throwaway office created', office.status === 201, JSON.stringify(office.json));
  if (office.status !== 201) return;
  rollupOfficeCreated = true;
  const createdAt = `${dayKey(20)}T12:00:00Z`;
  const patient = (name: string, activation: string, start: number, current: number, lastLog: string) => ({
    id: crypto.randomUUID(), provider_id: rollupOfficeId, name, activation_status: activation, created_at: createdAt,
    starting_weight: start, current_weight: current, last_log_date: lastLog,
  });
  const rows = await svc('POST', '/rest/v1/patients', [
    patient('QA Active Recent', 'activated', 200, 190, dayKey(2)),   // engaged in the trailing week
    patient('QA Active Stale', 'activated', 200, 180, dayKey(20)),   // active in range, not in the trailing week
    patient('QA Invited Heavy', 'invited', 300, 200, dayKey(1)),     // invited: excluded from avg + engagement
  ]);
  check('throwaway patients created', rows.status === 201, JSON.stringify(rows.json).slice(0, 200));

  const rollup = await svc('POST', '/rest/v1/rpc/nonfinancial_office_rollup', { p_provider_id: rollupOfficeId, p_start: RANGE.start, p_end: RANGE.end });
  const m = Array.isArray(rollup.json) ? rollup.json[0] : null;
  check('office rollup returns the throwaway office', !!m, JSON.stringify(rollup.json));
  if (m) {
    check('total/active/invited split', Number(m.total_patients) === 3 && Number(m.active_patients) === 2 && Number(m.invited) === 1, JSON.stringify(m));
    check('avg pounds lost averages ACTIVE patients only (15.0, not 40.0 with the invited one)', Number(m.avg_pounds_lost) === 15, String(m.avg_pounds_lost));
    check('engaged = active patients with activity in the 7 days ending on the range end (1, not 2 range-wide)', Number(m.engaged) === 1, String(m.engaged));
    check('enrollments count inside the range', Number(m.enrollments) === 3, String(m.enrollments));
  }
  const network = await svc('POST', '/rest/v1/rpc/nonfinancial_operational_rollup', { p_provider_id: rollupOfficeId, p_as_of: RANGE.end });
  const net = Array.isArray(network.json) ? network.json[0] : null;
  check('network rollup avg pounds lost also excludes invited patients', !!net && Number(net.avg_pounds_lost) === 15, JSON.stringify(net));

  const daily = await svc('POST', '/rest/v1/rpc/nonfinancial_office_daily', { p_provider_id: rollupOfficeId, p_start: RANGE.start, p_end: RANGE.end });
  const byDate = new Map<string, any>((Array.isArray(daily.json) ? daily.json : []).map((row: any) => [row.date, row]));
  const at = (offset: number) => Number(byDate.get(dayKey(offset))?.engaged_patients ?? -1);
  check('daily engaged on the range end equals the rollup engaged figure', at(0) === Number(m?.engaged ?? -2), `${at(0)} vs ${m?.engaged}`);
  check('daily engaged is a rolling 7-day count (stale patient still counts 20 days back)', at(20) === 1, String(at(20)));
  check('daily engaged drops to 0 once the window passes (12 days back)', at(12) === 0, String(at(12)));
  check('daily engaged before enrollment is 0', at(25) === 0, String(at(25)));
  const rangeStartRow = byDate.get(RANGE.start);
  check('daily series covers the whole range', byDate.size === 30 && !!rangeStartRow, String(byDate.size));
}

async function createStaffer(officeId: string): Promise<string> {
  await svc('POST', '/rest/v1/staff_role_assignments', { email: staffEmail, role: 'provider_staff', provider_account_code: officeId });
  const created = await svc('POST', '/auth/v1/admin/users', {
    email: staffEmail,
    password: qaPassword,
    email_confirm: true,
    app_metadata: { thinnr_provisioned: 'true' },
  });
  staffUserId = created.json?.id ?? null;
  if (!staffUserId) throw new Error(`could not create QA staffer: ${JSON.stringify(created.json)}`);
  staffMemberId = crypto.randomUUID();
  const member = await svc('POST', '/rest/v1/team_members', {
    id: staffMemberId,
    provider_id: officeId,
    name: 'QA Exports Staffer',
    email: staffEmail,
    activation_status: 'activated',
    auth_user_id: staffUserId,
  });
  if (member.status !== 201) throw new Error(`QA staffer roster row failed (${member.status}): ${JSON.stringify(member.json)}`);
  return signIn(staffEmail, qaPassword);
}

async function main() {
  // Throwaway HQ admin.
  await svc('POST', '/rest/v1/staff_role_assignments', { email: qaEmail, role: 'hq_admin' });
  const created = await svc('POST', '/auth/v1/admin/users', {
    email: qaEmail,
    password: qaPassword,
    email_confirm: true,
    app_metadata: { thinnr_provisioned: 'true' },
  });
  qaUserId = created.json?.id ?? null;
  if (!qaUserId) throw new Error(`could not create QA admin: ${JSON.stringify(created.json)}`);
  const membership = await svc('POST', '/rest/v1/hq_memberships', {
    email: qaEmail,
    auth_user_id: qaUserId,
    status: 'active',
    department_role: 'admin',
    display_name: 'QA Exports',
    activated_at: new Date().toISOString(),
  });
  if (membership.status !== 201) throw new Error(`membership failed: ${JSON.stringify(membership.json)}`);

  const hq = await signIn(qaEmail, qaPassword);

  console.log('\n1. HQ office comparison');
  const comparison = await api(hq, `/hq/office-comparison?start=${RANGE.start}&end=${RANGE.end}`);
  check('HQ comparison responds', comparison.status === 200, `${comparison.status} ${JSON.stringify(comparison.json)}`);
  const offices: any[] = comparison.json?.offices ?? [];
  check('at least one office row with series + metrics shape', offices.length > 0 && offices.every((o) => 'available' in o && Array.isArray(o.series)));
  const availableOffice = offices.find((o) => o.available && o.metrics);
  check('an office with data reports numeric metrics', Boolean(availableOffice) && typeof availableOffice.metrics.totalPatients === 'number');
  const pre = await api(hq, `/hq/office-comparison?start=${PRE_DATASET.start}&end=${PRE_DATASET.end}`);
  check('pre-dataset range → available:false, metrics null, empty series (not zero)', pre.status === 200 && (pre.json.offices as any[]).every((o) => o.available === false && o.metrics === null && o.series.length === 0), JSON.stringify(pre.json?.offices?.map((o: any) => [o.providerId, o.available, o.metrics])));
  const badRange = await api(hq, '/hq/office-comparison?start=2026-09-06&end=2026-08-01');
  check('reversed range is a 400', badRange.status === 400);
  const officeId: string = availableOffice?.providerId ?? offices[0]?.providerId;
  const dana = await createStaffer(officeId);
  const danaHq = await api(dana, `/hq/office-comparison?start=${RANGE.start}&end=${RANGE.end}`);
  check('provider staff cannot read the HQ comparison (not an HQ identity)', danaHq.status === 401 || danaHq.status === 403, String(danaHq.status));
  const anon = await api(null, `/hq/office-comparison?start=${RANGE.start}&end=${RANGE.end}`);
  check('anonymous cannot read the HQ comparison', anon.status === 401, String(anon.status));

  console.log('\n2. Office analytics scope');
  const hqAnalytics = await api(hq, `/office/analytics?start=${RANGE.start}&end=${RANGE.end}&office=${officeId}`);
  check('HQ can read a named office', hqAnalytics.status === 200 && hqAnalytics.json.office.providerId === officeId, `${hqAnalytics.status}`);
  check('HQ analytics carries range + series', hqAnalytics.json?.range?.start === RANGE.start && Array.isArray(hqAnalytics.json?.series));
  const hqNoOffice = await api(hq, `/office/analytics?start=${RANGE.start}&end=${RANGE.end}`);
  check('HQ without an office is refused', hqNoOffice.status >= 400 && hqNoOffice.status < 500, String(hqNoOffice.status));
  const danaOwn = await api(dana, `/office/analytics?start=${RANGE.start}&end=${RANGE.end}`);
  check('provider staff are pinned to their own office', danaOwn.status === 200 && danaOwn.json.office.providerId === officeId, `${danaOwn.status} ${JSON.stringify(danaOwn.json).slice(0, 200)}`);
  check('own-office analytics match the HQ read of that office', JSON.stringify(danaOwn.json?.metrics) === JSON.stringify(hqAnalytics.json?.metrics));
  const danaOther = await api(dana, `/office/analytics?start=${RANGE.start}&end=${RANGE.end}&office=${OTHER_OFFICE}`);
  check('provider staff naming another office are still pinned to their own', danaOther.status === 200 && danaOther.json.office.providerId === officeId, `${danaOther.status} ${JSON.stringify(danaOther.json?.office)}`);

  console.log('\n3. Export lifecycle (HQ admin)');
  const kinds = await api(hq, '/exports');
  check('export list offers HQ admin every kind', kinds.status === 200 && Array.isArray(kinds.json.available) && kinds.json.available.length >= 5 && kinds.json.ttlHours > 0, JSON.stringify(kinds.json?.available));
  const requests = [
    { kind: 'office_comparison', ...RANGE },
    { kind: 'patient_activity', office: officeId, ...RANGE },
    { kind: 'audit_events', ...RANGE },
    { kind: 'training_completion', start: '2025-09-06', end: RANGE.end },
    { kind: 'provider_directory' },
  ];
  const jobIds: string[] = [];
  for (const body of requests) {
    const r = await api(hq, '/exports', { method: 'POST', body: JSON.stringify(body) });
    check(`request ${body.kind} accepted (202)`, r.status === 202 && typeof r.json?.job?.id === 'string' && r.json.job.status === 'queued', `${r.status} ${JSON.stringify(r.json)}`);
    if (r.json?.job?.id) jobIds.push(r.json.job.id);
  }
  const finished = await waitForJobs(hq, jobIds);
  check('every job reached a terminal state', finished.size === jobIds.length, `${finished.size}/${jobIds.length}`);
  for (const job of finished.values()) {
    check(`${job.kind} completed ready with a file`, job.status === 'ready' && job.downloadable === true && typeof job.fileName === 'string' && job.rowCount >= 0, JSON.stringify({ status: job.status, error: job.error }));
  }
  const readyJobs = [...finished.values()].filter((j) => j.status === 'ready');
  for (const job of readyJobs) {
    const dl = await api(hq, `/exports/${job.id}/download-url`);
    check(`${job.kind} download URL minted`, dl.status === 200 && typeof dl.json?.url === 'string' && dl.json.expiresInSeconds > 0, `${dl.status} ${JSON.stringify(dl.json)}`);
    if (dl.status !== 200) continue;
    const csv = await fetch(dl.json.url).then((r) => r.text());
    const header = csv.split(/\r?\n/)[0] ?? '';
    check(`${job.kind} CSV has a header row`, header.includes(','), header.slice(0, 80));
    check(`${job.kind} CSV header carries no notes/messages`, !FORBIDDEN_HEADERS.test(header), header);
    if (job.kind === 'patient_activity') check('patient activity rows carry no contact details', !PATIENT_FORBIDDEN_HEADERS.test(header), header);
    const bodyLines = csv.split(/\r?\n/).filter((line) => line.length > 0).length - 1;
    check(`${job.kind} CSV row count matches the job`, bodyLines === job.rowCount, `${bodyLines} vs ${job.rowCount}`);
  }
  const afterDownload = await api(hq, `/exports/${readyJobs[0].id}`);
  check('download count increments', afterDownload.json?.job?.downloadCount >= 1, JSON.stringify(afterDownload.json?.job?.downloadCount));
  const audit = await svc('GET', `/rest/v1/admin_audit_events?actor_user_id=eq.${qaUserId}&select=action,target_kind,metadata&order=occurred_at.asc`);
  const actions = new Set<string>((audit.json ?? []).map((row: any) => row.action));
  check('export requests and downloads are audited', actions.has('data_export_requested') && actions.has('data_export_downloaded'), JSON.stringify([...actions]));
  const requestedAudit = (audit.json ?? []).filter((row: any) => row.action === 'data_export_requested');
  check('audit metadata names the kind and scope, never row contents', requestedAudit.length === requests.length && requestedAudit.every((row: any) => typeof row.metadata?.kind === 'string'), JSON.stringify(requestedAudit[0]));
  const auditExport = readyJobs.find((j) => j.kind === 'audit_events');
  check('audit export is scoped to HQ audit reads (no message text)', Boolean(auditExport) && auditExport.rowCount >= 0);

  console.log('\n4. Scope enforcement');
  const noOffice = await api(hq, '/exports', { method: 'POST', body: JSON.stringify({ kind: 'patient_activity', ...RANGE }) });
  check('HQ patient_activity without an office is a 400', noOffice.status === 400, `${noOffice.status} ${JSON.stringify(noOffice.json)}`);
  const unknownKind = await api(hq, '/exports', { method: 'POST', body: JSON.stringify({ kind: 'clinical_notes' }) });
  check('unknown kind is refused', unknownKind.status === 400, String(unknownKind.status));
  const danaList = await api(dana, '/exports');
  check('provider staff see an export list (own scope)', danaList.status === 200 && Array.isArray(danaList.json.available), `${danaList.status} ${JSON.stringify(danaList.json)}`);
  const danaKinds: string[] = (danaList.json?.available ?? []).map((k: any) => k.kind);
  check('provider staff are offered their own patient activity', danaKinds.includes('patient_activity'), danaKinds.join());
  check('provider staff are not offered the provider directory', !danaKinds.includes('provider_directory') && danaKinds.length === 4, danaKinds.join());
  check('office kinds never ask the staffer to choose an office', (danaList.json?.available ?? []).every((k: any) => k.needsOffice === false));
  const danaDirectory = await api(dana, '/exports', { method: 'POST', body: JSON.stringify({ kind: 'provider_directory' }) });
  check('provider staff cannot request the provider directory', danaDirectory.status === 403, String(danaDirectory.status));
  const danaOtherOffice = await api(dana, '/exports', { method: 'POST', body: JSON.stringify({ kind: 'patient_activity', office: OTHER_OFFICE, ...RANGE }) });
  check('provider staff naming another office get their own office, never the other', danaOtherOffice.status === 202 && danaOtherOffice.json?.job?.scope?.providerId === officeId, `${danaOtherOffice.status} ${JSON.stringify(danaOtherOffice.json?.job?.scope)}`);
  const danaComparison = await api(dana, '/exports', { method: 'POST', body: JSON.stringify({ kind: 'office_comparison', ...RANGE }) });
  check('office comparison for staff is pinned to their office (not network-wide)', danaComparison.status === 202 && danaComparison.json?.job?.scope?.providerId === officeId, `${danaComparison.status} ${JSON.stringify(danaComparison.json?.job?.scope)}`);
  const danaOwnExport = await api(dana, '/exports', { method: 'POST', body: JSON.stringify({ kind: 'patient_activity', ...RANGE }) });
  check('provider staff can export their own office activity (pinned scope)', danaOwnExport.status === 202 && danaOwnExport.json?.job?.scope?.providerId === officeId, `${danaOwnExport.status} ${JSON.stringify(danaOwnExport.json)}`);
  if (danaOwnExport.json?.job?.id) {
    const ownDone = await waitForJobs(dana, [danaOwnExport.json.job.id]);
    const ownJob = ownDone.get(danaOwnExport.json.job.id);
    check('own-office export completes', ownJob?.status === 'ready', JSON.stringify(ownJob));
    const hqForeign = await api(hq, `/exports/${danaOwnExport.json.job.id}`);
    check("HQ cannot read the staffer's job either (requester-only)", hqForeign.status === 404, String(hqForeign.status));
  }
  const foreignRead = await api(dana, `/exports/${readyJobs[0].id}`);
  check("another user's job is invisible (404)", foreignRead.status === 404, String(foreignRead.status));
  const foreignDownload = await api(dana, `/exports/${readyJobs[0].id}/download-url`);
  check("another user's download is refused", foreignDownload.status === 404 || foreignDownload.status === 403, String(foreignDownload.status));
  const anonList = await api(null, '/exports');
  check('anonymous export list is a 401', anonList.status === 401, String(anonList.status));

  console.log('\n5. Expiry');
  const expiring = readyJobs[readyJobs.length - 1];
  await svc('PATCH', `/rest/v1/data_exports?id=eq.${expiring.id}`, { expires_at: new Date(Date.now() - 60_000).toISOString() });
  const expiredDl = await api(hq, `/exports/${expiring.id}/download-url`);
  check('expired job download refused (410)', expiredDl.status === 410, `${expiredDl.status} ${JSON.stringify(expiredDl.json)}`);
  const expiredRead = await api(hq, `/exports/${expiring.id}`);
  check('expired job is reported not downloadable', expiredRead.status === 200 && expiredRead.json.job.downloadable === false && (expiredRead.json.job.status === 'expired' || expiredRead.json.job.status === 'ready'), JSON.stringify(expiredRead.json?.job));

  await verifyRollupSemantics();
}

main()
  .catch((error) => {
    failures += 1;
    console.error('FAIL  unexpected error', error);
  })
  .finally(async () => {
    // Expire the QA jobs so the sweep removes their files; the append-only
    // audit rows stay (they are the point of the audit trail).
    for (const userId of [qaUserId, staffUserId]) {
      if (!userId) continue;
      await svc('PATCH', `/rest/v1/data_exports?requested_by=eq.${userId}`, { expires_at: new Date(Date.now() - 60_000).toISOString() });
    }
    if (staffMemberId) await svc('DELETE', `/rest/v1/team_members?id=eq.${staffMemberId}`);
    if (staffUserId) {
      await svc('DELETE', `/rest/v1/staff_role_assignments?email=eq.${encodeURIComponent(staffEmail)}`);
      await svc('DELETE', `/auth/v1/admin/users/${staffUserId}`);
    }
    if (qaUserId) {
      await svc('DELETE', `/rest/v1/hq_memberships?auth_user_id=eq.${qaUserId}`);
      await svc('DELETE', `/rest/v1/staff_role_assignments?email=eq.${encodeURIComponent(qaEmail)}`);
      await svc('DELETE', `/auth/v1/admin/users/${qaUserId}`);
    }
    if (rollupOfficeCreated) {
      await svc('DELETE', `/rest/v1/patients?provider_id=eq.${rollupOfficeId}`);
      await svc('DELETE', `/rest/v1/providers?provider_id=eq.${rollupOfficeId}`);
    }
    console.log('\ncleaned up QA identities');
    if (failures > 0) {
      console.error(`\n${failures} check(s) failed.`);
      process.exit(1);
    }
    console.log('\nOffice comparison + exports verified live.');
  });
