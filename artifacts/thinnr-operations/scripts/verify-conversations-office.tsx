import * as React from 'react';
import assert from 'node:assert/strict';
import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import OfficeConversations from '../src/pages/OfficeConversations';
import { HqConversations } from '../src/components/conversations/HqConversations';
import { LiveMessageRow, planThreadFollow } from '../src/components/conversations/shared';
import { __setSession } from './a11y-stubs/session';
import { __setScope } from './a11y-stubs/provider-scope';
import { __setHqData } from './a11y-stubs/hq-data';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const browser = globalThis as typeof globalThis & { window: typeof globalThis };
browser.window ??= globalThis;
browser.window.addEventListener ??= () => {};
browser.window.removeEventListener ??= () => {};
(globalThis as unknown as { HTMLFormElement: unknown }).HTMLFormElement ??= class HTMLFormElement {};

const conversation = {
  id: 'conv-1', patientId: 'pat-1', patientName: 'Ada Patient', thread: 'care_team', channel: 'care_team',
  providerId: 'office-1', officeName: 'Beacon Clinic', status: 'open', assignee: null, unread: true,
  messageCount: 2, lastMessageAt: '2026-09-10T12:00:00Z', lastPatientMessageAt: '2026-09-10T12:00:00Z',
  lastStaffReplyAt: null, preview: 'Need help', noteCount: 0, openEscalation: null,
  createdAt: '2026-09-10T11:00:00Z', autoClosed: false,
};
const aiConversation = { ...conversation, id: 'conv-ai', thread: 'coach', channel: 'ai' };
const event = (seq: number, text: string) => ({
  seq, clientId: null, role: 'user', text, stopped: false, senderLabel: null, senderUserId: null,
  createdAt: `2026-09-10T1${seq}:00:00Z`,
});
const offeredProducts = [
  {
    product_id: 'prod-1', slug: 'daily-balance', name: 'Daily Balance', description: '', category: 'supplement',
    tagline: 'Daily support', image_url: null, unit_price_cents: 3200, office_priced: true,
    subscription_available: true, subscribe_save_percent: 10, subscription_unit_price_cents: 2880,
    subscription_cadences_weeks: [4, 8], default_cadence_weeks: 4,
  },
  {
    product_id: 'prod-2', slug: 'metabolic-drops', name: 'Metabolic Drops', description: '', category: 'drops',
    tagline: 'Metabolic support', image_url: null, unit_price_cents: 4500, office_priced: false,
    subscription_available: false, subscribe_save_percent: 0, subscription_unit_price_cents: null,
    subscription_cadences_weeks: [], default_cadence_weeks: 4,
  },
];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
const textOf = (node: ReactTestInstance): string => {
  const out: string[] = [];
  const walk = (child: ReactTestInstance | string) => {
    if (typeof child === 'string') out.push(child);
    else child.children.forEach(value => walk(value as ReactTestInstance | string));
  };
  walk(node);
  return out.join('');
};
const threadColumnOf = (root: ReactTestInstance) => root.find(node => node.props['data-testid'] === 'conversation-thread');
const assertTopAnchoredThread = (root: ReactTestInstance, label: string) => {
  const column = threadColumnOf(root);
  const className: string = column.props.className ?? '';
  assert.doesNotMatch(className, /justify-end|min-h-\[/, `${label} thread column must read top-down, not bottom-justified in a fixed-height box`);
  const pane = root.find(node => node.props['data-testid'] === 'conversation-thread-pane');
  assert.match(pane.props.className, /overflow-y-auto/, `${label} thread pane must scroll independently`);
  assert.match(pane.props.className, /flex-1/, `${label} thread pane must fill the viewer`);
  // The viewer root must size to the shell's content area. A 100dvh minimum
  // pushed the pane bottom (and the office composer) below the viewport, so
  // "scroll to newest" landed off-screen and the outer shell scrolled instead.
  const roots = root.findAll(node => typeof node.type === 'string' && /min-h-\[100dvh\]|h-\[100dvh\]/.test(node.props.className ?? ''));
  assert.equal(roots.length, 0, `${label} viewer must not force a viewport-height minimum inside the shell`);
};
const settle = async () => {
  for (let index = 0; index < 12; index += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 2)); });
};

let replyBodies: Array<{ clientId: string; text: string; suggestion?: unknown }> = [];
let failFirstReply = true;
let nextReplySeq = 3;
let requestUrls: string[] = [];
let listOwner = 'Ada Patient';
let delayedListResolve: ((response: Response) => void) | null = null;
let delayNextList = false;
let listEmpty = false;
const startBodies: Array<{ patientId: string }> = [];
const readRequests: Array<{ url: string; throughSeq: number }> = [];
let delayedNoteResolve: ((response: Response) => void) | null = null;
let hqNotes: Array<{ id: string; body: string; authorLabel: string; createdAt: string }> = [];
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  requestUrls.push(`${init?.method ?? 'GET'} ${url}`);
  const pathname = new URL(url, 'http://test').pathname;
  if (pathname.endsWith('/api/billing/office/sales/context')) {
    return json({
      patient: { id: 'pat-1', name: 'Ada Patient', email: 'ada@example.com', phone: null },
      default_address: null,
      products: offeredProducts,
      shipping_charge_cents: 0,
      subscribe_save_percent: 10,
      stripe_account_id: 'acct-test',
      publishable_key: 'pk_test',
      sandbox: true,
      available: true,
      unavailable_reason: null,
    });
  }
  if (url.includes('/api/hq/conversations')) {
    if (url.includes('/notes')) return json({ notes: hqNotes });
    if (url.includes('/read')) return json({ lastReadSeq: 2, changed: true });
    if (url.includes('/events')) {
      const parsed = new URL(url, 'http://test');
      if (parsed.searchParams.has('after')) return json({ events: [], nextBefore: null, nextAfter: null });
      return json({ events: [event(2, 'HQ transcript')], nextBefore: null, nextAfter: null });
    }
    return json({ conversations: [{ ...conversation, updatedAt: conversation.lastMessageAt }], total: 1, autoCloseDays: 14 });
  }
  if (url.includes('/api/office/roster')) return json({ office: {}, patients: [{ id: 'pat-1', name: 'Ada Patient', email: 'ada@example.com', phone: null, phoneDisplay: null }] });
  if (pathname.endsWith('/api/office/conversations/start')) {
    startBodies.push(JSON.parse(String(init?.body)));
    return json({ conversation: { ...conversation, id: 'conv-started', patientId: startBodies.at(-1)!.patientId }, created: true });
  }
  if (pathname.endsWith('/api/office/conversations/summary')) return json({ scope: { providerId: 'office-1', officeName: 'Beacon Clinic' }, asOf: new Date().toISOString(), metrics: { openThreads: 1, waitingOnPatient: 0, unanswered: 1, avgResponseMinutes: null, openEscalations: 0 } });
  if (pathname.endsWith('/api/office/conversations/staff')) return json({ staff: [] });
  if (url.includes('/notes') && (init?.method ?? 'GET') === 'POST') return new Promise<Response>(resolve => { delayedNoteResolve = resolve; });
  if (url.includes('/notes')) return json({ notes: [] });
  if (url.includes('/read')) {
    const throughSeq = JSON.parse(String(init?.body)).throughSeq;
    readRequests.push({ url, throughSeq });
    return json({ lastReadSeq: throughSeq, changed: true });
  }
  if (url.includes('/reply')) {
    replyBodies.push(JSON.parse(String(init?.body)));
    if (failFirstReply) { failFirstReply = false; return json({ error: 'response lost' }, 503); }
    return json({ conversation, event: { ...event(nextReplySeq++, replyBodies.at(-1)!.text), role: 'staff', clientId: replyBodies.at(-1)!.clientId, senderLabel: 'Nurse Lee', senderUserId: 'staff-1' } });
  }
  if (url.includes('/events')) {
    const parsed = new URL(url, 'http://test');
    if (url.includes('/conv-ai/')) return json({ conversation: aiConversation, events: [event(2, 'AI history')], nextBefore: null, nextAfter: null });
    if (url.includes('/conv-low/')) return json({ conversation: { ...conversation, id: 'conv-low' }, events: [event(1, 'Low sequence thread')], nextBefore: null, nextAfter: null });
    if (parsed.searchParams.has('before')) return json({ conversation, events: [event(1, 'Old history')], nextBefore: null, nextAfter: null });
    if (parsed.searchParams.has('after')) return json({ conversation, events: [], nextBefore: null, nextAfter: null });
    return json({ conversation, events: [event(2, 'Newest message')], nextBefore: 2, nextAfter: null });
  }
  if (url.includes('/api/office/conversations')) {
    if (delayNextList) {
      delayNextList = false;
      return new Promise<Response>(resolve => { delayedListResolve = resolve; });
    }
    return json({ conversations: listEmpty ? [] : [{ ...conversation, patientName: listOwner }], total: listEmpty ? 0 : 1, autoCloseDays: 14 });
  }
  throw new Error(`Unexpected request ${url}`);
};

type MemoryLocation = ReturnType<typeof memoryLocation>;
function Page({ path = '/conversations?channel=care_team&conversation=conv-1', location: providedLocation }: { path?: string; location?: MemoryLocation }) {
  const ownLocation = React.useMemo(() => memoryLocation({ path, record: true }), [path]);
  const location = providedLocation ?? ownLocation;
  const client = React.useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }), []);
  return <QueryClientProvider client={client}><Router hook={location.hook}><OfficeConversations /></Router></QueryClientProvider>;
}

function HqPage({ path }: { path: string }) {
  const location = React.useMemo(() => memoryLocation({ path, record: true }), [path]);
  const client = React.useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }), []);
  return <QueryClientProvider client={client}><Router hook={location.hook}><HqConversations role="Clinical" /></Router></QueryClientProvider>;
}

__setScope(null);
__setSession({ authStatus: 'signed-out', authRole: null, authUser: null });
requestUrls = [];
let renderer: ReactTestRenderer;
await act(async () => { renderer = create(<Page path="/conversations" />); });
assert.equal(renderer!.root.findAll(node => node.props['data-testid'] === 'demo-conversations-local').length, 1);
assert.equal(requestUrls.length, 0, 'guided demo must make no live requests');
await act(async () => { renderer!.unmount(); });

listEmpty = true;
startBodies.length = 0;
__setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'staff-start' }, providerAccountCode: 'office-1' });
await act(async () => { renderer = create(<Page path="/conversations?startPatient=pat-nohistory" />); });
await settle();
assert.deepEqual(startBodies, [{ patientId: 'pat-nohistory' }], 'roster action must ensure a thread even when the inbox is empty');
await act(async () => { renderer!.unmount(); });
listEmpty = false;

__setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'staff-old' }, providerAccountCode: 'office-old' });
delayNextList = true;
listOwner = 'New Account Patient';
await act(async () => { renderer = create(<Page path="/conversations?channel=care_team" />); });
await settle();
__setSession({ authUser: { id: 'staff-new' }, providerAccountCode: 'office-new' });
await act(async () => { renderer!.update(<Page path="/conversations?channel=care_team" />); });
await settle();
await act(async () => { delayedListResolve?.(json({ conversations: [{ ...conversation, patientName: 'Old Account Patient' }], total: 1, autoCloseDays: 14 })); });
await settle();
assert.match(textOf(renderer!.root), /New Account Patient/);
assert.doesNotMatch(textOf(renderer!.root), /Old Account Patient/, 'late prior-account list data must stay isolated');
await act(async () => { renderer!.unmount(); });

__setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'staff-1' }, providerAccountCode: 'office-1' });
await act(async () => { renderer = create(<Page />); });
await settle();
assert.match(textOf(renderer!.root), /Newest message/);
assertTopAnchoredThread(renderer!.root, 'office');
assert.match(textOf(renderer!.root), /No internal notes yet/, 'office notes card must show an empty state when there are no notes');
assert.equal(renderer!.root.findAll(node => node.type === 'button' && textOf(node).trim() === 'Escalate').length, 0, 'care-team conversations must not offer AI escalation');
assert.equal(renderer!.root.findAll(node => node.props['aria-label'] === 'Add product suggestion').length, 1, 'care-team conversations must offer product suggestions');
const composer = renderer!.root.find(node => node.type === 'textarea' && node.props['aria-label'] === 'Reply to patient');
await act(async () => { composer.props.onChange({ target: { value: 'Exact retry text' } }); });
const send = renderer!.root.find(node => node.type === 'button' && textOf(node).includes('Send'));
await act(async () => { await send.props.onClick(); });
await settle();
const retry = renderer!.root.find(node => node.type === 'button' && textOf(node) === 'Retry');
await act(async () => { await retry.props.onClick(); });
await settle();
assert.equal(replyBodies.length, 2);
assert.deepEqual(replyBodies[0], replyBodies[1], 'lost-response retry must preserve exact text and clientId');
assert.ok(requestUrls.some(request => request.includes('/events?after=2')), 'send acknowledgement must not advance the fetched polling watermark');
const older = renderer!.root.find(node => node.type === 'button' && textOf(node).includes('Load older'));
await act(async () => { older.props.onClick(); });
await settle();
const transcript = textOf(renderer!.root);
assert.match(transcript, /Old history/);
assert.match(transcript, /Newest message/);
const olderIndex = transcript.indexOf('Old history');
const newestIndex = transcript.indexOf('Newest message');
assert.ok(olderIndex >= 0 && olderIndex < newestIndex, 'older messages must be inserted above the newest, keeping the thread top-down');
assert.ok(transcript.indexOf('Started') < olderIndex, 'the "Started" label must lead the thread');
await act(async () => { renderer!.unmount(); });

// Newest-message auto-scroll across the open → close → reopen lifecycle and
// transcript growth, with fake pane geometry standing in for the browser.
// The pane is 700px tall with its bottom edge at y=800; the newest anchor
// sits 20px (pane padding) above the end of the transcript.
const PANE_CLIENT = 700;
const PANE_BOTTOM = 800;
const PANE_PADDING = 20;
// Transcript height follows what is actually rendered (thread B is much
// taller than thread A) plus any growth the test adds, so a decision taken
// against a stale, not-yet-swapped transcript measures the wrong thread.
let extraHeight = 0;
const transcriptHeightOf = (text: string) => (text.includes('AI history') ? 5000 : 3000) + (text.includes('Old history') ? 4000 : 0) + extraHeight;
const transcriptHeight = () => transcriptHeightOf(textOf(renderer!.root));
type FakePane = { scrollTop: number; readonly clientHeight: number; readonly scrollHeight: number; getBoundingClientRect: () => { bottom: number } };
let currentPane: FakePane | null = null;
const panesMounted: FakePane[] = [];
const fakeAnchor = {
  getBoundingClientRect: () => {
    const pane = currentPane!;
    return { bottom: PANE_BOTTOM + (pane.scrollHeight - pane.clientHeight - pane.scrollTop) - PANE_PADDING };
  },
};
const createNodeMock = (element: React.ReactElement<Record<string, unknown>>) => {
  if (element.props['data-testid'] === 'conversation-thread-pane') {
    let rawScrollTop = 0;
    const pane: FakePane = {
      // Browsers clamp scrollTop to the scrollable range, so a transcript
      // swap that shrinks the pane pulls the offset back with it.
      get scrollTop() { return Math.min(rawScrollTop, Math.max(0, this.scrollHeight - this.clientHeight)); },
      set scrollTop(value: number) { rawScrollTop = Math.max(0, value); },
      clientHeight: PANE_CLIENT,
      get scrollHeight() { return transcriptHeight(); },
      getBoundingClientRect: () => ({ bottom: PANE_BOTTOM }),
    };
    panesMounted.push(pane);
    currentPane = pane;
    return pane;
  }
  if (element.props['aria-hidden'] === 'true' && element.props.className === 'h-px') return fakeAnchor;
  return null;
};
const expectedBottom = () => transcriptHeight() - PANE_CLIENT - PANE_PADDING;

// The follow decision itself: a fresh pane for the same thread is a first
// load; a settled reader far from the end is left alone; growth is netted
// out before measuring how close to the end the reader was.
const paneAt = (scrollTop: number, scrollHeight: number) => ({ scrollTop, clientHeight: PANE_CLIENT, scrollHeight, getBoundingClientRect: () => ({ bottom: PANE_BOTTOM }) }) as unknown as HTMLElement;
const firstPane = paneAt(0, 3000);
const opened = planThreadFollow(null, 'acct:conv-1', firstPane);
assert.equal(opened.follow, true, 'first transcript for a thread must scroll');
const reopenedPane = paneAt(0, 3000);
assert.equal(planThreadFollow(opened.next, 'acct:conv-1', reopenedPane).follow, true, 'reopening the same thread in a fresh pane must scroll again');
assert.equal(planThreadFollow(opened.next, 'acct:conv-1', firstPane).follow, false, 'a reader far from the newest end is not moved by growth');
const livePane = paneAt(2280, 3000) as unknown as { scrollTop: number; scrollHeight: number };
const atBottom = planThreadFollow(null, 'acct:conv-1', livePane as unknown as HTMLElement);
livePane.scrollHeight = 3300;
assert.equal(planThreadFollow(atBottom.next, 'acct:conv-1', livePane as unknown as HTMLElement).follow, true, 'growth taller than the tolerance must still follow a reader who was at the end');
livePane.scrollTop = 1000;
assert.equal(planThreadFollow(atBottom.next, 'acct:conv-1', livePane as unknown as HTMLElement).follow, false, 'a reader who scrolled up before growth landed is not moved');
failFirstReply = false;
// Navigate through one shared location (as the browser does) so the page
// instance and its refs survive closing and reopening the thread.
const lifecycleLocation = memoryLocation({ path: '/conversations?channel=care_team&conversation=conv-1', record: true });
await act(async () => { renderer = create(<Page location={lifecycleLocation} />, { createNodeMock }); });
await settle();
assert.equal(panesMounted.length, 1, 'opening a thread mounts one scroll pane');
assert.equal(panesMounted[0].scrollTop, expectedBottom(), 'opening a long thread must scroll its pane to the newest message');
await act(async () => { lifecycleLocation.navigate('/conversations?channel=care_team'); });
await settle();
assert.equal(renderer!.root.findAll(node => node.props['data-testid'] === 'conversation-thread-pane').length, 0, 'closing the thread unmounts the pane');
await act(async () => { lifecycleLocation.navigate('/conversations?channel=care_team&conversation=conv-1'); });
await settle();
assert.equal(panesMounted.length, 2, 'reopening mounts a fresh pane');
assert.notEqual(panesMounted[1], panesMounted[0]);
assert.equal(panesMounted[1].scrollTop, expectedBottom(), 'reopening the same thread must scroll the fresh pane to the newest message again');

// A reader at the newest end keeps following even when the incoming message
// is taller than the near-bottom tolerance (300px > 120px).
extraHeight += 300;
const followComposer = renderer!.root.find(node => node.type === 'textarea' && node.props['aria-label'] === 'Reply to patient');
await act(async () => { followComposer.props.onChange({ target: { value: 'Tall reply' } }); });
await act(async () => { await renderer!.root.find(node => node.type === 'button' && textOf(node).includes('Send')).props.onClick(); });
await settle();
assert.match(textOf(renderer!.root), /Tall reply/);
assert.equal(panesMounted[1].scrollTop, expectedBottom(), 'a reader at the newest end must follow a tall incoming message');

// A reader who scrolled up to read is never yanked back down by growth.
panesMounted[1].scrollTop = 0;
extraHeight += 80;
await act(async () => { followComposer.props.onChange({ target: { value: 'Quiet reply' } }); });
await act(async () => { await renderer!.root.find(node => node.type === 'button' && textOf(node).includes('Send')).props.onClick(); });
await settle();
assert.match(textOf(renderer!.root), /Quiet reply/);
assert.equal(panesMounted[1].scrollTop, 0, 'transcript growth must not move a reader who scrolled up');

// Cached thread-to-thread navigation in the SAME pane: A → B → A where both
// threads end at seq 2 but B is far taller. The decision must wait for B's
// transcript to land, not fire against A's still-rendered events.
panesMounted[1].scrollTop = expectedBottom();
await act(async () => { lifecycleLocation.navigate('/conversations?channel=ai&conversation=conv-ai'); });
await settle();
assert.equal(panesMounted.length, 2, 'switching threads keeps the same pane mounted');
assert.match(textOf(renderer!.root), /AI history/);
assert.equal(panesMounted[1].scrollTop, expectedBottom(), 'switching to a cached, taller thread must land on its newest message');
await act(async () => { lifecycleLocation.navigate('/conversations?channel=care_team&conversation=conv-1'); });
await settle();
assert.match(textOf(renderer!.root), /Newest message/);
// Shrinking back to A clamps the offset to within the pane padding of the
// anchor, so the newest message is already in view; a follow is a no-op.
assert.ok(panesMounted[1].scrollTop >= expectedBottom(), 'switching back to the first cached thread must leave its newest message in view');
await act(async () => { lifecycleLocation.navigate('/conversations?channel=ai&conversation=conv-ai'); });
await settle();
assert.equal(panesMounted[1].scrollTop, expectedBottom(), 'returning to the taller thread must scroll to its newest message again');

// Browsing history: open → scroll to the top → load older (a 4000px batch
// prepended; scroll anchoring keeps the reader on the same message) → a new
// message appends. The reader must stay exactly where they were.
await act(async () => { lifecycleLocation.navigate('/conversations?channel=care_team&conversation=conv-1'); });
await settle();
panesMounted[1].scrollTop = 0;
await act(async () => { renderer!.root.find(node => node.type === 'button' && textOf(node).includes('Load older')).props.onClick(); });
await settle();
assert.match(textOf(renderer!.root), /Old history/);
panesMounted[1].scrollTop = 4000; // what the browser's scroll anchoring does on prepend
const historyOffset = panesMounted[1].scrollTop;
extraHeight += 80;
await act(async () => { renderer!.root.find(node => node.type === 'textarea' && node.props['aria-label'] === 'Reply to patient').props.onChange({ target: { value: 'Late reply' } }); });
await act(async () => { await renderer!.root.find(node => node.type === 'button' && textOf(node).includes('Send')).props.onClick(); });
await settle();
assert.match(textOf(renderer!.root), /Late reply/);
assert.equal(panesMounted[1].scrollTop, historyOffset, 'a reader browsing loaded history must not be yanked to the newest message');
await act(async () => { renderer!.unmount(); });
currentPane = null;
failFirstReply = true;

await act(async () => { renderer = create(<Page path="/conversations?channel=ai&conversation=conv-ai" />); });
await settle();
const aiEscalateButtons = renderer!.root.findAll(node => node.type === 'button' && textOf(node).trim() === 'Escalate');
assert.equal(aiEscalateButtons.length, 1, 'historic AI conversations must retain escalation');
assert.equal(renderer!.root.findAll(node => node.props['aria-label'] === 'Add product suggestion').length, 0, 'AI threads must not offer product suggestions');
await act(async () => { renderer!.unmount(); });

readRequests.length = 0;
await act(async () => { renderer = create(<Page path="/conversations?channel=care_team&conversation=conv-1" />); });
await settle();
const draft = renderer!.root.find(node => node.type === 'textarea' && node.props['aria-label'] === 'Reply to patient');
const note = renderer!.root.find(node => node.type === 'textarea' && node.props['aria-label'] === 'New internal note');
await act(async () => {
  draft.props.onChange({ target: { value: 'old thread draft' } });
  note.props.onChange({ target: { value: 'old thread note' } });
});
const addNote = renderer!.root.find(node => node.type === 'button' && textOf(node) === 'Add note');
await act(async () => { void addNote.props.onClick(); });
await act(async () => { renderer!.update(<Page path="/conversations?channel=care_team&conversation=conv-low" />); });
await settle();
const newDraft = renderer!.root.find(node => node.type === 'textarea' && node.props['aria-label'] === 'Reply to patient');
const newNote = renderer!.root.find(node => node.type === 'textarea' && node.props['aria-label'] === 'New internal note');
assert.equal(newDraft.props.value, '');
assert.equal(newNote.props.value, '', 'note and reply drafts must reset at the thread boundary');
await act(async () => { newNote.props.onChange({ target: { value: 'new thread note' } }); });
await act(async () => { delayedNoteResolve?.(json({ note: { id: 'note-old' } })); });
await settle();
assert.equal(renderer!.root.find(node => node.type === 'textarea' && node.props['aria-label'] === 'New internal note').props.value, 'new thread note', 'late old-thread note completion must not clear the current draft');
assert.ok(readRequests.some(request => request.url.includes('/conv-1/read') && request.throughSeq === 2));
assert.ok(readRequests.some(request => request.url.includes('/conv-low/read') && request.throughSeq === 1), 'a lower-sequence new thread must have an independent read watermark');
await act(async () => { renderer!.unmount(); });

__setHqData({ accounts: [{ id: 'office-1', officeName: 'Beacon Clinic', providerName: 'Dr Lee', providerCode: '123' }] });
requestUrls = [];
await act(async () => {
  renderer = create(<HqPage path="/admin/conversations?office=office-1&patientId=pat-1&channel=care_team&thread=care_team&status=open&assignee=unassigned&unread=true&q=Ada&sort=oldest&offset=20&conversation=conv-1" />);
});
await settle();
assert.match(textOf(renderer!.root), /HQ transcript/);
assertTopAnchoredThread(renderer!.root, 'HQ');
assert.match(textOf(renderer!.root), /No internal notes yet/, 'HQ notes card must show an empty state when there are no notes');
assert.doesNotMatch(textOf(renderer!.root), /Loading notes/, 'HQ notes must settle out of the loading state');
const hqListRequest = requestUrls.find(request => request.startsWith('GET ') && request.includes('/api/hq/conversations?'));
assert.ok(hqListRequest);
for (const fragment of ['office=office-1', 'patientId=pat-1', 'channel=care_team', 'thread=care_team', 'status=open', 'assignee=unassigned', 'unread=true', 'q=Ada', 'sort=oldest', 'offset=20']) {
  assert.ok(hqListRequest.includes(fragment), `HQ request missing ${fragment}`);
}
assert.ok(requestUrls.filter(request => request.startsWith('POST ')).every(request => request.includes('/read')), 'HQ rendered view must not expose workflow/message mutations');
assert.equal(renderer!.root.findAll(node => node.props['aria-label'] === 'Add product suggestion').length, 0, 'HQ must not offer product suggestions');
await act(async () => { renderer!.unmount(); });

hqNotes = [{ id: 'note-1', body: 'Called the office about refills', authorLabel: 'Nurse Lee', createdAt: '2026-09-10T12:30:00Z' }];
await act(async () => { renderer = create(<HqPage path="/admin/conversations?conversation=conv-1" />); });
await settle();
assert.match(textOf(renderer!.root), /Called the office about refills/, 'HQ notes card must list notes when present');
assert.doesNotMatch(textOf(renderer!.root), /No internal notes yet/, 'HQ empty state must disappear once notes exist');
await act(async () => { renderer!.unmount(); });
hqNotes = [];

// HQ drill-in: the office inbox is scoped to the drilled-in account. Every
// inbox request must name that office (the server otherwise answers 400 for
// HQ callers), and the human-reply surfaces stay hidden because HQ care-team
// access is read-only server-side.
__setSession({ authStatus: 'signed-in', authRole: 'hq_admin', authUser: { id: 'hq-1' }, providerAccountCode: null, claimedWorkspace: null });
__setScope({ providerId: 'live-abc123', officeName: 'Beacon Clinic' });
requestUrls = [];
readRequests.length = 0;
await act(async () => { renderer = create(<Page path="/conversations?channel=care_team&conversation=conv-1" />); });
await settle();
assert.match(textOf(renderer!.root), /Newest message/, 'HQ drill-in must render the office inbox');
const drillInRequests = requestUrls.filter(request => request.includes('/api/office/conversations'));
assert.ok(drillInRequests.length >= 5, `expected list, summary, staff, events and notes requests, saw ${drillInRequests.length}`);
for (const request of drillInRequests) {
  assert.ok(request.includes('office=live-abc123'), `HQ drill-in request missing office scope: ${request}`);
}
assert.ok(readRequests.some(request => request.url.includes('office=live-abc123')), 'HQ drill-in read marker must carry the office scope');
assert.equal(renderer!.root.findAll(node => node.type === 'textarea' && node.props['aria-label'] === 'Reply to patient').length, 0, 'HQ drill-in must not offer the care-team composer');
assert.equal(renderer!.root.findAll(node => node.type === 'button' && textOf(node).trim() === 'Start conversation').length, 0, 'HQ drill-in must not offer Start conversation');
assert.equal(renderer!.root.findAll(node => node.props['data-testid'] === 'text-hq-read-only').length, 1);
assert.equal(renderer!.root.findAll(node => node.props['aria-label'] === 'Add product suggestion').length, 0, 'HQ drill-in must not offer product suggestions');
for (const label of ['Claim', 'Add note']) {
  assert.equal(renderer!.root.findAll(node => node.type === 'button' && textOf(node).trim() === label).length, 0, `HQ drill-in care-team thread must not offer ${label}`);
}
assert.equal(renderer!.root.findAll(node => node.props['aria-label'] === 'Assign conversation').length, 0, 'HQ drill-in care-team thread must not offer assignment');
assert.equal(renderer!.root.findAll(node => node.props['aria-label'] === 'Conversation status').length, 0, 'HQ drill-in care-team thread must not offer status changes');
assert.equal(renderer!.root.findAll(node => node.type === 'textarea' && node.props['aria-label'] === 'New internal note').length, 0, 'HQ drill-in care-team thread must not offer note writing');
assert.equal(renderer!.root.findAll(node => node.props['data-testid'] === 'text-hq-care-team-status').length, 1, 'HQ drill-in must still show assignee and status as text');
assert.ok(requestUrls.filter(request => request.startsWith('POST ')).every(request => request.includes('/read')), 'HQ drill-in must issue no workflow mutations');
await act(async () => { renderer!.unmount(); });

// HQ drill-in never writes notes, on AI threads either: the notes panel is
// read-only for every thread kind, not just care-team ones.
await act(async () => { renderer = create(<Page path="/conversations?channel=ai&conversation=conv-ai" />); });
await settle();
assert.equal(renderer!.root.findAll(node => node.props['data-testid'] === 'thread-notes-panel').length, 1, 'HQ drill-in AI thread must still show the notes panel');
assert.equal(renderer!.root.findAll(node => node.type === 'textarea' && node.props['aria-label'] === 'New internal note').length, 0, 'HQ drill-in AI thread must not offer note writing');
await act(async () => { renderer!.unmount(); });

// The roster's "Message Care Team" deep link must not auto-start a thread for HQ.
startBodies.length = 0;
requestUrls = [];
await act(async () => { renderer = create(<Page path="/conversations?startPatient=pat-nohistory" />); });
await settle();
assert.equal(startBodies.length, 0, 'HQ drill-in must not auto-start care-team conversations');
await act(async () => { renderer!.unmount(); });
__setScope(null);

const individualSuggestion = {
  mode: 'individual' as const,
  items: [{
    productId: 'prod-1', slug: 'daily-balance', name: 'Daily Balance', imageUrl: null,
    purchase: 'subscription' as const, cadenceWeeks: 4, quantity: 2, unitPriceCents: 2880,
  }],
  totalCents: 5760,
};
await act(async () => {
  renderer = create(<LiveMessageRow message={{ ...event(8, 'Try this'), role: 'staff', senderLabel: 'Nurse Lee', senderUserId: 'staff-1', suggestion: individualSuggestion }} />);
});
assert.match(textOf(renderer!.root), /Daily Balance/);
assert.match(textOf(renderer!.root), /Every 4 weeks · ×2/);
assert.match(textOf(renderer!.root), /Sent as a suggestion/);
await act(async () => { renderer!.unmount(); });

const bundleSuggestion = {
  mode: 'bundle' as const,
  items: [
    { productId: 'prod-1', slug: 'daily-balance', name: 'Daily Balance', imageUrl: null, purchase: 'subscription' as const, cadenceWeeks: 4, quantity: 1, unitPriceCents: 2880 },
    { productId: 'prod-2', slug: 'metabolic-drops', name: 'Metabolic Drops', imageUrl: null, purchase: 'one_time' as const, cadenceWeeks: null, quantity: 1, unitPriceCents: 4500 },
  ],
  totalCents: 7380,
};
await act(async () => {
  renderer = create(<LiveMessageRow message={{ ...event(9, 'A bundle for you'), role: 'staff', senderLabel: 'Nurse Lee', senderUserId: 'staff-1', suggestion: bundleSuggestion }} />);
});
assert.match(textOf(renderer!.root), /Bundle/);
assert.match(textOf(renderer!.root), /Total\$73\.80/);
assert.match(textOf(renderer!.root), /Opens checkout in the patient app/);
await act(async () => { renderer!.unmount(); });

console.log('office conversations rendered verification passed');