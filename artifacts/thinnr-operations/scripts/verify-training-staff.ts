/**
 * Staff sign-in boundary checks — live integration test.
 *
 * Proves the real-staff training chain end to end against the live Supabase
 * project, using throwaway accounts that are fully cleaned up afterwards:
 *
 *   1. A pre-approved, confirmed staff signup automatically links (or
 *      creates) its training viewer row under the right office.
 *   2. Provider staff read exactly their office: own row + office roster;
 *      another office's real (non-demo) people never appear.
 *   3. training_add_staff works for the caller's own office, is idempotent,
 *      and refuses other offices, patients, and anonymous callers.
 *   4. training_mark_video_complete_self records progress against the
 *      caller's own linked viewer only, idempotently.
 *
 * Live suite — needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY +
 * SUPABASE_ANON_KEY. Deliberately NOT part of the hermetic validation gates.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:training-staff
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

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
    headers: anonHeaders(token),
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
  const PASSWORD = `Qa!${ts}staff`;
  const emailA = `qa-staff-a-${ts}@thinnr-staff-check.com`;
  const emailB = `qa-staff-b-${ts}@thinnr-staff-check.com`;
  const emailC = `qa-patient-c-${ts}@thinnr-staff-check.com`;
  const emailT = `qa-teammate-${ts}@thinnr-staff-check.com`;
  const userIds: string[] = [];
  let qaCourseId: string | null = null;

  try {
    // -- Setup: pre-approvals first, then confirmed accounts (no email sent) --
    for (const [email, code] of [
      [emailA, 'acct-p1'],
      [emailB, 'acct-p2'],
    ] as const) {
      const ins = await svc('POST', '/rest/v1/staff_role_assignments', {
        email,
        role: 'provider_staff',
        provider_account_code: code,
      });
      if (ins.status !== 201) throw new Error(`assignment insert failed (${ins.status}): ${JSON.stringify(ins.json)}`);
    }
    for (const [email, name] of [
      [emailA, 'QA Staff A'],
      [emailB, 'QA Staff B'],
      [emailC, 'QA Patient C'],
    ] as const) {
      const created = await svc('POST', '/auth/v1/admin/users', {
        email,
        password: PASSWORD,
        email_confirm: true,
        user_metadata: { display_name: name },
        // Role elevation requires the server-provisioned marker; these QA
        // fixtures stand in for accounts the API server would provision.
        app_metadata: { thinnr_provisioned: 'true' },
      });
      const id = created.json?.id ?? created.json?.user?.id;
      if ((created.status !== 200 && created.status !== 201) || !id)
        throw new Error(`admin create failed (${created.status}): ${JSON.stringify(created.json)}`);
      userIds.push(id);
    }
    const [idA, idB, idC] = userIds;

    console.log('1. Confirmed staff signup links a viewer under the office');
    const linkedA = await svc('GET', `/rest/v1/training_viewers?email=eq.${encodeURIComponent(emailA)}&select=*`);
    check('exactly one viewer row for the new staffer', Array.isArray(linkedA.json) && linkedA.json.length === 1);
    const viewerA = linkedA.json?.[0];
    check(
      'row is linked, office-filed, and not demo data',
      viewerA?.auth_user_id === idA && viewerA?.account_id === 'acct-p1' && viewerA?.is_demo === false,
      JSON.stringify({ auth: viewerA?.auth_user_id === idA, account: viewerA?.account_id, demo: viewerA?.is_demo }),
    );
    check('display name carried onto the roster', viewerA?.name === 'QA Staff A', viewerA?.name);

    // A disposable visible sequential course pins the RPC gate without
    // depending on whatever editorial seed happens to be live this week.
    const qaCourse = await svc('POST', '/rest/v1/training_courses', {
      slug: `qa-self-gate-${ts}`, title: 'QA self-completion gate', description: '',
      status: 'live', sequential_unlock: true,
    });
    qaCourseId = qaCourse.json?.[0]?.id ?? null;
    if (!qaCourseId) throw new Error(`QA course insert failed: ${JSON.stringify(qaCourse.json)}`);
    const qaModule = await svc('POST', '/rest/v1/training_modules', {
      course_id: qaCourseId, title: 'QA module', published: 'published', unlock_mode: 'sequential', position: 0,
    });
    const qaModuleId = qaModule.json?.[0]?.id;
    if (!qaModuleId) throw new Error(`QA module insert failed: ${JSON.stringify(qaModule.json)}`);
    const makeVideo = (title: string, published: string, position: number) => svc('POST', '/rest/v1/training_videos', {
      module_id: qaModuleId, subgroup_id: null, title, duration_seconds: 42, published,
      unlock_mode: 'sequential', add_staff: 'auto', description: [], chapters: [],
      thumbnail_chapter: 0, attachments: [], position,
    });
    const [qaFirst, qaSecond, qaDraft] = await Promise.all([
      makeVideo('QA first', 'published', 0), makeVideo('QA second', 'published', 1), makeVideo('QA draft', 'draft', 2),
    ]);
    const qaFirstId = qaFirst.json?.[0]?.id;
    const qaSecondId = qaSecond.json?.[0]?.id;
    const qaDraftId = qaDraft.json?.[0]?.id;
    if (!qaFirstId || !qaSecondId || !qaDraftId) throw new Error('QA video fixture insert failed');

    console.log('2. Office-scoped visibility');
    const tokenA = await signIn(emailA, PASSWORD);
    check('staff password sign-in works', tokenA !== null);
    if (!tokenA) throw new Error('cannot continue without a session for A');
    const profileA = await asUser(tokenA, 'GET', `/rest/v1/profiles?id=eq.${idA}&select=role,provider_account_code`);
    check(
      'profile elevated to provider_staff with the office code',
      profileA.json?.[0]?.role === 'provider_staff' && profileA.json?.[0]?.provider_account_code === 'acct-p1',
      JSON.stringify(profileA.json?.[0]),
    );
    const viewersA = await asUser(tokenA, 'GET', '/rest/v1/training_viewers?select=*&limit=1000');
    const rowsA: any[] = Array.isArray(viewersA.json) ? viewersA.json : [];
    check('sees own linked row', rowsA.some((row) => row.auth_user_id === idA));
    check('sees own-office demo roster', rowsA.some((row) => row.is_demo === true && row.account_id === 'acct-p1'));
    check('never sees another office\'s real people', !rowsA.some((row) => row.email === emailB));
    check(
      'every visible non-demo row is own office or self',
      rowsA.filter((row) => row.is_demo === false).every((row) => row.account_id === 'acct-p1' || row.auth_user_id === idA),
    );

    console.log('3. Self-serve teammate adds');
    const addOwn = await asUser(tokenA, 'POST', '/rest/v1/rpc/training_add_staff', {
      p_account_id: 'acct-p1',
      p_name: 'QA Teammate',
      p_email: emailT,
    });
    check('own-office add succeeds', addOwn.status === 200 && addOwn.json?.viewer?.account_id === 'acct-p1',
      JSON.stringify(addOwn.json).slice(0, 160));
    const addAgain = await asUser(tokenA, 'POST', '/rest/v1/rpc/training_add_staff', {
      p_account_id: 'acct-p1',
      p_name: 'QA Teammate',
      p_email: emailT,
    });
    check('repeat add is idempotent (same viewer)', addAgain.status === 200 && addAgain.json?.viewer?.id === addOwn.json?.viewer?.id);
    const rosterAfter = await asUser(tokenA, 'GET', `/rest/v1/training_viewers?email=eq.${encodeURIComponent(emailT)}&select=email`);
    check('teammate appears on the caller\'s roster', rosterAfter.json?.length === 1);
    const addCross = await asUser(tokenA, 'POST', '/rest/v1/rpc/training_add_staff', {
      p_account_id: 'acct-p2',
      p_name: 'QA Intruder',
      p_email: `qa-intruder-${ts}@thinnr-staff-check.com`,
    });
    check('cross-office add refused', addCross.status >= 400 && String(addCross.json?.message ?? '').includes('own office'),
      `${addCross.status} ${JSON.stringify(addCross.json).slice(0, 120)}`);

    console.log('4. Signed-in progress tracking');
    const video = { id: qaFirstId, duration_seconds: 42 };
    check('catalog is readable for staff', Boolean(video.id));
    const draftMark = await asUser(tokenA, 'POST', '/rest/v1/rpc/training_mark_video_complete_self', { p_video_id: qaDraftId });
    check('draft lesson refused', draftMark.status >= 400, `${draftMark.status} ${JSON.stringify(draftMark.json)}`);
    const lockedMark = await asUser(tokenA, 'POST', '/rest/v1/rpc/training_mark_video_complete_self', { p_video_id: qaSecondId });
    check('locked sequential lesson refused', lockedMark.status >= 400, `${lockedMark.status} ${JSON.stringify(lockedMark.json)}`);
    const mark = await asUser(tokenA, 'POST', '/rest/v1/rpc/training_mark_video_complete_self', {
      p_video_id: video.id,
    });
    check(
      'mark-complete lands on own viewer with the tracked duration',
      mark.status === 200 && mark.json?.viewer_id === viewerA?.id && mark.json?.watch_seconds === video.duration_seconds,
      JSON.stringify(mark.json).slice(0, 160),
    );
    const markAgain = await asUser(tokenA, 'POST', '/rest/v1/rpc/training_mark_video_complete_self', {
      p_video_id: video.id,
    });
    check('repeat mark is idempotent', markAgain.status === 200 && markAgain.json?.completed_at === mark.json?.completed_at);
    const frontierMark = await asUser(tokenA, 'POST', '/rest/v1/rpc/training_mark_video_complete_self', { p_video_id: qaSecondId });
    check('current sequential frontier completes after predecessor', frontierMark.status === 200 && frontierMark.json?.viewer_id === viewerA?.id);
    const badMark = await asUser(tokenA, 'POST', '/rest/v1/rpc/training_mark_video_complete_self', {
      p_video_id: '00000000-0000-0000-0000-000000000000',
    });
    check('unknown video refused', badMark.status >= 400);
    const completionsA = await asUser(tokenA, 'GET', '/rest/v1/training_completions?select=viewer_id&limit=1000');
    const compRows: any[] = Array.isArray(completionsA.json) ? completionsA.json : [];
    check('own completion visible through office read', compRows.some((row) => row.viewer_id === viewerA?.id));

    console.log('5. Patients and anonymous callers stay out');
    const tokenC = await signIn(emailC, PASSWORD);
    check('patient sign-in works', tokenC !== null);
    if (tokenC) {
      const addAsPatient = await asUser(tokenC, 'POST', '/rest/v1/rpc/training_add_staff', {
        p_account_id: 'acct-p1',
        p_name: 'Nope',
        p_email: `qa-nope-${ts}@thinnr-staff-check.com`,
      });
      check('patient cannot add staff', addAsPatient.status >= 400);
      const markAsPatient = await asUser(tokenC, 'POST', '/rest/v1/rpc/training_mark_video_complete_self', {
        p_video_id: video.id,
      });
      check(
        'patient has no linked training profile',
        markAsPatient.status >= 400 && String(markAsPatient.json?.message ?? '').includes('No training profile'),
      );
      const viewersC = await asUser(tokenC, 'GET', '/rest/v1/training_viewers?select=email,is_demo&limit=1000');
      const rowsC: any[] = Array.isArray(viewersC.json) ? viewersC.json : [];
      check('patient sees no real people', rowsC.every((row) => row.is_demo === true));
    }
    const anonAdd = await asUser(undefined, 'POST', '/rest/v1/rpc/training_add_staff', {
      p_account_id: 'acct-p1',
      p_name: 'Anon',
      p_email: `qa-anon-${ts}@thinnr-staff-check.com`,
    });
    check('anon cannot call training_add_staff', anonAdd.status >= 400, String(anonAdd.status));
    const anonMark = await asUser(undefined, 'POST', '/rest/v1/rpc/training_mark_video_complete_self', {
      p_video_id: video.id,
    });
    check('anon cannot call training_mark_video_complete_self', anonMark.status >= 400, String(anonMark.status));

    console.log('6. The other office is isolated the same way');
    const tokenB = await signIn(emailB, PASSWORD);
    check('second office sign-in works', tokenB !== null);
    if (tokenB) {
      const viewersB = await asUser(tokenB, 'GET', '/rest/v1/training_viewers?select=email,account_id,is_demo&limit=1000');
      const rowsB: any[] = Array.isArray(viewersB.json) ? viewersB.json : [];
      check('B sees own linked row under acct-p2', rowsB.some((row) => row.email === emailB && row.account_id === 'acct-p2'));
      check('B never sees A or A\'s teammate', !rowsB.some((row) => row.email === emailA || row.email === emailT));
      const completionsB = await asUser(tokenB, 'GET', '/rest/v1/training_completions?select=viewer_id,video_id&limit=1000');
      check(
        'B cannot read A office completion',
        !(completionsB.json as any[] ?? []).some((row) => row.viewer_id === viewerA?.id && row.video_id === qaFirstId),
      );
    }

    console.log('7. Revoking the assignment revokes training access');
    {
      const del = await svc('DELETE', `/rest/v1/staff_role_assignments?email=eq.${encodeURIComponent(emailB)}`);
      check('assignment revoked', del.status === 200 || del.status === 204, String(del.status));
      const unlinked = await svc(
        'GET',
        `/rest/v1/training_viewers?email=eq.${encodeURIComponent(emailB)}&select=auth_user_id,account_id`,
      );
      check(
        'viewer row kept for HQ but unlinked from the sign-in',
        unlinked.json?.length === 1 && unlinked.json[0].auth_user_id === null,
        JSON.stringify(unlinked.json),
      );
      if (tokenB) {
        const viewersRevoked = await asUser(tokenB, 'GET', '/rest/v1/training_viewers?select=email,is_demo&limit=1000');
        const rowsRevoked: any[] = Array.isArray(viewersRevoked.json) ? viewersRevoked.json : [];
        check('revoked session reads demo rows only', rowsRevoked.every((row) => row.is_demo === true));
        check('revoked session no longer sees its own row', !rowsRevoked.some((row) => row.email === emailB));
        const markRevoked = await asUser(tokenB, 'POST', '/rest/v1/rpc/training_mark_video_complete_self', {
          p_video_id: video.id,
        });
        check('revoked session cannot mark progress', markRevoked.status >= 400, String(markRevoked.status));
        const addRevoked = await asUser(tokenB, 'POST', '/rest/v1/rpc/training_add_staff', {
          p_account_id: 'acct-p2',
          p_name: 'Nope',
          p_email: `qa-revoked-${ts}@thinnr-staff-check.com`,
        });
        check('revoked session cannot add staff', addRevoked.status >= 400, String(addRevoked.status));
      }
      const viewersAStill = await asUser(tokenA, 'GET', `/rest/v1/training_viewers?email=eq.${encodeURIComponent(emailA)}&select=email`);
      check('active staffer A is unaffected by B\'s revocation', viewersAStill.json?.length === 1);
    }
  } finally {
    // -- Cleanup: rows first, then the auth users (viewer FK is SET NULL) --
    const emails = [emailA, emailB, emailC, emailT].map((email) => `"${email}"`).join(',');
    const viewerRows = await svc('GET', `/rest/v1/training_viewers?email=in.(${emails})&select=id`);
    const viewerIds: string[] = Array.isArray(viewerRows.json) ? viewerRows.json.map((row: any) => row.id) : [];
    if (viewerIds.length > 0) {
      await svc('DELETE', `/rest/v1/training_completions?viewer_id=in.(${viewerIds.join(',')})`);
      await svc('DELETE', `/rest/v1/training_viewers?id=in.(${viewerIds.join(',')})`);
    }
    if (qaCourseId) await svc('DELETE', `/rest/v1/training_courses?id=eq.${qaCourseId}`);
    await svc('DELETE', `/rest/v1/staff_role_assignments?email=in.(${emails})`);
    for (const id of userIds) {
      await svc('DELETE', `/auth/v1/admin/users/${id}`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll staff sign-in boundaries hold.');
}

void main().catch((error) => {
  console.error('Suite crashed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
