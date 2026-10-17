/**
 * Live reseller agreement date: HQ records the day a reseller office signed
 * its agreement and the office's included period follows it — against the
 * shared dev Supabase project and the running api-server (STAFF_API_BASE,
 * default the preview proxy at http://localhost:80).
 *
 *   pnpm --filter @workspace/thinnr-operations run test:reseller-agreement-live
 *
 * The rule bodies are proven with fakes and a temporary Postgres elsewhere;
 * this harness drives the real HTTP surface with disposable fixtures:
 *
 *   - a throwaway HQ admin (staff_role_assignments + auth user + active
 *     hq_memberships row);
 *   - a throwaway RESELLER office with its owner login and the launch waiver
 *     demonstration offices carry (no Stripe), created with NO agreement date.
 *
 * Then, the way HQ and the office would see it:
 *   with no date the office has no included period yet (first sign-in is the
 *   clock); HQ records a date → the account carries it, the period starts on
 *   that UTC day and ends the organization's reseller period later, HQ's
 *   access card and the owner's setup snapshot both name that day; HQ corrects
 *   the date to one more than a period ago → the period is already over, the
 *   office is NOT restricted (setup incomplete, next pass collects), the card
 *   says billing already started; HQ records a paid-through date and moves the
 *   agreement again → the paid coverage stands; HQ clears the date → the period
 *   falls back to the owner's first sign-in (none yet: no period); a software
 *   flip ignores the date entirely.
 *
 * Fixtures are removed in `finally`: append-only ledgers through the
 * management API, everything else through PostgREST.
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
const lit = (value: string) => `'${value.replace(/'/g, "''")}'`;
const isoDay = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10);
const utcMidnight = (day: string) => `${day}T00:00:00.000Z`;
const plusDays = (day: string, days: number) => new Date(Date.parse(utcMidnight(day)) + days * DAY_MS).toISOString();
const sameInstant = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && Date.parse(a) === Date.parse(b);

async function svc(method: string, path: string, body?: unknown, prefer = 'return=representation'): Promise<{ status: number; json: any }> {
  const response = await fetch(`${BASE}${path}`, { method, headers: { ...SVC_HEADERS, Prefer: prefer }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* empty body */ }
  return { status: response.status, json };
}

async function managementQuery(query: string): Promise<void> {
  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
  });
  const text = await response.text();
  if (response.status >= 300) throw new Error(`management query failed (${response.status}): ${text.slice(0, 300)}`);
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
const post = (token: string, path: string, body: unknown) => api(token, path, { method: 'POST', body: JSON.stringify(body) });
const patch = (token: string, path: string, body: unknown) => api(token, path, { method: 'PATCH', body: JSON.stringify(body) });

// ---------------------------------------------------------------- fixtures
const stamp = Date.now();
const password = `Qa-${stamp}!agreement`;
const hqEmail = `qa-agreement-hq-${stamp}@thinnr-qa.example.com`;
const ownerEmail = `qa-agreement-owner-${stamp}@thinnr-qa.example.com`;
const officeId = `qa-agreement-${stamp}`;
const officeName = `QA Reseller Practice ${stamp}`;
const ids: { hqUserId: string | null; ownerUserId: string | null; officeCreated: boolean } = { hqUserId: null, ownerUserId: null, officeCreated: false };

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
    email: hqEmail, auth_user_id: ids.hqUserId, status: 'active', department_role: 'admin', display_name: 'QA Agreement HQ', activated_at: new Date().toISOString(),
  });
  if (membership.status !== 201) throw new Error(`HQ membership failed (${membership.status}): ${brief(membership.json)}`);

  ids.ownerUserId = await createUser(ownerEmail, { thinnr_provisioned: 'true' });
  const office = await svc('POST', '/rest/v1/providers', {
    provider_id: officeId, office_name: officeName, provider_name: 'Dr. QA Reseller', provider_role: 'Practitioner',
    email: ownerEmail, auth_user_id: ids.ownerUserId, access_disabled: false, created_at: new Date().toISOString(),
    address_line_1: '1 Reseller Way', city: 'Austin', state: 'TX', postal_code: '78701', phone: '+15125550101',
    office_kind: 'reseller',
  });
  if (office.status !== 201) throw new Error(`office insert failed (${office.status}): ${brief(office.json)}`);
  ids.officeCreated = true;
  const launch = await svc('POST', '/rest/v1/practice_launch?on_conflict=provider_id', {
    provider_id: officeId, required: false, setup_override_at: new Date().toISOString(), setup_override_note: 'QA reseller agreement live proof',
  }, 'resolution=merge-duplicates,return=minimal');
  if (launch.status >= 300) throw new Error(`launch waiver failed (${launch.status}): ${brief(launch.json)}`);
  return { hq: await signIn(hqEmail, password), owner: await signIn(ownerEmail, password) };
}

async function cleanup() {
  console.log('\nCleanup');
  const users = [ids.hqUserId, ids.ownerUserId].filter((v): v is string => Boolean(v));
  const userList = users.map(lit).join(',');
  try {
    await managementQuery(`
begin;
set local session_replication_role = replica;
delete from public.billing_office_access_events where provider_id = ${lit(officeId)};
delete from public.billing_office_access_attempts where provider_id = ${lit(officeId)};
delete from public.billing_office_access_instruments where provider_id = ${lit(officeId)};
delete from public.billing_office_access_subscriptions where provider_id = ${lit(officeId)};
delete from public.admin_audit_events where provider_id = ${lit(officeId)}${users.length ? ` or actor_user_id in (${userList})` : ''};
delete from public.practice_launch where provider_id = ${lit(officeId)};
delete from public.auth_sign_ins where ${users.length ? `user_id in (${userList})` : 'false'};
delete from public.claim_verifications where identifier in (${[hqEmail, ownerEmail].map(lit).join(',')});
commit;`);
    console.log('  ok  ledgers cleared');
  } catch (error) {
    console.error(`  !!  ledger cleanup failed: ${(error as Error).message}`);
  }
  const steps: Array<[string, string]> = [
    ['profiles', `/rest/v1/profiles?id=in.(${users.join(',')})`],
    ['providers', `/rest/v1/providers?provider_id=eq.${enc(officeId)}`],
    ['hq_memberships', `/rest/v1/hq_memberships?email=eq.${enc(hqEmail)}`],
    ['staff_role_assignments', `/rest/v1/staff_role_assignments?email=eq.${enc(hqEmail)}`],
  ];
  for (const [label, path] of steps) {
    const res = await svc('DELETE', path, undefined, 'return=minimal');
    console.log(`  ${res.status < 300 ? 'ok ' : '!! '} ${label} (${res.status})`);
  }
  for (const [label, id] of [['hq user', ids.hqUserId], ['owner user', ids.ownerUserId]] as const) {
    if (!id) continue;
    const res = await svc('DELETE', `/auth/v1/admin/users/${id}`, undefined, 'return=minimal');
    console.log(`  ${res.status < 300 ? 'ok ' : '!! '} ${label} (${res.status})`);
  }
}

// ---------------------------------------------------------------- proof
async function main() {
  console.log('Fixtures');
  const { hq, owner } = await createFixtures();
  console.log(`  ok  reseller office ${officeId} with owner + HQ admin, no agreement date`);

  try {
    const detail = () => api(hq, `/provider-accounts/${enc(officeId)}`);
    const card = () => api(hq, `/hq/office-access/${enc(officeId)}`);
    const subRow = async () => (await svc('GET', `/rest/v1/billing_office_access_subscriptions?provider_id=eq.${enc(officeId)}&select=included_period_started_at,included_period_ends_at,paid_through,owner_first_sign_in_at,restricted_at`)).json?.[0] ?? null;
    const accountBody = (account: any, extra: Record<string, unknown>) => ({
      officeName: account.officeName, providerName: account.providerName, providerRole: account.providerRole,
      email: account.email, phone: account.phone, address1: account.address1, address2: account.address2,
      city: account.city, state: account.state, postalCode: account.postalCode, plan: account.plan, officeKind: account.officeKind,
      ...extra,
    });

    const settings = await api(hq, '/hq/settings');
    const resellerDays = Number(settings.json?.accessBilling?.includedPeriodDays);
    check('HQ settings name the reseller included period', Number.isFinite(resellerDays) && resellerDays > 0, `${settings.status} ${brief(settings.json?.accessBilling)}`);

    console.log('\nNo date: first sign-in is still the clock');
    {
      const res = await detail();
      check('the account detail carries an empty agreement date', res.status === 200 && res.json?.account?.resellerAgreementSignedOn === null, `${res.status} ${brief(res.json?.account)}`);
      const office = await card();
      check('HQ access card: no agreement date, no anchored billing start',
        office.status === 200 && office.json?.office?.resellerAgreementSignedOn === null && office.json?.office?.agreementBillingStartsAt === null, `${office.status} ${brief(office.json?.office)}`);
      check('…and the included period has not started (no subscription row yet)', office.json?.subscription == null || office.json?.subscription?.includedPeriodEndsAt == null, brief(office.json?.subscription));
    }

    console.log('\nHQ records the agreement date');
    const signedOn = isoDay(100);
    let account: any;
    {
      const before = (await detail()).json?.account;
      const saved = await patch(hq, `/provider-accounts/${enc(officeId)}`, accountBody(before, { resellerAgreementSignedOn: signedOn }));
      check('the edit answers 200', saved.status === 200, `${saved.status} ${brief(saved.json)}`);
      account = saved.json?.account;
      check('the account now carries the date', account?.resellerAgreementSignedOn === signedOn, brief(account));
      const row = await subRow();
      check('the included period starts on the agreement day (UTC)', sameInstant(row?.included_period_started_at, utcMidnight(signedOn)), brief(row));
      check(`…and ends ${resellerDays} days after it`, sameInstant(row?.included_period_ends_at, plusDays(signedOn, resellerDays)), brief(row));
      check('the owner has still not signed in (fallback clock untouched)', row?.owner_first_sign_in_at === null, brief(row));
      const office = await card();
      check('HQ access card names the date and the anchored billing start',
        office.json?.office?.resellerAgreementSignedOn === signedOn && sameInstant(office.json?.office?.agreementBillingStartsAt, plusDays(signedOn, resellerDays)), brief(office.json?.office));
      check('…and the subscription window matches it', sameInstant(office.json?.subscription?.includedPeriodEndsAt, plusDays(signedOn, resellerDays)) && office.json?.subscription?.state === 'included_period', brief(office.json?.subscription));
      const events = office.json?.events ?? office.json?.history ?? [];
      check('the ledger records the anchoring', Array.isArray(events) && events.some((e: any) => e.event === 'agreement_anchored' || e.kind === 'agreement_anchored'), brief(events.slice(0, 3)));
      const snap = await api(owner, '/billing/office/access');
      check('the owner\'s setup snapshot states the anchored first-charge day', snap.status === 200 && sameInstant(snap.json?.plan?.firstChargeAt, plusDays(signedOn, resellerDays)), `${snap.status} ${brief(snap.json?.plan)}`);
      const access = await api(owner, '/office/access');
      check('the office is not restricted', access.status === 200 && access.json?.restricted === false, brief(access.json));
    }

    console.log('\nHQ corrects the date to one more than a period ago');
    const elapsedOn = isoDay(resellerDays + 40);
    {
      const saved = await patch(hq, `/provider-accounts/${enc(officeId)}`, accountBody(account, { resellerAgreementSignedOn: elapsedOn }));
      check('the correction answers 200', saved.status === 200 && saved.json?.account?.resellerAgreementSignedOn === elapsedOn, `${saved.status} ${brief(saved.json)}`);
      account = saved.json?.account ?? account;
      const row = await subRow();
      check('the period re-anchors to the new day', sameInstant(row?.included_period_started_at, utcMidnight(elapsedOn)) && sameInstant(row?.included_period_ends_at, plusDays(elapsedOn, resellerDays)), brief(row));
      check('…which is already behind us', Date.parse(row?.included_period_ends_at ?? '') < Date.now(), brief(row));
      check('the office is NOT silently restricted', row?.restricted_at === null, brief(row));
      const office = await card();
      check('HQ sees the elapsed window, setup still incomplete (the next pass collects)', office.json?.subscription?.state === 'setup_incomplete', brief(office.json?.subscription));
      const access = await api(owner, '/office/access');
      check('the owner\'s dashboard is open', access.status === 200 && access.json?.restricted === false, brief(access.json));
      const snap = await api(owner, '/billing/office/access');
      check('the setup snapshot states the (past) first-charge day for the elapsed copy', sameInstant(snap.json?.plan?.firstChargeAt, plusDays(elapsedOn, resellerDays)), brief(snap.json?.plan));
    }

    console.log('\nPaid coverage is never shortened by a date change');
    const paidThrough = new Date(Date.now() + 200 * DAY_MS).toISOString();
    {
      const paid = await post(hq, `/hq/office-access/${enc(officeId)}/paid-through`, { paidThrough, source: 'hq_migration', note: 'QA live proof' });
      check('HQ records a paid-through date', paid.status === 200 && sameInstant(paid.json?.subscription?.paidThrough, paidThrough), `${paid.status} ${brief(paid.json?.subscription)}`);
      const laterOn = isoDay(resellerDays + 10);
      const saved = await patch(hq, `/provider-accounts/${enc(officeId)}`, accountBody(account, { resellerAgreementSignedOn: laterOn }));
      check('moving the agreement again answers 200', saved.status === 200, `${saved.status} ${brief(saved.json)}`);
      account = saved.json?.account ?? account;
      const office = await card();
      check('the paid-through date stands and the office is paid current',
        sameInstant(office.json?.subscription?.paidThrough, paidThrough) && office.json?.subscription?.state === 'paid_current', brief(office.json?.subscription));
      const row = await subRow();
      check('…while the included period follows the corrected date', sameInstant(row?.included_period_started_at, utcMidnight(laterOn)), brief(row));
    }

    console.log('\nAn unrelated edit leaves the period alone');
    {
      const row0 = await subRow();
      const saved = await patch(hq, `/provider-accounts/${enc(officeId)}`, accountBody(account, { phone: '+15125550199' }));
      check('the edit answers 200 and keeps the date', saved.status === 200 && saved.json?.account?.resellerAgreementSignedOn === account.resellerAgreementSignedOn, `${saved.status} ${brief(saved.json?.account)}`);
      account = saved.json?.account ?? account;
      const row1 = await subRow();
      check('the period is byte-identical', JSON.stringify(row0) === JSON.stringify(row1), `${brief(row0)} vs ${brief(row1)}`);
    }

    console.log('\nA hand-set period survives a save of the same date (the anchoring for it is on record)');
    {
      const handEndsAt = new Date(Date.now() + 90 * DAY_MS).toISOString();
      const set = await post(hq, `/hq/office-access/${enc(officeId)}/included-period`, { endsAt: handEndsAt });
      check('HQ sets the included period by hand', set.status === 200 && sameInstant(set.json?.subscription?.includedPeriodEndsAt, handEndsAt), `${set.status} ${brief(set.json?.subscription)}`);
      const saved = await patch(hq, `/provider-accounts/${enc(officeId)}`, accountBody(account, { resellerAgreementSignedOn: account.resellerAgreementSignedOn }));
      check('saving the same date answers 200', saved.status === 200, `${saved.status} ${brief(saved.json)}`);
      const row = await subRow();
      check('…and the hand-set period stands (the live history filter found the recorded anchoring)', sameInstant(row?.included_period_ends_at, handEndsAt), brief(row));
    }

    console.log('\nHQ clears the date: back to the first-sign-in clock');
    {
      const saved = await patch(hq, `/provider-accounts/${enc(officeId)}`, accountBody(account, { resellerAgreementSignedOn: null }));
      check('clearing answers 200 with an empty date', saved.status === 200 && saved.json?.account?.resellerAgreementSignedOn === null, `${saved.status} ${brief(saved.json)}`);
      account = saved.json?.account ?? account;
      const row = await subRow();
      check('with no sign-in yet there is no included period again', row?.included_period_started_at === null && row?.included_period_ends_at === null, brief(row));
      check('the paid-through coverage still stands', sameInstant(row?.paid_through, paidThrough), brief(row));
      const office = await card();
      check('HQ access card: no date, no anchored start', office.json?.office?.resellerAgreementSignedOn === null && office.json?.office?.agreementBillingStartsAt === null, brief(office.json?.office));
    }

    console.log('\nA software-only office ignores the date');
    {
      const saved = await patch(hq, `/provider-accounts/${enc(officeId)}`, accountBody(account, { officeKind: 'software', resellerAgreementSignedOn: signedOn }));
      check('the flip answers 200', saved.status === 200 && saved.json?.account?.officeKind === 'software', `${saved.status} ${brief(saved.json)}`);
      const row = await subRow();
      check('the period is not anchored for a software office', row?.included_period_started_at === null, brief(row));
      const office = await card();
      check('HQ access card shows no agreement billing start for software', office.json?.office?.agreementBillingStartsAt === null, brief(office.json?.office));
    }

    console.log('\nThe owner cannot set the date');
    {
      const res = await patch(owner, `/provider-accounts/${enc(officeId)}`, { resellerAgreementSignedOn: signedOn });
      check('the owner is refused', res.status === 401 || res.status === 403, `${res.status} ${brief(res.json)}`);
    }

    if (failures > 0) throw new Error(`${failures} live reseller agreement check(s) failed`);
    console.log('\nAll live reseller agreement checks passed.');
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
