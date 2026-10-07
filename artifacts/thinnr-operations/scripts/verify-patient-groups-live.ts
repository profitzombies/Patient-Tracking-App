/**
 * Live patient groups: a real office creates a group, adds a member, the
 * roster carries the membership (so the Group filter can select only that
 * patient), HQ drill-in reads it but cannot change it, then remove → delete —
 * end to end against the shared dev Supabase project and the running
 * api-server (STAFF_API_BASE, default the preview proxy at http://localhost:80).
 *
 *   pnpm --filter @workspace/thinnr-operations run test:patient-groups-live
 *
 * Fixtures: a throwaway HQ admin, an office with its owner login
 * (providers.auth_user_id) and two plain patient rows. Everything is removed
 * in `finally`, append-only ledgers through the management API.
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
const brief = (value: unknown) => JSON.stringify(value)?.slice(0, 240) ?? '';
const lit = (value: string) => `'${value.replace(/'/g, "''")}'`;

async function svc(method: string, path: string, body?: unknown, prefer = 'return=representation'): Promise<{ status: number; json: any }> {
  const response = await fetch(`${BASE}${path}`, { method, headers: { ...SVC_HEADERS, Prefer: prefer }, body: body === undefined ? undefined : JSON.stringify(body) });
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
    method: 'POST', headers: { apikey: ANON_KEY!, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  const json: any = await response.json();
  if (!json.access_token) throw new Error(`sign-in failed for ${email}: ${brief(json)}`);
  return json.access_token;
}

async function api(token: string | null, path: string, init: RequestInit = {}): Promise<{ status: number; json: any }> {
  const response = await fetch(`${API_BASE}/api${path}`, {
    ...init,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...((init.headers as Record<string, string>) ?? {}) },
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: response.status, json };
}
const send = (token: string, method: string, path: string, body?: unknown) => api(token, path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

async function createUser(email: string, password: string, appMetadata: Record<string, string>): Promise<string> {
  const created = await svc('POST', '/auth/v1/admin/users', { email, password, email_confirm: true, app_metadata: appMetadata });
  const id = created.json?.id;
  if (typeof id !== 'string') throw new Error(`could not create auth user ${email}: ${brief(created.json)}`);
  return id;
}

interface Fixture {
  stamp: number; password: string; hqEmail: string; ownerEmail: string; officeId: string;
  patientA: string; patientB: string; hqUserId: string | null; ownerUserId: string | null;
}
function newFixture(): Fixture {
  const stamp = Date.now();
  return {
    stamp, password: `Qa-${stamp}!grp`,
    hqEmail: `qa-groups-hq-${stamp}@thinnr-qa.example.com`,
    ownerEmail: `qa-groups-owner-${stamp}@thinnr-qa.example.com`,
    officeId: `qa-groups-${stamp}`, patientA: crypto.randomUUID(), patientB: crypto.randomUUID(), hqUserId: null, ownerUserId: null,
  };
}

async function createFixtures(f: Fixture): Promise<{ hq: string; owner: string }> {
  await svc('POST', '/rest/v1/staff_role_assignments', { email: f.hqEmail, role: 'hq_admin' });
  f.hqUserId = await createUser(f.hqEmail, f.password, { thinnr_provisioned: 'true' });
  const membership = await svc('POST', '/rest/v1/hq_memberships', { email: f.hqEmail, auth_user_id: f.hqUserId, status: 'active', department_role: 'admin', display_name: 'QA Groups HQ', activated_at: new Date().toISOString() });
  if (membership.status !== 201) throw new Error(`HQ membership failed (${membership.status}): ${brief(membership.json)}`);
  f.ownerUserId = await createUser(f.ownerEmail, f.password, { thinnr_provisioned: 'true' });
  const office = await svc('POST', '/rest/v1/providers', { provider_id: f.officeId, office_name: 'QA Groups Office', provider_name: 'Dr. QA Grouper', email: f.ownerEmail, auth_user_id: f.ownerUserId, access_disabled: false, created_at: new Date().toISOString() });
  if (office.status !== 201) throw new Error(`office insert failed (${office.status}): ${brief(office.json)}`);
  // A bare office sits behind the practice-setup gate; HQ's waiver on the
  // launch row (the one demonstration offices carry) lets this throwaway
  // office use the workspace without touching Stripe.
  const launch = await svc('POST', '/rest/v1/practice_launch?on_conflict=provider_id', { provider_id: f.officeId, required: false, setup_override_at: new Date().toISOString(), setup_override_note: 'QA groups live proof' }, 'resolution=merge-duplicates,return=minimal');
  if (launch.status >= 300) throw new Error(`launch waiver failed (${launch.status}): ${brief(launch.json)}`);
  for (const [id, name] of [[f.patientA, 'QA Groups Patient A'], [f.patientB, 'QA Groups Patient B']] as const) {
    const patient = await svc('POST', '/rest/v1/patients', { id, provider_id: f.officeId, name, email: `${id}@thinnr-qa.example.com`, activation_status: 'activated', claimed_at: new Date().toISOString(), created_at: new Date().toISOString(), starting_weight: 205, current_weight: 205 });
    if (patient.status !== 201) throw new Error(`patient insert failed (${patient.status}): ${brief(patient.json)}`);
  }
  return { hq: await signIn(f.hqEmail, f.password), owner: await signIn(f.ownerEmail, f.password) };
}

async function cleanup(f: Fixture) {
  console.log('\nCleanup');
  const users = [f.hqUserId, f.ownerUserId].filter((v): v is string => Boolean(v));
  const userList = users.map(lit).join(',');
  try {
    await managementQuery(`
begin;
set local session_replication_role = replica;
delete from public.patient_group_members where provider_id = ${lit(f.officeId)};
delete from public.patient_groups where provider_id = ${lit(f.officeId)};
delete from public.admin_audit_events where provider_id = ${lit(f.officeId)}${users.length ? ` or actor_user_id in (${userList})` : ''};
delete from public.patient_tombstones where provider_id = ${lit(f.officeId)};
delete from public.auth_sign_ins where ${users.length ? `user_id in (${userList})` : 'false'};
delete from public.claim_verifications where identifier in (${[f.hqEmail, f.ownerEmail].map(lit).join(',')});
commit;`);
    console.log('  ok  ledgers cleared');
  } catch (error) {
    console.error(`  !!  ledger cleanup failed: ${(error as Error).message}`);
  }
  const steps: Array<[string, string]> = [
    ['patients', `/rest/v1/patients?provider_id=eq.${enc(f.officeId)}`],
    ['team_members', `/rest/v1/team_members?provider_id=eq.${enc(f.officeId)}`],
    ['training_viewers', `/rest/v1/training_viewers?auth_user_id=in.(${users.join(',')})`],
    ['profiles', `/rest/v1/profiles?id=in.(${users.join(',')})`],
    ['providers', `/rest/v1/providers?provider_id=eq.${enc(f.officeId)}`],
    ['hq_memberships', `/rest/v1/hq_memberships?email=eq.${enc(f.hqEmail)}`],
    ['staff_role_assignments', `/rest/v1/staff_role_assignments?email=in.(${[f.hqEmail, f.ownerEmail].map(enc).join(',')})`],
  ];
  for (const [label, path] of steps) {
    const res = await svc('DELETE', path, undefined, 'return=minimal');
    if (res.status >= 300 && res.status !== 404) console.error(`  !!  ${label} cleanup failed (${res.status}): ${brief(res.json)}`);
  }
  for (const userId of users) {
    const res = await svc('DELETE', `/auth/v1/admin/users/${userId}`);
    if (res.status >= 300 && res.status !== 404) console.error(`  !!  auth user ${userId} cleanup failed (${res.status}): ${brief(res.json)}`);
  }
  const left = await svc('GET', `/rest/v1/providers?provider_id=eq.${enc(f.officeId)}&select=provider_id`);
  const groupsLeft = await svc('GET', `/rest/v1/patient_groups?provider_id=eq.${enc(f.officeId)}&select=id`);
  if (left.json?.length || groupsLeft.json?.length) console.error('  !!  fixture rows still present after cleanup');
  else console.log('  ok  fixtures removed');
}

const groupIdsOf = (roster: any, patientId: string): string[] => (roster?.patients ?? []).find((row: any) => row.id === patientId)?.groupIds ?? [];

async function main(f: Fixture) {
  const { hq, owner } = await createFixtures(f);
  const OFFICE_Q = `office=${enc(f.officeId)}`;

  console.log('\n1. Owner creates a group');
  const empty = await api(owner, '/office/patient-groups');
  check('empty list for a new office, canEdit true', empty.status === 200 && Array.isArray(empty.json?.groups) && empty.json.groups.length === 0 && empty.json.canEdit === true, `${empty.status} ${brief(empty.json)}`);
  const created = await send(owner, 'POST', '/office/patient-groups', { name: 'MJH', description: 'Employer cohort' });
  const groupId: string = created.json?.group?.id;
  check('group created (201) with id', created.status === 201 && typeof groupId === 'string' && created.json.group.memberCount === 0, `${created.status} ${brief(created.json)}`);
  const dup = await send(owner, 'POST', '/office/patient-groups', { name: ' mjh ' });
  check('case-insensitive duplicate is a 409', dup.status === 409, `${dup.status} ${brief(dup.json)}`);

  console.log('\n2. Add a member; the roster carries the membership');
  const added = await send(owner, 'PUT', `/office/patient-groups/${groupId}/members/${f.patientA}`);
  check('member added (201)', added.status === 201 && added.json?.membership?.added === true, `${added.status} ${brief(added.json)}`);
  const again = await send(owner, 'PUT', `/office/patient-groups/${groupId}/members/${f.patientA}`);
  check('adding twice is idempotent (200, added:false)', again.status === 200 && again.json?.membership?.added === false, `${again.status} ${brief(again.json)}`);
  const unknown = await send(owner, 'PUT', `/office/patient-groups/${groupId}/members/${crypto.randomUUID()}`);
  check('unknown patient is a 404', unknown.status === 404, `${unknown.status}`);
  const roster = await api(owner, '/office/roster');
  check('roster lists both patients', roster.status === 200 && [f.patientA, f.patientB].every((id) => (roster.json?.patients ?? []).some((row: any) => row.id === id)), `${roster.status}`);
  check('only patient A carries the group id', groupIdsOf(roster.json, f.patientA).join() === groupId && groupIdsOf(roster.json, f.patientB).length === 0, brief({ a: groupIdsOf(roster.json, f.patientA), b: groupIdsOf(roster.json, f.patientB) }));
  // The Group filter is a client-side predicate over row.groupIds — the same
  // selection the Patients page makes for f=group:is:<id>.
  const filtered = (roster.json?.patients ?? []).filter((row: any) => (row.groupIds ?? []).includes(groupId)).map((row: any) => row.id);
  check('Group is MJH selects exactly patient A', filtered.length === 1 && filtered[0] === f.patientA, brief(filtered));
  const list = await api(owner, '/office/patient-groups');
  check('group list shows memberCount 1', list.json?.groups?.[0]?.memberCount === 1, brief(list.json));
  const detail = await api(owner, `/office/patients/${f.patientA}`);
  check('patient detail carries groupIds', detail.status === 200 && Array.isArray(detail.json?.patient?.groupIds) && detail.json.patient.groupIds.includes(groupId), `${detail.status} ${brief(detail.json?.patient?.groupIds)}`);

  console.log('\n3. HQ drill-in reads with ?office=, never writes');
  const hqList = await api(hq, `/office/patient-groups?${OFFICE_Q}`);
  check('HQ sees the group with canEdit false', hqList.status === 200 && hqList.json?.canEdit === false && hqList.json?.groups?.[0]?.id === groupId, `${hqList.status} ${brief(hqList.json)}`);
  const hqNoOffice = await api(hq, '/office/patient-groups');
  check('HQ without ?office= is refused', hqNoOffice.status >= 400 && hqNoOffice.status < 500, `${hqNoOffice.status}`);
  const hqWrite = await send(hq, 'POST', `/office/patient-groups?${OFFICE_Q}`, { name: 'HQ made' });
  check('HQ create is a 403', hqWrite.status === 403, `${hqWrite.status} ${brief(hqWrite.json)}`);
  const hqRemove = await send(hq, 'DELETE', `/office/patient-groups/${groupId}/members/${f.patientA}?${OFFICE_Q}`);
  check('HQ member removal is a 403', hqRemove.status === 403, `${hqRemove.status}`);
  const hqRoster = await api(hq, `/office/roster?${OFFICE_Q}`);
  check('HQ roster carries the same group ids', groupIdsOf(hqRoster.json, f.patientA).join() === groupId, `${hqRoster.status}`);

  console.log('\n4. Rename, remove, delete');
  const renamed = await send(owner, 'PATCH', `/office/patient-groups/${groupId}`, { name: 'MJH Wellness' });
  check('rename lands', renamed.status === 200 && renamed.json?.group?.name === 'MJH Wellness', `${renamed.status} ${brief(renamed.json)}`);
  const removed = await send(owner, 'DELETE', `/office/patient-groups/${groupId}/members/${f.patientA}`);
  check('member removed', removed.status === 200 && removed.json?.membership?.removed === true, `${removed.status} ${brief(removed.json)}`);
  const rosterAfter = await api(owner, '/office/roster');
  check('roster drops the group id', groupIdsOf(rosterAfter.json, f.patientA).length === 0);
  await send(owner, 'PUT', `/office/patient-groups/${groupId}/members/${f.patientB}`);
  const deleted = await send(owner, 'DELETE', `/office/patient-groups/${groupId}`);
  check('delete reports the member count it removed', deleted.status === 200 && deleted.json?.deleted === true && deleted.json?.memberCount === 1, `${deleted.status} ${brief(deleted.json)}`);
  const gone = await api(owner, `/office/patient-groups`);
  check('group list is empty again', gone.json?.groups?.length === 0);
  const membersLeft = await svc('GET', `/rest/v1/patient_group_members?provider_id=eq.${enc(f.officeId)}&select=patient_id`);
  check('membership rows cascaded away', Array.isArray(membersLeft.json) && membersLeft.json.length === 0, brief(membersLeft.json));
  const missing = await send(owner, 'PATCH', `/office/patient-groups/${groupId}`, { name: 'Ghost' });
  check('renaming a deleted group is a 404', missing.status === 404, `${missing.status}`);

  console.log('\n5. Audit trail');
  const audit = await svc('GET', `/rest/v1/admin_audit_events?provider_id=eq.${enc(f.officeId)}&target_kind=eq.patient_group&select=action,target_id&order=occurred_at.asc`);
  const actions = Array.isArray(audit.json) ? audit.json.map((row: any) => row.action) : [];
  check('every mutation left an office audit event', ['patient_group_created', 'patient_group_member_added', 'patient_group_renamed', 'patient_group_member_removed', 'patient_group_deleted'].every((action) => actions.includes(action)), brief(actions));
  const officeAudit = await api(owner, `/office/audit-events?limit=50`);
  check('owner sees them on the office audit feed', officeAudit.status === 200 && JSON.stringify(officeAudit.json).includes('patient_group_created'), `${officeAudit.status}`);
}

async function run() {
  const fixture = newFixture();
  try {
    await main(fixture);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  harness error — ${(error as Error).stack ?? error}`);
  } finally {
    await cleanup(fixture);
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll patient groups live checks passed.');
}

void run();
