/**
 * Live HQ team invitations: one real invitation walked end to end against the
 * shared dev Supabase project and a running api-server.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:hq-team-live
 *
 * The route bodies and the page states are proven with fakes elsewhere. This
 * harness proves the parts only the live project can answer for: the
 * invitation function accepts the arguments the route actually sends, the
 * branded email leaves through the vendor, the emailed token resolves to the
 * invitee, the ordinary passwordless sign-in accepts that invitation and
 * leaves them inside HQ with their role active, and removal takes it away.
 *
 * Two deliberate accommodations, both about what a script cannot see:
 *
 *   - the invitee is Resend's own always-delivered test recipient, so the
 *     real send is proven without bouncing mail at an invented domain;
 *   - the plain setup token only ever exists inside the API process and the
 *     email, so after the invite this script re-stamps the stored hash with a
 *     token of its own and drives the lookup with that. The route's own
 *     token, hash and expiry are what the invite wrote; only the digest is
 *     swapped, so the lookup path under test is unchanged.
 *
 * Sign-in codes must come back inline, so point STAFF_API_BASE at an
 * api-server started with CLAIM_EMAIL_DELIVERY_MODE=dev (and
 * CLAIM_SMS_DELIVERY_MODE=dev when policy asks for the texted step).
 *
 * Every fixture is removed in `finally`; the append-only ledgers go through
 * the management API.
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
const SVC: Record<string, string> = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
const enc = encodeURIComponent;

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const brief = (value: unknown) => JSON.stringify(value)?.slice(0, 300) ?? '';

async function svc(method: string, path: string, body?: unknown, prefer = 'return=representation'): Promise<{ status: number; json: any }> {
  const response = await fetch(`${BASE}${path}`, {
    method, headers: { ...SVC, Prefer: prefer },
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
  if (!response.ok) console.error(`  !!  management query failed (${response.status}): ${(await response.text()).slice(0, 200)}`);
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

async function signIn(email: string, password: string): Promise<string> {
  const response = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON_KEY!, 'Content-Type': 'application/json' },
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

/**
 * The setup token as the invitee receives it. The API process is the only
 * place the plain token exists, and it names the delivered message in its
 * send log, so point HQ_LIVE_SERVER_LOG at that log (and keep RESEND_API_KEY
 * in the environment) to prove the link that actually left the building.
 */
async function mailedSetupToken(): Promise<string | null> {
  const logPath = process.env.HQ_LIVE_SERVER_LOG;
  const resendKey = process.env.RESEND_API_KEY;
  if (!logPath || !resendKey) return null;
  try {
    const { readFile } = await import('node:fs/promises');
    // Pretty-printed server logs colour their keys; drop the escapes first.
    const log = (await readFile(logPath, 'utf8')).replace(/\u001b\[[0-9;]*m/g, '');
    const sent = [...log.matchAll(/messageId: "([0-9a-f-]+)"/g)].map((match) => match[1]);
    // The newest send is usually the invitation, but the process mails other
    // things too: walk back until one carries a setup link.
    for (const messageId of sent.slice(-6).reverse()) {
      const response = await fetch(`https://api.resend.com/emails/${messageId}`, { headers: { Authorization: `Bearer ${resendKey}` } });
      const json: any = await response.json();
      const link = String(json?.html ?? '').match(/\/hq-setup\?token=([A-Za-z0-9_-]+)/);
      if (link) return link[1];
    }
    return null;
  } catch (error) {
    console.error(`  !!  could not read the delivered invitation: ${(error as Error).message}`);
    return null;
  }
}

/** Redeem the magic-link hash the auth routes return, the way the app does. */
async function redeem(tokenHash: string): Promise<string> {
  const response = await fetch(`${BASE}/auth/v1/verify`, {
    method: 'POST', headers: { apikey: ANON_KEY!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'email', token_hash: tokenHash }),
  });
  const json: any = await response.json();
  if (!json.access_token) throw new Error(`session redemption failed: ${brief(json)}`);
  return json.access_token;
}

async function createUser(email: string, password: string, appMetadata: Record<string, string>): Promise<string> {
  const created = await svc('POST', '/auth/v1/admin/users', { email, password, email_confirm: true, app_metadata: appMetadata });
  const id = created.json?.id;
  if (typeof id !== 'string') throw new Error(`could not create auth user ${email}: ${brief(created.json)}`);
  return id;
}

// ---------------------------------------------------------------- fixtures
const stamp = Date.now();
const QA_PREFIX = 'qa-hq-team-';
const password = `Qa-${stamp}!hqteam`;
const hqEmail = `${QA_PREFIX}admin-${stamp}@thinnr-qa.example.com`;
/** Resend's always-delivered test recipient: a real send, no real mailbox. */
const inviteeEmail = 'delivered@resend.dev';
const inviteeName = 'Quinn Liveproof';

const ids: { hqUserId: string | null; inviteeUserId: string | null; memberId: string | null } = {
  hqUserId: null, inviteeUserId: null, memberId: null,
};

/** Anything a previous run left behind at the fixed invitee address. */
async function clearInvitee(): Promise<void> {
  const members = await svc('GET', `/rest/v1/hq_memberships?email=ilike.${enc(inviteeEmail)}&select=id`);
  for (const row of Array.isArray(members.json) ? members.json : []) {
    await svc('DELETE', `/rest/v1/hq_invitations?membership_id=eq.${enc(row.id)}`, undefined, 'return=minimal');
    await svc('DELETE', `/rest/v1/hq_memberships?id=eq.${enc(row.id)}`, undefined, 'return=minimal');
  }
  const users = await svc('GET', `/auth/v1/admin/users?page=1&per_page=50&filter=${enc(inviteeEmail)}`);
  for (const user of (users.json?.users ?? []) as Array<{ id: string; email?: string }>) {
    if (String(user.email ?? '').toLowerCase() === inviteeEmail) {
      await managementQuery(`delete from public.auth_sign_ins where user_id = '${user.id}';`);
      await svc('DELETE', `/auth/v1/admin/users/${user.id}`, undefined, 'return=minimal');
    }
  }
  await svc('DELETE', `/rest/v1/staff_role_assignments?email=ilike.${enc(inviteeEmail)}`, undefined, 'return=minimal');
}

async function createFixtures(): Promise<string> {
  await clearInvitee();
  await svc('POST', '/rest/v1/staff_role_assignments', { email: hqEmail, role: 'hq_admin' });
  ids.hqUserId = await createUser(hqEmail, password, { thinnr_provisioned: 'true' });
  const membership = await svc('POST', '/rest/v1/hq_memberships', {
    email: hqEmail, auth_user_id: ids.hqUserId, status: 'active', department_role: 'admin',
    display_name: 'QA HQ Admin', activated_at: new Date().toISOString(),
  });
  if (membership.status !== 201) throw new Error(`HQ membership insert failed (${membership.status}): ${brief(membership.json)}`);

  const token = await signIn(hqEmail, password);
  // Fresh-code proof: the same ledger row the re-auth sheet stamps, so the
  // guarded removal below runs the path an administrator would.
  const signInRow = await svc('POST', '/rest/v1/auth_sign_ins', {
    user_id: ids.hqUserId, realm: 'staff', method: 'email_code', platform: 'web',
    device_fingerprint: `qa-hq-team-${stamp}`, session_id: sessionIdOf(token),
    code_verified_at: new Date().toISOString(),
  });
  if (signInRow.status !== 201) throw new Error(`sign-in ledger insert failed (${signInRow.status}): ${brief(signInRow.json)}`);
  return token;
}

async function cleanUp(): Promise<void> {
  if (ids.memberId) {
    await svc('DELETE', `/rest/v1/hq_invitations?membership_id=eq.${enc(ids.memberId)}`, undefined, 'return=minimal');
    await svc('DELETE', `/rest/v1/hq_memberships?id=eq.${enc(ids.memberId)}`, undefined, 'return=minimal');
  }
  await svc('DELETE', `/rest/v1/hq_memberships?email=ilike.${enc(hqEmail)}`, undefined, 'return=minimal');
  await svc('DELETE', `/rest/v1/staff_role_assignments?email=ilike.${enc(hqEmail)}`, undefined, 'return=minimal');
  await svc('DELETE', `/rest/v1/staff_role_assignments?email=ilike.${enc(inviteeEmail)}`, undefined, 'return=minimal');
  for (const userId of [ids.hqUserId, ids.inviteeUserId]) {
    if (!userId) continue;
    await managementQuery(`delete from public.auth_sign_ins where user_id = '${userId}';`);
    await svc('DELETE', `/auth/v1/admin/users/${userId}`, undefined, 'return=minimal');
  }
  // Append-only ledgers: management API, triggers off.
  await managementQuery(`
begin;
set local session_replication_role = replica;
delete from public.admin_audit_events where target_kind = 'hq_member' and target_id = '${ids.memberId ?? '00000000-0000-0000-0000-000000000000'}';
delete from public.claim_verifications where identifier ilike '${inviteeEmail}';
commit;`);
}

// ---------------------------------------------------------------- the walk
let hqToken = '';
try {
  console.log(`hq team live — api ${API_BASE}, project ${PROJECT_REF}`);
  hqToken = await createFixtures();

  console.log('\ninvite');
  const invited = await api(hqToken, '/hq-team', {
    method: 'POST',
    body: JSON.stringify({ name: inviteeName, email: inviteeEmail, role: 'support', title: 'QA live proof' }),
  });
  check('the live invitation function accepts the route\'s arguments',
    invited.status === 201, `${invited.status} ${invited.text.slice(0, 220)}`);
  ids.memberId = invited.json?.member?.id ?? null;
  check('the branded invitation email left through the vendor',
    invited.json?.invitation === 'sent', String(invited.json?.invitation));
  check('the roster row carries the invitation expiry',
    typeof invited.json?.member?.invitationExpiresAt === 'string' &&
    new Date(invited.json.member.invitationExpiresAt).valueOf() > Date.now(),
    String(invited.json?.member?.invitationExpiresAt));
  check('the same email is refused a second time, naming the stalled invitation',
    await (async () => {
      const again = await api(hqToken, '/hq-team', {
        method: 'POST',
        body: JSON.stringify({ name: inviteeName, email: inviteeEmail, role: 'support', title: '' }),
      });
      return again.status === 409 && again.json?.resendable?.memberId === ids.memberId;
    })());

  console.log('\nsetup link');
  const pending = await svc('GET', `/rest/v1/hq_invitations?membership_id=eq.${enc(ids.memberId!)}&status=eq.pending&select=id,expires_at`);
  check('the invite left one live invitation behind it',
    Array.isArray(pending.json) && pending.json.length === 1, brief(pending.json));

  let setupToken = await mailedSetupToken();
  if (setupToken) {
    console.log('  ··  using the token out of the delivered email');
  } else {
    // No readable mailbox: reissue the same invitation with a token this
    // process knows. The row is identical in every other respect, so the
    // lookup path under test is the one the emailed link uses.
    console.log('  ··  no readable mailbox; reissuing the invitation with a known token');
    setupToken = crypto.randomBytes(32).toString('base64url');
    await svc('DELETE', `/rest/v1/hq_invitations?id=eq.${enc(pending.json?.[0]?.id ?? '')}`, undefined, 'return=minimal');
    const reissued = await svc('POST', '/rest/v1/hq_invitations', {
      membership_id: ids.memberId, email: inviteeEmail,
      token_hash: crypto.createHash('sha256').update(setupToken).digest('hex'),
      expires_at: pending.json?.[0]?.expires_at, created_by: ids.hqUserId,
    });
    check('the reissued invitation is accepted by the live table',
      reissued.status === 201, `${reissued.status} ${brief(reissued.json)}`);
  }

  const lookup = await api(null, '/hq-team/invitation/lookup', { method: 'POST', body: JSON.stringify({ token: setupToken }) });
  check('the setup link opens without a session and greets the invitee',
    lookup.status === 200 && lookup.json?.state === 'pending' && lookup.json?.name === inviteeName &&
    lookup.json?.email === inviteeEmail && lookup.json?.role === 'Support',
    `${lookup.status} ${brief(lookup.json)}`);

  const unknown = await api(null, '/hq-team/invitation/lookup', {
    method: 'POST', body: JSON.stringify({ token: crypto.randomBytes(32).toString('base64url') }),
  });
  check('an unrecognised token answers without confirming anybody',
    unknown.status === 200 && unknown.json?.state === 'unknown' && !('email' in (unknown.json ?? {})),
    brief(unknown.json));

  console.log('\nsign-in from the link');
  const start = await api(null, '/auth/login/start', {
    method: 'POST', body: JSON.stringify({ realm: 'staff', identifier: inviteeEmail }),
  });
  const emailCode: string | null = start.json?.devCode ?? null;
  check('the invited address is recognised and a code is issued',
    start.status === 200 && typeof start.json?.requestId === 'string' && Boolean(emailCode),
    emailCode ? '' : `no dev code — start the api-server with CLAIM_EMAIL_DELIVERY_MODE=dev (${start.status} ${start.text.slice(0, 160)})`);

  let inviteeToken: string | null = null;
  if (emailCode) {
    const verified = await api(null, '/auth/login/verify', {
      method: 'POST', body: JSON.stringify({ requestId: start.json.requestId, code: emailCode }),
    });
    if (verified.json?.secondFactor) {
      // Policy asks for the texted step: drive it the way the setup page does.
      const step = verified.json.secondFactor;
      const phone = `+1555${String(stamp).slice(-7)}`;
      const smsStart = await api(null, '/auth/login/phone/start', {
        method: 'POST',
        body: JSON.stringify({ stepToken: step.stepToken, mode: step.mode, phone: step.mode === 'enroll' ? phone : undefined }),
      });
      const smsCode: string | null = smsStart.json?.devCode ?? null;
      check('the texted step issues its own code',
        smsStart.status === 200 && Boolean(smsCode),
        smsCode ? '' : `${smsStart.status} ${smsStart.text.slice(0, 160)}`);
      if (smsCode) {
        const smsVerified = await api(null, '/auth/login/phone/verify', {
          method: 'POST', body: JSON.stringify({ stepToken: step.stepToken, requestId: smsStart.json.requestId, code: smsCode }),
        });
        inviteeToken = smsVerified.json?.tokenHash ? await redeem(smsVerified.json.tokenHash) : null;
        if (!inviteeToken) console.error(`      texted step: ${smsVerified.status} ${smsVerified.text.slice(0, 200)}`);
      }
    } else {
      inviteeToken = verified.json?.tokenHash ? await redeem(verified.json.tokenHash) : null;
    }
    check('the one-time code signs the invitee in', Boolean(inviteeToken), brief(verified.json).slice(0, 200));
  }

  if (inviteeToken) {
    ids.inviteeUserId = JSON.parse(Buffer.from(inviteeToken.split('.')[1], 'base64url').toString('utf8')).sub ?? null;
    const session = await api(inviteeToken, '/hq-session');
    check('they land inside HQ with their role active',
      session.status === 200, `${session.status} ${session.text.slice(0, 200)}`);
    const row = await svc('GET', `/rest/v1/hq_memberships?id=eq.${enc(ids.memberId!)}&select=status,department_role,auth_user_id`);
    check('the membership is activated against the invited role',
      row.json?.[0]?.status === 'active' && row.json?.[0]?.department_role === 'support' && Boolean(row.json?.[0]?.auth_user_id),
      brief(row.json));
    const invitation = await svc('GET', `/rest/v1/hq_invitations?membership_id=eq.${enc(ids.memberId!)}&select=status`);
    check('the invitation is marked accepted', invitation.json?.[0]?.status === 'accepted', brief(invitation.json));

    const used = await api(null, '/hq-team/invitation/lookup', { method: 'POST', body: JSON.stringify({ token: setupToken }) });
    check('the spent link reports itself used, not pending', used.json?.state === 'used', brief(used.json));

    console.log('\nremoval');
    const removed = await api(hqToken, `/hq-team/${enc(ids.memberId!)}`, { method: 'DELETE' });
    check('removal succeeds and reports the sessions it ended',
      removed.status === 200 && removed.json?.revoked === true && removed.json?.sessionInvalidation === 'complete',
      `${removed.status} ${removed.text.slice(0, 200)}`);
    const after = await api(inviteeToken, '/hq-session');
    check('their access is gone immediately afterwards', after.status === 401 || after.status === 403, String(after.status));
  }
} catch (error) {
  failures += 1;
  console.error(`FAIL  harness error — ${(error as Error).message}`);
} finally {
  await cleanUp().catch((error: unknown) => console.error(`  !!  cleanup failed: ${(error as Error).message}`));
}

if (failures > 0) {
  console.error(`\n${failures} live HQ team check(s) failed.`);
  process.exit(1);
}
console.log('\nAll live HQ team invitation checks passed.');
