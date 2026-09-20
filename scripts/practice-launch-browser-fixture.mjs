#!/usr/bin/env node
/**
 * Explicit task 744 browser fixtures. No served credential helper, messages,
 * Stripe calls, global settings changes, or real-user mutations.
 *
 * node scripts/practice-launch-browser-fixture.mjs setup|status|refresh|verify|reset|cleanup --allow-live-fixtures
 * Private sessions: .cache/practice-launch-browser/{owner,teammate,hq}.json
 * Browser adapter: import { installLaunchFixture } from this file. It reads the
 * private session internally; never print its return values/storage contents.
 * installLaunchFixture(page, 'owner', { simulateStripe: true }) sets storage on
 * the existing app origin and installs strictly fixture-scoped route intercepts.
 *
 * LIMITATION: simulated pending Stripe and completion are browser-only. Details,
 * products and personal tour persist through actual APIs. Completion is NOT an
 * end-to-end test of Stripe sync or the server completion RPC. A browser reload
 * retains simulation within the same page; a new install starts it over.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../.cache/practice-launch-browser/', import.meta.url));
const statePath = `${directory}state.json`;
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const roles = ['owner', 'teammate', 'hq'];
function environment() {
  assert(process.env.NODE_ENV !== 'production', 'Production fixtures are forbidden');
  assert(process.env.REPLIT_DEV_DOMAIN, 'Run only in the development workspace');
  for (const key of ['SUPABASE_URL', 'SUPABASE_ACCESS_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY']) {
    assert(process.env[key], `${key} must be configured`);
  }
  return {
    url: process.env.SUPABASE_URL.replace(/\/$/, ''),
    project: new URL(process.env.SUPABASE_URL).hostname.split('.')[0],
  };
}
async function sql(query) {
  const { project } = environment();
  const response = await fetch(`https://api.supabase.com/v1/projects/${project}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }), signal: AbortSignal.timeout(30000),
  });
  assert(response.ok, `Fixture SQL failed (${response.status}); private recovery manifest retained`);
  return response.json();
}
async function auth(path, body, method = 'POST') {
  const { url } = environment();
  const response = await fetch(`${url}/auth/v1/${path}`, {
    method, headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000),
  });
  assert(response.ok, `Fixture auth failed (${response.status}); private recovery manifest retained`);
  return response.json();
}
async function save(state, exclusive = false) {
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600, flag: exclusive ? 'wx' : 'w' });
}
async function load() {
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.match(state.run, /^[0-9a-f-]{36}$/);
  assert.equal(state.providerId, `launch-browser-${state.run}`);
  assert.equal(state.project, environment().project, 'Project mismatch');
  for (const role of roles) assert.equal(state[role].email, `launch-${role}-${state.run}@example.com`);
  return state;
}
async function setup() {
  const { project } = environment();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const run = randomUUID();
  const state = { run, project, providerId: `launch-browser-${run}`, memberId: randomUUID() };
  for (const role of roles) state[role] = { email: `launch-${role}-${run}@example.com` };
  await save(state, true);
  for (const role of roles) {
    const password = randomBytes(36).toString('base64url');
    const user = await auth('admin/users', { email: state[role].email, password, email_confirm: true, user_metadata: { display_name: `Launch Browser ${role}` } });
    state[role].id = user.id ?? user.user?.id;
    assert.match(state[role].id, /^[0-9a-f-]{36}$/);
    await save(state);
    const session = await auth('token?grant_type=password', { email: state[role].email, password });
    session.expires_at ??= Math.floor(Date.now() / 1000) + session.expires_in;
    await writeFile(`${directory}${role}.json`, JSON.stringify({
      storageKey: `sb-${project}-auth-token`, session, providerId: state.providerId,
    }), { mode: 0o600 });
  }
  const p = quote(state.providerId);
  await sql(`begin;
    insert into public.providers
      (provider_id,provider_name,office_name,email,onboarding_code,access_disabled,auth_user_id,claimed_at,
       phone,address_line_1,city,state,postal_code)
    values (${p},'Launch Browser Owner','Launch Browser Practice',${quote(state.owner.email)},
      ${quote(String(randomInt(100000,1000000)))},false,${quote(state.owner.id)},now(),
      '(202) 555-0144','744 Example Avenue','Boston','MA','02108');
    insert into public.team_members(id,provider_id,name,email,activation_status,office_role,auth_user_id,claimed_at)
      values(${quote(state.memberId)},${p},'Launch Browser Teammate',${quote(state.teammate.email)},
        'activated','staff',${quote(state.teammate.id)},now());
    insert into public.hq_memberships(auth_user_id,email,display_name,department_role,status,activated_at)
      values(${quote(state.hq.id)},${quote(state.hq.email)},'Launch Browser HQ','admin','active',now());
    select public.provision_staff_login(${quote(state.owner.id)}::uuid,${quote(state.owner.email)},'Launch Browser Owner',${p});
    select public.provision_staff_login(${quote(state.teammate.id)}::uuid,${quote(state.teammate.email)},'Launch Browser Teammate',${p});
    insert into public.staff_second_factors(staff_kind,staff_ref,phone,verified_at,enabled)
      values ('provider',${p},'+12025550144',now(),true),
        ('team_member',${quote(state.memberId)},'+12025550145',now(),true);
    commit;`);
  console.log(JSON.stringify({ providerId: state.providerId, privateSessions: directory, message: 'Fixture identities ready. MFA is preseeded (not an MFA delivery test). No Stripe account created.' }));
}
async function status(state) {
  const [result] = await sql(`select
    (select row_to_json(p) from public.practice_launch p where provider_id=${quote(state.providerId)}) as launch,
    (select count(*) from public.practice_launch_tours where provider_id=${quote(state.providerId)}) as tour_rows,
    (select count(*) from public.practice_launch_completions where provider_id=${quote(state.providerId)}) as completion_rows,
    (select count(*) from public.billing_office_prices where provider_id=${quote(state.providerId)}) as price_rows,
    (select count(*) from public.billing_orders where provider_id=${quote(state.providerId)}) as orders`);
  console.log(JSON.stringify(result));
}
async function refresh(state) {
  for (const role of roles) {
    const password = randomBytes(36).toString('base64url');
    await auth(`admin/users/${state[role].id}`, { password }, 'PUT');
    const session = await auth('token?grant_type=password', { email: state[role].email, password });
    session.expires_at ??= Math.floor(Date.now() / 1000) + session.expires_in;
    await writeFile(`${directory}${role}.json`, JSON.stringify({
      storageKey: `sb-${state.project}-auth-token`, session, providerId: state.providerId,
    }), { mode: 0o600 });
  }
  console.log('Fresh private fixture sessions minted; practice details, prices and tour progress unchanged.');
}
async function verify(state) {
  for (const role of roles) {
    const envelope = JSON.parse(await readFile(`${directory}${role}.json`, 'utf8'));
    for (const origin of ['http://127.0.0.1:8080', 'http://localhost:80']) {
      const response = await fetch(`${origin}/api/office/launch${role === 'hq' ? `?office=${encodeURIComponent(state.providerId)}` : ''}`, {
        headers: { Authorization: `Bearer ${envelope.session.access_token}` },
      });
      const body = await response.json();
      console.log(JSON.stringify({
        role, origin, status: response.status, code: body.code ?? null,
        correctOffice: body.office?.providerId === state.providerId,
        canEdit: body.canEdit ?? null,
      }));
      assert.equal(response.status, 200, 'Authenticated launch verification failed');
      assert.equal(body.office?.providerId, state.providerId, 'Fixture office mismatch');
    }
  }
}
async function reset(state) {
  const p = quote(state.providerId);
  await sql(`begin;
    delete from public.practice_launch_tours where provider_id=${p};
    delete from public.practice_launch_completions where provider_id=${p};
    delete from public.practice_launch_product_receipts where provider_id=${p};
    delete from public.billing_office_prices where provider_id=${p};
    update public.practice_launch set required=true,version=0,details_confirmed=false,products_confirmed=false,completed_at=null where provider_id=${p};
    commit;`);
  console.log('Only fixture launch progress and fixture office prices reset. Reinstall browser adapter to clear simulated completion.');
}
async function cleanup(state) {
  const p = quote(state.providerId);
  const emails = roles.map(role => quote(state[role].email)).join(',');
  const users = `select id from auth.users where email in (${emails})`;
  await sql(`begin;
    set local session_replication_role=replica;
    delete from public.admin_audit_events where provider_id=${p} or actor_user_id in (${users});
    set local session_replication_role=origin;
    delete from public.staff_second_factors where (staff_kind='provider' and staff_ref=${p})
      or (staff_kind='team_member' and staff_ref=${quote(state.memberId)});
    delete from public.practice_launch_tours where provider_id=${p};
    delete from public.practice_launch_completions where provider_id=${p};
    delete from public.practice_launch_product_receipts where provider_id=${p};
    delete from public.billing_office_prices where provider_id=${p};
    delete from public.claim_verifications where identifier in (${emails});
    delete from public.training_viewers where auth_user_id in (${users});
    delete from public.hq_memberships where email=${quote(state.hq.email)} and is_protected_owner=false;
    delete from public.team_members where id=${quote(state.memberId)} and provider_id=${p};
    delete from public.profiles where id in (${users});
    delete from public.providers where provider_id=${p};
    commit;`);
  const remainingUsers = await sql(`select id from auth.users where email in (${emails})`);
  for (const user of remainingUsers) await auth(`admin/users/${user.id}`, null, 'DELETE');
  const [counts] = await sql(`select
    (select count(*) from auth.users where email in (${emails})) as users,
    (select count(*) from public.providers where provider_id=${p}) as offices,
    (select count(*) from public.practice_launch where provider_id=${p}) as launches,
    (select count(*) from public.practice_launch_tours where provider_id=${p}) as tours,
    (select count(*) from public.billing_office_prices where provider_id=${p}) as prices`);
  for (const count of Object.values(counts)) assert.equal(Number(count), 0, 'Cleanup incomplete; manifest retained');
  await rm(directory, { recursive: true });
  console.log('Fixture cleanup verified; private session files removed.');
}

/** Playwright adapter: no exported token or credential-bearing public page. */
export async function installLaunchFixture(page, role = 'owner', { simulateStripe = false } = {}) {
  assert(roles.includes(role), 'Unknown fixture role');
  const origin = new URL(page.url()).origin;
  assert(/^https?:\/\//.test(origin), 'Open the running development app origin before installing fixture');
  const envelope = JSON.parse(await readFile(`${directory}${role}.json`, 'utf8'));
  assert(envelope.providerId.startsWith('launch-browser-'), 'Non-fixture account refused');
  let completedAt = null;
  // No Stripe writes permitted even if someone clicks existing Connect controls.
  await page.route('**/api/billing/**', async route => {
    const request = route.request();
    if (request.method() !== 'GET' || /\/connect\//.test(request.url())) {
      return route.fulfill({ status: 409, json: { error: 'Browser fixture: Stripe and payment writes are disabled.' } });
    }
    return route.continue();
  });
  if (simulateStripe) {
    await page.route('**/api/office/launch**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.endsWith('/complete')) {
        if (role !== 'owner') return route.continue();
        // Fetch only the real scoped read; never call the real Stripe sync.
        url.pathname = '/api/office/launch';
        const response = await route.fetch({ url: url.toString(), method: 'GET', postData: undefined });
        if (!response.ok()) return route.fulfill({ response });
        const snapshot = await response.json();
        assert.equal(snapshot.office.providerId, envelope.providerId);
        if (!snapshot.detailsConfirmed || !snapshot.productsConfirmed || !snapshot.security.ready) {
          return route.fulfill({ status: 409, json: { error: 'Confirm real fixture details and products before simulated completion.' } });
        }
        completedAt = new Date().toISOString();
        return route.fulfill({ json: { ...snapshot, payments: { ...snapshot.payments, state: 'pending' }, completedAt } });
      }
      const response = await route.fetch();
      if (!response.ok()) return route.fulfill({ response });
      const snapshot = await response.json();
      assert.equal(snapshot.office.providerId, envelope.providerId);
      return route.fulfill({ response, json: { ...snapshot, payments: { ...snapshot.payments, state: 'pending' }, completedAt } });
    });
  }
  await page.evaluate(({ storageKey, session }) => {
    localStorage.setItem(storageKey, JSON.stringify(session));
    localStorage.setItem('thinnr-ops-code-login-at', String(Date.now()));
    sessionStorage.removeItem('thinnr-ops-persona');
  }, envelope);
  await page.goto(`${origin}${role === 'hq' ? `/admin/accounts/${encodeURIComponent(envelope.providerId)}/office` : '/'}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const command = process.argv[2];
    assert(['setup', 'status', 'refresh', 'verify', 'reset', 'cleanup'].includes(command) && process.argv.includes('--allow-live-fixtures'),
      'Usage: node scripts/practice-launch-browser-fixture.mjs setup|status|refresh|verify|reset|cleanup --allow-live-fixtures');
    if (command === 'setup') await setup();
    else {
      const state = await load();
      if (command === 'status') await status(state);
      else if (command === 'refresh') await refresh(state);
      else if (command === 'verify') await verify(state);
      else if (command === 'reset') await reset(state);
      else await cleanup(state);
    }
  } catch (error) {
    console.error(error.code === 'EEXIST' ? 'Existing fixture manifest: cleanup before setup.'
      : error.code === 'ENOENT' ? 'No private fixture manifest found.' : error.message);
    process.exitCode = 1;
  }
}