import * as React from 'react';
import assert from 'node:assert/strict';
import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import OfficeConversations from '../src/pages/OfficeConversations';
import { HqConversations } from '../src/components/conversations/HqConversations';
import { DataDisclaimerFooter } from '../src/components/layout/DataDisclaimerFooter';
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
const settle = async () => {
  for (let index = 0; index < 12; index += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 2)); });
};

let replyBodies: Array<{ clientId: string; text: string }> = [];
let failFirstReply = true;
let requestUrls: string[] = [];
let listOwner = 'Ada Patient';
let delayedListResolve: ((response: Response) => void) | null = null;
let delayNextList = false;
let listEmpty = false;
const startBodies: Array<{ patientId: string }> = [];
const readRequests: Array<{ url: string; throughSeq: number }> = [];
let delayedNoteResolve: ((response: Response) => void) | null = null;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  requestUrls.push(`${init?.method ?? 'GET'} ${url}`);
  if (url.includes('/api/hq/conversations')) {
    if (url.includes('/notes')) return json({ notes: [] });
    if (url.includes('/read')) return json({ lastReadSeq: 2, changed: true });
    if (url.includes('/events')) {
      const parsed = new URL(url, 'http://test');
      if (parsed.searchParams.has('after')) return json({ events: [], nextBefore: null, nextAfter: null });
      return json({ events: [event(2, 'HQ transcript')], nextBefore: null, nextAfter: null });
    }
    return json({ conversations: [{ ...conversation, updatedAt: conversation.lastMessageAt }], total: 1, autoCloseDays: 14 });
  }
  if (url.includes('/api/office/roster')) return json({ office: {}, patients: [{ id: 'pat-1', name: 'Ada Patient', email: 'ada@example.com', phone: null, phoneDisplay: null }] });
  if (url.endsWith('/api/office/conversations/start')) {
    startBodies.push(JSON.parse(String(init?.body)));
    return json({ conversation: { ...conversation, id: 'conv-started', patientId: startBodies.at(-1)!.patientId }, created: true });
  }
  if (url.endsWith('/api/office/conversations/summary')) return json({ scope: { providerId: 'office-1', officeName: 'Beacon Clinic' }, asOf: new Date().toISOString(), metrics: { openThreads: 1, waitingOnPatient: 0, unanswered: 1, avgResponseMinutes: null, openEscalations: 0 } });
  if (url.endsWith('/api/office/conversations/staff')) return json({ staff: [] });
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
    return json({ conversation, event: { ...event(3, replyBodies.at(-1)!.text), role: 'staff', clientId: replyBodies.at(-1)!.clientId, senderLabel: 'Nurse Lee', senderUserId: 'staff-1' } });
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

function Page({ path = '/conversations?channel=care_team&conversation=conv-1' }: { path?: string }) {
  const location = React.useMemo(() => memoryLocation({ path, record: true }), [path]);
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
assert.equal(renderer!.root.findAll(node => node.type === 'button' && textOf(node).trim() === 'Escalate').length, 0, 'care-team conversations must not offer AI escalation');
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
await act(async () => { renderer!.unmount(); });

await act(async () => { renderer = create(<Page path="/conversations?channel=ai&conversation=conv-ai" />); });
await settle();
const aiEscalateButtons = renderer!.root.findAll(node => node.type === 'button' && textOf(node).trim() === 'Escalate');
assert.equal(aiEscalateButtons.length, 1, 'historic AI conversations must retain escalation');
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
const hqListRequest = requestUrls.find(request => request.startsWith('GET ') && request.includes('/api/hq/conversations?'));
assert.ok(hqListRequest);
for (const fragment of ['office=office-1', 'patientId=pat-1', 'channel=care_team', 'thread=care_team', 'status=open', 'assignee=unassigned', 'unread=true', 'q=Ada', 'sort=oldest', 'offset=20']) {
  assert.ok(hqListRequest.includes(fragment), `HQ request missing ${fragment}`);
}
assert.ok(requestUrls.filter(request => request.startsWith('POST ')).every(request => request.includes('/read')), 'HQ rendered view must not expose workflow/message mutations');
await act(async () => { renderer!.unmount(); });

__setSession({ authStatus: 'signed-in' });
await act(async () => { renderer = create(<DataDisclaimerFooter />); });
assert.doesNotMatch(textOf(renderer!.root), /Synthetic Demo Data/, 'authenticated shells must not claim live data is synthetic');
assert.match(textOf(renderer!.root), /Not Medical Advice/);
await act(async () => { renderer!.unmount(); });
__setSession({ authStatus: 'signed-out' });
await act(async () => { renderer = create(<DataDisclaimerFooter />); });
assert.match(textOf(renderer!.root), /Synthetic Demo Data/, 'guided demo retains its synthetic-data disclosure');
await act(async () => { renderer!.unmount(); });

console.log('office conversations rendered verification passed');