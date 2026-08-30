/**
 * Staff sign-in provisioning — live end-to-end check of POST /api/staff-logins
 * plus the passwordless first login it sets up.
 *
 * Drives the REAL serving path (proxy → API server → Supabase) the way the
 * account page does, then proves the outcome with service-role reads and a
 * real email-code sign-in:
 *
 *   1. Only a signed-in HQ member with provider_manage may provision —
 *      anonymous callers and office staff get 401 (they are not HQ
 *      identities), and an HQ member whose department lacks the permission
 *      gets 403.
 *   2. Field validation is specific: missing name / bad email / unknown
 *      office each name the offending field. There is no password field
 *      anywhere in the contract.
 *   3. The happy path provisions an INVITED login: pre-approval row written,
 *      canonical team_members row created unlinked, and NO auth user yet.
 *   4. The new staffer's FIRST sign-in is an email code: /api/auth/login
 *      start → verify mints a token hash, GoTrue turns it into a session,
 *      and the signup trigger elevates the profile and links the office
 *      roster row — scoped exactly to their office.
 *   5. A spent code cannot be replayed, duplicates are refused (409) without
 *      re-pointing the existing person's office, and the start endpoint
 *      answers hits and misses with the same shape.
 *   6. The provider OWNER's first email-code login provisions a usable
 *      office workspace: provider_staff profile scoped to the office, linked
 *      provider row, pre-approval row, and office roster row — never the
 *      claimed-workspace placeholder.
 *   7. A staff login created BEFORE the provisioning rail existed (claim
 *      markers, linked row, no profile) is repaired into that same office
 *      workspace on its next proven code.
 *
 * In live email mode the suite never sees the sent code, so it overwrites
 * the ledger row's code hash with a hash of a code it knows (service-role
 * write) — the send caps, attempt counting, and consumption mechanics stay
 * fully real. In dev mode it just uses the returned devCode.
 *
 * Live suite — needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY +
 * SUPABASE_ANON_KEY and the API server running (the `artifacts/api-server`
 * workflow). Deliberately NOT part of the hermetic validation gates.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:staff-logins
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

async function signIn(email: string, password: string): Promise<string | null> {
  const response = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json: any = await response.json().catch(() => null);
  return response.status === 200 && typeof json?.access_token === 'string' ? json.access_token : null;
}

async function asUser(token: string, method: string, path: string): Promise<{ status: number; json: any }> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { apikey: ANON_KEY!, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const json: any = await response.json().catch(() => null);
  return { status: response.status, json };
}

async function api(
  path: string,
  body: unknown,
  token?: string | null,
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
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

const provision = (token: string | null, body: unknown) => api('/api/staff-logins', body, token);

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

/**
 * Get a usable login code for a ledger row: dev mode hands it to us; in live
 * mode we overwrite the row's hash with one we can answer (service role).
 */
async function obtainCode(requestId: string, devCode: string | undefined): Promise<string> {
  if (devCode) return devCode;
  const KNOWN = '531642';
  const row = await svc('GET', `/rest/v1/claim_verifications?id=eq.${requestId}&select=code_salt`);
  const salt = row.json?.[0]?.code_salt;
  if (typeof salt !== 'string' || salt.length === 0) throw new Error('ledger row has no code salt to rewrite');
  const patched = await svc('PATCH', `/rest/v1/claim_verifications?id=eq.${requestId}`, {
    code_hash: sha256(salt + KNOWN),
  });
  if (patched.status >= 300) throw new Error(`code injection failed (${patched.status})`);
  return KNOWN;
}

async function main() {
  const ts = Date.now();
  const PASSWORD = `Qa!${ts}staff`; // mechanics only: throwaway HQ/office fixtures sign in directly with GoTrue
  const hqEmail = `qa-hq-${ts}@thinnr-staff-check.com`;
  const contentEmail = `qa-content-${ts}@thinnr-staff-check.com`;
  const officeEmail = `qa-office-${ts}@thinnr-staff-check.com`;
  const newEmail = `qa-provisioned-${ts}@thinnr-staff-check.com`;
  const rejectedEmail = `qa-rejected-${ts}@thinnr-staff-check.com`;
  const ownerEmail = `qa-owner-${ts}@thinnr-staff-check.com`;
  const legacyEmail = `qa-legacy-${ts}@thinnr-staff-check.com`;
  const allEmails = [hqEmail, contentEmail, officeEmail, newEmail, rejectedEmail, ownerEmail, legacyEmail];
  const userIds: string[] = [];
  let officeId = '';

  try {
    // -- Reachability: the API server must be up before anything else. --
    const health = await fetch(`${API_BASE}/api/healthz`).catch(() => null);
    if (!health || !health.ok) {
      throw new Error(`API server unreachable at ${API_BASE} — start the artifacts/api-server workflow first.`);
    }

    // -- Setup: throwaway HQ admin + low-permission HQ member (mechanics sign-in). --
    for (const [email, name] of [
      [hqEmail, 'QA HQ Admin'],
      [contentEmail, 'QA HQ Content'],
    ] as const) {
      const created = await svc('POST', '/auth/v1/admin/users', {
        email,
        password: PASSWORD,
        email_confirm: true,
        user_metadata: { display_name: name },
      });
      const id = created.json?.id ?? created.json?.user?.id;
      if ((created.status !== 200 && created.status !== 201) || !id)
        throw new Error(`admin create failed (${created.status}): ${JSON.stringify(created.json)}`);
      userIds.push(id);
    }
    const [hqId, contentId] = userIds;
    for (const [email, authUserId, role, name] of [
      [hqEmail, hqId, 'admin', 'QA HQ Admin'],
      [contentEmail, contentId, 'content', 'QA HQ Content'],
    ] as const) {
      const membership = await svc('POST', '/rest/v1/hq_memberships', {
        email,
        auth_user_id: authUserId,
        status: 'active',
        department_role: role,
        display_name: name,
        activated_at: new Date().toISOString(),
      });
      if (membership.status !== 201)
        throw new Error(`hq membership insert failed (${membership.status}): ${JSON.stringify(membership.json)}`);
    }

    const hqToken = await signIn(hqEmail, PASSWORD);
    const contentToken = await signIn(contentEmail, PASSWORD);
    if (!hqToken || !contentToken) throw new Error('could not sign in the QA HQ accounts');

    console.log('1. New offices require a contact-only office phone');
    const noPhone = await api(
      '/api/provider-accounts',
      { officeName: 'QA Passwordless Office', providerName: 'QA Owner', email: ownerEmail, plan: 'Core' },
      hqToken,
    );
    check('missing office phone → 400 phone', noPhone.status === 400 && noPhone.json?.field === 'phone',
      `${noPhone.status} ${JSON.stringify(noPhone.json)}`);
    const officeCreate = await api(
      '/api/provider-accounts',
      {
        officeName: 'QA Passwordless Office',
        providerName: 'QA Owner',
        providerRole: 'Owner',
        email: ownerEmail,
        phone: '(813) 555-0100',
        city: 'Tampa',
        state: 'FL',
        plan: 'Core',
      },
      hqToken,
    );
    officeId = String(officeCreate.json?.account?.id ?? '');
    check(
      'office created with the phone on file',
      officeCreate.status === 201 && officeId.length > 0 && officeCreate.json?.account?.phone === '(813) 555-0100',
      `${officeCreate.status} ${JSON.stringify(officeCreate.json).slice(0, 200)}`,
    );
    if (!officeId) throw new Error('cannot continue without a throwaway office');

    // Office staffer fixture: pre-approval first so the signup trigger scopes them.
    const officeAssignment = await svc('POST', '/rest/v1/staff_role_assignments', {
      email: officeEmail,
      role: 'provider_staff',
      provider_account_code: officeId,
    });
    if (officeAssignment.status !== 201)
      throw new Error(`assignment insert failed (${officeAssignment.status}): ${JSON.stringify(officeAssignment.json)}`);
    const officeUser = await svc('POST', '/auth/v1/admin/users', {
      email: officeEmail,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: 'QA Office Staff' },
    });
    const officeUserId = officeUser.json?.id ?? officeUser.json?.user?.id;
    if ((officeUser.status !== 200 && officeUser.status !== 201) || !officeUserId)
      throw new Error(`office user create failed (${officeUser.status}): ${JSON.stringify(officeUser.json)}`);
    userIds.push(officeUserId);
    const officeToken = await signIn(officeEmail, PASSWORD);
    if (!officeToken) throw new Error('could not sign in the QA office account');

    console.log('2. Only provider_manage HQ staff may provision');
    const anon = await provision(null, {});
    check('anonymous caller gets 401', anon.status === 401, String(anon.status));
    const asStaff = await provision(officeToken, {
      accountId: officeId,
      firstName: 'Nope',
      lastName: 'Nope',
      email: rejectedEmail,
    });
    check('office staff is not an HQ identity → 401', asStaff.status === 401, String(asStaff.status));
    const asContent = await provision(contentToken, {
      accountId: officeId,
      firstName: 'Nope',
      lastName: 'Nope',
      email: rejectedEmail,
    });
    check('content-department HQ member gets 403', asContent.status === 403, String(asContent.status));

    console.log('3. Field validation names the offending field (no password anywhere)');
    const noFirst = await provision(hqToken, {
      accountId: officeId,
      firstName: '  ',
      lastName: 'Person',
      email: rejectedEmail,
    });
    check('missing first name → 400 firstName', noFirst.status === 400 && noFirst.json?.field === 'firstName',
      `${noFirst.status} ${JSON.stringify(noFirst.json)}`);
    const badEmail = await provision(hqToken, {
      accountId: officeId,
      firstName: 'QA',
      lastName: 'Person',
      email: 'not-an-email',
    });
    check('bad email → 400 email', badEmail.status === 400 && badEmail.json?.field === 'email',
      `${badEmail.status} ${JSON.stringify(badEmail.json)}`);
    const badOffice = await provision(hqToken, {
      accountId: 'acct-does-not-exist',
      firstName: 'QA',
      lastName: 'Person',
      email: rejectedEmail,
    });
    check('unknown office → 409 accountId', badOffice.status === 409 && badOffice.json?.field === 'accountId',
      `${badOffice.status} ${JSON.stringify(badOffice.json)}`);
    const rejectedAssignment = await svc(
      'GET',
      `/rest/v1/staff_role_assignments?email=eq.${encodeURIComponent(rejectedEmail)}&select=email`,
    );
    check('rejected attempts leave no assignment behind', Array.isArray(rejectedAssignment.json) && rejectedAssignment.json.length === 0);

    console.log('4. Happy path provisions an INVITED login — no password, no auth user yet');
    const happy = await provision(hqToken, {
      accountId: officeId,
      firstName: 'QA',
      lastName: 'Provisioned',
      email: newEmail,
    });
    check('201 with the invited staff summary', happy.status === 201 && happy.json?.staff?.accountId === officeId,
      `${happy.status} ${JSON.stringify(happy.json).slice(0, 160)}`);
    check('summary carries the full name', happy.json?.staff?.name === 'QA Provisioned', happy.json?.staff?.name);
    check('summary says invited, not active', happy.json?.staff?.status === 'invited', happy.json?.staff?.status);

    const memberRow = await svc(
      'GET',
      `/rest/v1/team_members?email=ilike.${encodeURIComponent(newEmail)}&select=id,provider_id,name,activation_status,auth_user_id`,
    );
    const member = Array.isArray(memberRow.json) ? memberRow.json[0] : null;
    check(
      'canonical staff row filed under the office, unlinked until first login',
      Boolean(member) && member.provider_id === officeId && member.activation_status === 'activated' && member.auth_user_id === null,
      JSON.stringify(member),
    );
    const users = await svc('GET', '/auth/v1/admin/users?page=1&per_page=1000');
    const userList: any[] = Array.isArray(users.json?.users) ? users.json.users : [];
    check(
      'no auth user exists until the first code sign-in',
      !userList.some((user) => String(user?.email ?? '').toLowerCase() === newEmail),
    );

    console.log('5. First sign-in is an email code, scoped to the office');
    const start = await api('/api/auth/login/start', { realm: 'staff', identifier: newEmail });
    check('login start answers ok with a request id', start.status === 200 && start.json?.ok === true && typeof start.json?.requestId === 'string',
      `${start.status} ${JSON.stringify(start.json).slice(0, 120)}`);
    const ledgerRow = await svc(
      'GET',
      `/rest/v1/claim_verifications?id=eq.${start.json.requestId}&select=purpose,account_type,identifier_kind`,
    );
    check(
      'ledger row is a staff login row',
      ledgerRow.json?.[0]?.purpose === 'login' && ledgerRow.json?.[0]?.account_type === 'team_member' && ledgerRow.json?.[0]?.identifier_kind === 'email',
      JSON.stringify(ledgerRow.json),
    );

    const code = await obtainCode(start.json.requestId, start.json.devCode);
    const wrong = await api('/api/auth/login/verify', { requestId: start.json.requestId, code: code === '000000' ? '111111' : '000000' });
    check('a wrong code is refused', wrong.status === 400, String(wrong.status));
    const verify = await api('/api/auth/login/verify', { requestId: start.json.requestId, code });
    check(
      'the right code answers with a staff token hash',
      verify.status === 200 && verify.json?.ok === true && verify.json?.realm === 'staff' && typeof verify.json?.tokenHash === 'string',
      `${verify.status} ${JSON.stringify(verify.json).slice(0, 120)}`,
    );

    const session = await fetch(`${BASE}/auth/v1/verify`, {
      method: 'POST',
      headers: { apikey: ANON_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'email', token_hash: verify.json.tokenHash }),
    });
    const sessionJson: any = await session.json().catch(() => null);
    const newToken: string | null = typeof sessionJson?.access_token === 'string' ? sessionJson.access_token : null;
    const newUserId: string | null = sessionJson?.user?.id ?? null;
    check('the token hash becomes a real session', newToken !== null && newUserId !== null,
      `${session.status} ${JSON.stringify(sessionJson).slice(0, 120)}`);
    if (newUserId) userIds.push(newUserId);

    const profileRow = await svc(
      'GET',
      `/rest/v1/profiles?id=eq.${newUserId}&select=role,provider_account_code`,
    );
    check(
      'profile elevated to provider_staff at the office',
      profileRow.json?.[0]?.role === 'provider_staff' && profileRow.json?.[0]?.provider_account_code === officeId,
      JSON.stringify(profileRow.json?.[0]),
    );
    const linkedMember = await svc(
      'GET',
      `/rest/v1/team_members?email=ilike.${encodeURIComponent(newEmail)}&select=auth_user_id`,
    );
    check('staff row linked to the new sign-in', linkedMember.json?.[0]?.auth_user_id === newUserId,
      JSON.stringify(linkedMember.json));
    const viewerRow = await svc(
      'GET',
      `/rest/v1/training_viewers?email=eq.${encodeURIComponent(newEmail)}&select=account_id,auth_user_id,is_demo,name`,
    );
    const viewer = Array.isArray(viewerRow.json) ? viewerRow.json[0] : null;
    check(
      'roster row linked under the office, not demo data',
      Boolean(viewer) && viewer.account_id === officeId && viewer.auth_user_id === newUserId && viewer.is_demo === false,
      JSON.stringify(viewer),
    );
    if (newToken) {
      const ownRows = await asUser(newToken, 'GET', `/rest/v1/training_viewers?select=email,account_id&limit=1000`);
      const rows: any[] = Array.isArray(ownRows.json) ? ownRows.json : [];
      check('new staffer sees their own office roster row', rows.some((row) => row.email === newEmail && row.account_id === officeId));
    }

    const replay = await api('/api/auth/login/verify', { requestId: start.json.requestId, code });
    check('a spent code cannot be replayed', replay.status === 400, String(replay.status));

    console.log('6. Duplicates refused without side effects; hits and misses share a shape');
    const dupe = await provision(hqToken, {
      accountId: officeId,
      firstName: 'QA',
      lastName: 'Duplicate',
      email: newEmail,
    });
    check('409 naming the email field', dupe.status === 409 && dupe.json?.field === 'email',
      `${dupe.status} ${JSON.stringify(dupe.json)}`);
    const hqDupe = await provision(hqToken, {
      accountId: officeId,
      firstName: 'QA',
      lastName: 'Collision',
      email: hqEmail,
    });
    check('HQ member email refused with 409', hqDupe.status === 409 && hqDupe.json?.field === 'email',
      `${hqDupe.status} ${JSON.stringify(hqDupe.json)}`);
    const assignmentAfter = await svc(
      'GET',
      `/rest/v1/staff_role_assignments?email=eq.${encodeURIComponent(newEmail)}&select=provider_account_code,role`,
    );
    check(
      'existing assignment untouched (still the original office)',
      assignmentAfter.json?.[0]?.provider_account_code === officeId && assignmentAfter.json?.[0]?.role === 'provider_staff',
      JSON.stringify(assignmentAfter.json),
    );

    const miss = await api('/api/auth/login/start', { realm: 'staff', identifier: `qa-ghost-${ts}@thinnr-staff-check.com` });
    check(
      'a miss answers with the same shape as a hit',
      miss.status === 200 && JSON.stringify(Object.keys(miss.json ?? {}).sort()) === JSON.stringify(Object.keys(start.json ?? {}).sort()),
      `${miss.status} ${JSON.stringify(Object.keys(miss.json ?? {}))} vs ${JSON.stringify(Object.keys(start.json ?? {}))}`,
    );

    console.log('7. Provider OWNER first code login lands in a usable office workspace');
    const ownerStart = await api('/api/auth/login/start', { realm: 'staff', identifier: ownerEmail });
    check(
      'owner login start answers ok with a request id',
      ownerStart.status === 200 && ownerStart.json?.ok === true && typeof ownerStart.json?.requestId === 'string',
      `${ownerStart.status} ${JSON.stringify(ownerStart.json).slice(0, 120)}`,
    );
    const ownerLedger = await svc(
      'GET',
      `/rest/v1/claim_verifications?id=eq.${ownerStart.json.requestId}&select=purpose,account_type,identifier_kind`,
    );
    check(
      'ledger row is a provider login row',
      ownerLedger.json?.[0]?.purpose === 'login' && ownerLedger.json?.[0]?.account_type === 'provider',
      JSON.stringify(ownerLedger.json),
    );
    const ownerCode = await obtainCode(ownerStart.json.requestId, ownerStart.json.devCode);
    const ownerVerify = await api('/api/auth/login/verify', { requestId: ownerStart.json.requestId, code: ownerCode });
    check(
      'owner code mints a staff token hash',
      ownerVerify.status === 200 && ownerVerify.json?.ok === true && ownerVerify.json?.realm === 'staff' && typeof ownerVerify.json?.tokenHash === 'string',
      `${ownerVerify.status} ${JSON.stringify(ownerVerify.json).slice(0, 120)}`,
    );
    const ownerSession = await fetch(`${BASE}/auth/v1/verify`, {
      method: 'POST',
      headers: { apikey: ANON_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'email', token_hash: ownerVerify.json.tokenHash }),
    });
    const ownerSessionJson: any = await ownerSession.json().catch(() => null);
    const ownerToken: string | null = typeof ownerSessionJson?.access_token === 'string' ? ownerSessionJson.access_token : null;
    const ownerUserId: string | null = ownerSessionJson?.user?.id ?? null;
    check('owner token hash becomes a real session', ownerToken !== null && ownerUserId !== null,
      `${ownerSession.status} ${JSON.stringify(ownerSessionJson).slice(0, 120)}`);
    if (ownerUserId) userIds.push(ownerUserId);

    const ownerProfile = await svc('GET', `/rest/v1/profiles?id=eq.${ownerUserId}&select=role,provider_account_code`);
    check(
      'owner profile routes to the office desk, not the claimed placeholder',
      ownerProfile.json?.[0]?.role === 'provider_staff' && ownerProfile.json?.[0]?.provider_account_code === officeId,
      JSON.stringify(ownerProfile.json),
    );
    const providerLink = await svc('GET', `/rest/v1/providers?provider_id=eq.${encodeURIComponent(officeId)}&select=auth_user_id`);
    check('provider row linked to the owner login', providerLink.json?.[0]?.auth_user_id === ownerUserId,
      JSON.stringify(providerLink.json));
    const ownerAssignment = await svc(
      'GET',
      `/rest/v1/staff_role_assignments?email=eq.${encodeURIComponent(ownerEmail)}&select=role,provider_account_code`,
    );
    check(
      'owner pre-approval row written for future assignment syncs',
      ownerAssignment.json?.[0]?.role === 'provider_staff' && ownerAssignment.json?.[0]?.provider_account_code === officeId,
      JSON.stringify(ownerAssignment.json),
    );
    const ownerViewer = await svc(
      'GET',
      `/rest/v1/training_viewers?email=eq.${encodeURIComponent(ownerEmail)}&select=account_id,auth_user_id,is_demo`,
    );
    check(
      'owner roster row filed under the office, not demo data',
      ownerViewer.json?.[0]?.account_id === officeId && ownerViewer.json?.[0]?.auth_user_id === ownerUserId && ownerViewer.json?.[0]?.is_demo === false,
      JSON.stringify(ownerViewer.json),
    );
    if (ownerToken) {
      const ownerRows = await asUser(ownerToken, 'GET', `/rest/v1/training_viewers?select=email,account_id&limit=1000`);
      const rows: any[] = Array.isArray(ownerRows.json) ? ownerRows.json : [];
      check('owner JWT reads their own office roster row (RLS-level access)',
        rows.some((row) => row.email === ownerEmail && row.account_id === officeId));
    }

    console.log('8. A claim-marked legacy login is repaired into the office workspace');
    // The shape from before the provisioning rail existed: linked auth user
    // carrying claim markers, no pre-approval row, no profiles row — exactly
    // what used to park on the claimed-workspace placeholder.
    const legacyMemberId = crypto.randomUUID();
    const legacyInsert = await svc('POST', '/rest/v1/team_members', {
      id: legacyMemberId,
      provider_id: officeId,
      name: 'QA Legacy Staffer',
      email: legacyEmail,
      activation_status: 'activated',
    });
    if (legacyInsert.status !== 201) throw new Error(`legacy member insert failed (${legacyInsert.status}): ${JSON.stringify(legacyInsert.json)}`);
    const legacyUser = await svc('POST', '/auth/v1/admin/users', {
      email: legacyEmail,
      email_confirm: true,
      app_metadata: { thinnr_claim: 'team_member', thinnr_claim_ref: legacyMemberId },
      user_metadata: { display_name: 'QA Legacy Staffer' },
    });
    const legacyUserId: string | null = legacyUser.json?.id ?? legacyUser.json?.user?.id ?? null;
    if ((legacyUser.status !== 200 && legacyUser.status !== 201) || !legacyUserId)
      throw new Error(`legacy user create failed (${legacyUser.status}): ${JSON.stringify(legacyUser.json)}`);
    userIds.push(legacyUserId);
    await svc('PATCH', `/rest/v1/team_members?id=eq.${legacyMemberId}`, { auth_user_id: legacyUserId });
    const beforeProfile = await svc('GET', `/rest/v1/profiles?id=eq.${legacyUserId}&select=role`);
    check('legacy login starts with no profile (the broken shape)',
      Array.isArray(beforeProfile.json) && beforeProfile.json.length === 0, JSON.stringify(beforeProfile.json));

    const legacyStart = await api('/api/auth/login/start', { realm: 'staff', identifier: legacyEmail });
    check('legacy staffer can start a login', legacyStart.status === 200 && typeof legacyStart.json?.requestId === 'string',
      `${legacyStart.status} ${JSON.stringify(legacyStart.json).slice(0, 120)}`);
    const legacyCode = await obtainCode(legacyStart.json.requestId, legacyStart.json.devCode);
    const legacyVerify = await api('/api/auth/login/verify', { requestId: legacyStart.json.requestId, code: legacyCode });
    check('legacy staffer code mints a session', legacyVerify.status === 200 && typeof legacyVerify.json?.tokenHash === 'string',
      `${legacyVerify.status} ${JSON.stringify(legacyVerify.json).slice(0, 120)}`);
    const legacyLink = await svc('GET', `/rest/v1/team_members?id=eq.${legacyMemberId}&select=auth_user_id`);
    check('repair reuses the existing login, no duplicate account', legacyLink.json?.[0]?.auth_user_id === legacyUserId,
      JSON.stringify(legacyLink.json));
    const legacyProfile = await svc('GET', `/rest/v1/profiles?id=eq.${legacyUserId}&select=role,provider_account_code`);
    check(
      'repair files the provider_staff profile at the office',
      legacyProfile.json?.[0]?.role === 'provider_staff' && legacyProfile.json?.[0]?.provider_account_code === officeId,
      JSON.stringify(legacyProfile.json),
    );
    const legacyMarker = await svc('GET', `/auth/v1/admin/users/${legacyUserId}`);
    check('provisioning marker set for future assignment syncs',
      legacyMarker.json?.app_metadata?.thinnr_provisioned === true,
      JSON.stringify(legacyMarker.json?.app_metadata));
    const legacyAssignment = await svc(
      'GET',
      `/rest/v1/staff_role_assignments?email=eq.${encodeURIComponent(legacyEmail)}&select=role,provider_account_code`,
    );
    check(
      'repair writes the pre-approval row at the office',
      legacyAssignment.json?.[0]?.role === 'provider_staff' && legacyAssignment.json?.[0]?.provider_account_code === officeId,
      JSON.stringify(legacyAssignment.json),
    );
    const legacyViewer = await svc(
      'GET',
      `/rest/v1/training_viewers?email=eq.${encodeURIComponent(legacyEmail)}&select=account_id,auth_user_id,is_demo`,
    );
    check(
      'repair links the office roster row',
      legacyViewer.json?.[0]?.account_id === officeId && legacyViewer.json?.[0]?.auth_user_id === legacyUserId && legacyViewer.json?.[0]?.is_demo === false,
      JSON.stringify(legacyViewer.json),
    );
  } finally {
    // -- Cleanup: ledger → completions → viewers → staff rows → assignments → memberships → users. --
    const emailList = allEmails.map((email) => `"${email}"`).join(',');
    await svc('DELETE', `/rest/v1/claim_verifications?identifier=in.(${emailList})`);
    const viewerRows = await svc('GET', `/rest/v1/training_viewers?email=in.(${emailList})&select=id`);
    const viewerIds: string[] = Array.isArray(viewerRows.json) ? viewerRows.json.map((row: any) => row.id) : [];
    if (viewerIds.length > 0) {
      await svc('DELETE', `/rest/v1/training_completions?viewer_id=in.(${viewerIds.join(',')})`);
      await svc('DELETE', `/rest/v1/training_viewers?id=in.(${viewerIds.join(',')})`);
    }
    await svc('DELETE', `/rest/v1/team_members?email=in.(${emailList})`);
    if (officeId) await svc('DELETE', `/rest/v1/providers?provider_id=eq.${encodeURIComponent(officeId)}`);
    await svc('DELETE', `/rest/v1/staff_role_assignments?email=in.(${emailList})`);
    await svc('DELETE', `/rest/v1/hq_memberships?email=in.(${emailList})`);
    for (const id of [...new Set(userIds)]) {
      await svc('DELETE', `/auth/v1/admin/users/${id}`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nStaff sign-in provisioning + passwordless first login hold end to end.');
}

void main().catch((error) => {
  console.error('Suite crashed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
