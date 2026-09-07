import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const conversations = readFileSync(new URL('../src/pages/admin/Conversations.tsx', import.meta.url), 'utf8');
const escalations = readFileSync(new URL('../src/pages/admin/Escalations.tsx', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../src/components/admin/AdminShell.tsx', import.meta.url), 'utf8');
const permissions = readFileSync(new URL('../src/data/hq/team.ts', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

for (const parameter of ['office', 'thread', 'status', 'assignee', 'unread', 'q', 'sort', 'conversation']) {
  assert.match(conversations, new RegExp(`['"]${parameter}['"]|${parameter}:`), `missing ${parameter} URL/API filter`);
}
for (const hook of [
  'useGetOfficeConversationSummary', 'useGetOfficeConversationStaff', 'useAssignOfficeConversation',
  'useSetOfficeConversationStatus', 'useReplyOfficeConversation', 'useAddOfficeConversationNote',
  'useEscalateOfficeConversation',
]) assert.ok(conversations.includes(hook), `missing ${hook}`);
assert.match(conversations, /conv\.unread.*Unread conversation/s);
assert.match(conversations, /message\.role === 'staff'/);
assert.match(conversations, /senderLabel \?\? 'Care team'/);
assert.match(conversations, /assigneeUserId/);
assert.match(conversations, /data: \{ status \}/);
assert.match(conversations, /data: \{ text: replyText\.trim\(\) \}/);
assert.match(conversations, /data: \{ body: noteText\.trim\(\) \}/);
assert.match(conversations, /status\?: number.*409/s);
assert.match(conversations, /already escalated/i);

assert.match(escalations, /useGetHqEscalations/);
assert.match(escalations, /department: department \?\? undefined, status/);
assert.match(escalations, /useResolveHqEscalation/);
assert.match(escalations, /escalationId: resolveId, data: \{ note:/);
assert.match(escalations, /query\.data\?\.departments\.map/);
assert.match(shell, /\/admin\/escalations/);
assert.match(permissions, /path\.startsWith\('\/admin\/escalations'\)/);
assert.match(app, /path="\/admin\/escalations"/);

const demoStart = conversations.indexOf('function DemoSupportConversations');
const liveStart = conversations.indexOf('function LiveConversations');
const demoRegion = conversations.slice(demoStart, liveStart);
assert.ok(demoStart >= 0 && liveStart > demoStart);
assert.doesNotMatch(demoRegion, /useGetOfficeConversation|useReplyOfficeConversation|fetch\(/);

console.log('staff inbox verification passed');