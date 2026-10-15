/**
 * Live software-only office: the kind, the gating and the agreement against
 * the shared dev Supabase project and the running api-server (STAFF_API_BASE,
 * default the preview proxy at http://localhost:80).
 *
 *   pnpm --filter @workspace/thinnr-operations run test:office-kind-live
 *
 * The rule bodies are proven with fakes elsewhere; this harness drives the
 * real HTTP surface and the real row-level security with disposable fixtures:
 *
 *   - a throwaway HQ admin (staff_role_assignments + auth user + active
 *     hq_memberships row);
 *   - a throwaway office created as SOFTWARE ONLY with its owner login and
 *     the launch waiver demonstration offices carry (no Stripe).
 *
 * It then walks the product the way the two sides would:
 *   HQ sees and filters the kind on the account directory and reads it on the
 *   detail; the owner's whoami and office access payloads carry it; the office
 *   files routes refuse the owner (and only the owner — HQ drilling in still
 *   reads); the training catalog comes back EMPTY for the owner's own token
 *   through PostgREST while HQ's service view still has rows; the setup
 *   snapshot shows the software agreement with HQ's current wording and the
 *   30-day window, and accepting it records the software agreement + version;
 *   the first sign-in clock ends 30 days out; HQ's access card says the same.
 *   Then HQ flips the office to THINNR reseller and every one of those facts
 *   flips with it — the proof that each one reads the kind, not a fixture.
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

/** PostgREST as the signed-in user: the row-level security the apps live under. */
async function asUser(token: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { apikey: ANON_KEY!, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
const patch = (token: string, path: string, body: unknown) => api(token, path, { method: 'PATCH', body: JSON.stringify(body) });

// ---------------------------------------------------------------- fixtures
const stamp = Date.now();
const password = `Qa-${stamp}!kind`;
const hqEmail = `qa-office-kind-hq-${stamp}@thinnr-qa.example.com`;
const ownerEmail = `qa-office-kind-owner-${stamp}@thinnr-qa.example.com`;
const officeId = `qa-office-kind-${stamp}`;
const officeName = `QA Software Practice ${stamp}`;
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
    display_name: 'QA Office Kind HQ', activated_at: new Date().toISOString(),
  });
  if (membership.status !== 201) throw new Error(`HQ membership failed (${membership.status}): ${brief(membership.json)}`);

  ids.ownerUserId = await createUser(ownerEmail, { thinnr_provisioned: 'true' });
  const office = await svc('POST', '/rest/v1/providers', {
    provider_id: officeId, office_name: officeName, provider_name: 'Dr. QA Software', provider_role: 'Practitioner',
    email: ownerEmail, auth_user_id: ids.ownerUserId, access_disabled: false, created_at: new Date().toISOString(),
    address_line_1: '1 Software Way', city: 'Austin', state: 'TX', postal_code: '78701', phone: '+15125550100',
    office_kind: 'software',
  });
  if (office.status !== 201) throw new Error(`office insert failed (${office.status}): ${brief(office.json)}`);
  ids.officeCreated = true;
  // A bare office sits behind the practice-setup gate; HQ's waiver on the
  // launch row lets this throwaway office use the workspace without Stripe.
  const launch = await svc('POST', '/rest/v1/practice_launch?on_conflict=provider_id', {
    provider_id: officeId, required: false, setup_override_at: new Date().toISOString(), setup_override_note: 'QA office kind live proof',
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
  console.log(`  ok  software-only office ${officeId} with owner + HQ admin`);
  const ownerSvc = () => svc('GET', `/rest/v1/providers?provider_id=eq.${enc(officeId)}&select=office_kind`);

  try {
    const detail = () => api(hq, `/provider-accounts/${enc(officeId)}`);
    const settings = await api(hq, '/hq/settings');
    check('HQ settings answer', settings.status === 200, brief(settings.json));
    const accessBilling = settings.json?.accessBilling ?? {};
    const softwareDays = Number(accessBilling.softwareIncludedPeriodDays);
    const resellerDays = Number(accessBilling.includedPeriodDays);
    check('HQ settings carry a software included period separate from the reseller one',
      Number.isFinite(softwareDays) && Number.isFinite(resellerDays) && softwareDays !== resellerDays,
      `software=${softwareDays} reseller=${resellerDays}`);
    check('HQ settings carry a software agreement text', typeof accessBilling.softwareAgreementText === 'string' && accessBilling.softwareAgreementText.length > 20);
    check('HQ settings keep the reseller disclosure text', typeof accessBilling.disclosureText === 'string' && accessBilling.disclosureText !== accessBilling.softwareAgreementText);

    console.log('\nHQ sees the kind');
    {
      const res = await detail();
      check('the account detail says software only', res.status === 200 && res.json?.account?.officeKind === 'software', `${res.status} ${brief(res.json)}`);
      const list = await api(hq, '/provider-accounts');
      const row = (list.json?.accounts ?? []).find((a: any) => a.id === officeId);
      check('the account list carries the kind', row?.officeKind === 'software', `${list.status} ${brief(row ?? list.json)}`);
      check('the list can be narrowed to software offices',
        (list.json?.accounts ?? []).filter((a: any) => a.officeKind === 'software').some((a: any) => a.id === officeId));
      const office = await api(hq, `/hq/office-access/${enc(officeId)}`);
      check('HQ access card knows the office is software only', office.json?.office?.officeKind === 'software', brief(office.json?.office));
      check('HQ access card describes the software window', office.json?.policy?.officeKind === 'software' && office.json?.policy?.includedPeriodDays === softwareDays, brief(office.json?.policy));
      check('the policy also carries both defaults', office.json?.policy?.resellerIncludedPeriodDays === resellerDays && office.json?.policy?.softwareIncludedPeriodDays === softwareDays, brief(office.json?.policy));
    }

    console.log('\nThe owner\'s clients learn the kind at sign-in');
    let includedEndsAt: string | null = null;
    {
      const who = await api(owner, '/claim/whoami');
      check('whoami answers', who.status === 200, brief(who.json));
      check('whoami carries the kind', who.json?.officeKind === 'software', brief(who.json));
      const access = await api(owner, '/office/access');
      check('office access answers', access.status === 200, brief(access.json));
      check('office access carries office_kind', access.json?.office_kind === 'software', brief(access.json));
      check('a software office is not narrowed on day one', access.json?.restricted === false, brief(access.json));
      // The owner's first dashboard sign-in rides the emailed-code login, which
      // this harness cannot complete; HQ's "restart the included period" uses
      // the same kind-resolved default through the same resolver, so it stands
      // in for the clock here (the sign-in path itself is unit-tested).
      const started = await post(hq, `/hq/office-access/${enc(officeId)}/reset-trial`, {});
      check('the standard clock starts without HQ naming a length', started.status === 200, `${started.status} ${brief(started.json)}`);
      const sub = await svc('GET', `/rest/v1/billing_office_access_subscriptions?provider_id=eq.${enc(officeId)}&select=included_period_ends_at`);
      includedEndsAt = sub.json?.[0]?.included_period_ends_at ?? null;
      const days = includedEndsAt ? Math.round((Date.parse(includedEndsAt) - Date.now()) / DAY_MS) : NaN;
      check('…and it is the SOFTWARE window, not the reseller one', Math.abs(days - softwareDays) <= 1 && Math.abs(days - resellerDays) > 1, `ends in ${days} days (${includedEndsAt})`);
      const history = await api(hq, `/hq/office-access/${enc(officeId)}`);
      check('the HQ card shows the software window ending', (history.json?.subscription?.includedPeriodEndsAt ?? '').slice(0, 10) === includedEndsAt?.slice(0, 10), brief(history.json?.subscription?.includedPeriodEndsAt));
    }

    console.log('\nMarketing Assets are refused for the office, not for HQ');
    {
      for (const path of ['/office/files', '/office/files/search?q=a', '/office/files/00000000-0000-0000-0000-000000000000/download-url', '/office/files/00000000-0000-0000-0000-000000000000/content']) {
        const res = await api(owner, path);
        check(`${path.split('?')[0]} → 404 office_kind for the owner`, res.status === 404 && res.json?.reason === 'office_kind', `${res.status} ${brief(res.json)}`);
      }
      const hqRead = await api(hq, `/office/files?office=${enc(officeId)}`);
      check('HQ drilling in still reads the drive', hqRead.status === 200, `${hqRead.status} ${brief(hqRead.json)}`);
    }

    console.log('\nTraining fails closed at the database');
    {
      const all = await svc('GET', '/rest/v1/training_courses?select=id&limit=5');
      check('the catalog has rows for the service view', Array.isArray(all.json) && all.json.length > 0, brief(all.json));
      const mine = await asUser(owner, '/rest/v1/training_courses?select=id&limit=5');
      check('the owner\'s own token reads an EMPTY catalog', mine.status === 200 && Array.isArray(mine.json) && mine.json.length === 0, `${mine.status} ${brief(mine.json)}`);
      const modules = await asUser(owner, '/rest/v1/training_modules?select=id&limit=5');
      check('…and no modules', modules.status === 200 && modules.json?.length === 0, brief(modules.json));
      const viewers = await asUser(owner, `/rest/v1/training_viewers?select=id&account_id=eq.${enc(officeId)}`);
      check('…and no learner roster', viewers.status === 200 && viewers.json?.length === 0, brief(viewers.json));
    }

    console.log('\nThe setup wizard shows the software agreement');
    let acceptedVersion: number | null = null;
    {
      const snap = await api(owner, '/billing/office/access');
      check('the setup snapshot answers for the owner', snap.status === 200, `${snap.status} ${brief(snap.json)}`);
      check('the disclosure is the software agreement', snap.json?.disclosure?.kind === 'software', brief(snap.json?.disclosure?.kind));
      check('its text is HQ\'s current software agreement', snap.json?.disclosure?.text === accessBilling.softwareAgreementText);
      check('the plan describes the software window', snap.json?.plan?.includedPeriodDays === softwareDays, brief(snap.json?.plan?.includedPeriodDays));
      const firstCharge = snap.json?.plan?.firstChargeAt ? Math.round((Date.parse(snap.json.plan.firstChargeAt) - Date.now()) / DAY_MS) : NaN;
      check('the first-charge estimate is the software window out', Math.abs(firstCharge - softwareDays) <= 1, `${firstCharge} days`);
      check('the list price is the same as a reseller\'s', snap.json?.plan?.monthlyPriceCents === 20_000 && snap.json?.plan?.yearlyPriceCents === 200_000, brief(snap.json?.plan));
      acceptedVersion = typeof snap.json?.disclosure?.version === 'number' ? snap.json.disclosure.version : null;
      const ack = await post(owner, '/billing/office/access/disclosure', { version: acceptedVersion ?? 0 });
      check('accepting the agreement answers 200', ack.status === 200, `${ack.status} ${brief(ack.json)}`);
      check('the snapshot shows it accepted', typeof ack.json?.disclosure?.acknowledgedAt === 'string', brief(ack.json?.disclosure));
      const row = await svc('GET', `/rest/v1/billing_office_access_subscriptions?provider_id=eq.${enc(officeId)}&select=disclosure_kind,disclosure_version,disclosure_acknowledged_at`);
      check('the record says WHICH agreement was accepted', row.json?.[0]?.disclosure_kind === 'software', brief(row.json));
      check('…and at which version', row.json?.[0]?.disclosure_version === acceptedVersion, brief(row.json));
      const events = await svc('GET', `/rest/v1/billing_office_access_events?provider_id=eq.${enc(officeId)}&event=eq.disclosure_acknowledged&select=detail`);
      check('the history names the agreement too', events.json?.[0]?.detail?.agreementKind === 'software', brief(events.json));
    }

    console.log('\nHQ flips the office to THINNR reseller — every fact follows');
    {
      const before = (await detail()).json?.account;
      if (!before) throw new Error('account detail unavailable for the kind flip');
      const body = {
        officeName: before.officeName, providerName: before.providerName, providerRole: before.providerRole,
        email: before.email, phone: before.phone, address1: before.address1, address2: before.address2,
        city: before.city, state: before.state, postalCode: before.postalCode, plan: before.plan, officeKind: 'reseller',
      };
      const changed = await patch(hq, `/provider-accounts/${enc(officeId)}`, body);
      check('HQ can change the kind', changed.status === 200 && changed.json?.account?.officeKind === 'reseller', `${changed.status} ${brief(changed.json)}`);
      check('the row says reseller', (await ownerSvc()).json?.[0]?.office_kind === 'reseller');
      const who = await api(owner, '/claim/whoami');
      check('whoami follows', who.json?.officeKind === 'reseller', brief(who.json?.officeKind));
      const access = await api(owner, '/office/access');
      check('office access follows', access.json?.office_kind === 'reseller', brief(access.json?.office_kind));
      const files = await api(owner, '/office/files');
      check('Marketing Assets open up', files.status === 200, `${files.status} ${brief(files.json)}`);
      const mine = await asUser(owner, '/rest/v1/training_courses?select=id&limit=5');
      check('the owner\'s token now reads the catalog', mine.status === 200 && mine.json?.length > 0, `${mine.status} ${brief(mine.json)}`);
      const snap = await api(owner, '/billing/office/access');
      check('the wizard shows the reseller disclosure', snap.json?.disclosure?.kind === 'reseller' && snap.json?.disclosure?.text === accessBilling.disclosureText, brief(snap.json?.disclosure?.kind));
      // The software agreement accepted a moment ago does not cover the reseller disclosure.
      check('the reseller disclosure reads NOT accepted yet', snap.json?.disclosure?.acknowledgedAt === null, brief(snap.json?.disclosure));
      check('…so the disclosure step reopens', snap.json?.steps?.find((s: any) => s.id === 'disclosure')?.status === 'todo' && snap.json?.complete === false, brief(snap.json?.steps));
      check('the plan describes the reseller window', snap.json?.plan?.includedPeriodDays === resellerDays, brief(snap.json?.plan?.includedPeriodDays));
      check('the clock already started is NOT rewritten by a kind change', (await svc('GET', `/rest/v1/billing_office_access_subscriptions?provider_id=eq.${enc(officeId)}&select=included_period_ends_at`)).json?.[0]?.included_period_ends_at === includedEndsAt);
      const office = await api(hq, `/hq/office-access/${enc(officeId)}`);
      check('HQ access card follows', office.json?.policy?.officeKind === 'reseller' && office.json?.policy?.includedPeriodDays === resellerDays, brief(office.json?.policy));
      const list = await api(hq, '/provider-accounts');
      check('the directory follows', (list.json?.accounts ?? []).find((a: any) => a.id === officeId)?.officeKind === 'reseller');
      // And back, through the same route, so the kind is a real two-way edit.
      const back = await patch(hq, `/provider-accounts/${enc(officeId)}`, { ...body, officeKind: 'software' });
      check('…and back to software only', back.status === 200 && back.json?.account?.officeKind === 'software', brief(back.json?.account?.officeKind));
      const again = await api(owner, '/billing/office/access');
      check('the software agreement accepted earlier counts again', again.json?.disclosure?.kind === 'software' && typeof again.json?.disclosure?.acknowledgedAt === 'string', brief(again.json?.disclosure));
      // The self-serve roster RPC resolves provider staff through their profile
      // row; give the owner one for this office so the refusal we reach is the
      // kind's, not the "own office" one every other caller gets.
      const staffed = await svc('PATCH', `/rest/v1/profiles?id=eq.${enc(ids.ownerUserId!)}`, { role: 'provider_staff', provider_account_code: officeId }, 'return=representation');
      check('the owner holds a staff profile for the office', staffed.status < 300 && staffed.json?.[0]?.provider_account_code === officeId, `${staffed.status} ${brief(staffed.json)}`);
      const training = await asUser(owner, '/rest/v1/rpc/training_add_staff', { p_account_id: officeId, p_name: 'Probe', p_email: `probe-${Date.now()}@example.invalid` });
      check('the owner cannot grow a training roster by calling the RPC directly', training.status >= 400 && JSON.stringify(training.json).includes('Training is not part of this office'), `${training.status} ${brief(training.json)}`);
      const omitted = await patch(hq, `/provider-accounts/${enc(officeId)}`, { ...body, officeKind: undefined });
      check('a form that omits the kind leaves it alone', omitted.status === 200 && omitted.json?.account?.officeKind === 'software', brief(omitted.json?.account?.officeKind));
    }

    console.log('\nThe owner cannot change the kind');
    {
      const res = await patch(owner, `/provider-accounts/${enc(officeId)}`, { officeKind: 'reseller' });
      check('the HQ route refuses the owner', res.status === 401 || res.status === 403, `${res.status}`);
    }
  } finally {
    await cleanup();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll live office-kind checks passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
