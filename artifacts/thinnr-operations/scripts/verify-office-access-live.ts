/**
 * Live HQ office access controls: the per-office billing actions and the
 * billing board against the shared dev Supabase project and the running
 * api-server (STAFF_API_BASE, default the preview proxy at http://localhost:80).
 *
 * The state machine and the route bodies are proven with fakes elsewhere; this
 * harness drives the real HTTP surface with disposable fixtures:
 *
 *   - a throwaway HQ admin (staff_role_assignments + auth user + active
 *     hq_memberships row), the department access the screens require;
 *   - a throwaway office with its owner login, which stands in for the
 *     provider side that must never reach these endpoints.
 *
 * It then walks the HQ controls in the order an operator would:
 *   an office with no subscription work reports itself honestly, an included
 *   period is granted and switched to lifetime and back, the trial is reset,
 *   the price is overridden, paid-through is recorded with its source, a
 *   restricted office is freed by an offline payment, the change history names
 *   the HQ user who did it, the board reports the office under the state it is
 *   actually in, and the office owner's own token is refused everywhere.
 *
 * Fixtures are removed in `finally`: the append-only access event ledger
 * through the management API, everything else through PostgREST.
 */
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
const DAY_MS = 86_400_000;

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
const dayOf = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);

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

async function managementQuery(query: string): Promise<void> {
  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await response.text();
  if (response.status >= 300) throw new Error(`management query failed (${response.status}): ${text.slice(0, 300)}`);
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
const post = (token: string, path: string, body: unknown) => api(token, path, { method: 'POST', body: JSON.stringify(body) });

// ---------------------------------------------------------------- fixtures
const stamp = Date.now();
const password = `Qa-${stamp}!acc`;
const hqEmail = `qa-office-access-hq-${stamp}@thinnr-qa.example.com`;
const ownerEmail = `qa-office-access-owner-${stamp}@thinnr-qa.example.com`;
const officeId = `qa-office-access-${stamp}`;
const hqName = 'QA Office Access';
const ids: { hqUserId: string | null; ownerUserId: string | null; officeCreated: boolean } = {
  hqUserId: null, ownerUserId: null, officeCreated: false,
};

async function createUser(email: string, appMetadata: Record<string, string>): Promise<string> {
  const created = await svc('POST', '/auth/v1/admin/users', { email, password, email_confirm: true, app_metadata: appMetadata });
  const id = created.json?.id;
  if (typeof id !== 'string') throw new Error(`could not create auth user ${email}: ${brief(created.json)}`);
  return id;
}

async function createFixtures(): Promise<{ hq: string; owner: string }> {
  await svc('POST', '/rest/v1/staff_role_assignments', { email: hqEmail, role: 'hq_admin' });
  ids.hqUserId = await createUser(hqEmail, { thinnr_provisioned: 'true' });
  const membership = await svc('POST', '/rest/v1/hq_memberships', {
    email: hqEmail, auth_user_id: ids.hqUserId, status: 'active', department_role: 'admin',
    display_name: hqName, activated_at: new Date().toISOString(),
  });
  if (membership.status !== 201) throw new Error(`HQ membership failed (${membership.status}): ${brief(membership.json)}`);

  ids.ownerUserId = await createUser(ownerEmail, { thinnr_provisioned: 'true' });
  const office = await svc('POST', '/rest/v1/providers', {
    provider_id: officeId, office_name: 'QA Office Access Practice', provider_name: 'QA Office Access Provider',
    email: ownerEmail, auth_user_id: ids.ownerUserId, access_disabled: false, created_at: new Date().toISOString(),
  });
  if (office.status !== 201) throw new Error(`office insert failed (${office.status}): ${brief(office.json)}`);
  ids.officeCreated = true;
  return { hq: await signIn(hqEmail, password), owner: await signIn(ownerEmail, password) };
}

async function cleanup() {
  console.log('\nCleanup');
  try {
    await managementQuery(`
begin;
set local session_replication_role = replica;
delete from public.billing_office_access_events where provider_id = ${lit(officeId)};
delete from public.billing_office_access_attempts where provider_id = ${lit(officeId)};
delete from public.billing_office_access_instruments where provider_id = ${lit(officeId)};
delete from public.billing_office_access_subscriptions where provider_id = ${lit(officeId)};
delete from public.admin_audit_events where provider_id = ${lit(officeId)}${ids.hqUserId ? ` or actor_user_id = ${lit(ids.hqUserId)}` : ''};
commit;`);
    console.log('  ok  access ledgers cleared');
  } catch (error) {
    console.error(`  !!  ledger cleanup failed: ${(error as Error).message}`);
  }
  const steps: Array<[string, string]> = [
    ['providers', `/rest/v1/providers?provider_id=eq.${enc(officeId)}`],
    ['hq_memberships', `/rest/v1/hq_memberships?email=eq.${enc(hqEmail)}`],
    ['staff_role_assignments', `/rest/v1/staff_role_assignments?email=in.(${[hqEmail, ownerEmail].map(enc).join(',')})`],
  ];
  for (const [label, path] of steps) {
    const res = await svc('DELETE', path, undefined, 'return=minimal');
    if (res.status >= 300) console.error(`  !!  ${label} cleanup failed (${res.status}): ${brief(res.json)}`);
  }
  for (const userId of [ids.hqUserId, ids.ownerUserId].filter((value): value is string => Boolean(value))) {
    const res = await svc('DELETE', `/auth/v1/admin/users/${userId}`);
    if (res.status >= 300 && res.status !== 404) console.error(`  !!  auth user ${userId} cleanup failed (${res.status}): ${brief(res.json)}`);
  }
  console.log('  ok  fixtures removed');
}

async function main() {
  const health = await api(null, '/healthz');
  if (health.status >= 400) throw new Error(`api-server is not answering at ${API_BASE}/api (${health.status}) — start the API Server workflow first.`);

  const { hq, owner } = await createFixtures();
  const detail = () => api(hq, `/hq/office-access/${enc(officeId)}`);

  console.log('\nAn office with no subscription work reports itself honestly');
  {
    const res = await detail();
    check('detail answers 200', res.status === 200, brief(res.json));
    check('subscription is absent rather than zeroed', res.json?.subscription === null, brief(res.json?.subscription));
    check('instruments, attempts and history are empty', res.json?.instruments?.length === 0 && res.json?.attempts?.length === 0 && res.json?.history?.length === 0, brief(res.json));
    check('the office name comes back', res.json?.office?.officeName === 'QA Office Access Practice', brief(res.json?.office));
    check('policy carries the standard prices and the three-year ceiling', typeof res.json?.policy?.monthlyPriceCents === 'number' && res.json?.policy?.maxIncludedPeriodDays === 1095, brief(res.json?.policy));
  }

  console.log('\nIncluded period, lifetime and reset');
  {
    const granted = await post(hq, `/hq/office-access/${enc(officeId)}/included-period`, { days: 30 });
    check('granting 30 included days answers 200', granted.status === 200, brief(granted.json));
    check('the office is in its included period', granted.json?.subscription?.state === 'included_period', brief(granted.json?.subscription));
    const endsIn = Math.round((Date.parse(granted.json?.subscription?.includedPeriodEndsAt ?? '') - Date.now()) / DAY_MS);
    check('the period ends about 30 days out', endsIn === 30 || endsIn === 29, `${endsIn} days`);

    const tooLong = await post(hq, `/hq/office-access/${enc(officeId)}/included-period`, { days: 1096 });
    check('more than three years is refused', tooLong.status === 400, `${tooLong.status} ${brief(tooLong.json)}`);

    const lifetime = await post(hq, `/hq/office-access/${enc(officeId)}/included-period`, { lifetime: true });
    check('lifetime access sticks', lifetime.json?.subscription?.lifetime === true && lifetime.json?.subscription?.state === 'included_period', brief(lifetime.json?.subscription));
    check('a lifetime office has no next charge', lifetime.json?.subscription?.nextChargeAt === null, brief(lifetime.json?.subscription?.nextChargeAt));

    const back = await post(hq, `/hq/office-access/${enc(officeId)}/included-period`, { lifetime: false, days: 14 });
    check('switching back off lifetime keeps a dated period', back.json?.subscription?.lifetime === false && back.json?.subscription?.includedPeriodEndsAt !== null, brief(back.json?.subscription));

    const reset = await post(hq, `/hq/office-access/${enc(officeId)}/reset-trial`, { days: 21 });
    const resetIn = Math.round((Date.parse(reset.json?.subscription?.includedPeriodEndsAt ?? '') - Date.now()) / DAY_MS);
    check('a reset trial runs from now', resetIn === 21 || resetIn === 20, `${resetIn} days`);
  }

  console.log('\nPrice override and paid-through');
  {
    const priced = await post(hq, `/hq/office-access/${enc(officeId)}/terms`, { plan: 'yearly', priceCentsOverride: 123_400 });
    check('the office keeps its own price', priced.json?.subscription?.priceCents === 123_400 && priced.json?.subscription?.priceCentsOverride === 123_400, brief(priced.json?.subscription));
    check('the plan changed with it', priced.json?.subscription?.plan === 'yearly', brief(priced.json?.subscription?.plan));

    const cleared = await post(hq, `/hq/office-access/${enc(officeId)}/terms`, { priceCentsOverride: null });
    const standard = (await detail()).json?.policy?.yearlyPriceCents;
    check('clearing the override falls back to the standard price', cleared.json?.subscription?.priceCentsOverride === null && cleared.json?.subscription?.priceCents === standard, brief(cleared.json?.subscription));

    const paid = await post(hq, `/hq/office-access/${enc(officeId)}/paid-through`, { paidThrough: dayOf(365), source: 'hq_migration' });
    check('an office migrating over is paid, not new', paid.json?.subscription?.state === 'paid_current', brief(paid.json?.subscription));
    check('the source HQ chose is kept', paid.json?.subscription?.paidThroughSource === 'hq_migration', brief(paid.json?.subscription?.paidThroughSource));
    check('the next charge is the paid-through date', (paid.json?.subscription?.nextChargeAt ?? '').slice(0, 10) === dayOf(365), brief(paid.json?.subscription?.nextChargeAt));
  }

  console.log('\nAn offline payment frees a restricted office');
  {
    const past = new Date(Date.now() - 10 * DAY_MS).toISOString();
    const patched = await svc('PATCH', `/rest/v1/billing_office_access_subscriptions?provider_id=eq.${enc(officeId)}`, {
      state: 'restricted', lifetime: false, paid_through: past, included_period_ends_at: past,
      setup_completed_at: past, grace_started_at: past, grace_ends_at: past, restricted_at: past,
    });
    check('the office can be put in the restricted state', patched.status < 300 && patched.json?.[0]?.state === 'restricted', brief(patched.json));

    const before = await detail();
    check('the panel shows it as restricted', before.json?.subscription?.state === 'restricted', brief(before.json?.subscription?.state));
    check('restricted-since is shown', typeof before.json?.subscription?.restrictedAt === 'string', brief(before.json?.subscription?.restrictedAt));

    const offline = await post(hq, `/hq/office-access/${enc(officeId)}/offline-payment`, { paidThrough: dayOf(30), amountCents: 20_000, note: 'Cheque 1042' });
    check('recording the payment answers 200', offline.status === 200, brief(offline.json));
    check('the restriction is lifted the way a card charge would lift it', offline.json?.subscription?.state === 'paid_current', brief(offline.json?.subscription?.state));
    check('restricted-since is cleared', offline.json?.subscription?.restrictedAt === null, brief(offline.json?.subscription?.restrictedAt));
    check('the grace clock is cleared', offline.json?.subscription?.graceEndsAt === null, brief(offline.json?.subscription?.graceEndsAt));
    check('the payment is recorded as offline', offline.json?.subscription?.paidThroughSource === 'offline', brief(offline.json?.subscription?.paidThroughSource));
  }

  console.log('\nThe change history names who did it');
  {
    const res = await detail();
    const history: any[] = res.json?.history ?? [];
    check('every action left a history entry', history.length >= 7, `${history.length} entries`);
    check('entries are attributed to the HQ user', history.every((entry) => entry.actorKind === 'hq') && history.some((entry) => entry.actorName === hqName), brief(history.slice(0, 2)));
    check('the offline payment is in the history', history.some((entry) => String(entry.event).includes('offline')), brief(history.map((entry) => entry.event)));
    const noted = history.find((entry) => String(entry.event).includes('offline'));
    check('the note HQ typed is kept with the entry', noted?.detail?.note === 'Cheque 1042', brief(noted?.detail));
    check('the history says what the payment moved the office from and to', noted?.fromState === 'restricted' && noted?.toState === 'paid_current', brief(noted));
  }

  console.log('\nThe billing board');
  {
    const board = await api(hq, '/hq/office-access');
    check('the board answers 200', board.status === 200, brief(board.json));
    const row = (board.json?.offices ?? []).find((office: any) => office.providerId === officeId);
    check('the office is on the board', Boolean(row), `${board.json?.offices?.length ?? 0} offices`);
    check('its board state matches the state it is actually in', row?.state === 'paid_current', brief(row));
    check('the board shows what it pays and when next', typeof row?.priceCents === 'number' && (row?.nextChargeAt ?? '').slice(0, 10) === dayOf(30), brief(row));
    const counts = board.json?.counts;
    check('the counts cover every office the board lists', counts?.total === board.json?.offices?.length, brief(counts));
    const notStarted = (board.json?.offices ?? []).filter((office: any) => office.state === null).length;
    check('offices with no subscription work are counted as not started', counts?.notStarted === notStarted, `${counts?.notStarted} vs ${notStarted}`);
    const paid = (board.json?.offices ?? []).filter((office: any) => office.state === 'paid_current').length;
    check('the paid count matches the rows in that state', counts?.paidCurrent === paid, `${counts?.paidCurrent} vs ${paid}`);
    check('trials ending soon has a window the board states', typeof board.json?.trialEndingSoonDays === 'number', brief(board.json?.trialEndingSoonDays));
  }

  console.log('\nThe provider side can never reach these controls');
  {
    const boardAsOwner = await api(owner, '/hq/office-access');
    check('the owner cannot read the board', boardAsOwner.status === 401 || boardAsOwner.status === 403, `${boardAsOwner.status} ${brief(boardAsOwner.json)}`);
    const detailAsOwner = await api(owner, `/hq/office-access/${enc(officeId)}`);
    check('the owner cannot read its own access panel', detailAsOwner.status === 401 || detailAsOwner.status === 403, `${detailAsOwner.status}`);
    const writeAsOwner = await post(owner, `/hq/office-access/${enc(officeId)}/offline-payment`, { paidThrough: dayOf(400) });
    check('the owner cannot pay itself through', writeAsOwner.status === 401 || writeAsOwner.status === 403, `${writeAsOwner.status}`);
    const anonymous = await api(null, `/hq/office-access/${enc(officeId)}`);
    check('an unauthenticated request is refused', anonymous.status === 401 || anonymous.status === 403, `${anonymous.status}`);
    const after = await detail();
    check('nothing the owner tried changed the office', (after.json?.subscription?.paidThrough ?? '').slice(0, 10) === dayOf(30), brief(after.json?.subscription?.paidThrough));
  }
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
console.log('\nLive HQ office access: not-started honesty, included period, lifetime, trial reset, price override, paid-through, offline payment clearing a restriction, attributed history, board states and provider lock-out all passed.');
