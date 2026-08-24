/**
 * HQ conversations rail check.
 *
 * Freezes the contracts the iMessage-style conversations page depends on:
 *
 *  - every thread's last-activity timestamp is parsed from its transcript's
 *    display labels (single source of truth, fixed Aug 2026 demo dates) and
 *    the rail sorts by that latest activity, NOT the thread start date;
 *  - rail time labels follow the messages-app convention against the fixed
 *    anchor (clock time on the demo "today", 'Yesterday', else the date);
 *  - rail previews are single-line snippets of the newest message;
 *  - the search matcher is case-insensitive and format-tolerant (digits
 *    match phones and codes regardless of dashes/parens) across patient
 *    name/email/phone and office/provider/code.
 *
 * Run under several TZ values (see package script) — everything is anchored
 * to the demo dates, so results must be identical in every timezone.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:conversations
 */
import {
  HQ_CONVERSATIONS,
  conversationMatchesQuery,
  getConversations,
  parseAtLabel,
  type ConversationSearchFields,
} from '../src/data/hq/conversations';
import { SEEDED_ACCOUNTS } from '../src/data/hq/accounts';
import { MOCK_PATIENTS } from '../src/data/mock-data';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok  ${label} = ${e}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}: expected ${e}, got ${a}`);
  }
}

function checkThrows(label: string, fn: () => unknown) {
  try {
    fn();
    failures += 1;
    console.error(`FAIL  ${label}: expected a throw, got a value`);
  } catch {
    console.log(`  ok  ${label} throws`);
  }
}

console.log(`TZ=${process.env.TZ ?? '(system)'}\n`);

// ─── Label parsing (demo-timeline timestamps, timezone-independent) ──────────
check('parseAtLabel midnight', parseAtLabel('Aug 22 · 12:00 AM'), Date.UTC(2026, 7, 22, 0, 0));
check('parseAtLabel noon-ish', parseAtLabel('Aug 22 · 12:30 PM'), Date.UTC(2026, 7, 22, 12, 30));
check('parseAtLabel evening', parseAtLabel('Aug 20 · 9:49 PM'), Date.UTC(2026, 7, 20, 21, 49));
checkThrows('parseAtLabel missing meridiem', () => parseAtLabel('Aug 22 · 7:12'));
checkThrows('parseAtLabel lowercase month', () => parseAtLabel('aug 22 · 7:12 AM'));
checkThrows('parseAtLabel unknown month', () => parseAtLabel('Foo 22 · 7:12 AM'));

// ─── Rail order: latest message activity, never the start date ───────────────
const all = getConversations();
check(
  'all-accounts order (newest activity first)',
  all.map((conv) => conv.id),
  // conv-03 and conv-08 both STARTED Aug 22 (start-date sorting would keep
  // conv-03 first); conv-08's last message (2:56 PM) beats conv-03's (9:07 AM).
  ['conv-08', 'conv-03', 'conv-05', 'conv-09', 'conv-01', 'conv-06', 'conv-02', 'conv-10', 'conv-04', 'conv-07'],
);
check(
  'activity strictly descending',
  all.every((conv, index) => index === 0 || all[index - 1].lastActivityAt > conv.lastActivityAt),
  true,
);
check('account scope order (acct-p1)', getConversations('acct-p1').map((c) => c.id), ['conv-03', 'conv-01', 'conv-02']);
check('account scope order (acct-p3)', getConversations('acct-p3').map((c) => c.id), ['conv-08', 'conv-06', 'conv-07']);
check('summary count matches seeds', all.length, HQ_CONVERSATIONS.length);

// ─── Rail time labels against the fixed Aug 22, 2026 anchor ──────────────────
const byId = new Map(all.map((conv) => [conv.id, conv]));
check('anchor-day label shows clock time', byId.get('conv-08')?.lastActivityLabel, '2:56 PM');
check('anchor-day label (morning)', byId.get('conv-03')?.lastActivityLabel, '9:07 AM');
check('anchor-1 label', byId.get('conv-01')?.lastActivityLabel, 'Yesterday');
check('older label keeps the date', byId.get('conv-02')?.lastActivityLabel, 'Aug 20');
check('oldest label', byId.get('conv-07')?.lastActivityLabel, 'Aug 18');

// ─── Previews: single-line snippet of the newest message ─────────────────────
check('conv-08 last message id', byId.get('conv-08')?.lastMessage.id, 'c8-m4');
check('preview has no newlines', all.every((conv) => !conv.preview.includes('\n')), true);
check('conv-08 preview content', byId.get('conv-08')?.preview.includes('grouped by aisle'), true);
check(
  'conv-01 preview collapses blocks',
  byId.get('conv-01')?.preview.includes('Sunday. Want a reminder that evening'),
  true,
);

// ─── Search matcher ──────────────────────────────────────────────────────────
const emma = MOCK_PATIENTS.find((p) => p.id === 'pat_100');
if (!emma) throw new Error('Demo patient pat_100 missing from mock data');
const jenkins = SEEDED_ACCOUNTS.find((a) => a.id === 'acct-p1');
if (!jenkins) throw new Error('Seeded account acct-p1 missing');

const emmaFields: ConversationSearchFields = {
  patientName: emma.name,
  patientEmail: emma.email,
  patientPhone: emma.phone,
  officeName: jenkins.officeName,
  providerName: jenkins.providerName,
  providerCode: jenkins.providerCode,
};
const phoneDigits = emma.phone.replace(/\D+/g, '');

check('empty query matches', conversationMatchesQuery(emmaFields, ''), true);
check('blank query matches', conversationMatchesQuery(emmaFields, '   '), true);
check('name, case-insensitive', conversationMatchesQuery(emmaFields, 'EMMA smith'), true);
check('email fragment', conversationMatchesQuery(emmaFields, 'emma.smith@example'), true);
check('phone as seeded format', conversationMatchesQuery(emmaFields, emma.phone), true);
check('phone dashed fragment', conversationMatchesQuery(emmaFields, `${phoneDigits.slice(0, 3)}-${phoneDigits.slice(3, 6)}`), true);
check('phone parenthesized', conversationMatchesQuery(emmaFields, `(${phoneDigits.slice(0, 3)}) ${phoneDigits.slice(3, 6)}`), true);
check('office name with ampersand', conversationMatchesQuery(emmaFields, 'aesthetics & wellness'), true);
check('provider name with punctuation', conversationMatchesQuery(emmaFields, 'dr. sarah'), true);
check('provider code plain', conversationMatchesQuery(emmaFields, '123456'), true);
check('provider code with dashes', conversationMatchesQuery(emmaFields, '12-34-56'), true);
check('wrong office rejected', conversationMatchesQuery(emmaFields, 'chen'), false);
check('wrong code rejected', conversationMatchesQuery(emmaFields, '284119'), false);
check('AND across tokens rejects mixups', conversationMatchesQuery(emmaFields, 'emma rostova'), false);

// ─── Search over the real rail rows (same composition the page uses) ─────────
const rows = all.map((conv) => {
  const patient = MOCK_PATIENTS.find((p) => p.id === conv.patientId);
  const account = SEEDED_ACCOUNTS.find((a) => a.id === conv.accountId);
  return {
    conv,
    fields: {
      patientName: patient?.name,
      patientEmail: patient?.email,
      patientPhone: patient?.phone,
      officeName: account?.officeName,
      providerName: account?.providerName,
      providerCode: account?.providerCode,
    } satisfies ConversationSearchFields,
  };
});
const idsFor = (query: string) => rows.filter((row) => conversationMatchesQuery(row.fields, query)).map((row) => row.conv.id);

check('office search narrows to its threads', idsFor('rostova'), ['conv-08', 'conv-06', 'conv-07']);
check('provider code search matches office search', idsFor('590233'), ['conv-08', 'conv-06', 'conv-07']);
const pat102 = MOCK_PATIENTS.find((p) => p.id === 'pat_102');
if (!pat102) throw new Error('Demo patient pat_102 missing from mock data');
check('phone digits find one patient thread', idsFor(pat102.phone.replace(/\D+/g, '')), ['conv-06']);
check('garbage query matches nothing', idsFor('zzzqx'), []);

console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All conversations-rail checks passed.');
