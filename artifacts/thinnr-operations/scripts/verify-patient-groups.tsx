/**
 * Office patient groups — the Groups manager, roster tags, the Group filter
 * field, HQ read-only drill-in, and the seeded demo.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:patient-groups
 *
 * Renders the REAL Patients page with react-test-renderer under Node
 * (tsconfig.patient-groups.json: session / scope / supabase stubs, DOM-free
 * Radix stubs for dialog, alert-dialog, sheet, select, popover, command,
 * calendar) against a scripted fetch that keeps an in-memory group store, so
 * every mutation round-trips the way the live API does: the roster rows'
 * groupIds and the group list are re-fetched after each write.
 *
 * Covers:
 *   - live: group tags on rows, "+N" overflow, the Groups button count;
 *   - manager: empty state copy, create (409 shown inline), rename, delete
 *     confirm naming the member count, roster search → add, remove;
 *   - filter builder: Group field with is / is not over the office's groups,
 *     chip "Group is MJH", URL f=group:is:<id>, stacking with another
 *     condition, a deleted group's condition pruned from the URL;
 *   - HQ drill-in: every request carries ?office=, no write controls anywhere
 *     (manager, rows), group filter still works;
 *   - live error: groups endpoint failing shows the inline error (never the
 *     demo groups);
 *   - demo (signed out): seeded groups incl. MJH, session-local add/remove
 *     without any fetch, Group filter over the seeded roster.
 */
import * as React from 'react';
import { act } from 'react';
import { create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PatientSessionProvider } from '../src/contexts/patient-session';
import { __setSession } from './a11y-stubs/session';
import { __setScope } from './a11y-stubs/provider-scope';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import type { OfficePatient, OfficeRoster, PatientGroup } from '../src/lib/office-roster';
import { GROUPS_EMPTY_COPY } from '../src/components/office/PatientGroups';
import { resetDemoPatientGroups, getDemoPatientGroupsState } from '../src/data/patient-groups-demo';
import Patients from '../src/pages/Patients';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const g = globalThis as any;
g.window ??= {};
g.window.getSelection ??= () => ({ toString: () => '' });
g.window.addEventListener ??= () => {};
g.window.removeEventListener ??= () => {};
g.window.innerWidth ??= 1280;
g.window.localStorage ??= (() => { const map = new Map<string, string>(); return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); }, clear: () => map.clear() }; })();
g.window.sessionStorage ??= (() => { const map = new Map<string, string>(); return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); }, clear: () => map.clear() }; })();
g.document ??= { title: '', querySelector: () => null, activeElement: null };

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ─── Fixture: an in-memory office with a group store ─────────────────────────

const AS_OF = '2026-09-06';
const OFFICE = { providerId: 'office-1', officeName: 'Beacon Hill Aesthetics', providerCode: '483920' };

function patient(id: string, name: string, startDate: string): OfficePatient {
  return {
    id, name, email: `${id}@example.com`, phone: null, phoneDisplay: null, activationStatus: 'activated', verified: true,
    createdAt: '2026-07-01T00:00:00Z',
    program: { id: 'metabolic', day: 60, stage: 'protocol', week: 9, startDate, startingWeight: 210, currentWeight: 200, goalWeight: 170, weightChange: -10, lastLogDate: null },
    invitation: null,
    attention: { flagged: false, reasons: [], signature: null },
    operational: {
      asOfDate: AS_OF, latestActivityDate: AS_OF, latestDiaryDate: AS_OF, latestCheckInDate: AS_OF, latestWaterDate: null, latestWeightDate: null, latestPhotoDate: null,
      loggedDays7: 4, checkIns7: 2, activity: null, status: 'on_track', reasons: [], followUps: [],
    },
    spend: { paidCents: 0, refundedCents: 0, netCents: 0, lastPaidAt: null },
    activeSubscription: false,
    groupIds: [],
  } as OfficePatient;
}

const BASE_PATIENTS: OfficePatient[] = [
  patient('pat-ada', 'Ada Aster', '2026-08-20'),
  patient('pat-bea', 'Bea Brook', '2026-08-10'),
  patient('pat-cal', 'Cal Cole', '2026-07-30'),
  patient('pat-dev', 'Dev Dunn', '2026-07-20'),
];

interface StoredGroup { id: string; name: string; description: string | null; createdAt: string; updatedAt: string; members: Set<string> }
let store = new Map<string, StoredGroup>();
let nextId = 1;
let groupsStatus = 200;
let hqScope = false;
const requests: { method: string; url: string }[] = [];

function seedStore(groups: Array<{ name: string; description?: string | null; members?: string[] }>) {
  store = new Map();
  nextId = 1;
  for (const entry of groups) {
    const id = `grp-${nextId++}`;
    store.set(id, { id, name: entry.name, description: entry.description ?? null, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', members: new Set(entry.members ?? []) });
  }
}

const toGroup = (group: StoredGroup): PatientGroup => ({ id: group.id, name: group.name, description: group.description, memberCount: group.members.size, createdAt: group.createdAt, updatedAt: group.updatedAt });
const sortedGroups = () => [...store.values()].sort((a, b) => a.name.localeCompare(b.name)).map(toGroup);

function rosterNow(): OfficeRoster {
  return {
    office: OFFICE,
    patients: BASE_PATIENTS.map((row) => ({ ...row, groupIds: [...store.values()].filter((group) => group.members.has(row.id)).map((group) => group.id) })),
    summary: { totalPatients: 4, activePatients: 4, newEnrollments30d: 0, needsAttention: 0, attention: 0, inactive: 0, invited: 0, checkInsOverdue: 0, loggingLapsed: 0, asOf: AS_OF },
  } as OfficeRoster;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  requests.push({ method, url });
  const path = url.split('?')[0];
  if (path === '/api/office/roster') return json(200, rosterNow());
  if (path === '/api/office/alerts') return json(200, { asOf: AS_OF, count: 0, total: 0, items: [] });
  if (path.startsWith('/api/office/patient-groups')) {
    if (groupsStatus !== 200) return json(groupsStatus, { error: 'Groups are unavailable right now.' });
    const rest = path.slice('/api/office/patient-groups'.length);
    if (method !== 'GET' && hqScope) return json(403, { error: 'HQ can view office groups but not change them.' });
    if (rest === '' && method === 'GET') return json(200, { office: { providerId: OFFICE.providerId, officeName: OFFICE.officeName }, canEdit: !hqScope, groups: sortedGroups() });
    if (rest === '' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { name: string; description?: string | null };
      if ([...store.values()].some((group) => group.name.toLowerCase() === body.name.toLowerCase())) return json(409, { error: 'A group with that name already exists.' });
      const id = `grp-${nextId++}`;
      const group: StoredGroup = { id, name: body.name, description: body.description ?? null, createdAt: '2026-09-06T00:00:00Z', updatedAt: '2026-09-06T00:00:00Z', members: new Set() };
      store.set(id, group);
      return json(201, { group: toGroup(group) });
    }
    const match = rest.match(/^\/([^/]+)(?:\/members\/([^/]+))?$/);
    const group = match ? store.get(decodeURIComponent(match[1])) : undefined;
    if (!match || !group) return json(404, { error: 'No group found for this office.' });
    const patientId = match[2] ? decodeURIComponent(match[2]) : null;
    if (patientId == null && method === 'PATCH') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { name?: string; description?: string | null };
      if (body.name && [...store.values()].some((other) => other.id !== group.id && other.name.toLowerCase() === body.name!.toLowerCase())) return json(409, { error: 'A group with that name already exists.' });
      if (body.name) group.name = body.name;
      if (body.description !== undefined) group.description = body.description;
      return json(200, { group: toGroup(group) });
    }
    if (patientId == null && method === 'DELETE') {
      const memberCount = group.members.size;
      store.delete(group.id);
      return json(200, { deleted: true, memberCount });
    }
    if (patientId != null && method === 'PUT') {
      if (!BASE_PATIENTS.some((row) => row.id === patientId)) return json(404, { error: 'No patient found for this office.' });
      const added = !group.members.has(patientId);
      group.members.add(patientId);
      return json(added ? 201 : 200, { added });
    }
    if (patientId != null && method === 'DELETE') {
      const removed = group.members.delete(patientId);
      return json(200, { removed });
    }
  }
  throw new Error(`unexpected fetch ${method} ${url}`);
};

// ─── Render helpers ──────────────────────────────────────────────────────────

interface Rendered { renderer: ReactTestRenderer; root: ReactTestInstance; loc: ReturnType<typeof memoryLocation> }

async function settle(rounds = 10) {
  for (let i = 0; i < rounds; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
}

async function renderRoster(path = '/patients'): Promise<Rendered> {
  const loc = memoryLocation({ path, record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <PatientSessionProvider>
          <Router hook={loc.hook}>
            <Patients />
          </Router>
        </PatientSessionProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
  return { renderer: renderer!, root: renderer!.root, loc };
}

function textOf(instance: ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (node: ReactTestInstance | string) => {
    if (typeof node === 'string') { parts.push(node); return; }
    node.children.forEach((child) => walk(child as ReactTestInstance | string));
  };
  walk(instance);
  return parts.join('');
}

const allByTestId = (root: ReactTestInstance, id: string) => root.findAll((node) => typeof node.type === 'string' && node.props['data-testid'] === id);
const byTestId = (root: ReactTestInstance, id: string) => {
  const matches = allByTestId(root, id);
  if (matches.length !== 1) throw new Error(`expected one ${id}, found ${matches.length}`);
  return matches[0];
};
function nearby(control: ReactTestInstance, predicate: (node: ReactTestInstance) => boolean): ReactTestInstance {
  let container: ReactTestInstance | null = control.parent;
  for (let depth = 0; container && depth < 6; depth += 1) {
    const hit = container.findAll((node) => typeof node.type === 'string' && predicate(node))[0];
    if (hit) return hit;
    container = container.parent;
  }
  throw new Error('no nearby match');
}
const tableRows = (root: ReactTestInstance) => root.findAll((node) => node.type === 'tr' && typeof node.props['aria-label'] === 'string' && node.props['aria-label'].startsWith('Open '));
const rowNames = (root: ReactTestInstance) => tableRows(root).map((row) => String(row.props['aria-label']).replace(/^Open |[’']s patient record.*$/g, ''));
const rowFor = (root: ReactTestInstance, name: string) => tableRows(root).find((row) => String(row.props['aria-label']).includes(name));
const rowTags = (root: ReactTestInstance, name: string) => {
  const row = rowFor(root, name);
  const tags = row ? allByTestId(row, 'patient-group-tags') : [];
  return tags.length ? textOf(tags[0]) : '';
};

async function click(node: ReactTestInstance) { await act(async () => { node.props.onClick?.({ preventDefault() {} }); }); await settle(4); }
async function type(node: ReactTestInstance, value: string) { await act(async () => { node.props.onChange({ target: { value } }); }); await settle(2); }
async function submit(form: ReactTestInstance) { await act(async () => { form.props.onSubmit({ preventDefault() {} }); }); await settle(6); }
async function pickOption(root: ReactTestInstance, controlTestId: string, value: string) {
  await click(nearby(byTestId(root, controlTestId), (node) => node.props.role === 'option' && node.props['data-value'] === value));
}
const lastUrl = (loc: ReturnType<typeof memoryLocation>) => loc.history?.at(-1) ?? '';

const signInStaff = () => {
  hqScope = false;
  __setScope(null);
  __setSupabaseSession('staff-token');
  __setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'staff-1', displayName: 'Casey Staff' } });
};
const signInHq = () => {
  hqScope = true;
  __setScope({ providerId: OFFICE.providerId, officeName: OFFICE.officeName });
  __setSupabaseSession('hq-token');
  __setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-1', displayName: 'Harper HQ' } });
};
const signOutDemo = () => {
  hqScope = false;
  __setScope(null);
  __setSupabaseSession(null);
  __setSession({ authStatus: 'signed-out', authRole: null, authUser: null });
};

// ─── Live: tags and the manager ──────────────────────────────────────────────

console.log('live roster: group tags');
{
  signInStaff();
  seedStore([
    { name: 'MJH', description: 'MJH employer wellness cohort', members: ['pat-ada', 'pat-bea'] },
    { name: 'Tuesday clinic', members: ['pat-ada'] },
    { name: 'GLP-1 transition', members: ['pat-ada'] },
  ]);
  const { renderer, root } = await renderRoster();
  check('four rows render', rowNames(root).length === 4, rowNames(root).join(','));
  check('Bea carries her MJH tag', rowTags(root, 'Bea Brook') === 'MJH', rowTags(root, 'Bea Brook'));
  check('Ada shows two names then +1', rowTags(root, 'Ada Aster') === 'GLP-1 transitionMJH+1', rowTags(root, 'Ada Aster'));
  check('+1 pill names the hidden groups', byTestId(rowFor(root, 'Ada Aster')!, 'patient-group-tags-more').props.title === 'Tuesday clinic');
  check('Cal has no tags', rowTags(root, 'Cal Cole') === '' && (rowFor(root, 'Cal Cole') ? allByTestId(rowFor(root, 'Cal Cole')!, 'patient-group-tags').length : 1) === 0);
  const button = byTestId(root, 'button-groups');
  check('Groups button counts the office groups', textOf(button) === 'Groups3' && button.props['aria-haspopup'] === 'dialog', textOf(button));
  check('groups and roster each fetched once', requests.filter((r) => r.url.startsWith('/api/office/patient-groups')).length === 1 && requests.filter((r) => r.url.startsWith('/api/office/roster')).length === 1);
  renderer.unmount();
}

console.log('\nmanager: empty state and create');
{
  signInStaff();
  seedStore([]);
  const { renderer, root } = await renderRoster();
  check('no tags, no count when the office has no groups', allByTestId(root, 'patient-group-tags').length === 0 && textOf(byTestId(root, 'button-groups')) === 'Groups');
  await click(byTestId(root, 'button-groups'));
  check('manager opens in a dialog on desktop', allByTestId(root, 'groups-dialog').length === 1);
  check('empty state copy', textOf(byTestId(root, 'groups-empty')).includes(GROUPS_EMPTY_COPY));
  await click(byTestId(root, 'button-new-group'));
  const form = byTestId(root, 'form-create-group');
  await submit(form);
  check('blank name is refused inline', textOf(form).includes('Enter a group name.'));
  await type(byTestId(root, 'form-create-group-name'), '  MJH ');
  await type(byTestId(root, 'form-create-group-description'), 'MJH employer wellness cohort');
  await submit(form);
  check('created group is selected in the manager', allByTestId(root, 'groups-manager').length === 1 && textOf(byTestId(root, 'group-detail-name')) === 'MJH');
  check('POST carried the trimmed name', requests.some((r) => r.method === 'POST' && r.url === '/api/office/patient-groups') && store.size === 1 && [...store.values()][0].name === 'MJH');
  check('Groups button count updates without reload', textOf(byTestId(root, 'button-groups')) === 'Groups1');
  // Duplicate (case-insensitive) → 409 shown inline.
  await click(byTestId(root, 'button-new-group'));
  await type(byTestId(root, 'form-create-group-name'), 'mjh');
  await submit(byTestId(root, 'form-create-group'));
  check('duplicate name shows the server conflict inline', textOf(byTestId(root, 'form-create-group')).includes('A group with that name already exists.') && store.size === 1);
  renderer.unmount();
}

console.log('\nmanager: add, remove, rename, delete');
{
  signInStaff();
  seedStore([{ name: 'MJH', members: ['pat-bea'] }, { name: 'Tuesday clinic' }]);
  const { renderer, root } = await renderRoster();
  await click(byTestId(root, 'button-groups'));
  check('first group selected by default (alphabetical)', textOf(byTestId(root, 'group-detail-name')) === 'MJH');
  check('member list shows Bea', allByTestId(root, 'group-member-pat-bea').length === 1 && allByTestId(root, 'group-member-pat-ada').length === 0);
  await type(byTestId(root, 'input-group-add-search'), 'ad');
  check('search lists only non-members matching the query', allByTestId(root, 'button-group-add-pat-ada').length === 1 && allByTestId(root, 'button-group-add-pat-bea').length === 0);
  await click(byTestId(root, 'button-group-add-pat-ada'));
  check('PUT member, Ada joins the member list', requests.some((r) => r.method === 'PUT' && r.url === '/api/office/patient-groups/grp-1/members/pat-ada') && allByTestId(root, 'group-member-pat-ada').length === 1);
  check('roster row picks up the tag without reload', rowTags(root, 'Ada Aster') === 'MJH', rowTags(root, 'Ada Aster'));
  check('member count follows', textOf(byTestId(root, 'group-item-grp-1')).includes('2'));
  await click(byTestId(root, 'button-group-remove-pat-bea'));
  check('DELETE member, Bea leaves the list and loses the tag', requests.some((r) => r.method === 'DELETE' && r.url === '/api/office/patient-groups/grp-1/members/pat-bea') && allByTestId(root, 'group-member-pat-bea').length === 0 && rowTags(root, 'Bea Brook') === '');
  // Rename.
  await click(byTestId(root, 'button-rename-group'));
  await type(byTestId(root, 'form-rename-group-name'), 'Tuesday Clinic');
  await submit(byTestId(root, 'form-rename-group'));
  check('rename conflict (case-insensitive) stays inline', textOf(byTestId(root, 'form-rename-group')).includes('A group with that name already exists.'));
  await type(byTestId(root, 'form-rename-group-name'), 'MJH Wellness');
  await submit(byTestId(root, 'form-rename-group'));
  check('rename lands on the detail, the row tag and the list', textOf(byTestId(root, 'group-detail-name')) === 'MJH Wellness' && rowTags(root, 'Ada Aster') === 'MJH Wellness' && textOf(byTestId(root, 'group-item-grp-1')).includes('MJH Wellness'));
  // Delete with confirm naming the count.
  await click(byTestId(root, 'button-delete-group'));
  check('confirm names the member count', textOf(byTestId(root, 'delete-group-description')).startsWith('This group contains 1 patient;'), textOf(byTestId(root, 'delete-group-description')));
  await click(byTestId(root, 'button-confirm-delete-group'));
  check('group deleted: list falls back to the next group, tag gone', !store.has('grp-1') && textOf(byTestId(root, 'group-detail-name')) === 'Tuesday clinic' && rowTags(root, 'Ada Aster') === '');
  renderer.unmount();
}

// ─── Live: the Group filter ──────────────────────────────────────────────────

console.log('\nfilter builder: Group is / is not');
{
  signInStaff();
  seedStore([{ name: 'MJH', members: ['pat-bea', 'pat-dev'] }, { name: 'Tuesday clinic', members: ['pat-ada'] }]);
  const { renderer, root, loc } = await renderRoster();
  await click(byTestId(root, 'button-filter'));
  await click(byTestId(root, 'button-add-filter'));
  await pickOption(root, 'filter-field-0', 'group');
  const optionsNear = (testId: string) => {
    let container: ReactTestInstance | null = byTestId(root, testId).parent;
    for (let depth = 0; container && depth < 6; depth += 1) {
      const hits = container.findAll((node) => typeof node.type === 'string' && node.props.role === 'option');
      if (hits.length) return hits;
      container = container.parent;
    }
    return [];
  };
  const operatorOptions = optionsNear('filter-operator-0').map((node) => node.props['data-value']);
  check('operators are is / is not only', operatorOptions.join(',') === 'is,is_not', operatorOptions.join(','));
  const valueOptions = optionsNear('filter-value-0').map((node) => `${node.props['data-value']}=${textOf(node)}`);
  check('value options are the office groups by name', valueOptions.join(',') === 'grp-1=MJH,grp-2=Tuesday clinic', valueOptions.join(','));
  await pickOption(root, 'filter-value-0', 'grp-1');
  check('Group is MJH keeps the two members', rowNames(root).join(',') === 'Bea Brook,Dev Dunn', rowNames(root).join(','));
  check('chip reads "Group is MJH"', textOf(byTestId(root, 'filter-chip-0')).startsWith('Group is MJH'), textOf(byTestId(root, 'filter-chip-0')));
  check('URL encodes f=group:is:<id>', lastUrl(loc).includes('f=group%3Ais%3Agrp-1'), lastUrl(loc));
  await pickOption(root, 'filter-operator-0', 'is_not');
  check('Group is not MJH keeps the others (non-members included)', rowNames(root).join(',') === 'Ada Aster,Cal Cole', rowNames(root).join(','));
  // Stack with another condition.
  await click(byTestId(root, 'button-add-filter'));
  await pickOption(root, 'filter-field-1', 'group');
  await pickOption(root, 'filter-value-1', 'grp-2');
  check('stacks with a second group condition (AND)', rowNames(root).join(',') === 'Ada Aster' && (lastUrl(loc).match(/f=/g) ?? []).length === 2, `${rowNames(root)} ${lastUrl(loc)}`);
  check('match count reads 1', textOf(byTestId(root, 'roster-filter-builder')).includes('1 patient shown'), textOf(byTestId(root, 'roster-filter-builder')).slice(0, 200));
  renderer.unmount();
}

console.log('\nfilter: arriving URL and a deleted group');
{
  signInStaff();
  seedStore([{ name: 'MJH', members: ['pat-bea'] }]);
  const { renderer, root, loc } = await renderRoster('/patients?f=group%3Ais%3Agrp-1&f=status%3Ais%3Aactive');
  check('arriving link applies the group filter with its sibling', rowNames(root).join(',') === 'Bea Brook' && allByTestId(root, 'filter-chip-1').length === 1, rowNames(root).join(','));
  // Delete the group through the manager: the condition must leave the URL.
  await click(byTestId(root, 'button-groups'));
  await click(byTestId(root, 'button-delete-group'));
  await click(byTestId(root, 'button-confirm-delete-group'));
  check('deleted group condition pruned, status condition kept', !lastUrl(loc).includes('group') && lastUrl(loc).includes('f=status%3Ais%3Aactive') && rowNames(root).length === 4, lastUrl(loc));
  renderer.unmount();

  // An arriving link for a group that no longer exists is dropped once the list loads.
  const second = await renderRoster('/patients?f=group%3Ais%3Agrp-missing');
  check('unknown group in the URL is dropped, nothing silently matches nothing', !lastUrl(second.loc).includes('group') && rowNames(second.root).length === 4, lastUrl(second.loc));
  second.renderer.unmount();
}

// ─── HQ drill-in: read-only, scoped ──────────────────────────────────────────

console.log('\nHQ drill-in: read-only groups');
{
  signInHq();
  seedStore([{ name: 'MJH', members: ['pat-bea'] }]);
  requests.length = 0;
  const { renderer, root } = await renderRoster();
  const scoped = requests.filter((r) => r.url.startsWith('/api/office/'));
  check('every office request carries ?office=', scoped.length >= 2 && scoped.every((r) => r.url.includes(`office=${OFFICE.providerId}`)), scoped.map((r) => r.url).join(' '));
  check('tags still render', rowTags(root, 'Bea Brook') === 'MJH');
  await click(byTestId(root, 'button-groups'));
  check('manager says view only', textOf(byTestId(root, 'groups-dialog')).includes('view only'));
  check('no create / rename / delete / add / remove controls', ['button-new-group', 'button-rename-group', 'button-delete-group', 'input-group-add-search', 'button-group-remove-pat-bea'].every((id) => allByTestId(root, id).length === 0));
  check('members still listed', allByTestId(root, 'group-member-pat-bea').length === 1);
  await click(byTestId(root, 'button-filter'));
  await click(byTestId(root, 'button-add-filter'));
  await pickOption(root, 'filter-field-0', 'group');
  await pickOption(root, 'filter-value-0', 'grp-1');
  check('group filter works under HQ', rowNames(root).join(',') === 'Bea Brook');
  renderer.unmount();
}

// ─── Live error: never the demo groups ───────────────────────────────────────

console.log('\nlive error: groups endpoint down');
{
  signInStaff();
  seedStore([]);
  groupsStatus = 503;
  const { renderer, root } = await renderRoster();
  await click(byTestId(root, 'button-groups'));
  check('manager shows the inline error', allByTestId(root, 'groups-error').length === 1 && textOf(byTestId(root, 'groups-error')).includes('Groups could not be loaded'));
  check('no seeded demo group leaks into the live page', !textOf(root).includes('Tuesday clinic') && allByTestId(root, 'patient-group-tags').length === 0);
  groupsStatus = 200;
  renderer.unmount();
}

// ─── Demo persona ────────────────────────────────────────────────────────────

console.log('\ndemo: seeded groups, session-local edits');
{
  signOutDemo();
  resetDemoPatientGroups();
  requests.length = 0;
  const { renderer, root, loc } = await renderRoster();
  const seeded = getDemoPatientGroupsState();
  const mjh = seeded.groups.find((group) => group.name === 'MJH')!;
  check('seeded groups include an employer-style MJH', Boolean(mjh) && seeded.groups.length === 3 && textOf(byTestId(root, 'button-groups')) === 'Groups3');
  const mjhMembers = seeded.members.get(mjh.id) ?? [];
  check('seeded MJH membership is deterministic', mjhMembers.length === 6 && mjhMembers[0] === 'pat_101', mjhMembers.join(','));
  check('demo rows carry tags', allByTestId(root, 'patient-group-tags').length > 0);
  await click(byTestId(root, 'button-filter'));
  await click(byTestId(root, 'button-add-filter'));
  await pickOption(root, 'filter-field-0', 'group');
  await pickOption(root, 'filter-value-0', mjh.id);
  check('demo Group is MJH keeps the seeded members', rowNames(root).length === 6 && textOf(byTestId(root, 'filter-chip-0')).startsWith('Group is MJH'), `${rowNames(root).length}`);
  check('demo URL round-trips the same way', lastUrl(loc).includes(`f=group%3Ais%3A${mjh.id}`), lastUrl(loc));
  await click(byTestId(root, 'button-clear-filters'));
  await click(byTestId(root, 'button-groups'));
  await click(byTestId(root, `group-item-${mjh.id}`));
  await type(byTestId(root, 'input-group-add-search'), 'a');
  const addButtons = root.findAll((node) => typeof node.type === 'string' && String(node.props['data-testid'] ?? '').startsWith('button-group-add-'));
  check('demo roster search offers non-members', addButtons.length > 0);
  const targetId = String(addButtons[0].props['data-testid']).replace('button-group-add-', '');
  await click(addButtons[0]);
  check('demo add is session-local (no fetch)', (getDemoPatientGroupsState().members.get(mjh.id) ?? []).includes(targetId) && allByTestId(root, `group-member-${targetId}`).length === 1 && requests.length === 0);
  await click(byTestId(root, `button-group-remove-${targetId}`));
  check('demo remove reverts it', !(getDemoPatientGroupsState().members.get(mjh.id) ?? []).includes(targetId) && requests.length === 0);
  check('no demo write controls hidden (full edit for the guided office)', allByTestId(root, 'button-new-group').length === 1);
  renderer.unmount();
  resetDemoPatientGroups();
}

console.log('\nphone width: manager in a bottom sheet');
{
  signInStaff();
  seedStore([{ name: 'MJH' }]);
  g.window.innerWidth = 390;
  const { renderer, root } = await renderRoster();
  await click(byTestId(root, 'button-groups'));
  check('sheet hosts the manager on phones', allByTestId(root, 'groups-sheet').length === 1 && byTestId(root, 'groups-sheet').props['data-side'] === 'bottom' && allByTestId(root, 'groups-dialog').length === 0);
  g.window.innerWidth = 1280;
  renderer.unmount();
}

if (failures > 0) {
  console.error(`\n${failures} patient-groups check(s) failed`);
  process.exit(1);
}
console.log('\nall patient-groups checks passed');
