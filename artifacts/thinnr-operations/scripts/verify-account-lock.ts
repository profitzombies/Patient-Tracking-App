/**
 * Provider account lock — live enforcement checks.
 *
 * Proves the lock chain end to end against the live Supabase project, using
 * the permanent demo staffer (Dana at Jenkins) plus a throwaway HQ admin that
 * is fully cleaned up afterwards:
 *
 *   1. Lock state is world-readable (badges) but anon/staff cannot write it.
 *   2. Only a real signed-in HQ admin can lock and unlock.
 *   3. While locked, the office's staff lose their server-side reads and
 *      writes (own viewer row, mark-complete, add-staff) — but keep their
 *      own profile row, which is how the app shows the locked notice.
 *   4. HQ keeps full visibility into the locked office's data.
 *   5. Unlocking restores access with nothing re-created (same viewer row).
 *
 * The test lock exists only for the seconds between checks and is removed in
 * cleanup even on failure. Live suite — needs SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE_KEY + SUPABASE_ANON_KEY. Deliberately NOT part of the
 * hermetic validation gates.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:account-lock
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY in the environment.');
  process.exit(1);
}

const BASE = SUPABASE_URL.replace(/\/$/, '');
const OFFICE = 'acct-p1';
const DANA_EMAIL = 'dana.frontdesk@jenkinswellness.example.com';
const DANA_PASSWORD = 'JenkinsTraining!26';

const SVC_HEADERS: Record<string, string> = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};
const anonHeaders = (token?: string): Record<string, string> => ({
  apikey: ANON_KEY!,
  Authorization: `Bearer ${token ?? ANON_KEY!}`,
  'Content-Type': 'application/json',
});

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

async function asUser(
  token: string | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...anonHeaders(token), Prefer: 'return=representation' },
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
  const { status, json } = await asUser(undefined, 'POST', '/auth/v1/token?grant_type=password', {
    email,
    password,
  });
  return status === 200 && typeof json?.access_token === 'string' ? json.access_token : null;
}

async function main() {
  const ts = Date.now();
  const adminEmail = `qa-hq-admin-${ts}@thinnr-lock-check.com`;
  const adminPassword = `Qa!${ts}lock`;
  const teammateEmail = `qa-lock-teammate-${ts}@thinnr-lock-check.com`;
  let adminUserId: string | null = null;

  try {
    // -- Preflight: the office must start unlocked --
    await svc('DELETE', `/rest/v1/provider_account_locks?account_id=eq.${OFFICE}`);

    console.log('1. Lock state is world-readable, but anon cannot write it');
    const anonRead = await asUser(undefined, 'GET', '/rest/v1/provider_account_locks?select=*');
    check('anon reads the lock table', anonRead.status === 200 && Array.isArray(anonRead.json));
    check('office starts unlocked', !anonRead.json?.some?.((row: any) => row.account_id === OFFICE));
    const anonInsert = await asUser(undefined, 'POST', '/rest/v1/provider_account_locks', { account_id: OFFICE });
    check('anon cannot lock', anonInsert.status >= 400, String(anonInsert.status));
    const anonDelete = await asUser(undefined, 'DELETE', `/rest/v1/provider_account_locks?account_id=eq.${OFFICE}`);
    check('anon cannot unlock', anonDelete.status >= 400, String(anonDelete.status));

    console.log('2. Provider staff cannot write locks either');
    const danaToken = await signIn(DANA_EMAIL, DANA_PASSWORD);
    check('demo staffer signs in', danaToken !== null);
    if (!danaToken) throw new Error('cannot continue without a session for the demo staffer');
    const danaInsert = await asUser(danaToken, 'POST', '/rest/v1/provider_account_locks', { account_id: OFFICE });
    check('staff cannot lock', danaInsert.status >= 400, String(danaInsert.status));

    console.log('3. Baseline: the staffer has full office access');
    const baselineViewer = await asUser(
      danaToken,
      'GET',
      `/rest/v1/training_viewers?email=eq.${encodeURIComponent(DANA_EMAIL)}&select=id,account_id,is_demo`,
    );
    check(
      'sees own viewer row under the office',
      baselineViewer.json?.length === 1 && baselineViewer.json[0].account_id === OFFICE,
      JSON.stringify(baselineViewer.json),
    );
    const baselineViewerId: string | undefined = baselineViewer.json?.[0]?.id;

    console.log('4. Only a real signed-in HQ admin can flip the lock');
    const assignment = await svc('POST', '/rest/v1/staff_role_assignments', {
      email: adminEmail,
      role: 'hq_admin',
    });
    if (assignment.status !== 201) throw new Error(`admin assignment failed (${assignment.status}): ${JSON.stringify(assignment.json)}`);
    const created = await svc('POST', '/auth/v1/admin/users', {
      email: adminEmail,
      password: adminPassword,
      email_confirm: true,
      user_metadata: { display_name: 'QA Lock Admin' },
      // Elevation requires the server-provisioned marker; this QA fixture
      // stands in for an account the API server would provision.
      app_metadata: { thinnr_provisioned: 'true' },
    });
    adminUserId = created.json?.id ?? created.json?.user?.id ?? null;
    if ((created.status !== 200 && created.status !== 201) || !adminUserId)
      throw new Error(`admin create failed (${created.status}): ${JSON.stringify(created.json)}`);
    // Lock writes are gated on an ACTIVE HQ membership (department
    // permissions), not the coarse profile role, so the QA admin needs a
    // real membership row.
    const membership = await svc('POST', '/rest/v1/hq_memberships', {
      email: adminEmail,
      auth_user_id: adminUserId,
      status: 'active',
      department_role: 'admin',
      display_name: 'QA Lock Admin',
      activated_at: new Date().toISOString(),
    });
    if (membership.status !== 201)
      throw new Error(`hq membership insert failed (${membership.status}): ${JSON.stringify(membership.json)}`);
    const adminToken = await signIn(adminEmail, adminPassword);
    check('HQ admin signs in', adminToken !== null);
    if (!adminToken) throw new Error('cannot continue without an HQ admin session');
    const lockInsert = await asUser(adminToken, 'POST', '/rest/v1/provider_account_locks', { account_id: OFFICE });
    check('HQ admin locks the office', lockInsert.status === 201, `${lockInsert.status} ${JSON.stringify(lockInsert.json).slice(0, 120)}`);

    console.log('5. While locked: badges stay readable, office access is gone');
    const anonSeesLock = await asUser(undefined, 'GET', `/rest/v1/provider_account_locks?account_id=eq.${OFFICE}&select=account_id`);
    check('anon (demo badges) sees the lock row', anonSeesLock.json?.length === 1);
    const lockedProfile = await asUser(danaToken, 'GET', '/rest/v1/profiles?select=role,provider_account_code');
    check(
      'staffer still reads own profile (how the app shows the locked notice)',
      lockedProfile.json?.some?.((row: any) => row.provider_account_code === OFFICE && row.role === 'provider_staff'),
      JSON.stringify(lockedProfile.json).slice(0, 160),
    );
    const lockedViewer = await asUser(
      danaToken,
      'GET',
      `/rest/v1/training_viewers?email=eq.${encodeURIComponent(DANA_EMAIL)}&select=id`,
    );
    check('own viewer row is no longer readable', lockedViewer.json?.length === 0, JSON.stringify(lockedViewer.json));
    const lockedRoster = await asUser(danaToken, 'GET', '/rest/v1/training_viewers?select=is_demo&limit=1000');
    check(
      'office reads collapse to demo rows only',
      Array.isArray(lockedRoster.json) && lockedRoster.json.every((row: any) => row.is_demo === true),
    );
    const videos = await asUser(danaToken, 'GET', '/rest/v1/training_videos?select=id&limit=1');
    const videoId = videos.json?.[0]?.id;
    const lockedMark = await asUser(danaToken, 'POST', '/rest/v1/rpc/training_mark_video_complete_self', {
      p_video_id: videoId,
    });
    check('mark-complete refused while locked', lockedMark.status >= 400, String(lockedMark.status));
    const lockedAdd = await asUser(danaToken, 'POST', '/rest/v1/rpc/training_add_staff', {
      p_account_id: OFFICE,
      p_name: 'QA Lock Teammate',
      p_email: teammateEmail,
    });
    check(
      'add-staff refused while locked, naming the lock',
      lockedAdd.status >= 400 && String(lockedAdd.json?.message ?? '').toLowerCase().includes('locked'),
      `${lockedAdd.status} ${JSON.stringify(lockedAdd.json).slice(0, 120)}`,
    );
    const danaUnlockTry = await asUser(danaToken, 'DELETE', `/rest/v1/provider_account_locks?account_id=eq.${OFFICE}`);
    const lockStillThere = await asUser(undefined, 'GET', `/rest/v1/provider_account_locks?account_id=eq.${OFFICE}&select=account_id`);
    check(
      'staffer cannot remove the lock',
      lockStillThere.json?.length === 1,
      `delete status ${danaUnlockTry.status}`,
    );

    console.log('6. HQ keeps full visibility into the locked office');
    const adminViewers = await asUser(
      adminToken,
      'GET',
      `/rest/v1/training_viewers?email=eq.${encodeURIComponent(DANA_EMAIL)}&select=id,account_id`,
    );
    check(
      'HQ admin still reads the locked office roster',
      adminViewers.json?.length === 1 && adminViewers.json[0].id === baselineViewerId,
      JSON.stringify(adminViewers.json),
    );

    console.log('7. Unlock restores access with nothing re-created');
    const unlock = await asUser(adminToken, 'DELETE', `/rest/v1/provider_account_locks?account_id=eq.${OFFICE}`);
    check('HQ admin unlocks', unlock.status === 200 || unlock.status === 204, String(unlock.status));
    const lockGone = await asUser(undefined, 'GET', `/rest/v1/provider_account_locks?account_id=eq.${OFFICE}&select=account_id`);
    check('lock row is gone', lockGone.json?.length === 0);
    const restoredViewer = await asUser(
      danaToken,
      'GET',
      `/rest/v1/training_viewers?email=eq.${encodeURIComponent(DANA_EMAIL)}&select=id,account_id`,
    );
    check(
      'same viewer row is back (nothing re-created)',
      restoredViewer.json?.length === 1 && restoredViewer.json[0].id === baselineViewerId,
      JSON.stringify(restoredViewer.json),
    );
    const restoredAdd = await asUser(danaToken, 'POST', '/rest/v1/rpc/training_add_staff', {
      p_account_id: OFFICE,
      p_name: 'QA Lock Teammate',
      p_email: teammateEmail,
    });
    check(
      'office writes work again after unlock',
      restoredAdd.status === 200 && restoredAdd.json?.viewer?.account_id === OFFICE,
      `${restoredAdd.status} ${JSON.stringify(restoredAdd.json).slice(0, 120)}`,
    );
  } finally {
    // -- Cleanup: the lock, the QA teammate, and the throwaway admin --
    await svc('DELETE', `/rest/v1/provider_account_locks?account_id=eq.${OFFICE}`);
    const teammateRows = await svc(
      'GET',
      `/rest/v1/training_viewers?email=eq.${encodeURIComponent(teammateEmail)}&select=id`,
    );
    const teammateIds: string[] = Array.isArray(teammateRows.json) ? teammateRows.json.map((row: any) => row.id) : [];
    if (teammateIds.length > 0) {
      await svc('DELETE', `/rest/v1/training_completions?viewer_id=in.(${teammateIds.join(',')})`);
      await svc('DELETE', `/rest/v1/training_viewers?id=in.(${teammateIds.join(',')})`);
    }
    await svc(
      'DELETE',
      `/rest/v1/staff_role_assignments?email=in.(${[teammateEmail, adminEmail].map((email) => `"${email}"`).join(',')})`,
    );
    await svc('DELETE', `/rest/v1/hq_memberships?email=eq.${encodeURIComponent(adminEmail)}`);
    if (adminUserId) await svc('DELETE', `/auth/v1/admin/users/${adminUserId}`);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAccount lock enforcement holds end to end.');
}

void main().catch((error) => {
  console.error('Suite crashed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
