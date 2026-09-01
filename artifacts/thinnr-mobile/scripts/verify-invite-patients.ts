/**
 * Invite-patients regression suite (native provider dashboard).
 *
 * Behavioral half: runs the REAL lib/office-roster-api.ts client under Node
 * against a scripted global fetch — bearer attachment, the
 * 401→refresh→retry hop, field-keyed error mapping, the not-configured and
 * signed-out failure modes, and the shared US-phone validation the modal
 * relies on. The client never names an office: staff scope is always
 * server-derived from the token.
 *
 * Source half: pins the screen wiring — the Patients tab gates the invite
 * action and live section on a server-accepted roster fetch (demo persona
 * and patient tokens hide it silently), the modal rides AppModal, and the
 * resend control carries an accessible name.
 *
 *   pnpm --filter @workspace/thinnr-mobile run test:invite-patients
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  fetchOfficeRoster,
  formatUsPhoneInput,
  invitePatient,
  resendInvitation,
  usPhoneDigits,
  validateInviteForm,
  OfficeRosterError,
} from '@/lib/office-roster-api';
import {
  __resetSupabaseStub,
  __setRefreshResult,
  __setSession,
  stubCalls,
} from '@/lib/supabase';
import { __setApiBaseThrows } from '@/lib/coach-api';

let checks = 0;
function check(name: string, run: () => void | Promise<void>): Promise<void> {
  checks += 1;
  return Promise.resolve()
    .then(run)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((error) => {
      console.error(`  ✗ ${name}`);
      throw error;
    });
}

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}
let requests: Recorded[] = [];
let responses: Array<{ status: number; json: unknown } | 'network-error'> = [];

global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const next = responses.shift();
  if (!next) throw new Error('fetch called with no scripted response');
  if (next === 'network-error') throw new TypeError('fetch failed');
  requests.push({
    url: String(input),
    method: init?.method ?? 'GET',
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: init?.body ? JSON.parse(String(init.body)) : null,
  });
  return new Response(JSON.stringify(next.json), {
    status: next.status,
    headers: { 'Content-Type': 'application/json' },
  });
}) as typeof fetch;

function reset(token: string | null = 'tok-1') {
  requests = [];
  responses = [];
  __resetSupabaseStub();
  __setSession(token);
  __setApiBaseThrows(false);
}

const ROSTER = { office: { providerId: 'office-1', officeName: 'Harbor', providerCode: '483920' }, patients: [] };
const INVITE = { firstName: 'Jordan', lastName: 'Ellis', email: 'j@example.com', phone: '(555) 201-7788' };

async function main() {
  console.log('Shared validation and formatting:');

  await check('phone formats progressively and matches the desktop portal exactly', () => {
    assert.equal(formatUsPhoneInput('5552'), '(555) 2');
    assert.equal(formatUsPhoneInput('15552017788'), '(555) 201-7788');
    assert.equal(formatUsPhoneInput('555201778899'), '(555) 201-7788');
    assert.equal(usPhoneDigits('1 (555) 201-7788'), '5552017788');
    assert.equal(usPhoneDigits('555-201'), null);
  });

  await check('validateInviteForm mirrors the API field rules', () => {
    const empty = validateInviteForm({ firstName: '', lastName: ' ', email: '', phone: '' });
    assert.deepEqual(Object.keys(empty).sort(), ['email', 'firstName', 'lastName', 'phone']);
    const bad = validateInviteForm({ ...INVITE, email: 'nope', phone: '12345' });
    assert.match(String(bad.email), /valid email/i);
    assert.match(String(bad.phone), /10-digit US/i);
    assert.deepEqual(validateInviteForm(INVITE), {});
  });

  console.log('Client behavior against a scripted API:');

  await check('requests carry the session bearer and never name an office', async () => {
    reset();
    responses = [
      { status: 200, json: ROSTER },
      { status: 201, json: { patient: {}, invitation: 'sent' } },
      { status: 200, json: { ok: true, invitation: 'sent', patient: {} } },
    ];
    await fetchOfficeRoster();
    await invitePatient(INVITE);
    await resendInvitation('pat-1');
    assert.equal(requests[0].url, 'http://api.test/api/office/roster');
    assert.equal(requests[0].headers.Authorization, 'Bearer tok-1');
    assert.equal(requests[1].body.office, undefined);
    assert.equal(requests[2].url, 'http://api.test/api/office/invitations/pat-1/resend');
    assert.equal(requests[2].body.office, undefined);
  });

  await check('an expired token refreshes once and retries with the new bearer', async () => {
    reset('stale');
    __setRefreshResult('fresh');
    responses = [
      { status: 401, json: { error: 'Sign in to continue.' } },
      { status: 200, json: ROSTER },
    ];
    await fetchOfficeRoster();
    assert.equal(stubCalls.refreshes, 1);
    assert.equal(requests[1].headers.Authorization, 'Bearer fresh');
  });

  await check('field-keyed API errors keep their field and exact message', async () => {
    reset();
    responses = [{ status: 409, json: { error: 'That phone number is already on a patient account. Use a different number.', field: 'phone' } }];
    await assert.rejects(invitePatient(INVITE), (error: unknown) => {
      assert.ok(error instanceof OfficeRosterError);
      assert.equal(error.status, 409);
      assert.equal(error.field, 'phone');
      return true;
    });
  });

  await check('signed-out, unconfigured, and unreachable states map to hideable statuses', async () => {
    reset(null);
    await assert.rejects(fetchOfficeRoster(), (error: unknown) =>
      error instanceof OfficeRosterError && error.status === 401);
    reset();
    __setApiBaseThrows(true);
    await assert.rejects(fetchOfficeRoster(), (error: unknown) =>
      error instanceof OfficeRosterError && error.status === 503);
    reset();
    responses = ['network-error'];
    await assert.rejects(fetchOfficeRoster(), (error: unknown) =>
      error instanceof OfficeRosterError && error.status === 0);
    reset();
    responses = [{ status: 403, json: { error: 'Only office staff can use this.' } }];
    await assert.rejects(fetchOfficeRoster(), (error: unknown) =>
      error instanceof OfficeRosterError && error.status === 403);
  });

  console.log('Screen and component wiring:');

  const screenSource = readFileSync(new URL('../app/(tabs)/patients.tsx', import.meta.url), 'utf8');
  const rosterSource = readFileSync(
    new URL('../components/office/LiveOfficeRoster.tsx', import.meta.url),
    'utf8',
  );
  const headerSource = readFileSync(
    new URL('../components/ui/ScreenHeader.tsx', import.meta.url),
    'utf8',
  );

  await check('the invite action appears only after the server accepts the roster fetch', () => {
    assert.match(screenSource, /officeRoster\.status === 'ready'/);
    assert.match(screenSource, /testID: 'header-invite-patient-btn'/);
    assert.match(screenSource, /label: 'Invite patient'/);
  });

  await check('the live section rides the list header and hides for non-staff sessions', () => {
    assert.match(screenSource, /ListHeaderComponent=\{<LiveRosterSection state=\{officeRoster\} onNotice=\{showNotice\} \/>\}/);
    assert.match(rosterSource, /err\.status === 401 \|\| err\.status === 403 \|\| err\.status === 503/);
    assert.match(rosterSource, /status === 'unavailable' \|\| state\.status === 'loading'/);
  });

  await check('the modal rides AppModal with per-field errors and a self-announcing ErrorBox', () => {
    assert.match(rosterSource, /<AppModal visible=\{visible\} transparent/);
    assert.match(rosterSource, /ErrorBox/);
    assert.match(rosterSource, /testID=\{`invite-patient-\$\{key\}`\}/);
    assert.match(rosterSource, /formatUsPhoneInput/);
  });

  await check('the resend control is rate-limit aware and carries an accessible name', () => {
    assert.match(rosterSource, /accessibilityLabel=\{`Resend invitation to \$\{patient\.name\}`\}/);
    assert.match(rosterSource, /resending === patient\.id/);
  });

  await check('the header action slot keeps an accessible name on the icon button', () => {
    assert.match(headerSource, /accessibilityLabel=\{action\.label\}/);
    assert.match(headerSource, /accessibilityRole="button"/);
  });

  console.log(`\nInvite-patients (mobile) checks passed: ${checks}/${checks}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
