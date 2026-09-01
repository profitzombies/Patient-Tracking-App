/**
 * Invite-patients regression suite (desktop provider portal).
 *
 * Behavioral half: runs the REAL src/lib/office-roster.ts client against a
 * scripted global fetch — auth token attachment, the 401→refresh→retry hop,
 * HQ office scoping on every endpoint, field-keyed error mapping, and the
 * shared phone/e-mail validation the modal relies on.
 *
 * Source half: pins the wiring a unit test can't reach — the Patients page
 * gates live UI on a signed-in staff session (demo personas stay
 * byte-identical), HQ drill-ins pass their explicitly scoped office, and
 * the roster/modal expose the stable testids + announced errors.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:invite-patients
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
} from '@/lib/office-roster';
import {
  __resetSupabaseStub,
  __setRefreshResult,
  __setSession,
  stubCalls,
} from '@/lib/supabase';

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

// --- scripted fetch ---------------------------------------------------------

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
}

const ROSTER = { office: { providerId: 'office-1', officeName: 'Harbor', providerCode: '483920' }, patients: [] };
const INVITE = { firstName: 'Jordan', lastName: 'Ellis', email: 'j@example.com', phone: '(555) 201-7788' };

async function main() {
  console.log('Shared validation and formatting:');

  await check('phone formats progressively to (xxx) xxx-xxxx and strips a leading 1', () => {
    assert.equal(formatUsPhoneInput('5'), '(5');
    assert.equal(formatUsPhoneInput('5552'), '(555) 2');
    assert.equal(formatUsPhoneInput('5552017'), '(555) 201-7');
    assert.equal(formatUsPhoneInput('5552017788'), '(555) 201-7788');
    assert.equal(formatUsPhoneInput('15552017788'), '(555) 201-7788');
    assert.equal(formatUsPhoneInput('555201778899'), '(555) 201-7788');
    assert.equal(formatUsPhoneInput(''), '');
  });

  await check('usPhoneDigits accepts exactly 10 digits (optional leading 1)', () => {
    assert.equal(usPhoneDigits('(555) 201-7788'), '5552017788');
    assert.equal(usPhoneDigits('1-555-201-7788'), '5552017788');
    assert.equal(usPhoneDigits('555-201'), null);
    assert.equal(usPhoneDigits('25552017788'), null);
  });

  await check('validateInviteForm demands every field with API-matching messages', () => {
    const empty = validateInviteForm({ firstName: ' ', lastName: '', email: '', phone: '' });
    assert.deepEqual(Object.keys(empty).sort(), ['email', 'firstName', 'lastName', 'phone']);
    assert.match(String(empty.phone), /required/i);
    const bad = validateInviteForm({ ...INVITE, email: 'nope', phone: '12345' });
    assert.match(String(bad.email), /valid email/i);
    assert.match(String(bad.phone), /10-digit US/i);
    assert.deepEqual(validateInviteForm(INVITE), {});
  });

  console.log('Client behavior against a scripted API:');

  await check('roster request is root-relative and carries the session bearer', async () => {
    reset();
    responses = [{ status: 200, json: ROSTER }];
    const roster = await fetchOfficeRoster();
    assert.equal(roster.office.providerCode, '483920');
    assert.equal(requests[0].url, '/api/office/roster');
    assert.equal(requests[0].headers.Authorization, 'Bearer tok-1');
  });

  await check('HQ drill-in scopes every endpoint to the explicit office', async () => {
    reset();
    responses = [
      { status: 200, json: ROSTER },
      { status: 201, json: { patient: {}, invitation: 'sent' } },
      { status: 200, json: { ok: true, invitation: 'sent', patient: {} } },
    ];
    await fetchOfficeRoster('office-2');
    await invitePatient(INVITE, 'office-2');
    await resendInvitation('pat-1', 'office-2');
    assert.equal(requests[0].url, '/api/office/roster?office=office-2');
    assert.equal(requests[1].body.office, 'office-2');
    assert.equal(requests[2].url, '/api/office/invitations/pat-1/resend');
    assert.equal(requests[2].body.office, 'office-2');
  });

  await check('a provider session sends no office at all — scope stays server-derived', async () => {
    reset();
    responses = [{ status: 201, json: { patient: {}, invitation: 'sent' } }];
    await invitePatient(INVITE);
    assert.equal(requests[0].body.office, undefined);
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

  await check('field-keyed API errors surface as OfficeRosterError with the field', async () => {
    reset();
    responses = [{ status: 409, json: { error: 'That email is already on a patient account. Use a different email.', field: 'email' } }];
    await assert.rejects(invitePatient(INVITE), (error: unknown) => {
      assert.ok(error instanceof OfficeRosterError);
      assert.equal(error.status, 409);
      assert.equal(error.field, 'email');
      assert.match(error.message, /already on a patient account/);
      return true;
    });
  });

  await check('signed-out and unreachable states fail loudly, never silently', async () => {
    reset(null);
    await assert.rejects(fetchOfficeRoster(), (error: unknown) =>
      error instanceof OfficeRosterError && error.status === 401);
    reset();
    responses = ['network-error'];
    await assert.rejects(fetchOfficeRoster(), (error: unknown) =>
      error instanceof OfficeRosterError && error.status === 0);
  });

  console.log('Page and component wiring:');

  const patientsSource = readFileSync(new URL('../src/pages/Patients.tsx', import.meta.url), 'utf8');
  const rosterSource = readFileSync(new URL('../src/components/office/LiveRoster.tsx', import.meta.url), 'utf8');

  await check('live UI mounts only for signed-in staff; demo personas stay seeded-only', () => {
    assert.match(patientsSource, /authStatus === 'signed-in'/);
    assert.match(patientsSource, /authRole === 'provider_staff'/);
    assert.match(patientsSource, /authRole === 'hq_admin' && Boolean\(scope\?\.providerId\)/);
    assert.match(patientsSource, /\{liveEnabled && <InvitePatientAction office=\{liveOffice\} \/>\}/);
    assert.match(patientsSource, /\{liveEnabled && <LiveRosterCard office=\{liveOffice\} \/>\}/);
  });

  await check('HQ drill-in passes ONLY its explicitly scoped office; staff pass none', () => {
    assert.match(patientsSource, /authRole === 'hq_admin' \? scope\?\.providerId \?\? null : null/);
  });

  await check('the invite action and modal expose stable testids and announced errors', () => {
    assert.match(rosterSource, /data-testid="button-invite-patient"/);
    assert.match(rosterSource, /data-testid="button-invite-patient-submit"/);
    assert.match(rosterSource, /data-testid=\{`input-invite-patient-\$\{key\}`\}/);
    assert.match(rosterSource, /role="alert"/);
    assert.match(rosterSource, /formatUsPhoneInput/);
  });

  await check('the live roster refreshes itself and offers a rate-limit-aware resend', () => {
    assert.match(rosterSource, /refetchInterval: 30_000/);
    assert.match(rosterSource, /invalidateQueries\(\{ queryKey: officeRosterQueryKey\(office\) \}\)/);
    assert.match(rosterSource, /data-testid=\{`button-resend-invite-\$\{patient\.id\}`\}/);
    assert.match(rosterSource, /data-testid="live-roster"/);
  });

  console.log(`\nInvite-patients (web) checks passed: ${checks}/${checks}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
