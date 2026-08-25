/**
 * Seed the live Supabase training portal with realistic — but clearly fake —
 * sample data: three courses (two live, one draft), a dozen obviously fake
 * viewers (.example.com emails), staff invites, and scattered completion
 * history with watch metadata so dashboards and analytics show meaningful,
 * non-zero numbers from day one.
 *
 * Idempotent: every row has a deterministic UUID derived from a readable seed
 * key, and everything is UPSERTed — re-running restores the sample rows
 * without duplicating them and without touching rows created through the app.
 *
 *   pnpm --filter @workspace/thinnr-operations run seed:training
 *   pnpm --filter @workspace/thinnr-operations run seed:training -- --reset
 *
 * `--reset` deletes ALL training rows first (including ones created through
 * the app), then reseeds — a full factory reset of the training portal.
 *
 * Timestamps are seeded relative to "now" (first seen N days ago), so the
 * dashboard's "new this week" and "last seen" stay lively no matter when the
 * seed last ran. Videos are metadata only — no files are uploaded anywhere
 * and the `video_source` column is intentionally left NULL.
 */
import { createHash } from 'node:crypto';

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;
for (const key of required) {
  if (!process.env[key]) throw new Error(`${key} is required to seed training data.`);
}

const baseUrl = process.env.SUPABASE_URL!.replace(/\/$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const adminHeaders = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  'Content-Type': 'application/json',
};

// ---------------------------------------------------------------------------
// Deterministic ids and timestamps
// ---------------------------------------------------------------------------

/** Stable UUID from a readable seed key — same key, same UUID, every run. */
function uuidFromKey(key: string): string {
  const hex = createHash('md5').update(`thinnr-training:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const NOW = Date.now();
const DAY = 86_400_000;

/** `daysAgo` at hh:mm (approximately US Eastern), clamped to the past. */
function at(daysAgo: number, hh = 12, mm = 0): string {
  const date = new Date(NOW - daysAgo * DAY);
  date.setUTCHours(hh + 4, mm, 0, 0);
  return new Date(Math.min(date.getTime(), NOW - 5 * 60_000)).toISOString();
}

/** djb2 — deterministic jitter so watch metadata varies but never changes between runs. */
function hashId(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h;
}

/** "10:48" → seconds. */
const dur = (clock: string): number => {
  const [m, s] = clock.split(':').map(Number);
  return m! * 60 + s!;
};

// ---------------------------------------------------------------------------
// Chapter generation (same shape the mock used, so slides look editorial)
// ---------------------------------------------------------------------------

interface ChapterSeed {
  id: string;
  at: number;
  title: string;
}

const CHAPTER_POOLS: string[][] = [
  ['What this covers', 'The setup', 'Live walkthrough', 'Where people slip', 'A worked example', 'Recap and next step'],
  ['Why this matters', 'The screen tour', 'Doing it for real', 'Common mistakes', 'Practice prompt', 'Wrap-up'],
  ['Starting point', 'Key terms', 'Step by step', 'Edge cases', 'Checklist moment', 'What comes next'],
  ['The goal', 'Before you start', 'The walkthrough', 'Troubleshooting', 'Pro habits', 'Recap'],
];

function generatedChapters(videoKey: string, duration: number): ChapterSeed[] {
  const seed = hashId(videoKey);
  const count = duration <= 260 ? 3 : duration <= 380 ? 4 : duration <= 480 ? 5 : 6;
  const pool = CHAPTER_POOLS[seed % CHAPTER_POOLS.length]!;
  const chapters: ChapterSeed[] = [];
  for (let i = 0; i < count; i++) {
    const base = (duration * i) / count;
    const jitter = i === 0 ? 0 : ((seed >> (i * 3)) % 21) - 10;
    chapters.push({
      id: `${videoKey}-ch${i + 1}`,
      at: Math.max(0, Math.min(duration - 20, Math.round(base + jitter))),
      title: pool[i % pool.length]!,
    });
  }
  return chapters;
}

// ---------------------------------------------------------------------------
// Course catalog — two live courses and one draft
// ---------------------------------------------------------------------------

interface VideoSeed {
  key: string;
  title: string;
  clock: string;
  published?: 'published' | 'draft';
  unlock?: 'sequential' | 'free';
  addStaff?: 'auto' | 'show' | 'hidden';
  description?: string[];
  chapters?: ChapterSeed[];
  thumbnailChapter?: number;
  attachments?: { id: string; name: string; sizeLabel: string }[];
}

type EntrySeed = { video: VideoSeed } | { subgroup: SubgroupSeed };

interface SubgroupSeed {
  key: string;
  title: string;
  published?: 'published' | 'draft';
  unlock?: 'sequential' | 'free';
  videos: VideoSeed[];
}

interface ModuleSeed {
  key: string;
  title: string;
  published?: 'published' | 'draft';
  unlock?: 'sequential' | 'free';
  entries: EntrySeed[];
}

interface CourseSeed {
  key: string;
  slug: string;
  title: string;
  description: string;
  status: 'live' | 'draft';
  sequentialUnlock: boolean;
  createdDaysAgo: number;
  modules: ModuleSeed[];
}

const vid = (key: string, title: string, clock: string, extra: Partial<VideoSeed> = {}): EntrySeed => ({
  video: { key, title, clock, ...extra },
});
const sub = (key: string, title: string, videos: VideoSeed[], unlock: 'sequential' | 'free' = 'free'): EntrySeed => ({
  subgroup: { key, title, unlock, videos },
});
const sv = (key: string, title: string, clock: string, extra: Partial<VideoSeed> = {}): VideoSeed => ({
  key,
  title,
  clock,
  ...extra,
});

const INTRO_CHAPTERS: ChapterSeed[] = [
  { id: 'v1-1-ch1', at: 0, title: 'Welcome' },
  { id: 'v1-1-ch2', at: 38, title: 'Why finish this training' },
  { id: 'v1-1-ch3', at: 72, title: 'What THINNR offices do differently' },
  { id: 'v1-1-ch4', at: 117, title: 'The tools you will use daily' },
  { id: 'v1-1-ch5', at: 151, title: 'How modules unlock' },
  { id: 'v1-1-ch6', at: 184, title: 'Adding your teammates' },
  { id: 'v1-1-ch7', at: 222, title: 'The operations desk in one minute' },
  { id: 'v1-1-ch8', at: 259, title: 'Patients and the mobile app' },
  { id: 'v1-1-ch9', at: 302, title: 'The coach, briefly' },
  { id: 'v1-1-ch10', at: 347, title: 'What HQ sees' },
  { id: 'v1-1-ch11', at: 384, title: 'Certificates and graduation' },
  { id: 'v1-1-ch12', at: 435, title: 'Getting help' },
  { id: 'v1-1-ch13', at: 520, title: 'Your first assignment' },
  { id: 'v1-1-ch14', at: 592, title: "Let's begin" },
];

const OVERVIEW_CHAPTERS: ChapterSeed[] = [
  { id: 'v2-2-ch1', at: 0, title: 'The four headline numbers' },
  { id: 'v2-2-ch2', at: 61, title: 'Revenue: recurring vs enrollment' },
  { id: 'v2-2-ch3', at: 148, title: 'Reading the trend chart' },
  { id: 'v2-2-ch4', at: 234, title: 'Protocol stages at a glance' },
  { id: 'v2-2-ch5', at: 331, title: 'When a number looks wrong' },
  { id: 'v2-2-ch6', at: 406, title: 'A daily 90-second routine' },
];

const SIGNUP_CHAPTERS: ChapterSeed[] = [
  { id: 'v3-2-ch1', at: 0, title: 'Before the patient arrives' },
  { id: 'v3-2-ch2', at: 55, title: 'Download and first open' },
  { id: 'v3-2-ch3', at: 132, title: 'The provider code moment' },
  { id: 'v3-2-ch4', at: 219, title: 'Birthday and goal weight' },
  { id: 'v3-2-ch5', at: 308, title: 'What patients see next' },
  { id: 'v3-2-ch6', at: 379, title: 'Troubleshooting sign-up' },
];

const COURSES: CourseSeed[] = [
  {
    key: 'course-office-onboarding',
    slug: 'office-onboarding',
    title: 'THINNR Office Onboarding',
    description:
      'The complete ramp for a new provider office — from first sign-in on the operations desk to a confident launch week. Watch in order; modules unlock as your team progresses.',
    status: 'live',
    sequentialUnlock: true,
    createdDaysAgo: 105,
    modules: [
      {
        key: 'm1',
        title: 'Welcome to THINNR',
        entries: [
          vid('v1-1', 'Start here: how this training works', '10:48', {
            chapters: INTRO_CHAPTERS,
            thumbnailChapter: 3,
            description: [
              'Everything your office needs to get full value from this course: how modules unlock, how to add teammates, and what finishing unlocks for your practice.',
              'Offices that complete onboarding in their first two weeks consistently run smoother launch days — this video shows you the path.',
            ],
            attachments: [
              { id: 'att-welcome-1', name: 'Onboarding roadmap (one page).pdf', sizeLabel: '412 KB' },
              { id: 'att-welcome-2', name: 'Team roles worksheet.pdf', sizeLabel: '286 KB' },
            ],
          }),
          vid('v1-2', 'The THINNR program at a glance', '6:24'),
          vid('v1-3', 'Meet the operations desk', '7:05'),
          vid('v1-4', 'Your provider code and why it matters', '4:41'),
          vid('v1-5', 'Setting up your office profile', '5:33'),
        ],
      },
      {
        key: 'm2',
        title: 'The Operations Desk',
        entries: [
          vid('v2-1', 'Desk tour: navigation and layout', '5:58'),
          vid('v2-2', 'Reading the Overview numbers', '7:44', { chapters: OVERVIEW_CHAPTERS }),
          vid('v2-3', 'Choosing and saving date ranges', '4:19'),
          sub('sg-roster', 'Roster walkthrough', [
            sv('v2-4-1', 'Finding a patient fast', '3:52'),
            sv('v2-4-2', 'Check-ins and status chips', '6:07'),
            sv('v2-4-3', 'Sorting, filters, and saved views', '5:26'),
            sv('v2-4-4', 'Editing patient details safely', '4:48'),
          ]),
          sub('sg-subs', 'Subscriptions walkthrough', [
            sv('v2-5-1', 'Subscription states explained', '5:11'),
            sv('v2-5-2', 'Pausing and resuming a plan', '4:02'),
            sv('v2-5-3', 'Deliveries and what patients see', '6:31'),
          ]),
          sub('sg-leaderboard', 'Leaderboard & milestones', [
            sv('v2-6-1', 'How the leaderboard ranks offices', '4:56'),
            sv('v2-6-2', 'Celebrating milestones without oversharing', '3:37'),
          ]),
        ],
      },
      {
        key: 'm3',
        title: 'Patient App & Onboarding',
        entries: [
          vid('v3-1', 'What patients see on day one', '6:12'),
          vid('v3-2', 'Walking a patient through sign-up', '7:18', { chapters: SIGNUP_CHAPTERS }),
          vid('v3-3', 'Birthday, goal weight, and provider code prompts', '4:27'),
          vid('v3-4', "The food diary from the patient's side", '8:03'),
          vid('v3-5', 'Approved foods and swaps', '5:44'),
          vid('v3-6', 'Progress photos: capture and consent', '6:56', {
            attachments: [{ id: 'att-photo-1', name: 'Photo consent script.pdf', sizeLabel: '198 KB' }],
          }),
        ],
      },
      {
        key: 'm4',
        title: 'Coach & Conversations',
        entries: [
          vid('v4-1', 'How the THINNR coach fits your care team', '6:38'),
          vid('v4-2', 'Reading a coach transcript', '5:21'),
          vid('v4-3', 'Recipe cards and quick replies', '4:44'),
          vid('v4-4', 'When to step in with a human touch', '7:09'),
          vid('v4-5', 'Handoffs your patients will thank you for', '5:02'),
        ],
      },
      {
        key: 'm5',
        title: 'Front Desk Playbook',
        entries: [
          vid('v5-1', 'The first visit script', '6:47', {
            attachments: [{ id: 'att-script-1', name: 'First visit script (print).pdf', sizeLabel: '344 KB' }],
          }),
          vid('v5-2', 'Weigh-ins that feel supportive', '5:36'),
          vid('v5-3', 'Handling billing questions', '6:14'),
          vid('v5-4', 'Reorders and delivery hiccups', '4:53'),
          vid('v5-5', 'Difficult conversations, done kindly', '7:31'),
        ],
      },
      {
        key: 'm6',
        title: 'Go Live & Graduation',
        entries: [
          vid('v6-1', 'Launch-week checklist', '5:17', {
            attachments: [{ id: 'att-launch-1', name: 'Launch-week checklist.pdf', sizeLabel: '251 KB' }],
          }),
          vid('v6-2', 'Your first ten patients', '6:29'),
          vid('v6-3', 'Demo data vs live data', '4:08'),
          vid('v6-4', 'Graduation: what great looks like', '3:58', { published: 'draft' }),
        ],
      },
    ],
  },
  {
    key: 'course-front-desk-refresher',
    slug: 'front-desk-refresher',
    title: 'Front Desk Refresher',
    description:
      'Short, rewatchable refreshers for the front desk — the moments that come up every week, each kept under seven minutes. Open to your whole team, in any order.',
    status: 'live',
    sequentialUnlock: false,
    createdDaysAgo: 40,
    modules: [
      {
        key: 'fm1',
        title: 'Weekly rhythms',
        unlock: 'free',
        entries: [
          vid('fv1-1', 'Monday morning: the 10-minute desk reset', '5:12', { unlock: 'free' }),
          vid('fv1-2', 'Reorder day: keeping deliveries on time', '6:05', { unlock: 'free' }),
          vid('fv1-3', 'Friday close-out: the numbers worth a glance', '4:47', { unlock: 'free' }),
        ],
      },
      {
        key: 'fm2',
        title: 'Tricky moments',
        unlock: 'free',
        entries: [
          vid('fv2-1', "A patient asks about someone else's results", '3:58', { unlock: 'free' }),
          vid('fv2-2', 'The scale says something nobody wants to hear', '6:22', { unlock: 'free' }),
          vid('fv2-3', 'Payment declined — keeping it graceful', '5:31', { unlock: 'free' }),
          vid('fv2-4', 'When the coach should hand off to a human', '4:44', { unlock: 'free' }),
        ],
      },
    ],
  },
  {
    key: 'course-hq-reporting',
    slug: 'hq-reporting-deep-dive',
    title: 'HQ Reporting Deep Dive',
    description:
      'For HQ analysts and multi-office owners: how account metrics roll up, and how to read cross-account comparisons without fooling yourself.',
    status: 'draft',
    sequentialUnlock: false,
    createdDaysAgo: 19,
    modules: [
      {
        key: 'rm1',
        title: 'Account metrics',
        unlock: 'free',
        entries: [
          vid('rv1-1', 'The five numbers on every account card', '6:41', { unlock: 'free' }),
          vid('rv1-2', 'Drilling into an office dashboard', '8:22', { unlock: 'free' }),
          vid('rv1-3', 'Comparing offices honestly', '7:15', { unlock: 'free' }),
        ],
      },
      {
        key: 'rm2',
        title: 'Cross-account rollups',
        published: 'draft',
        unlock: 'free',
        entries: [
          vid('rv2-1', 'Why the umbrella totals always reconcile', '7:58', { unlock: 'free', published: 'draft' }),
          vid('rv2-2', 'Exports and board-ready snapshots', '5:49', { unlock: 'free', published: 'draft' }),
        ],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Viewer roster — a dozen obviously fake people (.example.com emails)
// ---------------------------------------------------------------------------

interface ExtraCompletionSeed {
  videoKey: string;
  done: boolean;
  daysAgo: number;
}

interface ViewerSeedRow {
  key: string;
  name: string;
  email: string;
  phone: string;
  accountId: string | null;
  staffOfKey?: string;
  location: string;
  firstSeenDaysAgo: number;
  lastSeenDaysAgo: number;
  lastSeenClock: [number, number];
  sessions: number;
  /** Completed count over the flagship course's published order. */
  completed: number;
  /** Video keys to skip while counting — creates honest gaps in progress. */
  skip?: string[];
  /** Also started (but didn't finish) the next uncompleted video. */
  startNext?: boolean;
  /** Scattered activity on other courses. */
  extras?: ExtraCompletionSeed[];
}

const VIEWERS: ViewerSeedRow[] = [
  { key: 'vw-01', name: 'Maria Delgado', email: 'maria@jenkinswellness.example.com', phone: '(555) 301-4471', accountId: 'acct-p1', location: 'Pasadena, CA', firstSeenDaysAgo: 81, lastSeenDaysAgo: 0, lastSeenClock: [9, 12], sessions: 21, completed: 36 },
  { key: 'vw-02', name: 'Tanya Brooks', email: 'tanya@jenkinswellness.example.com', phone: '(555) 301-4488', accountId: 'acct-p1', staffOfKey: 'vw-01', location: 'Pasadena, CA', firstSeenDaysAgo: 74, lastSeenDaysAgo: 2, lastSeenClock: [15, 42], sessions: 14, completed: 26, startNext: true },
  { key: 'vw-03', name: 'Alicia Fontaine', email: 'alicia@jenkinswellness.example.com', phone: '(555) 301-4493', accountId: 'acct-p1', location: 'Pasadena, CA', firstSeenDaysAgo: 59, lastSeenDaysAgo: 1, lastSeenClock: [11, 5], sessions: 12, completed: 20, skip: ['v2-4-2'] },
  { key: 'vw-04', name: 'Jordan Pruitt', email: 'jordan@jenkinswellness.example.com', phone: '(555) 301-4429', accountId: 'acct-p1', staffOfKey: 'vw-01', location: 'Pasadena, CA', firstSeenDaysAgo: 45, lastSeenDaysAgo: 6, lastSeenClock: [13, 27], sessions: 9, completed: 14 },
  { key: 'vw-05', name: 'Dana Kowalski', email: 'dana@chenmetabolic.example.com', phone: '(555) 442-8144', accountId: 'acct-p2', location: 'Austin, TX', firstSeenDaysAgo: 87, lastSeenDaysAgo: 0, lastSeenClock: [8, 26], sessions: 19, completed: 36, extras: [
    { videoKey: 'fv1-1', done: true, daysAgo: 14 },
    { videoKey: 'fv1-2', done: true, daysAgo: 9 },
    { videoKey: 'fv2-2', done: true, daysAgo: 4 },
  ] },
  { key: 'vw-06', name: 'Bethany Cole', email: 'bethany@chenmetabolic.example.com', phone: '(555) 442-8195', accountId: 'acct-p2', staffOfKey: 'vw-05', location: 'Austin, TX', firstSeenDaysAgo: 66, lastSeenDaysAgo: 3, lastSeenClock: [12, 55], sessions: 11, completed: 22, startNext: true },
  { key: 'vw-07', name: 'Shreya Patel', email: 'shreya@chenmetabolic.example.com', phone: '(555) 442-8109', accountId: 'acct-p2', location: 'Austin, TX', firstSeenDaysAgo: 12, lastSeenDaysAgo: 0, lastSeenClock: [11, 38], sessions: 3, completed: 4, startNext: true },
  { key: 'vw-08', name: 'Camille Duval', email: 'camille@rostovawellness.example.com', phone: '(555) 218-7791', accountId: 'acct-p3', location: 'Miami, FL', firstSeenDaysAgo: 73, lastSeenDaysAgo: 1, lastSeenClock: [9, 58], sessions: 16, completed: 33, extras: [
    { videoKey: 'fv1-1', done: true, daysAgo: 18 },
    { videoKey: 'fv1-2', done: true, daysAgo: 15 },
    { videoKey: 'fv1-3', done: true, daysAgo: 12 },
    { videoKey: 'fv2-1', done: true, daysAgo: 9 },
    { videoKey: 'fv2-2', done: true, daysAgo: 6 },
    { videoKey: 'fv2-3', done: true, daysAgo: 4 },
    { videoKey: 'fv2-4', done: true, daysAgo: 2 },
  ] },
  { key: 'vw-09', name: 'Yuri Melnyk', email: 'yuri@rostovawellness.example.com', phone: '(555) 218-7769', accountId: 'acct-p3', location: 'Miami, FL', firstSeenDaysAgo: 35, lastSeenDaysAgo: 11, lastSeenClock: [12, 7], sessions: 6, completed: 8, skip: ['v1-4'] },
  { key: 'vw-10', name: 'Hannah Cho', email: 'hannah@kimvitality.example.com', phone: '(555) 674-2248', accountId: 'acct-p4', location: 'Seattle, WA', firstSeenDaysAgo: 56, lastSeenDaysAgo: 2, lastSeenClock: [13, 3], sessions: 13, completed: 28, extras: [
    { videoKey: 'fv1-1', done: true, daysAgo: 10 },
    { videoKey: 'fv2-1', done: false, daysAgo: 5 },
  ] },
  { key: 'vw-11', name: 'Kelly Draper', email: 'kelly.draper@example.com', phone: '(555) 903-1174', accountId: null, location: 'Boise, ID', firstSeenDaysAgo: 5, lastSeenDaysAgo: 4, lastSeenClock: [12, 40], sessions: 2, completed: 2 },
  { key: 'vw-12', name: 'Tom Sinclair', email: 'tom.sinclair@example.com', phone: '(555) 772-3049', accountId: null, location: 'Denver, CO', firstSeenDaysAgo: 3, lastSeenDaysAgo: 3, lastSeenClock: [16, 44], sessions: 1, completed: 0, startNext: true },
];

/** Staff invites recorded for the Add Staff links above. */
const INVITES: { key: string; inviterKey: string; invitedKey: string }[] = [
  { key: 'inv-1', inviterKey: 'vw-01', invitedKey: 'vw-02' },
  { key: 'inv-2', inviterKey: 'vw-01', invitedKey: 'vw-04' },
  { key: 'inv-3', inviterKey: 'vw-05', invitedKey: 'vw-06' },
];

// ---------------------------------------------------------------------------
// Flatten the catalog into rows
// ---------------------------------------------------------------------------

const defaultDescription = (title: string): string[] => [
  `A focused walkthrough of ${title.toLowerCase().replace(/\.$/, '')} — recorded on the live THINNR operations desk with demo data, so your team can follow along click for click.`,
  'Watch once end to end, then keep it open in a second window the first time you do this for real.',
];

interface Row {
  [column: string]: unknown;
}

const courseRows: Row[] = [];
const moduleRows: Row[] = [];
const subgroupRows: Row[] = [];
const videoRows: Row[] = [];
/** key → { id, duration } for completion building. */
const videoByKey = new Map<string, { id: string; duration: number }>();
/** Flagship published order, as video keys. */
const flagshipOrderKeys: string[] = [];

function pushVideo(video: VideoSeed, moduleKey: string, subgroupKey: string | null, position: number, defaults: { unlock: 'sequential' | 'free' }) {
  const duration = dur(video.clock);
  const id = uuidFromKey(`video:${video.key}`);
  videoByKey.set(video.key, { id, duration });
  videoRows.push({
    id,
    module_id: uuidFromKey(`module:${moduleKey}`),
    subgroup_id: subgroupKey ? uuidFromKey(`subgroup:${subgroupKey}`) : null,
    title: video.title,
    duration_seconds: duration,
    published: video.published ?? 'published',
    unlock_mode: video.unlock ?? defaults.unlock,
    add_staff: video.addStaff ?? 'auto',
    description: video.description ?? defaultDescription(video.title),
    chapters: video.chapters ?? generatedChapters(video.key, duration),
    thumbnail_chapter: video.thumbnailChapter ?? 0,
    attachments: video.attachments ?? [],
    position,
    // video_source stays NULL on purpose: no storage provider is configured.
  });
}

for (const course of COURSES) {
  courseRows.push({
    id: uuidFromKey(`course:${course.key}`),
    slug: course.slug,
    title: course.title,
    description: course.description,
    status: course.status,
    sequential_unlock: course.sequentialUnlock,
    created_at: at(course.createdDaysAgo, 10, 30),
  });
  course.modules.forEach((module, moduleIndex) => {
    const defaults = { unlock: course.sequentialUnlock ? ('sequential' as const) : ('free' as const) };
    moduleRows.push({
      id: uuidFromKey(`module:${module.key}`),
      course_id: uuidFromKey(`course:${course.key}`),
      title: module.title,
      published: module.published ?? 'published',
      unlock_mode: module.unlock ?? defaults.unlock,
      position: moduleIndex,
    });
    module.entries.forEach((entry, entryIndex) => {
      if ('video' in entry) {
        pushVideo(entry.video, module.key, null, entryIndex, defaults);
        const publishedPath =
          course.status === 'live' &&
          (module.published ?? 'published') === 'published' &&
          (entry.video.published ?? 'published') === 'published';
        if (course.key === 'course-office-onboarding' && publishedPath) flagshipOrderKeys.push(entry.video.key);
      } else {
        const subgroup = entry.subgroup;
        subgroupRows.push({
          id: uuidFromKey(`subgroup:${subgroup.key}`),
          module_id: uuidFromKey(`module:${module.key}`),
          title: subgroup.title,
          published: subgroup.published ?? 'published',
          unlock_mode: subgroup.unlock ?? 'free',
          position: entryIndex,
        });
        subgroup.videos.forEach((video, videoIndex) => {
          pushVideo(video, module.key, subgroup.key, videoIndex, defaults);
          const publishedPath =
            course.status === 'live' &&
            (module.published ?? 'published') === 'published' &&
            (subgroup.published ?? 'published') === 'published' &&
            (video.published ?? 'published') === 'published';
          if (course.key === 'course-office-onboarding' && publishedPath) flagshipOrderKeys.push(video.key);
        });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Viewers, invites, and scattered completions with watch metadata
// ---------------------------------------------------------------------------

const viewerRows: Row[] = VIEWERS.map((viewer) => ({
  id: uuidFromKey(`viewer:${viewer.key}`),
  name: viewer.name,
  email: viewer.email.toLowerCase(),
  phone: viewer.phone,
  account_id: viewer.accountId,
  staff_of_viewer_id: viewer.staffOfKey ? uuidFromKey(`viewer:${viewer.staffOfKey}`) : null,
  location: viewer.location,
  first_seen_at: at(viewer.firstSeenDaysAgo, 9, 0),
  last_seen_at: at(viewer.lastSeenDaysAgo, viewer.lastSeenClock[0], viewer.lastSeenClock[1]),
  sessions: viewer.sessions,
  // Seed rows are the world-readable demo roster; gate registrations stay
  // admin-only (is_demo=false, the column default).
  is_demo: true,
}));

const inviteRows: Row[] = INVITES.map((invite) => {
  const invited = VIEWERS.find((viewer) => viewer.key === invite.invitedKey)!;
  return {
    id: uuidFromKey(`invite:${invite.key}`),
    inviter_viewer_id: uuidFromKey(`viewer:${invite.inviterKey}`),
    email: invited.email.toLowerCase(),
    invited_viewer_id: uuidFromKey(`viewer:${invite.invitedKey}`),
    created_at: at(invited.firstSeenDaysAgo, 9, 0),
  };
});

const completionRows: Row[] = [];

for (const viewer of VIEWERS) {
  const viewerId = uuidFromKey(`viewer:${viewer.key}`);
  const eligible = flagshipOrderKeys.filter((key) => !(viewer.skip ?? []).includes(key));
  const completedKeys = eligible.slice(0, viewer.completed);
  const completedSet = new Set(completedKeys);

  const start = Date.parse(at(viewer.firstSeenDaysAgo, 9, 0));
  const end = Date.parse(at(viewer.lastSeenDaysAgo, viewer.lastSeenClock[0], viewer.lastSeenClock[1]));

  completedKeys.forEach((videoKey, index) => {
    const video = videoByKey.get(videoKey)!;
    const jitter = hashId(`${viewer.key}:${videoKey}`);
    // Watch metadata: 0.86× to 1.45× of the duration (some rewatching).
    const watchSeconds = Math.round(video.duration * (0.86 + (jitter % 60) / 100));
    const completedAt = new Date(start + ((index + 1) * (end - start)) / (completedKeys.length + 1));
    const firstWatchedAt = new Date(completedAt.getTime() - watchSeconds * 1000 - (jitter % 45) * 60_000);
    completionRows.push({
      viewer_id: viewerId,
      video_id: video.id,
      watch_seconds: watchSeconds,
      first_watched_at: firstWatchedAt.toISOString(),
      completed_at: completedAt.toISOString(),
    });
  });

  if (viewer.startNext) {
    const nextKey = flagshipOrderKeys.find((key) => !completedSet.has(key));
    if (nextKey) {
      const video = videoByKey.get(nextKey)!;
      const jitter = hashId(`${viewer.key}:started:${nextKey}`);
      const watchSeconds = Math.round(video.duration * (0.3 + (jitter % 30) / 100));
      completionRows.push({
        viewer_id: viewerId,
        video_id: video.id,
        watch_seconds: watchSeconds,
        first_watched_at: new Date(end - 40 * 60_000).toISOString(),
        completed_at: null,
      });
    }
  }

  for (const extra of viewer.extras ?? []) {
    const video = videoByKey.get(extra.videoKey)!;
    const jitter = hashId(`${viewer.key}:extra:${extra.videoKey}`);
    const watchSeconds = extra.done
      ? Math.round(video.duration * (0.9 + (jitter % 50) / 100))
      : Math.round(video.duration * (0.3 + (jitter % 30) / 100));
    const moment = Date.parse(at(extra.daysAgo, 10 + (jitter % 6), jitter % 60));
    completionRows.push({
      viewer_id: viewerId,
      video_id: video.id,
      watch_seconds: watchSeconds,
      first_watched_at: new Date(moment - watchSeconds * 1000).toISOString(),
      completed_at: extra.done ? new Date(moment).toISOString() : null,
    });
  }
}

// ---------------------------------------------------------------------------
// Talk to Supabase
// ---------------------------------------------------------------------------

async function upsert(table: string, rows: Row[], onConflict: string) {
  const response = await fetch(`${baseUrl}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: { ...adminHeaders, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(rows),
  });
  if (!response.ok) {
    throw new Error(`${table} upsert failed: HTTP ${response.status} — ${(await response.text()).slice(0, 500)}`);
  }
  console.log(`✓ ${table}: upserted ${rows.length} rows`);
}

async function wipe(table: string, filter: string) {
  const response = await fetch(`${baseUrl}/rest/v1/${table}?${filter}`, {
    method: 'DELETE',
    headers: adminHeaders,
  });
  if (!response.ok) {
    throw new Error(`${table} wipe failed: HTTP ${response.status} — ${(await response.text()).slice(0, 500)}`);
  }
  console.log(`✗ ${table}: cleared`);
}

async function count(table: string, column: string): Promise<string> {
  const response = await fetch(`${baseUrl}/rest/v1/${table}?select=${column}`, {
    method: 'HEAD',
    headers: { ...adminHeaders, Prefer: 'count=exact', Range: '0-0' },
  });
  return response.headers.get('content-range')?.split('/')[1] ?? '?';
}

async function main() {
  const reset = process.argv.includes('--reset');
  if (reset) {
    console.log('Resetting ALL training data…');
    await wipe('training_completions', 'viewer_id=not.is.null');
    await wipe('training_invites', 'id=not.is.null');
    await wipe('training_learner_sessions', 'token=not.is.null');
    await wipe('training_viewers', 'id=not.is.null');
    await wipe('training_videos', 'id=not.is.null');
    await wipe('training_subgroups', 'id=not.is.null');
    await wipe('training_modules', 'id=not.is.null');
    await wipe('training_courses', 'id=not.is.null');
  }

  await upsert('training_courses', courseRows, 'id');
  await upsert('training_modules', moduleRows, 'id');
  await upsert('training_subgroups', subgroupRows, 'id');
  await upsert('training_videos', videoRows, 'id');
  await upsert('training_viewers', viewerRows, 'id');
  await upsert('training_invites', inviteRows, 'id');
  await upsert('training_completions', completionRows, 'viewer_id,video_id');

  console.log('\nRow counts now in Supabase:');
  for (const [table, column] of [
    ['training_courses', 'id'],
    ['training_modules', 'id'],
    ['training_subgroups', 'id'],
    ['training_videos', 'id'],
    ['training_viewers', 'id'],
    ['training_invites', 'id'],
    ['training_completions', 'viewer_id'],
  ] as const) {
    console.log(`  ${table}: ${await count(table, column)}`);
  }
  console.log(`\nSeed complete. Flagship published order: ${flagshipOrderKeys.length} videos.`);
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
