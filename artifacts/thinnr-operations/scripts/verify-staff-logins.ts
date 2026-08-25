/**
 * Staff sign-in provisioning — live end-to-end check of POST /api/staff-logins.
 *
 * Drives the REAL serving path (proxy → API server → Supabase) the way the
 * account page does, then proves the outcome with service-role reads and a
 * real password sign-in:
 *
 *   1. Only a real signed-in HQ admin may provision — anonymous callers get
 *      401 and office staff get 403.
 *   2. Field validation is specific: missing name / bad email / short
 *      password each return 400 naming the offending field.
 *   3. The happy path creates a working login: profile elevated under the
 *      office, roster viewer linked (with the optional phone carried over),
 *      and the new staffer's email + password sign in immediately, scoped to
 *      the office.
 *   4. A duplicate email is refused (409) WITHOUT re-pointing the existing
 *      person's office — the assignment row must stay untouched.
 *   5. Existing revocation still bites newly provisioned staff: deleting the
 *      assignment unlinks the roster row from the sign-in.
 *
 * Live suite — needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY +
 * SUPABASE_ANON_KEY and the API server running (the `artifacts/api-server`
 * workflow). Deliberately NOT part of the hermetic validation gates. No
 * passwords are ever printed.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:staff-logins
 */

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

async function provision(token: string | null, body: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${API_BASE}/api/staff-logins`, {
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

async function main() {
  const ts = Date.now();
  const PASSWORD = `Qa!${ts}staff`;
  const hqEmail = `qa-hq-${ts}@thinnr-staff-check.com`;
  const officeEmail = `qa-office-${ts}@thinnr-staff-check.com`;
  const newEmail = `qa-provisioned-${ts}@thinnr-staff-check.com`;
  const rejectedEmail = `qa-rejected-${ts}@thinnr-staff-check.com`;
  const allEmails = [hqEmail, officeEmail, newEmail, rejectedEmail];
  const userIds: string[] = [];

  try {
    // -- Reachability: the API server must be up before anything else. --
    const health = await fetch(`${API_BASE}/api/healthz`).catch(() => null);
    if (!health || !health.ok) {
      throw new Error(`API server unreachable at ${API_BASE} — start the artifacts/api-server workflow first.`);
    }

    // -- Setup: a throwaway HQ admin + a throwaway office staffer. --
    for (const [email, role, code] of [
      [hqEmail, 'hq_admin', null],
      [officeEmail, 'provider_staff', 'acct-p1'],
    ] as const) {
      const ins = await svc('POST', '/rest/v1/staff_role_assignments', {
        email,
        role,
        provider_account_code: code,
      });
      if (ins.status !== 201) throw new Error(`assignment insert failed (${ins.status}): ${JSON.stringify(ins.json)}`);
    }
    for (const [email, name] of [
      [hqEmail, 'QA HQ Admin'],
      [officeEmail, 'QA Office Staff'],
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
    const hqToken = await signIn(hqEmail, PASSWORD);
    const officeToken = await signIn(officeEmail, PASSWORD);
    if (!hqToken || !officeToken) throw new Error('could not sign in the QA accounts');

    console.log('1. Only a real HQ admin may provision');
    const anon = await provision(null, {});
    check('anonymous caller gets 401', anon.status === 401, String(anon.status));
    const asStaff = await provision(officeToken, {
      accountId: 'acct-p1',
      firstName: 'Nope',
      lastName: 'Nope',
      email: `qa-nope-${ts}@thinnr-staff-check.com`,
      password: 'Password!123',
    });
    check('office staff gets 403', asStaff.status === 403, String(asStaff.status));

    console.log('2. Field validation names the offending field');
    const noFirst = await provision(hqToken, {
      accountId: 'acct-p1',
      firstName: '  ',
      lastName: 'Person',
      email: rejectedEmail,
      password: 'Password!123',
    });
    check('missing first name → 400 firstName', noFirst.status === 400 && noFirst.json?.field === 'firstName',
      `${noFirst.status} ${JSON.stringify(noFirst.json)}`);
    const badEmail = await provision(hqToken, {
      accountId: 'acct-p1',
      firstName: 'QA',
      lastName: 'Person',
      email: 'not-an-email',
      password: 'Password!123',
    });
    check('bad email → 400 email', badEmail.status === 400 && badEmail.json?.field === 'email',
      `${badEmail.status} ${JSON.stringify(badEmail.json)}`);
    const shortPw = await provision(hqToken, {
      accountId: 'acct-p1',
      firstName: 'QA',
      lastName: 'Person',
      email: rejectedEmail,
      password: 'short',
    });
    check('short password → 400 password', shortPw.status === 400 && shortPw.json?.field === 'password',
      `${shortPw.status} ${JSON.stringify(shortPw.json)}`);
    const rejectedAssignment = await svc(
      'GET',
      `/rest/v1/staff_role_assignments?email=eq.${encodeURIComponent(rejectedEmail)}&select=email`,
    );
    check('rejected attempts leave no assignment behind', Array.isArray(rejectedAssignment.json) && rejectedAssignment.json.length === 0);

    console.log('3. Happy path provisions a working office login');
    const happy = await provision(hqToken, {
      accountId: 'acct-p1',
      firstName: 'QA',
      lastName: 'Provisioned',
      email: newEmail,
      phone: '(555) 010-2233',
      password: PASSWORD,
    });
    check('201 with the staff summary', happy.status === 201 && happy.json?.staff?.accountId === 'acct-p1',
      `${happy.status} ${JSON.stringify(happy.json).slice(0, 160)}`);
    check('summary carries the full name', happy.json?.staff?.name === 'QA Provisioned', happy.json?.staff?.name);

    const viewerRow = await svc(
      'GET',
      `/rest/v1/training_viewers?email=eq.${encodeURIComponent(newEmail)}&select=id,name,phone,account_id,auth_user_id,is_demo`,
    );
    const viewer = Array.isArray(viewerRow.json) ? viewerRow.json[0] : null;
    check(
      'roster row linked under the office, not demo data',
      Boolean(viewer) && viewer.account_id === 'acct-p1' && Boolean(viewer.auth_user_id) && viewer.is_demo === false,
      JSON.stringify(viewer),
    );
    check('optional phone carried onto the roster row', viewer?.phone === '(555) 010-2233', viewer?.phone);
    if (viewer?.auth_user_id) userIds.push(viewer.auth_user_id);

    const profileRow = await svc(
      'GET',
      `/rest/v1/profiles?id=eq.${viewer?.auth_user_id}&select=role,provider_account_code`,
    );
    check(
      'profile elevated to provider_staff @ acct-p1',
      profileRow.json?.[0]?.role === 'provider_staff' && profileRow.json?.[0]?.provider_account_code === 'acct-p1',
      JSON.stringify(profileRow.json?.[0]),
    );

    const newToken = await signIn(newEmail, PASSWORD);
    check('new staffer signs in immediately with the typed password', newToken !== null);
    if (newToken) {
      const ownRows = await asUser(newToken, 'GET', `/rest/v1/training_viewers?select=email,account_id&limit=1000`);
      const rows: any[] = Array.isArray(ownRows.json) ? ownRows.json : [];
      check('new staffer sees their own office roster row', rows.some((row) => row.email === newEmail && row.account_id === 'acct-p1'));
    }

    console.log('4. Duplicate email is refused without side effects');
    const dupe = await provision(hqToken, {
      accountId: 'acct-p2',
      firstName: 'QA',
      lastName: 'Duplicate',
      email: newEmail,
      password: 'Password!123',
    });
    check('409 naming the email field', dupe.status === 409 && dupe.json?.field === 'email',
      `${dupe.status} ${JSON.stringify(dupe.json)}`);
    const assignmentAfter = await svc(
      'GET',
      `/rest/v1/staff_role_assignments?email=eq.${encodeURIComponent(newEmail)}&select=provider_account_code,role`,
    );
    check(
      'existing assignment untouched (still acct-p1)',
      assignmentAfter.json?.[0]?.provider_account_code === 'acct-p1' && assignmentAfter.json?.[0]?.role === 'provider_staff',
      JSON.stringify(assignmentAfter.json),
    );

    console.log('5. Existing revocation still bites provisioned staff');
    const revoke = await svc('DELETE', `/rest/v1/staff_role_assignments?email=eq.${encodeURIComponent(newEmail)}`);
    check('assignment revoked', revoke.status === 200 || revoke.status === 204, String(revoke.status));
    const unlinked = await svc(
      'GET',
      `/rest/v1/training_viewers?email=eq.${encodeURIComponent(newEmail)}&select=auth_user_id`,
    );
    check(
      'roster row kept but unlinked from the sign-in',
      unlinked.json?.length === 1 && unlinked.json[0].auth_user_id === null,
      JSON.stringify(unlinked.json),
    );
  } finally {
    // -- Cleanup: completions → viewers → assignments → users. --
    const emailList = allEmails.map((email) => `"${email}"`).join(',');
    const viewerRows = await svc('GET', `/rest/v1/training_viewers?email=in.(${emailList})&select=id`);
    const viewerIds: string[] = Array.isArray(viewerRows.json) ? viewerRows.json.map((row: any) => row.id) : [];
    if (viewerIds.length > 0) {
      await svc('DELETE', `/rest/v1/training_completions?viewer_id=in.(${viewerIds.join(',')})`);
      await svc('DELETE', `/rest/v1/training_viewers?id=in.(${viewerIds.join(',')})`);
    }
    await svc('DELETE', `/rest/v1/staff_role_assignments?email=in.(${emailList})`);
    for (const id of [...new Set(userIds)]) {
      await svc('DELETE', `/auth/v1/admin/users/${id}`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nStaff sign-in provisioning holds end to end.');
}

void main().catch((error) => {
  console.error('Suite crashed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
