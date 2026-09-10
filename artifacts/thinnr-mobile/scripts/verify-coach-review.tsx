/** Real mobile provider coach-review regression suite (Node/RTR native stubs). */
import React, { act } from 'react';
import assert from 'node:assert/strict';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setBaseUrl } from '@workspace/api-client-react';
import { CoachReviewPanel } from '../components/office/CoachReviewPanel';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
setBaseUrl('https://mobile-coach-review.test');
const textOf = (node: ReactTestInstance): string => {
  const out: string[] = [];
  const walk = (value: ReactTestInstance | string | number) => typeof value === 'string' || typeof value === 'number'
    ? out.push(String(value))
    : value.children.forEach(child => walk(child as ReactTestInstance | string | number));
  walk(node);
  return out.join('');
};
const settle = async (rounds = 10) => { for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 2)); }); };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const pressText = async (root: ReactTestInstance, label: string, last = false) => {
  const all = root.findAll(node => node.type === 'Pressable' && textOf(node).includes(label));
  const target = last ? all.at(-1) : all[0];
  assert.ok(target, `pressable ${label} exists`);
  await act(async () => { target!.props.onPress(); });
  await settle();
};

const requests: Array<{ url: string; auth: string | null }> = [];
let holdOld = false;
let resolveOld!: (response: Response) => void;
const conversation = (id: string, archivedAt: string | null = null) => ({ id, title: `Conversation ${id}`, archivedAt, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z', titleState: 'ready', processingState: 'ready', version: 1 });
const conversations = Array.from({ length: 20 }, (_, index) => conversation(`conversation-${index + 1}`, index === 1 ? '2026-09-03T00:00:00Z' : null));
const memories = Array.from({ length: 21 }, (_, index) => ({ id: `memory-${index + 1}`, text: `Memory ${index + 1}`, category: 'diet', sensitivity: 'ordinary', state: 'active', sourceConversationId: 'conversation-1', sourceMessageId: index === 20 ? 'source-1' : null, sourceCreatedAt: '2026-08-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', confirmedAt: null, version: 1 }));
const newest = Array.from({ length: 100 }, (_, index) => ({ id: `message-${index + 157}`, seq: index + 157, role: index % 2 ? 'user' : 'assistant', text: `Message ${index + 157}`, createdAt: '2026-09-10T00:00:00Z', ...(index === 99 ? { photo: { secureUrl: 'https://media.test/provider-signed.jpg' }, card: { kind: 'meal', title: 'Dinner card', description: 'Salmon and greens' } } : {}) }));
const middle = Array.from({ length: 100 }, (_, index) => ({ id: `message-${index + 57}`, seq: index + 57, role: 'assistant', text: `Message ${index + 57}`, createdAt: '2026-08-01T00:00:00Z' }));
const older = Array.from({ length: 56 }, (_, index) => ({ id: index === 0 ? 'source-1' : `message-${index + 1}`, seq: index + 1, role: 'assistant', text: index === 0 ? 'The saved source message' : `Message ${index + 1}`, createdAt: '2026-08-01T00:00:00Z' }));
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input.toString());
  const headers = new Headers(init?.headers);
  requests.push({ url: url.href, auth: headers.get('authorization') });
  if (holdOld && url.pathname.includes('/patients/patient-a/coach-conversations') && !url.pathname.endsWith('conversation-1')) return new Promise<Response>(resolve => { resolveOld = resolve; });
  if (url.pathname.endsWith('/coach-conversations')) {
    if (url.pathname.includes('patient-b')) return json({ conversations: [conversation('conversation-b')], total: 1, nextOffset: null });
    return json(url.searchParams.get('offset') === '20' ? { conversations: [conversation('conversation-21')], total: 21, nextOffset: null } : { conversations, total: 21, nextOffset: 20 });
  }
  if (url.pathname.endsWith('/coach-memories')) return json(url.searchParams.get('offset') === '20' ? { memories: [memories[20]], total: 21, nextOffset: null } : { memories: memories.slice(0, 20), total: 21, nextOffset: 20 });
  if (url.pathname.endsWith('/coach-conversations/conversation-1')) return json(url.searchParams.get('before') === '57'
    ? { conversation: conversation('conversation-1'), messages: older, nextBefore: null, patient: { firstName: 'Ada', programDay: 3 } }
    : url.searchParams.get('before') === '157'
      ? { conversation: conversation('conversation-1'), messages: middle, nextBefore: 57, patient: { firstName: 'Ada', programDay: 3 } }
      : { conversation: conversation('conversation-1'), messages: newest, nextBefore: 157, patient: { firstName: 'Ada', programDay: 3 } });
  return json({ error: 'not found' }, 404);
};

async function main() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const A = { access_token: 'provider-token-a', user: { id: 'provider-a' } };
  const B = { access_token: 'provider-token-b', user: { id: 'provider-b' } };
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<QueryClientProvider client={client}><CoachReviewPanel patientId="patient-a" session={A} /></QueryClientProvider>); });
  await settle();
  assert.ok(textOf(renderer.root).includes('Conversation conversation-1') && textOf(renderer.root).includes('ARCHIVED'), 'all conversations include an archived badge');
  await pressText(renderer.root, 'Load more conversations');
  assert.ok(textOf(renderer.root).includes('Conversation conversation-1') && textOf(renderer.root).includes('Conversation conversation-21'), 'conversation page 2 appends after 20');
  assert.ok(requests[0]?.auth === 'Bearer provider-token-a' && !requests[0]?.url.includes('archived='), 'authorized all-provider list sends no ignored archive query');
  await pressText(renderer.root, 'Memories');
  await pressText(renderer.root, 'Load more memories');
  assert.ok(textOf(renderer.root).includes('Memory 1') && textOf(renderer.root).includes('Memory 21'), 'memory page 2 appends after 20');
  assert.ok(textOf(renderer.root).includes('NOT CLINICALLY VERIFIED'), 'memory provenance is clearly read-only/non-clinical');
  await pressText(renderer.root, 'View source conversation', true);
  await settle(20);
  const transcript = textOf(renderer.root);
  assert.ok(transcript.includes('The saved source message') && transcript.includes('Message 256'), 'source search follows all older exclusive pages and retains 256 messages');
  assert.equal(renderer.root.findAll(node => node.type === 'Image' && node.props.source?.uri === 'https://media.test/provider-signed.jpg').length, 1, 'provider-safe preview URI is rendered as an actual photo');
  assert.ok(transcript.includes('Dinner card') && transcript.includes('Salmon and greens'), 'actual read-only card fields render');
  assert.equal(renderer.root.findAll(node => node.type === 'Pressable' && /archive|restore|approve|decline|forget/i.test(textOf(node))).length, 0, 'no provider mutation controls render');
  assert.ok(requests.some(request => request.url.includes('/conversation-1?') && request.url.includes('limit=100') && request.url.includes('before=157')) && requests.some(request => request.url.includes('before=57')), 'older source requests use 100-message exclusive cursors');

  await pressText(renderer.root, 'Back');
  // Same user, but a new session object/token: its private TanStack scope is
  // opaque and fresh, so no prior list can paint while authorization is held.
  holdOld = true;
  const ARelogin = { access_token: 'provider-token-a-relogin', user: { id: 'provider-a' } };
  await act(async () => { renderer.update(<QueryClientProvider client={client}><CoachReviewPanel patientId="patient-a" session={ARelogin} /></QueryClientProvider>); });
  await settle();
  assert.ok(!textOf(renderer.root).includes('Conversation conversation-1'), 'same-user reauthentication clears cached rows before new authorization settles');
  const keyText = JSON.stringify(client.getQueryCache().getAll().map(query => query.queryKey));
  assert.ok(!keyText.includes(A.access_token) && !keyText.includes(ARelogin.access_token) && !/bearer/i.test(keyText), 'mobile query keys never serialize bearer tokens');
  holdOld = false;
  resolveOld(json({ error: 'no clinical permission' }, 403));
  await settle();
  assert.ok(textOf(renderer.root).includes('Failed to load conversations.') && !textOf(renderer.root).includes('Conversation conversation-1'), 'authorization failure never falls back to cached rows');

  await act(async () => { renderer.update(<QueryClientProvider client={client}><CoachReviewPanel patientId="patient-b" session={B} /></QueryClientProvider>); });
  await settle();
  assert.ok(textOf(renderer.root).includes('Conversation conversation-b') && !textOf(renderer.root).includes('Conversation conversation-1'), 'account/patient switch clears old pages');
  assert.ok(requests.some(request => request.url.includes('/patients/patient-b/coach-conversations') && request.auth === 'Bearer provider-token-b'), 'new account request is separately authorized');
  await act(async () => renderer.unmount());
  client.clear();
  setBaseUrl(null);
  console.log('mobile coach review verification passed');
}
main().catch(error => { console.error(error); process.exit(1); });