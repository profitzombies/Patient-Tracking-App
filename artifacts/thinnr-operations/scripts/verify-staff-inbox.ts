import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const office = readFileSync(new URL('../src/pages/OfficeConversations.tsx', import.meta.url), 'utf8');
const hq = readFileSync(new URL('../src/components/conversations/HqConversations.tsx', import.meta.url), 'utf8');
const admin = readFileSync(new URL('../src/pages/admin/Conversations.tsx', import.meta.url), 'utf8');
const nav = readFileSync(new URL('../src/components/layout/nav-config.tsx', import.meta.url), 'utf8');

for (const parameter of ['channel', 'thread', 'status', 'assignee', 'unread', 'q', 'sort', 'offset', 'conversation']) {
  assert.match(office, new RegExp(`${parameter}`), `office inbox is missing ${parameter}`);
  assert.match(hq, new RegExp(`${parameter}`), `HQ inbox is missing ${parameter}`);
}
assert.match(hq, /patientId/);
assert.match(hq, /office: accountFilter/);
// Live updates ride one stream per tab; no fixed-interval polling remains.
assert.doesNotMatch(office, /refetchInterval/);
assert.doesNotMatch(hq, /refetchInterval/);
assert.match(office, /useInboxStream\(\{/);
assert.match(hq, /useInboxStream\(\{/);
assert.match(office, /path: '\/api\/office\/conversations\/stream'/);
assert.match(hq, /path: '\/api\/hq\/conversations\/stream'/);
assert.match(office, /refetchOnWindowFocus: true/);
assert.match(hq, /refetchOnWindowFocus: true/);
assert.match(office, /after: fetchedThrough/);
assert.match(hq, /after: fetchedThrough/);
assert.match(office, /clientId: attempted\.clientId/);
assert.match(office, /sendReply\(pendingReply\)/);
assert.match(office, /Open Care Team conversation/);
assert.match(office, /useStartOfficeConversation/);
assert.match(office, /useReadOfficeConversation/);
assert.match(office, /Search the office roster/);
assert.match(office, /demo-conversations-local/);
assert.doesNotMatch(office, /as any|undefined as any|care-team-api/);
assert.doesNotMatch(hq, /useReplyOfficeConversation|useAssignOfficeConversation|useSetOfficeConversationStatus|useAddOfficeConversationNote|useEscalateOfficeConversation/);
assert.doesNotMatch(hq, /care-team-api|as any/);
assert.match(hq, /HQ read-only view/);
assert.match(nav, /path: '\/conversations'/);

// Existing signed-out HQ demo selection and historic AI transcript implementation
// remain in place; live signed-in HQ traffic alone switches to the fleet viewer.
assert.match(admin, /function DemoClinicalConversations/);
assert.match(admin, /getConversationMessagesForRole/);
assert.match(admin, /if \(authStatus === 'signed-in'\)/);
assert.match(admin, /<HqConversations/);

console.log('staff inbox verification passed');