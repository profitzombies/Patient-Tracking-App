/**
 * Mock coach transcripts for the HQ conversations viewer.
 *
 * Each transcript imitates the mobile coach thread's message shape — the
 * same `{ id, role, text, status, card?, quickReplies? }` contract the app's
 * chat context uses — plus a display timestamp, so the web viewer can render
 * bubbles, rich cards, and one-tap reply chips the way the phone shows them.
 * Nothing here is a live chat: these are pre-written, session-static
 * transcripts tied to real seeded patients of each provider account.
 *
 * Content rules: coach lines stay generic and supportive (routines,
 * hydration, planning ahead) and never state program or medical claims —
 * program wording belongs to the docs archive, not paraphrased mock data.
 * Card payloads imitate the app's kinds: `recipe` carries an inline
 * suggestion summary; `product` carries a catalog id resolved against the
 * shared product catalog at render time so it can never drift.
 *
 * The rail-facing helpers at the bottom derive each thread's machine-sortable
 * last-activity timestamp, its iMessage-style time label, and its preview
 * snippet from the transcripts themselves — the display labels are the single
 * source of truth, anchored to the fixed Aug 2026 demo dates (never the
 * viewer clock). The format-tolerant search matcher the conversations page
 * uses lives here too so it stays pure and node-testable.
 */
import { TODAY_KEY } from '../nutrition-data';
import type { HqRole } from './team';

export interface HqCoachCard {
  kind: 'recipe' | 'product';
  payload: unknown;
}

/** Recipe-card payload subset the web preview renders (mirrors the app's). */
export interface HqRecipePayload {
  id: string;
  name: string;
  description: string;
  mode: 'recipe' | 'cravings';
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

export interface HqCoachMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Transcripts are settled history — every message arrived fully. */
  status: 'done';
  /** Display timestamp anchored to the demo dates (never the viewer clock). */
  atLabel: string;
  card?: HqCoachCard;
  /** One-tap answer chips the app offered under this reply. */
  quickReplies?: string[];
}

export interface HqConversation {
  id: string;
  /** Provider account (sub-account) whose patient this thread belongs to. */
  accountId: string;
  /** Real seeded roster patient — the viewer resolves the name at render. */
  patientId: string;
  /** Short list-pane summary of what the thread was about. */
  topic: string;
  startedLabel: string;
}

const recipeCard = (payload: HqRecipePayload): HqCoachCard => ({ kind: 'recipe', payload });
const productCard = (productId: string): HqCoachCard => ({ kind: 'product', payload: { id: productId } });

export const HQ_CONVERSATIONS: HqConversation[] = [
  { id: 'conv-01', accountId: 'acct-p1', patientId: 'pat_100', topic: 'Breakfast ideas before work', startedLabel: 'Aug 21, 2026' },
  { id: 'conv-02', accountId: 'acct-p1', patientId: 'pat_104', topic: 'Keeping the water goal on track', startedLabel: 'Aug 20, 2026' },
  { id: 'conv-03', accountId: 'acct-p1', patientId: 'pat_112', topic: 'Eating out this weekend', startedLabel: 'Aug 22, 2026' },
  { id: 'conv-04', accountId: 'acct-p2', patientId: 'pat_101', topic: 'What comes after week six?', startedLabel: 'Aug 19, 2026' },
  { id: 'conv-05', accountId: 'acct-p2', patientId: 'pat_105', topic: 'Travel week routine', startedLabel: 'Aug 21, 2026' },
  { id: 'conv-06', accountId: 'acct-p3', patientId: 'pat_102', topic: 'Late-night cravings', startedLabel: 'Aug 20, 2026' },
  { id: 'conv-07', accountId: 'acct-p3', patientId: 'pat_106', topic: 'Getting back after a missed week', startedLabel: 'Aug 18, 2026' },
  { id: 'conv-08', accountId: 'acct-p3', patientId: 'pat_110', topic: 'Snack swaps for the office', startedLabel: 'Aug 22, 2026' },
  { id: 'conv-09', accountId: 'acct-p4', patientId: 'pat_103', topic: 'First week check-in', startedLabel: 'Aug 21, 2026' },
  { id: 'conv-10', accountId: 'acct-p4', patientId: 'pat_107', topic: 'Grocery list help', startedLabel: 'Aug 20, 2026' },
];

export const HQ_CONVERSATION_MESSAGES: Record<string, HqCoachMessage[]> = {
  'conv-01': [
    { id: 'c1-m1', role: 'user', status: 'done', atLabel: 'Aug 21 · 7:12 AM', text: 'Mornings are chaos. I keep skipping breakfast and then I overdo it at lunch.' },
    {
      id: 'c1-m2', role: 'assistant', status: 'done', atLabel: 'Aug 21 · 7:12 AM',
      text: 'That rush-hour gap is one of the most common patterns people mention — and it usually isn\u2019t about willpower, it\u2019s about having nothing ready to grab.\n\nA make-ahead option you can pick up with one hand tends to fix the lunch overshoot on its own.\n\nWant a five-minute idea you can prep the night before?',
    },
    { id: 'c1-m3', role: 'user', status: 'done', atLabel: 'Aug 21 · 7:13 AM', text: 'Yes please, something I can make Sunday night.' },
    {
      id: 'c1-m4', role: 'assistant', status: 'done', atLabel: 'Aug 21 · 7:13 AM',
      text: 'Here\u2019s one that keeps well for several days, so a single batch covers your busiest mornings.\n\nTap the card to see how the app presents it — servings, timing, and the estimated numbers are all in one place.\n\nWould you like a version without dairy too?',
      card: recipeCard({
        id: 'hq-rec-01', mode: 'recipe',
        name: 'Overnight Greek Yogurt Jars',
        description: 'Layered jars with berries and toasted oats — five minutes of prep the night before.',
        calories: 310, protein: 24, carbs: 32, fat: 9,
      }),
      quickReplies: ['Yes, dairy-free please', 'This works for me'],
    },
    { id: 'c1-m5', role: 'user', status: 'done', atLabel: 'Aug 21 · 7:14 AM', text: 'This works for me' },
    {
      id: 'c1-m6', role: 'assistant', status: 'done', atLabel: 'Aug 21 · 7:14 AM',
      text: 'Great choice. I\u2019ve kept it in your suggestions so it\u2019s easy to find on Sunday.\n\nWant a reminder that evening to prep the jars?',
      quickReplies: ['Remind me Sunday', 'No reminder needed'],
    },
  ],

  'conv-02': [
    { id: 'c2-m1', role: 'user', status: 'done', atLabel: 'Aug 20 · 12:40 PM', text: 'I always forget to drink water until dinner. Any tricks?' },
    {
      id: 'c2-m2', role: 'assistant', status: 'done', atLabel: 'Aug 20 · 12:40 PM',
      text: 'Very fixable — the trick most people land on is tying water to things you already do, instead of trying to remember it cold.\n\nA glass with each meal and one after every bathroom break quietly gets most of the way there.\n\nWant me to suggest a simple checkpoint schedule for your day?',
    },
    { id: 'c2-m3', role: 'user', status: 'done', atLabel: 'Aug 20 · 12:41 PM', text: 'Sure, my day starts around 6.' },
    {
      id: 'c2-m4', role: 'assistant', status: 'done', atLabel: 'Aug 20 · 12:41 PM',
      text: 'Starting at 6, try four easy checkpoints: one glass when you wake, one mid-morning, one with lunch, and one before your commute home.\n\nThat spreads it out so nothing feels forced, and dinner stops being a catch-up.\n\nShall I check in with you tomorrow afternoon to see how it went?',
      quickReplies: ['Yes, check in tomorrow', 'I\u2019ll track it myself'],
    },
  ],

  'conv-03': [
    { id: 'c3-m1', role: 'user', status: 'done', atLabel: 'Aug 22 · 9:05 AM', text: 'We have a birthday dinner Saturday. How do I not undo my week?' },
    {
      id: 'c3-m2', role: 'assistant', status: 'done', atLabel: 'Aug 22 · 9:05 AM',
      text: 'One dinner doesn\u2019t undo a week — the pattern around it matters more than the plate itself.\n\nA light look at the menu ahead of time, a protein-forward pick, and deciding your one treat in advance usually keeps the evening feeling normal instead of like a test.\n\nDo you know the restaurant yet? If you snap the menu in the app, I can point out a few picks.',
    },
    { id: 'c3-m3', role: 'user', status: 'done', atLabel: 'Aug 22 · 9:07 AM', text: 'It\u2019s a Mediterranean place. I\u2019ll scan the menu when they post it.' },
    {
      id: 'c3-m4', role: 'assistant', status: 'done', atLabel: 'Aug 22 · 9:07 AM',
      text: 'Mediterranean menus make this easy — grilled mains and vegetable-forward sides are usually the stars anyway.\n\nEnjoy the celebration, and log the evening honestly; one real data point beats a guilty gap in your diary.\n\nWant me to flag menu-scan tips before Saturday?',
      quickReplies: ['Yes, send tips Friday', 'I\u2019m all set'],
    },
  ],

  'conv-04': [
    { id: 'c4-m1', role: 'user', status: 'done', atLabel: 'Aug 19 · 6:20 PM', text: 'I finish week six soon. What happens to my routine after that?' },
    {
      id: 'c4-m2', role: 'assistant', status: 'done', atLabel: 'Aug 19 · 6:20 PM',
      text: 'First — finishing the six weeks is a real milestone, so take the win.\n\nWhat changes next is mostly cadence: the habits stay, the check-ins spread out, and your care team tailors what maintenance looks like for you at your next visit.\n\nWould you like to see what the app suggests for maintenance support?',
    },
    { id: 'c4-m3', role: 'user', status: 'done', atLabel: 'Aug 19 · 6:21 PM', text: 'Yes, show me.' },
    {
      id: 'c4-m4', role: 'assistant', status: 'done', atLabel: 'Aug 19 · 6:21 PM',
      text: 'This is the maintenance option patients most often review with their care team.\n\nYour provider\u2019s office confirms what fits your plan — the card just gives you the details to browse before that conversation.\n\nAnything else you\u2019d like to line up before your check-in?',
      card: productCard('prod9'),
      quickReplies: ['Book my check-in', 'That\u2019s all for now'],
    },
  ],

  'conv-05': [
    { id: 'c5-m1', role: 'user', status: 'done', atLabel: 'Aug 21 · 8:30 PM', text: 'I\u2019m traveling for work all next week. Hotel food, airports, the works.' },
    {
      id: 'c5-m2', role: 'assistant', status: 'done', atLabel: 'Aug 21 · 8:30 PM',
      text: 'Travel weeks reward a lighter version of your routine, not a paused one.\n\nThree anchors carry most of it: a protein-forward breakfast wherever you are, a refillable water bottle through security, and a default \u201cgrilled + vegetables\u201d dinner order when menus get chaotic.\n\nWant a packable snack shortlist for the flights?',
    },
    { id: 'c5-m3', role: 'user', status: 'done', atLabel: 'Aug 21 · 8:32 PM', text: 'Yes — nothing that melts, please.' },
    {
      id: 'c5-m4', role: 'assistant', status: 'done', atLabel: 'Aug 21 · 8:32 PM',
      text: 'Melt-proof and TSA-friendly: single-serve nut packs, jerky, roasted chickpea pouches, and a few protein bars you already like.\n\nToss two in every bag so the airport kiosk never makes the decision for you.\n\nShall I check in mid-week while you\u2019re on the road?',
      quickReplies: ['Check in Wednesday', 'I\u2019ve got this'],
    },
  ],

  'conv-06': [
    { id: 'c6-m1', role: 'user', status: 'done', atLabel: 'Aug 20 · 9:48 PM', text: 'It\u2019s 10pm and I want something sweet so badly.' },
    {
      id: 'c6-m2', role: 'assistant', status: 'done', atLabel: 'Aug 20 · 9:48 PM',
      text: 'Thanks for messaging instead of just riding it out — late-evening sweet cravings are extremely common, and they pass faster with a plan than with a staring contest.\n\nA small, genuinely satisfying option beats white-knuckling it.\n\nWant a quick fix built only from approved-list foods?',
    },
    { id: 'c6-m3', role: 'user', status: 'done', atLabel: 'Aug 20 · 9:49 PM', text: 'Yes! Something chocolatey if possible.' },
    {
      id: 'c6-m4', role: 'assistant', status: 'done', atLabel: 'Aug 20 · 9:49 PM',
      text: 'Chocolatey it is — this one takes about three minutes and uses only approved-list items, so it\u2019s a yes tonight, not a maybe.\n\nThe card has the short ingredient list and the estimated numbers.\n\nDid that take the edge off, or should we look at your evening meals for a pattern?',
      card: recipeCard({
        id: 'hq-rec-02', mode: 'cravings',
        name: 'Cocoa Ricotta Cup',
        description: 'Whipped ricotta with cocoa and berries — a three-minute sweet fix from approved-list items.',
        calories: 180, protein: 12, carbs: 14, fat: 8,
      }),
      quickReplies: ['That helped, thanks', 'Let\u2019s look at the pattern'],
    },
  ],

  'conv-07': [
    { id: 'c7-m1', role: 'user', status: 'done', atLabel: 'Aug 18 · 10:15 AM', text: 'I fell off completely last week. Honestly embarrassed to even open the app.' },
    {
      id: 'c7-m2', role: 'assistant', status: 'done', atLabel: 'Aug 18 · 10:15 AM',
      text: 'I\u2019m glad you opened it anyway — that\u2019s genuinely the hard part, and it says more about where this goes than last week does.\n\nA missed week is information, not a verdict. The fastest way back is small: one logged meal today, not a perfect day.\n\nWant to pick one easy win for today together?',
    },
    { id: 'c7-m3', role: 'user', status: 'done', atLabel: 'Aug 18 · 10:17 AM', text: 'Okay. Logging lunch is probably doable.' },
    {
      id: 'c7-m4', role: 'assistant', status: 'done', atLabel: 'Aug 18 · 10:17 AM',
      text: 'Logging lunch it is — that\u2019s the whole assignment for today, and it counts.\n\nYour care team can also shift your check-in if the week ahead looks heavy; there\u2019s no penalty for asking.\n\nWant me to nudge you at lunchtime?',
      quickReplies: ['Nudge me at noon', 'No nudge, I\u2019m on it'],
    },
  ],

  'conv-08': [
    { id: 'c8-m1', role: 'user', status: 'done', atLabel: 'Aug 22 · 2:55 PM', text: 'The office snack drawer is my downfall. What can I keep at my desk instead?' },
    {
      id: 'c8-m2', role: 'assistant', status: 'done', atLabel: 'Aug 22 · 2:55 PM',
      text: 'The drawer wins because it\u2019s closest — so the fix is making your options the closest ones.\n\nDesk-stable swaps that hold up well: portioned nuts, roasted edamame, seaweed snacks, and a shaker you actually like using.\n\nWant me to turn those into a shopping list in the app?',
      quickReplies: ['Make the list', 'I\u2019ll wing it'],
    },
    { id: 'c8-m3', role: 'user', status: 'done', atLabel: 'Aug 22 · 2:56 PM', text: 'Make the list' },
    {
      id: 'c8-m4', role: 'assistant', status: 'done', atLabel: 'Aug 22 · 2:56 PM',
      text: 'Done — it\u2019s waiting in your lists, grouped by aisle so the store run takes five minutes.\n\nRestock on Sundays and the drawer loses its main advantage.\n\nAnything else about the workday routine you\u2019d like to tune?',
    },
  ],

  'conv-09': [
    { id: 'c9-m1', role: 'user', status: 'done', atLabel: 'Aug 21 · 5:10 PM', text: 'Just finished my first week. Scale barely moved. Is that normal?' },
    {
      id: 'c9-m2', role: 'assistant', status: 'done', atLabel: 'Aug 21 · 5:10 PM',
      text: 'Completely normal — early weeks are noisy, and one number can\u2019t see the habits you just built: your logs show real consistency for a first week.\n\nTrends over two to three weeks are the honest signal, and your care team watches those with you.\n\nHow are you feeling energy-wise compared to last week?',
    },
    { id: 'c9-m3', role: 'user', status: 'done', atLabel: 'Aug 21 · 5:12 PM', text: 'Actually better in the afternoons, now that you mention it.' },
    {
      id: 'c9-m4', role: 'assistant', status: 'done', atLabel: 'Aug 21 · 5:12 PM',
      text: 'That afternoon lift is worth logging — small wins like that usually show up before the scale agrees.\n\nKeep the routine exactly as boring as it\u2019s been; boring is working.\n\nWant a quick recap of week one to share at your check-in?',
      quickReplies: ['Yes, recap please', 'Maybe later'],
    },
  ],

  'conv-10': [
    { id: 'c10-m1', role: 'user', status: 'done', atLabel: 'Aug 20 · 11:02 AM', text: 'Shopping tonight. Can you help me build a list that isn\u2019t boring?' },
    {
      id: 'c10-m2', role: 'assistant', status: 'done', atLabel: 'Aug 20 · 11:02 AM',
      text: 'Happy to — \u201cnot boring\u201d usually means variety in textures and sauces, not more ingredients.\n\nGive me two dinners you already enjoy and I\u2019ll build around them so the week feels familiar with a twist.\n\nWhat are your two keepers?',
    },
    { id: 'c10-m3', role: 'user', status: 'done', atLabel: 'Aug 20 · 11:04 AM', text: 'Tacos and stir fry, easily.' },
    {
      id: 'c10-m4', role: 'assistant', status: 'done', atLabel: 'Aug 20 · 11:04 AM',
      text: 'Great anchors. Here\u2019s a stir-fry refresh to start — same pan, new profile — and your list now covers both dinners plus lunches from the leftovers.\n\nThe card shows the estimated numbers per serving.\n\nWant a taco-night variation too?',
      card: recipeCard({
        id: 'hq-rec-03', mode: 'recipe',
        name: 'Ginger-Lime Chicken Stir Fry',
        description: 'Weeknight stir fry with a bright ginger-lime finish — built for leftovers.',
        calories: 420, protein: 38, carbs: 30, fat: 16,
      }),
      quickReplies: ['Yes, taco version', 'List is enough'],
    },
  ],
};

// ─── Rail summaries: sortable activity, time labels, previews ────────────────

const DAY_MS = 86_400_000;
/** Demo year the transcript labels live in (from the shared fixed anchor). */
const DEMO_YEAR = Number(TODAY_KEY.slice(0, 4));
/** UTC day index of the fixed demo "today" (2026-08-22). */
const ANCHOR_DAY_INDEX = Math.floor(Date.parse(`${TODAY_KEY}T12:00:00.000Z`) / DAY_MS);

const MONTH_INDEX: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

const AT_LABEL_PATTERN = /^([A-Z][a-z]{2}) (\d{1,2}) · (\d{1,2}):(\d{2}) (AM|PM)$/;

/**
 * Message display label ('Aug 21 · 7:12 AM') → machine-sortable demo-timeline
 * timestamp (UTC ms in the fixed demo year). The label is the single source
 * of truth, so sorting can never disagree with what the transcript shows; a
 * malformed label throws at module load — a seed typo becomes a loud
 * dev-time failure, never a silently mis-sorted rail.
 */
export function parseAtLabel(atLabel: string): number {
  const match = AT_LABEL_PATTERN.exec(atLabel);
  const month = match ? MONTH_INDEX[match[1]] : undefined;
  if (!match || month === undefined) {
    throw new Error(`Unparseable transcript time label: "${atLabel}" (expected e.g. "Aug 21 · 7:12 AM")`);
  }
  const hour = (Number(match[3]) % 12) + (match[5] === 'PM' ? 12 : 0);
  return Date.UTC(DEMO_YEAR, month, Number(match[2]), hour, Number(match[4]));
}

export interface HqConversationSummary extends HqConversation {
  /** Newest message of the thread, resolved once for the rail. */
  lastMessage: HqCoachMessage;
  /** Sortable timestamp of the newest message (demo timeline, never viewer clock). */
  lastActivityAt: number;
  /** iMessage-style rail label: clock time on the demo "today", 'Yesterday', else the date. */
  lastActivityLabel: string;
  /** Single-line snippet of the newest message for the rail preview. */
  preview: string;
}

const summarize = (conv: HqConversation): HqConversationSummary => {
  const messages = HQ_CONVERSATION_MESSAGES[conv.id] ?? [];
  if (messages.length === 0) throw new Error(`Conversation ${conv.id} has no transcript messages`);
  // Parse every label (validating the whole transcript, not just the tail)
  // and keep the newest — the rail's contract is "latest activity", not
  // "last array entry", even though seeds are written chronologically.
  let last = messages[0];
  let lastActivityAt = parseAtLabel(last.atLabel);
  for (const message of messages.slice(1)) {
    const at = parseAtLabel(message.atLabel);
    if (at >= lastActivityAt) {
      last = message;
      lastActivityAt = at;
    }
  }
  const [datePart, timePart] = last.atLabel.split(' · ');
  const dayIndex = Math.floor(lastActivityAt / DAY_MS);
  const lastActivityLabel =
    dayIndex === ANCHOR_DAY_INDEX ? timePart : dayIndex === ANCHOR_DAY_INDEX - 1 ? 'Yesterday' : datePart;
  return {
    ...conv,
    lastMessage: last,
    lastActivityAt,
    lastActivityLabel,
    preview: last.text.replace(/\s*\n+\s*/g, ' '),
  };
};

/** Built once at module load — eagerly validates every seeded time label. */
const HQ_CONVERSATION_SUMMARIES: HqConversationSummary[] = HQ_CONVERSATIONS.map(summarize);

/**
 * Conversation rail summaries for one account, or all of them — always
 * newest activity first, based on each thread's latest message (not the
 * thread start date). Id tie-break keeps the order fully deterministic.
 */
export function getConversations(accountId?: string): HqConversationSummary[] {
  const list = accountId
    ? HQ_CONVERSATION_SUMMARIES.filter((conv) => conv.accountId === accountId)
    : HQ_CONVERSATION_SUMMARIES;
  return [...list].sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.id.localeCompare(b.id));
}

/**
 * Coach transcripts contain patient clinical context. Support is intentionally
 * excluded: this demo has no server-backed support-conversation source, so an
 * empty result is safer and more honest than re-labeling coach fixtures.
 */
export function canReadClinicalCoachConversations(role: HqRole | null): boolean {
  return role === 'Super Admin' || role === 'Admin' || role === 'Clinical';
}

export function getConversationsForRole(
  role: HqRole | null,
  accountId?: string,
): HqConversationSummary[] {
  return canReadClinicalCoachConversations(role) ? getConversations(accountId) : [];
}

export function getConversationMessagesForRole(
  role: HqRole | null,
  conversationId: string,
): HqCoachMessage[] {
  if (!canReadClinicalCoachConversations(role)) return [];
  return [...(HQ_CONVERSATION_MESSAGES[conversationId] ?? [])];
}

// ─── Rail search ─────────────────────────────────────────────────────────────

/** The per-thread identity fields the rail search runs over. */
export interface ConversationSearchFields {
  patientName?: string;
  patientEmail?: string;
  patientPhone?: string;
  officeName?: string;
  providerName?: string;
  providerCode?: string;
}

const digitsOf = (value: string) => value.replace(/\D+/g, '');

/**
 * Case-insensitive, format-tolerant rail search. Every whitespace-separated
 * token must hit either the text haystack (patient name/email, office name,
 * provider name, provider code) or — for tokens carrying digits — the digit
 * haystack (phone and code with punctuation stripped), so "(555) 301" finds
 * the patient whose phone is 555-301-4420 however either side is formatted.
 * An empty query matches everything.
 */
export function conversationMatchesQuery(fields: ConversationSearchFields, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const text = [fields.patientName, fields.patientEmail, fields.officeName, fields.providerName, fields.providerCode]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  // Space-joined so digits can never falsely match across two fields.
  const digits = [fields.patientPhone, fields.providerCode].map((value) => digitsOf(value ?? '')).join(' ');
  return tokens.every((token) => {
    if (text.includes(token)) return true;
    const tokenDigits = digitsOf(token);
    return tokenDigits.length > 0 && digits.includes(tokenDigits);
  });
}
