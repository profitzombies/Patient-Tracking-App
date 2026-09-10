/**
 * Real provider coach-review regression suite. Run with tsconfig.coach-review:
 * it maps only the browser session context to the established Node stand-in.
 */
import * as React from 'react';
import assert from 'node:assert/strict';
import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setBaseUrl } from '@workspace/api-client-react';
import { __setSession } from './a11y-stubs/session';
import { CoachReviewPanel } from '../src/components/office/CoachReviewPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
setBaseUrl('http://coach-review.test');
const textOf = (node: ReactTestInstance): string => {
  const values: string[] = [];
  const visit = (value: ReactTestInstance | string | number) => typeof value === 'string' || typeof value === 'number'
    ? values.push(String(value))
    : value.children.forEach(child => visit(child as ReactTestInstance | string | number));
  visit(node);
  return values.join('');
};
const settle = async (rounds = 10) => { for (let i = 0; i < rounds; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 2)); }); };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const button = (root: ReactTestInstance, label: string) => {
  const found = root.findAll(node => node.type === 'button' && textOf(node).includes(label))[0];
  assert.ok(found, `button ${label} exists`);
  return found;
};
const press = async (node: ReactTestInstance) => { await act(async () => { node.props.onClick(); }); await settle(); };

const requests: string[] = [];
let holdOldList = false;
let releaseOldList!: (response: Response) => void;
const conversation = (id: string, archivedAt: string | null = null) => ({
  id, title: `Conversation ${id}`, archivedAt, createdAt: '2026-09-01T12:00:00Z', updatedAt: '2026-09-10T12:00:00Z', titleState: 'ready', version: 1, processingState: 'ready',
});
const memories = Array.from({ length: 21 }, (_, index) => ({
  id: `memory-${index + 1}`, text: `Patient memory ${index + 1}`, category: 'diet', sensitivity: 'ordinary', state: 'active',
  sourceConversationId: 'conversation-1', sourceMessageId: index === 20 ? 'old-1' : null, sourceCreatedAt: '2026-08-01T12:00:00Z',
  createdAt: '2026-09-01T12:00:00Z', updatedAt: '2026-09-01T12:00:00Z', confirmedAt: null, version: 1,
}));
const firstConversations = Array.from({ length: 20 }, (_, index) => conversation(`conversation-${index + 1}`, index === 1 ? '2026-09-02T00:00:00Z' : null));
const latestMessages = Array.from({ length: 100 }, (_, index) => ({
  id: `message-${index + 157}`, seq: index + 157, role: index % 2 ? 'user' : 'assistant', text: `Transcript message ${index + 157}`, createdAt: '2026-09-10T12:00:00Z',
  ...(index === 99 ? { photo: { secureUrl: 'https://cdn.test/patient-photo.jpg' }, card: { kind: 'meal', title: 'Lunch plan', description: 'Chicken and vegetables' } } : {}),
}));
const middleMessages = Array.from({ length: 100 }, (_, index) => ({ id: `message-${index + 57}`, seq: index + 57, role: 'assistant', text: `Transcript message ${index + 57}`, createdAt: '2026-08-01T12:00:00Z' }));
const olderMessages = Array.from({ length: 56 }, (_, index) => ({ id: index === 0 ? 'old-1' : `message-${index + 1}`, seq: index + 1, role: 'assistant', text: index === 0 ? 'Original source statement' : `Transcript message ${index + 1}`, createdAt: '2026-08-01T12:00:00Z' }));

globalThis.fetch = async (input: RequestInfo | URL) => {
  const url = new URL(typeof input === 'string' ? input : input.toString());
  requests.push(url.href);
  const office = url.searchParams.get('office');
  if (office !== 'office-a' && office !== 'office-b') return json({ error: 'missing office' }, 400);
  if (holdOldList && url.pathname.includes('/patients/patient-a/coach-conversations') && !url.pathname.endsWith('conversation-1')) {
    return new Promise<Response>(resolve => { releaseOldList = resolve; });
  }
  if (url.pathname.endsWith('/coach-conversations')) {
    if (url.pathname.includes('patient-b')) return json({ conversations: [conversation('conversation-b')], total: 1, nextOffset: null });
    return json(url.searchParams.get('offset') === '20'
      ? { conversations: [conversation('conversation-21', '2026-08-01T00:00:00Z')], total: 21, nextOffset: null }
      : { conversations: firstConversations, total: 21, nextOffset: 20 });
  }
  if (url.pathname.endsWith('/coach-memories')) {
    return json(url.searchParams.get('offset') === '20'
      ? { memories: [memories[20]], total: 21, nextOffset: null }
      : { memories: memories.slice(0, 20), total: 21, nextOffset: 20 });
  }
  if (url.pathname.endsWith('/coach-conversations/conversation-1')) {
    return json(url.searchParams.get('before') === '57'
      ? { conversation: conversation('conversation-1'), messages: olderMessages, nextBefore: null, patient: { firstName: 'Ada', programDay: 5 } }
      : url.searchParams.get('before') === '157'
        ? { conversation: conversation('conversation-1'), messages: middleMessages, nextBefore: 57, patient: { firstName: 'Ada', programDay: 5 } }
        : { conversation: conversation('conversation-1'), messages: latestMessages, nextBefore: 157, patient: { firstName: 'Ada', programDay: 5 } });
  }
  return json({ error: 'not found' }, 404);
};

async function main() {
  __setSession({ authUser: { id: 'provider-a' }, providerAccountCode: 'account-a' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<QueryClientProvider client={client}><CoachReviewPanel patientId="patient-a" office="office-a" /></QueryClientProvider>); });
  await settle();
  assert.ok(textOf(renderer.root).includes('Conversation conversation-1'), 'initial provider list is rendered');
  assert.ok(textOf(renderer.root).includes('Archived'), 'archived conversations are identified in all-conversation list');
  const firstListRequest = requests.find(url => url.includes('/coach-conversations?'))!;
  assert.ok(firstListRequest.includes('office=office-a') && !firstListRequest.includes('archived='), 'provider list is office-scoped and does not send ignored archived filter');
  await press(button(renderer.root, 'Load more conversations'));
  assert.ok(textOf(renderer.root).includes('Conversation conversation-1') && textOf(renderer.root).includes('Conversation conversation-21'), '21st conversation appends rather than replacing first page');

  await press(button(renderer.root, 'Memories'));
  await press(button(renderer.root, 'Load more memories'));
  assert.ok(textOf(renderer.root).includes('Patient memory 1') && textOf(renderer.root).includes('Patient memory 21'), '21st memory appends rather than replacing first page');
  assert.ok(textOf(renderer.root).includes('not clinically verified'), 'memory provenance is explicitly non-clinical');
  const sourceButtons = renderer.root.findAll(node => node.type === 'button' && textOf(node).includes('View source'));
  await press(sourceButtons.at(-1)!);
  await settle(20);
  const transcriptText = textOf(renderer.root);
  assert.ok(transcriptText.includes('Original source statement') && transcriptText.includes('Transcript message 256'), 'source navigation loads all three older pages and retains the full 256-message transcript');
  assert.equal(renderer.root.findAll(node => node.props['data-source-message'] === true).length, 1, 'located source is highlighted exactly once');
  assert.equal(renderer.root.findAll(node => node.type === 'img' && node.props.src === 'https://cdn.test/patient-photo.jpg').length, 1, 'read-only transcript renders secure photo URI');
  assert.ok(transcriptText.includes('Lunch plan') && transcriptText.includes('Chicken and vegetables'), 'read-only transcript renders card content');
  assert.ok(requests.some(url => url.includes('/conversation-1?') && url.includes('limit=100') && url.includes('before=157') && url.includes('office=office-a')) && requests.some(url => url.includes('before=57') && url.includes('office=office-a')), 'source lookup uses office-scoped exclusive older cursors');
  assert.equal(renderer.root.findAll(node => node.type === 'button' && /archive|restore|approve|decline|forget/i.test(textOf(node))).length, 0, 'provider review exposes no mutation controls');

  // Same-user reauthentication must receive a fresh, opaque scope rather than
  // painting the prior user's cache while its new authorization is unresolved.
  await press(button(renderer.root, 'Back'));
  holdOldList = true;
  __setSession({ authUser: { id: 'provider-a' }, providerAccountCode: 'account-a' });
  await act(async () => { renderer.update(<QueryClientProvider client={client}><CoachReviewPanel patientId="patient-a" office="office-a" /></QueryClientProvider>); });
  await settle();
  assert.ok(!textOf(renderer.root).includes('Conversation conversation-1'), 'same-user reauthentication clears cached rows before its fresh request settles');
  const keyText = JSON.stringify(client.getQueryCache().getAll().map(query => query.queryKey));
  assert.ok(!/bearer|token|provider-token/i.test(keyText), 'web query keys contain no bearer credential or token derivative');
  holdOldList = false;
  releaseOldList(json({ error: 'no clinical permission' }, 403));
  await settle();
  assert.ok(textOf(renderer.root).includes('Failed to load conversations.') && !textOf(renderer.root).includes('Conversation conversation-1'), 'authorization failure never falls back to prior cached rows');

  // A held old request cannot paint after the account/patient/office scope remounts.
  __setSession({ authUser: { id: 'provider-b' }, providerAccountCode: 'account-b' });
  await act(async () => { renderer.update(<QueryClientProvider client={client}><CoachReviewPanel patientId="patient-b" office="office-b" /></QueryClientProvider>); });
  await settle();
  assert.ok(textOf(renderer.root).includes('Conversation conversation-b') && !textOf(renderer.root).includes('Conversation conversation-1'), 'scope switch clears old selection/pages');
  assert.ok(requests.some(url => url.includes('/patients/patient-b/coach-conversations?') && url.includes('office=office-b')), 'new scope request is isolated to its office');
  await act(async () => renderer.unmount());
  client.clear();
  setBaseUrl(null);
  console.log('web coach review verification passed');
}
main().catch(error => { console.error(error); process.exit(1); });