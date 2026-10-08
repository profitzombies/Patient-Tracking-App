/**
 * Training-portal ACCESS-BOUNDARY checks — live integration test.
 *
 * Runs with the ANON key against the real Supabase project and proves the
 * privacy/authorization model end to end:
 *
 *   1. The course catalog is world-readable (no PII in it).
 *   2. Gate registration issues a private capability (viewer + token).
 *   3. An email registered through the gate never appears in anon reads
 *      (viewers, completions, or invites). Whatever anon CAN read is
 *      demo-flagged only — and may be empty: nothing here relies on seeded
 *      demo viewers existing, so clearing them changes no verdict.
 *   4. Learner actions are keyed by the opaque session token: a random token
 *      is rejected, one learner's progress never leaks into another's state,
 *      and the old viewer-id RPC signatures no longer exist.
 *   5. Anon direct writes are refused on every table, and the token table
 *      itself is unreadable.
 *   6. The API server's hosted-media routes keep learner reads (playback,
 *      transcript) open, while every write needs an HQ sign-in: a tokenless
 *      call gets 401 and a synthetic bearer 401/403. Only harmless probes
 *      are sent, so a regressed gate can't damage a lesson. (Needs the
 *      artifacts/api-server workflow.)
 *
 * Test rows use FIXED @example.test addresses so re-runs upsert instead of
 * growing the roster; they stay invisible to anon (visible to real HQ admins
 * only) and `seed:training --reset` clears them entirely.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:training-access
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!SUPABASE_URL || !ANON_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY in the environment.');
  process.exit(1);
}

const BASE = SUPABASE_URL.replace(/\/$/, '');
const HEADERS: Record<string, string> = {
  apikey: ANON_KEY,
  Authorization: `Bearer ${ANON_KEY}`,
  'Content-Type': 'application/json',
};

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function select(pathAndQuery: string): Promise<{ status: number; rows: any[] }> {
  const response = await fetch(`${BASE}/rest/v1/${pathAndQuery}`, { headers: HEADERS });
  const body = await response.text();
  let rows: any[] = [];
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) rows = parsed;
  } catch {
    /* non-JSON error body */
  }
  return { status: response.status, rows };
}

async function rpc(name: string, args: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const response = await fetch(`${BASE}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(args),
  });
  const body = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(body);
  } catch {
    /* keep null */
  }
  return { status: response.status, json };
}

async function write(method: string, pathAndQuery: string, body?: unknown): Promise<number> {
  const response = await fetch(`${BASE}/rest/v1/${pathAndQuery}`, {
    method,
    headers: HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response.status;
}

const EMAIL_A = 'qa-access-a@example.test';
const EMAIL_B = 'qa-access-b@example.test';
const EMAIL_STAFF = 'qa-access-staff@example.test';
const ZERO_TOKEN = '00000000-0000-0000-0000-000000000000';

// --- Hosted-media API routes (learner reads open, writes HQ-only) ----------

const API_BASE = (process.env.STAFF_API_BASE ?? 'http://localhost:80').replace(/\/$/, '');
/** A well-formed but unsigned bearer: verification must reject it. */
const SYNTHETIC_BEARER = { Authorization: 'Bearer synthetic-staff-bearer' };

async function apiRead(path: string, headers: Record<string, string> = {}): Promise<number> {
  const response = await fetch(`${API_BASE}/api${path}`, { headers });
  return response.status;
}

async function apiWrite(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${API_BASE}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep null */
  }
  return { status: response.status, json };
}

async function mediaSection(videoId: string) {
  console.log('6. Hosted-media API: learner reads open, writes need an HQ sign-in');
  const health = await fetch(`${API_BASE}/api/healthz`).catch(() => null);
  if (!health || !health.ok) {
    check(
      'API server reachable',
      false,
      `unreachable at ${API_BASE} — start the artifacts/api-server workflow first`,
    );
    return;
  }

  // Reads lesson pages need: tokenless, and a synthetic bearer is ignored.
  // 200 = playback URLs / transcript; 404 = nothing hosted yet — either way
  // there is no auth wall in front of learners.
  const media = `/training/videos/${videoId}/media`;
  const tokenless = await apiRead(media);
  check('tokenless media read has no auth wall', tokenless === 200 || tokenless === 404, `status ${tokenless}`);
  const bearered = await apiRead(media, SYNTHETIC_BEARER);
  check('synthetic bearer does not block a media read', bearered === tokenless, `status ${bearered} vs ${tokenless}`);
  const transcript = await apiRead(`/training/videos/${videoId}/transcript`);
  check('tokenless transcript read has no auth wall', transcript === 200 || transcript === 404, `status ${transcript}`);

  // Writes: an upload-url mint is the harmless probe (nothing is uploaded and
  // a mint changes no lesson) — a tokenless caller is told to sign in, and an
  // unsigned bearer is never trusted.
  const mintBody = { fileName: 'probe.mp4', contentType: 'video/mp4', sizeBytes: 1024 };
  const mint = await apiWrite(`/training/videos/${videoId}/upload-url`, mintBody);
  check(
    'tokenless upload-url mint is refused (401)',
    mint.status === 401 && !mint.json?.uploadUrl,
    `status ${mint.status}`,
  );
  const forged = await apiWrite(`/training/videos/${videoId}/upload-url`, mintBody, SYNTHETIC_BEARER);
  check(
    'synthetic bearer cannot mint an upload URL',
    (forged.status === 401 || forged.status === 403) && !forged.json?.uploadUrl,
    `status ${forged.status}`,
  );
  // An invalid body proves the gate runs BEFORE validation: an open route
  // would answer 400, a gated one 401.
  const processRun = await apiWrite(`/training/videos/${videoId}/process`, {});
  check('tokenless AI processing is refused (401)', processRun.status === 401, `status ${processRun.status}`);
}

async function main() {
  console.log('1. Course catalog is world-readable (authored content, no PII)');
  const courses = await select('training_courses?select=id,status&limit=5');
  check('anon can read courses', courses.status === 200 && courses.rows.length >= 1, `status ${courses.status}`);
  const videos = await select('training_videos?select=id&published=eq.published&limit=1');
  check('anon can read videos', videos.status === 200 && videos.rows.length === 1, `status ${videos.status}`);
  const videoId = videos.rows[0]?.id as string;

  console.log('2. Gate registration issues a private capability');
  const regA = await rpc('training_register_viewer', { p_email: EMAIL_A });
  check('register returns viewer + token + completions', regA.status === 200 && !!regA.json?.viewer?.id && typeof regA.json?.token === 'string' && Array.isArray(regA.json?.completions), `status ${regA.status}`);
  const viewerA = regA.json?.viewer?.id as string;
  const tokenA = regA.json?.token as string;
  const regA2 = await rpc('training_register_viewer', { p_email: EMAIL_A });
  check('re-registering the same email resumes the same viewer', regA2.status === 200 && regA2.json?.viewer?.id === viewerA);
  check('…but mints a fresh token', typeof regA2.json?.token === 'string' && regA2.json.token !== tokenA);
  const regB = await rpc('training_register_viewer', { p_email: EMAIL_B });
  const tokenB = regB.json?.token as string;
  const viewerB = regB.json?.viewer?.id as string;
  check('second learner registered', regB.status === 200 && !!tokenB && viewerB !== viewerA);

  console.log('3. Anon reads never expose gate registrations');
  // The anon roster may be empty (no seeded demo viewers needed); whatever
  // it does return must be demo-flagged.
  const roster = await select('training_viewers?select=id,email,is_demo&limit=1000');
  check('anon roster holds demo-flagged rows only (possibly none)', roster.status === 200 && roster.rows.every((row) => row.is_demo === true), `status ${roster.status}, ${roster.rows.length} rows`);
  check('registered emails hidden from anon roster', !roster.rows.some((row) => [EMAIL_A, EMAIL_B, EMAIL_STAFF].includes(String(row.email).toLowerCase())));
  const emailProbe = await select(`training_viewers?select=id&email=eq.${encodeURIComponent(EMAIL_A)}`);
  check('direct email lookup returns nothing', emailProbe.status === 200 && emailProbe.rows.length === 0);
  const demoViewerIds = new Set(roster.rows.map((row) => String(row.id)));
  const anonCompletions = await select('training_completions?select=viewer_id&limit=1000');
  check(
    'anon completions belong to demo-flagged viewers only (possibly none)',
    anonCompletions.status === 200 && anonCompletions.rows.every((row) => demoViewerIds.has(String(row.viewer_id))),
    `status ${anonCompletions.status}, ${anonCompletions.rows.length} rows`,
  );

  console.log('4. Learner actions are bound to the token, not caller-supplied ids');
  const badState = await rpc('training_learner_state', { p_token: ZERO_TOKEN });
  check('random token is rejected', badState.status >= 400, `status ${badState.status}`);
  const badMark = await rpc('training_mark_video_complete', { p_token: ZERO_TOKEN, p_video_id: videoId });
  check('random token cannot mark progress', badMark.status >= 400, `status ${badMark.status}`);
  const oldMark = await rpc('training_mark_video_complete', { p_viewer_id: viewerA, p_video_id: videoId });
  check('old viewer-id mark signature is gone', oldMark.status === 404, `status ${oldMark.status}`);
  const oldInvite = await rpc('training_invite_staff', { p_inviter_viewer_id: viewerA, p_email: EMAIL_STAFF });
  check('old viewer-id invite signature is gone', oldInvite.status === 404, `status ${oldInvite.status}`);

  const mark = await rpc('training_mark_video_complete', { p_token: tokenA, p_video_id: videoId });
  check('own token marks own progress', mark.status === 200 && mark.json?.viewer_id === viewerA && mark.json?.video_id === videoId, `status ${mark.status}`);
  const stateA = await rpc('training_learner_state', { p_token: tokenA });
  check('own state shows the completion', stateA.status === 200 && Array.isArray(stateA.json?.completions) && stateA.json.completions.some((c: any) => c.video_id === videoId));
  const stateB = await rpc('training_learner_state', { p_token: tokenB });
  check("another learner's state is untouched", stateB.status === 200 && Array.isArray(stateB.json?.completions) && stateB.json.completions.length === 0, `${stateB.json?.completions?.length} rows`);
  const leakedCompletion = await select(`training_completions?select=video_id&viewer_id=eq.${viewerA}`);
  check("anon table reads can't see the learner's completion", leakedCompletion.status === 200 && leakedCompletion.rows.length === 0);

  const invite = await rpc('training_invite_staff', { p_token: tokenA, p_email: EMAIL_STAFF });
  const inviteOk = invite.status === 200 && invite.json?.invited === true;
  const inviteCapped = invite.status >= 400 && JSON.stringify(invite.json ?? '').includes('Invite limit');
  check('invite works via token (or hits its abuse cap)', inviteOk || inviteCapped, `status ${invite.status}`);
  check('invite response reveals nothing about the invitee', !invite.json?.viewer && !invite.json?.id && !invite.json?.email);
  const staffProbe = await select(`training_viewers?select=id&email=eq.${encodeURIComponent(EMAIL_STAFF)}`);
  check('invited teammate hidden from anon roster', staffProbe.status === 200 && staffProbe.rows.length === 0);
  const inviteLeak = await select(`training_invites?select=id&inviter_viewer_id=eq.${viewerA}`);
  check("learner invites hidden from anon reads", inviteLeak.status === 200 && inviteLeak.rows.length === 0);

  console.log('5. No anon write or token-table path exists');
  check('anon INSERT viewer refused', (await write('POST', 'training_viewers', { name: 'X', email: 'x@example.test' })) >= 400);
  check('anon UPDATE viewer refused', (await write('PATCH', 'training_viewers?is_demo=eq.true', { location: 'nope' })) >= 400);
  check('anon DELETE completions refused', (await write('DELETE', `training_completions?viewer_id=eq.${viewerA}`)) >= 400);
  check('anon INSERT course refused', (await write('POST', 'training_courses', { slug: 'x', title: 'X' })) >= 400);
  const sessions = await select('training_learner_sessions?select=token&limit=1');
  check('token table is unreadable', sessions.status >= 400, `status ${sessions.status}`);

  await mediaSection(videoId);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll training access boundaries hold.');
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
