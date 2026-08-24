/**
 * Training portal data — courses, viewers, and every derived statistic.
 *
 * Mock-only: there is no server, no real video files, and no AI. The seeded
 * catalog below is the single source of truth; EVERY number shown anywhere in
 * the portal (dashboard stats, analytics funnels, retention curves, watch
 * times) is DERIVED from it by the helpers in this file, so the pages can
 * never disagree with each other. Viewer progress uses a prefix model — a
 * viewer has completed the first N published videos of the live course —
 * which matches sequential unlock and makes drop-off charts monotone by
 * construction.
 *
 * Dates are keys anchored to the fixed demo date (TODAY_KEY = 2026-08-22).
 * No viewer-clock math anywhere.
 */
import { TODAY_KEY } from '../nutrition-data';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PublishState = 'published' | 'draft';
export type UnlockMode = 'sequential' | 'free';
export type AddStaffMode = 'auto' | 'show' | 'hidden';

export interface TrainingChapter {
  id: string;
  /** Seconds from the start of the video. */
  at: number;
  title: string;
}

export interface TrainingAttachment {
  id: string;
  name: string;
  sizeLabel: string;
}

export interface TrainingVideo {
  id: string;
  title: string;
  /** Duration in seconds. */
  duration: number;
  published: PublishState;
  unlock: UnlockMode;
  addStaff: AddStaffMode;
  /** Plain paragraphs; the editor renders them as rich text. */
  description: string[];
  chapters: TrainingChapter[];
  /** Chapter index whose slide frame is the poster/thumbnail everywhere. */
  thumbnailChapter: number;
  attachments: TrainingAttachment[];
}

export interface TrainingSubgroup {
  id: string;
  /** Rendered as small-caps section header, e.g. "ROSTER WALKTHROUGH". */
  title: string;
  published: PublishState;
  unlock: UnlockMode;
  videos: TrainingVideo[];
}

export type ModuleEntry =
  | { kind: 'video'; video: TrainingVideo }
  | { kind: 'subgroup'; subgroup: TrainingSubgroup };

export interface TrainingModule {
  id: string;
  title: string;
  published: PublishState;
  unlock: UnlockMode;
  entries: ModuleEntry[];
}

export interface TrainingCourse {
  id: string;
  /** Share path: /training/<slug>. */
  slug: string;
  title: string;
  description: string;
  status: 'live' | 'draft';
  /** Course-level "Sequential unlock" badge. */
  sequentialUnlock: boolean;
  createdKey: string;
  modules: TrainingModule[];
}

export interface TrainingViewer {
  id: string;
  name: string;
  email: string;
  phone: string;
  /** Provider account this office learner belongs to; null = "No account". */
  accountId: string | null;
  /** Set when a learner added this person via the Add Staff button. */
  staffOfViewerId: string | null;
  location: string;
  firstSeenKey: string;
  lastSeenKey: string;
  /** Minutes after midnight ET for the last-seen timestamp. */
  lastSeenMinute: number;
  sessions: number;
  /**
   * Ids of the videos this viewer has COMPLETED. Progress is always derived
   * as |completedVideoIds ∩ current published order|, so reordering, moving,
   * publishing/unpublishing, and deleting videos stay truthful with no
   * reconciliation pass.
   */
  completedVideoIds: string[];
  /** 1 = additionally STARTED (not finished) the next uncompleted video. */
  startedExtra: 0 | 1;
  /** Rewatch multiplier for watch-time derivation (1 = watched once). */
  replay: number;
}

// ---------------------------------------------------------------------------
// Small deterministic utilities (no Math.random, no Date.now)
// ---------------------------------------------------------------------------

/** "10:48" → seconds. Keeps the seed readable. */
const dur = (clock: string): number => {
  const [m, s] = clock.split(':').map(Number);
  return m! * 60 + s!;
};

/** djb2 — stable tiny hash for palette/curve/chapter variation. */
export function hashId(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h;
}

export const formatClock = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  return `${m}:${String(rest).padStart(2, '0')}`;
};

/** 148500s → "41h 15m"; under an hour → "38m". */
export const formatHours = (seconds: number): string => {
  const totalMinutes = Math.round(seconds / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h <= 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-08-21" → "Aug 21" (or "Aug 21, 2025" for other years). */
export function formatDateKey(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const base = `${MONTHS[(m ?? 1) - 1]} ${d}`;
  return y === 2026 ? base : `${base}, ${y}`;
}

/** Minutes after midnight → "3:42 PM". */
export function formatMinute(minute: number): string {
  const h24 = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  const suffix = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** "Today · 3:42 PM ET" / "Aug 21 · 9:05 AM ET" — anchored, never clock-derived. */
export function formatLastSeen(viewer: Pick<TrainingViewer, 'lastSeenKey' | 'lastSeenMinute'>): string {
  const day = viewer.lastSeenKey === TODAY_KEY ? 'Today' : formatDateKey(viewer.lastSeenKey);
  return `${day} · ${formatMinute(viewer.lastSeenMinute)} ET`;
}

// ---------------------------------------------------------------------------
// Generated chapters for videos without hand-written ones
// ---------------------------------------------------------------------------

const CHAPTER_POOLS: string[][] = [
  ['What this covers', 'The setup', 'Live walkthrough', 'Where people slip', 'A worked example', 'Recap and next step'],
  ['Why this matters', 'The screen tour', 'Doing it for real', 'Common mistakes', 'Practice prompt', 'Wrap-up'],
  ['Starting point', 'Key terms', 'Step by step', 'Edge cases', 'Checklist moment', 'What comes next'],
  ['The goal', 'Before you start', 'The walkthrough', 'Troubleshooting', 'Pro habits', 'Recap'],
];

function generatedChapters(videoId: string, duration: number): TrainingChapter[] {
  const seed = hashId(videoId);
  const count = duration <= 260 ? 3 : duration <= 380 ? 4 : duration <= 480 ? 5 : 6;
  const pool = CHAPTER_POOLS[seed % CHAPTER_POOLS.length]!;
  const chapters: TrainingChapter[] = [];
  for (let i = 0; i < count; i++) {
    // Spread quasi-evenly with a deterministic jitter; chapter 1 is always 0:00.
    const base = (duration * i) / count;
    const jitter = i === 0 ? 0 : ((seed >> (i * 3)) % 21) - 10;
    chapters.push({
      id: `${videoId}-ch${i + 1}`,
      at: Math.max(0, Math.min(duration - 20, Math.round(base + jitter))),
      title: pool[i % pool.length]!,
    });
  }
  return chapters;
}

// ---------------------------------------------------------------------------
// Seed builders
// ---------------------------------------------------------------------------

let VIDEO_SEQ = 0;

interface VideoSeedOptions {
  published?: PublishState;
  unlock?: UnlockMode;
  addStaff?: AddStaffMode;
  description?: string[];
  chapters?: TrainingChapter[];
  thumbnailChapter?: number;
  attachments?: TrainingAttachment[];
}

function video(id: string, title: string, clock: string, options: VideoSeedOptions = {}): TrainingVideo {
  VIDEO_SEQ += 1;
  const duration = dur(clock);
  return {
    id,
    title,
    duration,
    published: options.published ?? 'published',
    unlock: options.unlock ?? 'sequential',
    // Only the very first seeded video defaults the Add Staff prompt to Auto.
    addStaff: options.addStaff ?? (VIDEO_SEQ === 1 ? 'auto' : 'auto'),
    description:
      options.description ?? [
        `A focused walkthrough of ${title.toLowerCase().replace(/\.$/, '')} — recorded on the live THINNR operations desk with demo data, so your team can follow along click for click.`,
        'Watch once end to end, then keep it open in a second window the first time you do this for real.',
      ],
    chapters: options.chapters ?? generatedChapters(id, duration),
    thumbnailChapter: options.thumbnailChapter ?? 0,
    attachments: options.attachments ?? [],
  };
}

const v = (entry: TrainingVideo): ModuleEntry => ({ kind: 'video', video: entry });
const sg = (id: string, title: string, videos: TrainingVideo[], unlock: UnlockMode = 'free'): ModuleEntry => ({
  kind: 'subgroup',
  subgroup: { id, title, published: 'published', unlock, videos },
});

// ---------------------------------------------------------------------------
// The flagship live course — THINNR Office Onboarding
// ---------------------------------------------------------------------------

const INTRO_CHAPTERS: TrainingChapter[] = [
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

const OVERVIEW_CHAPTERS: TrainingChapter[] = [
  { id: 'v2-2-ch1', at: 0, title: 'The four headline numbers' },
  { id: 'v2-2-ch2', at: 61, title: 'Revenue: recurring vs enrollment' },
  { id: 'v2-2-ch3', at: 148, title: 'Reading the trend chart' },
  { id: 'v2-2-ch4', at: 234, title: 'Protocol stages at a glance' },
  { id: 'v2-2-ch5', at: 331, title: 'When a number looks wrong' },
  { id: 'v2-2-ch6', at: 406, title: 'A daily 90-second routine' },
];

const SIGNUP_CHAPTERS: TrainingChapter[] = [
  { id: 'v3-2-ch1', at: 0, title: 'Before the patient arrives' },
  { id: 'v3-2-ch2', at: 55, title: 'Download and first open' },
  { id: 'v3-2-ch3', at: 132, title: 'The provider code moment' },
  { id: 'v3-2-ch4', at: 219, title: 'Birthday and goal weight' },
  { id: 'v3-2-ch5', at: 308, title: 'What patients see next' },
  { id: 'v3-2-ch6', at: 379, title: 'Troubleshooting sign-up' },
];

export const FLAGSHIP_COURSE_ID = 'course-office-onboarding';

function buildFlagshipCourse(): TrainingCourse {
  return {
    id: FLAGSHIP_COURSE_ID,
    slug: 'office-onboarding',
    title: 'THINNR Office Onboarding',
    description:
      'The complete ramp for a new provider office — from first sign-in on the operations desk to a confident launch week. Watch in order; modules unlock as your team progresses.',
    status: 'live',
    sequentialUnlock: true,
    createdKey: '2026-05-11',
    modules: [
      {
        id: 'm1',
        title: 'Welcome to THINNR',
        published: 'published',
        unlock: 'sequential',
        entries: [
          v(
            video('v1-1', 'Start here: how this training works', '10:48', {
              chapters: INTRO_CHAPTERS,
              thumbnailChapter: 3,
              addStaff: 'auto',
              description: [
                'Everything your office needs to get full value from this course: how modules unlock, how to add teammates, and what finishing unlocks for your practice.',
                'Offices that complete onboarding in their first two weeks consistently run smoother launch days — this video shows you the path.',
              ],
              attachments: [
                { id: 'att-welcome-1', name: 'Onboarding roadmap (one page).pdf', sizeLabel: '412 KB' },
                { id: 'att-welcome-2', name: 'Team roles worksheet.pdf', sizeLabel: '286 KB' },
              ],
            }),
          ),
          v(video('v1-2', 'The THINNR program at a glance', '6:24')),
          v(video('v1-3', 'Meet the operations desk', '7:05')),
          v(video('v1-4', 'Your provider code and why it matters', '4:41')),
          v(video('v1-5', 'Setting up your office profile', '5:33')),
        ],
      },
      {
        id: 'm2',
        title: 'The Operations Desk',
        published: 'published',
        unlock: 'sequential',
        entries: [
          v(video('v2-1', 'Desk tour: navigation and layout', '5:58')),
          v(video('v2-2', 'Reading the Overview numbers', '7:44', { chapters: OVERVIEW_CHAPTERS })),
          v(video('v2-3', 'Choosing and saving date ranges', '4:19')),
          sg('sg-roster', 'Roster walkthrough', [
            video('v2-4-1', 'Finding a patient fast', '3:52'),
            video('v2-4-2', 'Check-ins and status chips', '6:07'),
            video('v2-4-3', 'Sorting, filters, and saved views', '5:26'),
            video('v2-4-4', 'Editing patient details safely', '4:48'),
          ]),
          sg('sg-subs', 'Subscriptions walkthrough', [
            video('v2-5-1', 'Subscription states explained', '5:11'),
            video('v2-5-2', 'Pausing and resuming a plan', '4:02'),
            video('v2-5-3', 'Deliveries and what patients see', '6:31'),
          ]),
          sg('sg-leaderboard', 'Leaderboard & milestones', [
            video('v2-6-1', 'How the leaderboard ranks offices', '4:56'),
            video('v2-6-2', 'Celebrating milestones without oversharing', '3:37'),
          ]),
        ],
      },
      {
        id: 'm3',
        title: 'Patient App & Onboarding',
        published: 'published',
        unlock: 'sequential',
        entries: [
          v(video('v3-1', 'What patients see on day one', '6:12')),
          v(video('v3-2', 'Walking a patient through sign-up', '7:18', { chapters: SIGNUP_CHAPTERS })),
          v(video('v3-3', 'Birthday, goal weight, and provider code prompts', '4:27')),
          v(video('v3-4', "The food diary from the patient's side", '8:03')),
          v(video('v3-5', 'Approved foods and swaps', '5:44')),
          v(
            video('v3-6', 'Progress photos: capture and consent', '6:56', {
              attachments: [{ id: 'att-photo-1', name: 'Photo consent script.pdf', sizeLabel: '198 KB' }],
            }),
          ),
        ],
      },
      {
        id: 'm4',
        title: 'Coach & Conversations',
        published: 'published',
        unlock: 'sequential',
        entries: [
          v(video('v4-1', 'How the THINNR coach fits your care team', '6:38')),
          v(video('v4-2', 'Reading a coach transcript', '5:21')),
          v(video('v4-3', 'Recipe cards and quick replies', '4:44')),
          v(video('v4-4', 'When to step in with a human touch', '7:09')),
          v(video('v4-5', 'Handoffs your patients will thank you for', '5:02')),
        ],
      },
      {
        id: 'm5',
        title: 'Front Desk Playbook',
        published: 'published',
        unlock: 'sequential',
        entries: [
          v(
            video('v5-1', 'The first visit script', '6:47', {
              attachments: [{ id: 'att-script-1', name: 'First visit script (print).pdf', sizeLabel: '344 KB' }],
            }),
          ),
          v(video('v5-2', 'Weigh-ins that feel supportive', '5:36')),
          v(video('v5-3', 'Handling billing questions', '6:14')),
          v(video('v5-4', 'Reorders and delivery hiccups', '4:53')),
          v(video('v5-5', 'Difficult conversations, done kindly', '7:31')),
        ],
      },
      {
        id: 'm6',
        title: 'Go Live & Graduation',
        published: 'published',
        unlock: 'sequential',
        entries: [
          v(
            video('v6-1', 'Launch-week checklist', '5:17', {
              attachments: [{ id: 'att-launch-1', name: 'Launch-week checklist.pdf', sizeLabel: '251 KB' }],
            }),
          ),
          v(video('v6-2', 'Your first ten patients', '6:29')),
          v(video('v6-3', 'Demo data vs live data', '4:08')),
          // Draft: hidden from learners; admins still see it in the editor.
          v(video('v6-4', 'Graduation: what great looks like', '3:58', { published: 'draft' })),
        ],
      },
    ],
  };
}

/** Second, draft course — gives the Courses list a real Draft state. */
function buildDraftCourse(): TrainingCourse {
  return {
    id: 'course-hq-reporting',
    slug: 'hq-reporting-deep-dive',
    title: 'HQ Reporting Deep Dive',
    description:
      'For HQ analysts and multi-office owners: how account metrics roll up, and how to read cross-account comparisons without fooling yourself.',
    status: 'draft',
    sequentialUnlock: false,
    createdKey: '2026-08-03',
    modules: [
      {
        id: 'rm1',
        title: 'Account metrics',
        published: 'published',
        unlock: 'free',
        entries: [
          v(video('rv1-1', 'The five numbers on every account card', '6:41', { unlock: 'free' })),
          v(video('rv1-2', 'Drilling into an office dashboard', '8:22', { unlock: 'free' })),
          v(video('rv1-3', 'Comparing offices honestly', '7:15', { unlock: 'free' })),
        ],
      },
      {
        id: 'rm2',
        title: 'Cross-account rollups',
        published: 'draft',
        unlock: 'free',
        entries: [
          v(video('rv2-1', 'Why the umbrella totals always reconcile', '7:58', { unlock: 'free', published: 'draft' })),
          v(video('rv2-2', 'Exports and board-ready snapshots', '5:49', { unlock: 'free', published: 'draft' })),
        ],
      },
    ],
  };
}

export const SEEDED_COURSES: TrainingCourse[] = [buildFlagshipCourse(), buildDraftCourse()];

// ---------------------------------------------------------------------------
// Seeded viewers — office teams from each provider account
// ---------------------------------------------------------------------------

interface ViewerSeed {
  id: string;
  name: string;
  email: string;
  phone: string;
  accountId: string | null;
  staffOf?: string;
  location: string;
  firstSeenKey: string;
  lastSeenKey: string;
  lastSeenMinute: number;
  sessions: number;
  completed: number;
  startedExtra?: 0 | 1;
  replay: number;
}

/**
 * Progress values are over the live course's PUBLISHED video order (36
 * videos). Crafted funnel: nearly everyone starts, a visible cliff after
 * module 1 (video 5), a slow bleed through module 2, and exactly two
 * full-course completions.
 */
const VIEWER_SEEDS: ViewerSeed[] = [
  // — Jenkins Aesthetics & Wellness (acct-p1), Pasadena CA
  { id: 'vw-01', name: 'Maria Delgado', email: 'maria@jenkinswellness.example.com', phone: '(555) 301-4471', accountId: 'acct-p1', location: 'Pasadena, CA', firstSeenKey: '2026-06-02', lastSeenKey: '2026-08-22', lastSeenMinute: 9 * 60 + 12, sessions: 21, completed: 36, replay: 1.22 },
  { id: 'vw-02', name: 'Tanya Brooks', email: 'tanya@jenkinswellness.example.com', phone: '(555) 301-4488', accountId: 'acct-p1', staffOf: 'vw-01', location: 'Pasadena, CA', firstSeenKey: '2026-06-09', lastSeenKey: '2026-08-20', lastSeenMinute: 15 * 60 + 42, sessions: 14, completed: 26, replay: 1.08 },
  { id: 'vw-03', name: 'Alicia Fontaine', email: 'alicia@jenkinswellness.example.com', phone: '(555) 301-4493', accountId: 'acct-p1', location: 'Pasadena, CA', firstSeenKey: '2026-06-24', lastSeenKey: '2026-08-21', lastSeenMinute: 11 * 60 + 5, sessions: 12, completed: 20, replay: 1.15 },
  { id: 'vw-04', name: 'Jordan Pruitt', email: 'jordan@jenkinswellness.example.com', phone: '(555) 301-4429', accountId: 'acct-p1', staffOf: 'vw-01', location: 'Pasadena, CA', firstSeenKey: '2026-07-08', lastSeenKey: '2026-08-18', lastSeenMinute: 13 * 60 + 27, sessions: 9, completed: 14, replay: 1.0 },
  { id: 'vw-05', name: 'Sam Whitaker', email: 'sam@jenkinswellness.example.com', phone: '(555) 301-4436', accountId: 'acct-p1', location: 'Pasadena, CA', firstSeenKey: '2026-07-15', lastSeenKey: '2026-08-16', lastSeenMinute: 10 * 60 + 51, sessions: 7, completed: 9, replay: 1.05 },
  { id: 'vw-06', name: 'Renee Calloway', email: 'renee@jenkinswellness.example.com', phone: '(555) 301-4462', accountId: 'acct-p1', location: 'Pasadena, CA', firstSeenKey: '2026-07-29', lastSeenKey: '2026-08-12', lastSeenMinute: 16 * 60 + 4, sessions: 5, completed: 5, replay: 1.0 },
  { id: 'vw-07', name: 'Priya Natarajan', email: 'priya@jenkinswellness.example.com', phone: '(555) 301-4417', accountId: 'acct-p1', location: 'Pasadena, CA', firstSeenKey: '2026-08-05', lastSeenKey: '2026-08-19', lastSeenMinute: 14 * 60 + 33, sessions: 4, completed: 5, startedExtra: 1, replay: 1.02 },
  { id: 'vw-08', name: 'Evan Marsh', email: 'evan@jenkinswellness.example.com', phone: '(555) 301-4409', accountId: 'acct-p1', location: 'Pasadena, CA', firstSeenKey: '2026-08-14', lastSeenKey: '2026-08-15', lastSeenMinute: 9 * 60 + 47, sessions: 1, completed: 1, replay: 1.0 },

  // — Chen Metabolic Health (acct-p2), Austin TX
  { id: 'vw-09', name: 'Dana Kowalski', email: 'dana@chenmetabolic.example.com', phone: '(555) 442-8144', accountId: 'acct-p2', location: 'Austin, TX', firstSeenKey: '2026-05-27', lastSeenKey: '2026-08-22', lastSeenMinute: 8 * 60 + 26, sessions: 19, completed: 36, replay: 1.31 },
  { id: 'vw-10', name: 'Luis Herrera', email: 'luis@chenmetabolic.example.com', phone: '(555) 442-8127', accountId: 'acct-p2', location: 'Austin, TX', firstSeenKey: '2026-06-03', lastSeenKey: '2026-08-21', lastSeenMinute: 17 * 60 + 18, sessions: 15, completed: 30, replay: 1.12 },
  { id: 'vw-11', name: 'Bethany Cole', email: 'bethany@chenmetabolic.example.com', phone: '(555) 442-8195', accountId: 'acct-p2', staffOf: 'vw-09', location: 'Austin, TX', firstSeenKey: '2026-06-17', lastSeenKey: '2026-08-19', lastSeenMinute: 12 * 60 + 55, sessions: 11, completed: 22, replay: 1.04 },
  { id: 'vw-12', name: 'Marcus Reed', email: 'marcus@chenmetabolic.example.com', phone: '(555) 442-8168', accountId: 'acct-p2', location: 'Austin, TX', firstSeenKey: '2026-07-01', lastSeenKey: '2026-08-17', lastSeenMinute: 15 * 60 + 9, sessions: 8, completed: 15, replay: 1.0 },
  { id: 'vw-13', name: 'Iris Tanaka', email: 'iris@chenmetabolic.example.com', phone: '(555) 442-8181', accountId: 'acct-p2', staffOf: 'vw-09', location: 'Austin, TX', firstSeenKey: '2026-07-13', lastSeenKey: '2026-08-20', lastSeenMinute: 10 * 60 + 2, sessions: 7, completed: 11, replay: 1.18 },
  { id: 'vw-14', name: 'Colby Franks', email: 'colby@chenmetabolic.example.com', phone: '(555) 442-8112', accountId: 'acct-p2', location: 'Austin, TX', firstSeenKey: '2026-07-27', lastSeenKey: '2026-08-09', lastSeenMinute: 13 * 60 + 44, sessions: 4, completed: 5, replay: 1.0 },
  { id: 'vw-15', name: 'Shreya Patel', email: 'shreya@chenmetabolic.example.com', phone: '(555) 442-8109', accountId: 'acct-p2', location: 'Austin, TX', firstSeenKey: '2026-08-10', lastSeenKey: '2026-08-22', lastSeenMinute: 11 * 60 + 38, sessions: 3, completed: 4, startedExtra: 1, replay: 1.0 },

  // — Rostova Wellness Collective (acct-p3), Miami FL
  { id: 'vw-16', name: 'Camille Duval', email: 'camille@rostovawellness.example.com', phone: '(555) 218-7791', accountId: 'acct-p3', location: 'Miami, FL', firstSeenKey: '2026-06-10', lastSeenKey: '2026-08-21', lastSeenMinute: 9 * 60 + 58, sessions: 16, completed: 33, replay: 1.09 },
  { id: 'vw-17', name: 'Rosa Jimenez', email: 'rosa@rostovawellness.example.com', phone: '(555) 218-7738', accountId: 'acct-p3', location: 'Miami, FL', firstSeenKey: '2026-06-22', lastSeenKey: '2026-08-18', lastSeenMinute: 16 * 60 + 21, sessions: 12, completed: 24, replay: 1.06 },
  { id: 'vw-18', name: 'Nate Okafor', email: 'nate@rostovawellness.example.com', phone: '(555) 218-7754', accountId: 'acct-p3', staffOf: 'vw-16', location: 'Miami, FL', firstSeenKey: '2026-07-06', lastSeenKey: '2026-08-14', lastSeenMinute: 14 * 60 + 16, sessions: 9, completed: 17, replay: 1.0 },
  { id: 'vw-19', name: 'Yuri Melnyk', email: 'yuri@rostovawellness.example.com', phone: '(555) 218-7769', accountId: 'acct-p3', location: 'Miami, FL', firstSeenKey: '2026-07-20', lastSeenKey: '2026-08-11', lastSeenMinute: 12 * 60 + 7, sessions: 6, completed: 8, replay: 1.11 },
  { id: 'vw-20', name: 'Sofia Barros', email: 'sofia@rostovawellness.example.com', phone: '(555) 218-7723', accountId: 'acct-p3', location: 'Miami, FL', firstSeenKey: '2026-08-03', lastSeenKey: '2026-08-13', lastSeenMinute: 15 * 60 + 52, sessions: 3, completed: 5, replay: 1.0 },
  { id: 'vw-21', name: 'Deja Coleman', email: 'deja@rostovawellness.example.com', phone: '(555) 218-7716', accountId: 'acct-p3', location: 'Miami, FL', firstSeenKey: '2026-08-12', lastSeenKey: '2026-08-22', lastSeenMinute: 10 * 60 + 24, sessions: 2, completed: 2, startedExtra: 1, replay: 1.0 },

  // — Kim Vitality Clinic (acct-p4), Seattle WA
  { id: 'vw-22', name: 'Hannah Cho', email: 'hannah@kimvitality.example.com', phone: '(555) 674-2248', accountId: 'acct-p4', location: 'Seattle, WA', firstSeenKey: '2026-06-29', lastSeenKey: '2026-08-20', lastSeenMinute: 13 * 60 + 3, sessions: 13, completed: 28, replay: 1.14 },
  { id: 'vw-23', name: 'Miles Turner', email: 'miles@kimvitality.example.com', phone: '(555) 674-2273', accountId: 'acct-p4', location: 'Seattle, WA', firstSeenKey: '2026-07-09', lastSeenKey: '2026-08-16', lastSeenMinute: 11 * 60 + 49, sessions: 8, completed: 13, replay: 1.0 },
  { id: 'vw-24', name: 'Grace Yoon', email: 'grace@kimvitality.example.com', phone: '(555) 674-2216', accountId: 'acct-p4', staffOf: 'vw-22', location: 'Seattle, WA', firstSeenKey: '2026-07-22', lastSeenKey: '2026-08-08', lastSeenMinute: 9 * 60 + 31, sessions: 5, completed: 6, replay: 1.03 },
  { id: 'vw-25', name: 'Owen Fletcher', email: 'owen@kimvitality.example.com', phone: '(555) 674-2287', accountId: 'acct-p4', location: 'Seattle, WA', firstSeenKey: '2026-08-06', lastSeenKey: '2026-08-07', lastSeenMinute: 14 * 60 + 58, sessions: 1, completed: 1, startedExtra: 1, replay: 1.0 },

  // — Entered the email gate, no account assigned yet
  { id: 'vw-26', name: 'Kelly Draper', email: 'kelly.draper@example.com', phone: '(555) 903-1174', accountId: null, location: 'Boise, ID', firstSeenKey: '2026-08-15', lastSeenKey: '2026-08-17', lastSeenMinute: 12 * 60 + 40, sessions: 2, completed: 2, replay: 1.0 },
  { id: 'vw-27', name: 'Tom Sinclair', email: 'tom.sinclair@example.com', phone: '(555) 772-3049', accountId: null, location: 'Denver, CO', firstSeenKey: '2026-08-19', lastSeenKey: '2026-08-19', lastSeenMinute: 16 * 60 + 44, sessions: 1, completed: 0, startedExtra: 1, replay: 1.0 },
  { id: 'vw-28', name: 'Ava Lindqvist', email: 'ava.lindqvist@example.com', phone: '(555) 615-8820', accountId: null, location: 'Portland, OR', firstSeenKey: '2026-08-21', lastSeenKey: '2026-08-21', lastSeenMinute: 8 * 60 + 17, sessions: 1, completed: 0, replay: 1.0 },
];

// Seed progress values are prefix counts over the flagship's published order
// (readable in VIEWER_SEEDS); they materialize into explicit video-id sets.
const SEED_ORDER_IDS = getOrderedVideos(
  SEEDED_COURSES.find((course) => course.id === FLAGSHIP_COURSE_ID)!,
  true,
).map((item) => item.video.id);

export const SEEDED_VIEWERS: TrainingViewer[] = VIEWER_SEEDS.map((seed) => ({
  id: seed.id,
  name: seed.name,
  email: seed.email,
  phone: seed.phone,
  accountId: seed.accountId,
  staffOfViewerId: seed.staffOf ?? null,
  location: seed.location,
  firstSeenKey: seed.firstSeenKey,
  lastSeenKey: seed.lastSeenKey,
  lastSeenMinute: seed.lastSeenMinute,
  sessions: seed.sessions,
  completedVideoIds: SEED_ORDER_IDS.slice(0, seed.completed),
  startedExtra: seed.startedExtra ?? 0,
  replay: seed.replay,
}));

// ---------------------------------------------------------------------------
// Course structure helpers
// ---------------------------------------------------------------------------

export interface OrderedVideo {
  video: TrainingVideo;
  module: TrainingModule;
  subgroup: TrainingSubgroup | null;
  /** 1-based order among the course's published videos (analytics rows). */
  position: number;
  /** Display numbering: "1.2" or "2.4.1". */
  numbering: string;
}

/**
 * Flattened course order. `publishedOnly` (learner/analytics view) skips
 * draft modules, subgroups, and videos; the admin editor passes false.
 * Numbering counts every entry the ADMIN sees so it matches the editor.
 */
export function getOrderedVideos(course: TrainingCourse, publishedOnly = true): OrderedVideo[] {
  const out: OrderedVideo[] = [];
  let position = 0;
  course.modules.forEach((module, moduleIndex) => {
    if (publishedOnly && module.published !== 'published') return;
    module.entries.forEach((entry, entryIndex) => {
      const base = `${moduleIndex + 1}.${entryIndex + 1}`;
      if (entry.kind === 'video') {
        if (publishedOnly && entry.video.published !== 'published') return;
        position += 1;
        out.push({ video: entry.video, module, subgroup: null, position, numbering: base });
      } else {
        if (publishedOnly && entry.subgroup.published !== 'published') return;
        entry.subgroup.videos.forEach((videoItem, videoIndex) => {
          if (publishedOnly && videoItem.published !== 'published') return;
          position += 1;
          out.push({
            video: videoItem,
            module,
            subgroup: entry.subgroup,
            position,
            numbering: `${base}.${videoIndex + 1}`,
          });
        });
      }
    });
  });
  return out;
}

export function countVideos(course: TrainingCourse, publishedOnly = false): number {
  return getOrderedVideos(course, publishedOnly).length;
}

export function courseDuration(course: TrainingCourse, publishedOnly = false): number {
  return getOrderedVideos(course, publishedOnly).reduce((sum, item) => sum + item.video.duration, 0);
}

export interface VideoLocation extends OrderedVideo {
  course: TrainingCourse;
}

/** Find a video (published or draft) anywhere in a course. */
export function findVideoInCourse(course: TrainingCourse, videoId: string): VideoLocation | null {
  const all = getOrderedVideos(course, false);
  const hit = all.find((item) => item.video.id === videoId);
  return hit ? { ...hit, course } : null;
}

// ---------------------------------------------------------------------------
// Derived statistics — every page reads these, nobody hand-computes
// ---------------------------------------------------------------------------

/** Seconds a viewer has watched, derived from completed videos and replay. */
export function viewerWatchSeconds(viewer: TrainingViewer, order: OrderedVideo[]): number {
  const done = new Set(viewer.completedVideoIds);
  let base = 0;
  for (const item of order) if (done.has(item.video.id)) base += item.video.duration;
  const frontier = frontierIndex(viewer, order);
  if (viewer.startedExtra === 1 && frontier < order.length) {
    base += Math.round(order[frontier]!.video.duration * 0.45);
  }
  return Math.round(base * viewer.replay);
}

export function viewerStartedCount(viewer: TrainingViewer, order: OrderedVideo[]): number {
  return Math.min(order.length, completedCount(viewer, order) + viewer.startedExtra);
}

/** Videos from `order` this viewer has completed (id-set intersection). */
export function completedCount(viewer: TrainingViewer, order: OrderedVideo[]): number {
  const done = new Set(viewer.completedVideoIds);
  let count = 0;
  for (const item of order) if (done.has(item.video.id)) count += 1;
  return count;
}

export function isVideoCompletedBy(viewer: TrainingViewer, videoId: string): boolean {
  return viewer.completedVideoIds.includes(videoId);
}

/** Index of the first uncompleted video in `order`; order.length when done. */
export function frontierIndex(viewer: TrainingViewer, order: OrderedVideo[]): number {
  const done = new Set(viewer.completedVideoIds);
  for (let i = 0; i < order.length; i++) if (!done.has(order[i]!.video.id)) return i;
  return order.length;
}

/** Did this viewer start (complete, or partially watch) this ordered video? */
export function viewerStartedVideo(viewer: TrainingViewer, order: OrderedVideo[], index: number): boolean {
  const item = order[index];
  if (!item) return false;
  if (viewer.completedVideoIds.includes(item.video.id)) return true;
  return viewer.startedExtra === 1 && frontierIndex(viewer, order) === index;
}

/**
 * Unlock resolution across the hierarchy: marking a module or sub-group
 * "free" frees every video inside it; otherwise the video's own mode wins.
 */
export function effectiveUnlock(item: OrderedVideo): UnlockMode {
  if (item.video.unlock === 'free') return 'free';
  if (item.subgroup && item.subgroup.unlock === 'free') return 'free';
  if (item.module.unlock === 'free') return 'free';
  return 'sequential';
}

export interface TrainingTotals {
  totalViewers: number;
  newViewersThisWeek: number;
  totalWatchSeconds: number;
  totalSessions: number;
  videoCompletions: number;
  fullCourseCompletions: number;
  libraryVideoCount: number;
  libraryDuration: number;
}

export function getTrainingTotals(courses: TrainingCourse[], viewers: TrainingViewer[]): TrainingTotals {
  const live = courses.find((course) => course.id === FLAGSHIP_COURSE_ID) ?? courses[0]!;
  const order = getOrderedVideos(live, true);
  const weekAgoKey = '2026-08-15'; // TODAY_KEY minus 7 — fixed, like everything else.
  return {
    totalViewers: viewers.length,
    newViewersThisWeek: viewers.filter((viewer) => viewer.firstSeenKey > weekAgoKey).length,
    totalWatchSeconds: viewers.reduce((sum, viewer) => sum + viewerWatchSeconds(viewer, order), 0),
    totalSessions: viewers.reduce((sum, viewer) => sum + viewer.sessions, 0),
    videoCompletions: viewers.reduce((sum, viewer) => sum + completedCount(viewer, order), 0),
    fullCourseCompletions: viewers.filter((viewer) => order.length > 0 && completedCount(viewer, order) === order.length).length,
    libraryVideoCount: courses.reduce((sum, course) => sum + countVideos(course, false), 0),
    libraryDuration: courses.reduce((sum, course) => sum + courseDuration(course, false), 0),
  };
}

export interface VideoStat extends OrderedVideo {
  started: number;
  completedCount: number;
  /** completed / population, in percent (0-100, one decimal). */
  pctOfPopulation: number;
  /** Drop vs previous video in percentage points; null = first video. */
  dropPts: number | null;
  watchSeconds: number;
}

export interface CourseAnalytics {
  order: OrderedVideo[];
  stats: VideoStat[];
  /** Viewers who started at least one video. */
  population: number;
  avgCompletionPct: number;
  avgWatchSecondsPerViewer: number;
  finished: number;
  finishedPct: number;
  biggestDrop: { stat: VideoStat; pts: number } | null;
  /** Histogram buckets of how far viewers get (population only). */
  buckets: { label: string; count: number }[];
  avgCompletionSeconds: number;
  activeViewers: number;
  totalWatchSeconds: number;
}

export function getCourseAnalytics(course: TrainingCourse, viewers: TrainingViewer[]): CourseAnalytics {
  const order = getOrderedVideos(course, true);
  const n = order.length;
  const startedOf = (viewer: TrainingViewer) => viewerStartedCount(viewer, order);
  const populationViewers = viewers.filter((viewer) => startedOf(viewer) >= 1);
  const population = populationViewers.length;

  const stats: VideoStat[] = order.map((item, index) => {
    const started = populationViewers.filter((viewer) => viewerStartedVideo(viewer, order, index)).length;
    const completedHere = populationViewers.filter((viewer) => isVideoCompletedBy(viewer, item.video.id)).length;
    const pct = population > 0 ? (completedHere / population) * 100 : 0;
    const watchSeconds = Math.round(
      populationViewers.reduce(
        (sum, viewer) => sum + (viewerStartedVideo(viewer, order, index) ? item.video.duration * viewer.replay * 0.92 : 0),
        0,
      ),
    );
    return {
      ...item,
      started,
      completedCount: completedHere,
      pctOfPopulation: Math.round(pct * 10) / 10,
      dropPts: null, // filled below
      watchSeconds,
    };
  });
  for (let i = 1; i < stats.length; i++) {
    const drop = Math.round((stats[i - 1]!.pctOfPopulation - stats[i]!.pctOfPopulation) * 10) / 10;
    stats[i]!.dropPts = drop;
  }

  let biggestDrop: CourseAnalytics['biggestDrop'] = null;
  for (const stat of stats) {
    if (stat.dropPts !== null && (biggestDrop === null || stat.dropPts > biggestDrop.pts)) {
      biggestDrop = { stat, pts: stat.dropPts };
    }
  }

  const completionPcts = populationViewers.map((viewer) => (completedCount(viewer, order) / Math.max(1, n)) * 100);
  const avgCompletionPct =
    population > 0 ? Math.round((completionPcts.reduce((sum, value) => sum + value, 0) / population) * 10) / 10 : 0;

  const totalWatchSeconds = viewers.reduce((sum, viewer) => sum + viewerWatchSeconds(viewer, order), 0);
  const finishedViewers = populationViewers.filter((viewer) => completedCount(viewer, order) >= n);

  // "Time to complete" — derived wall-clock span between first and last seen
  // for finishers, expressed in watch-session hours (mock but stable).
  const avgCompletionSeconds =
    finishedViewers.length > 0
      ? Math.round(
          finishedViewers.reduce((sum, viewer) => sum + viewerWatchSeconds(viewer, order) * 5.4, 0) /
            finishedViewers.length,
        )
      : 0;

  const bucketDefs = [
    { label: '1-25%', min: 0.0001, max: 25 },
    { label: '26-50%', min: 25.0001, max: 50 },
    { label: '51-75%', min: 50.0001, max: 75 },
    { label: '76-99%', min: 75.0001, max: 99.9999 },
    { label: '100%', min: 99.9999, max: 1000 },
  ];
  const buckets = bucketDefs.map((def) => ({
    label: def.label,
    count: completionPcts.filter((value) => value >= def.min && value <= def.max).length,
  }));

  return {
    order,
    stats,
    population,
    avgCompletionPct,
    // Labeled "across active viewers" in Analytics — denominator must be the
    // active population, not the whole roster.
    avgWatchSecondsPerViewer: population > 0 ? Math.round(totalWatchSeconds / population) : 0,
    finished: finishedViewers.length,
    finishedPct: population > 0 ? Math.round((finishedViewers.length / population) * 1000) / 10 : 0,
    biggestDrop,
    buckets,
    avgCompletionSeconds,
    activeViewers: population,
    totalWatchSeconds,
  };
}

/** Top videos by derived watch time — dashboard "most watched". */
export function getMostWatched(course: TrainingCourse, viewers: TrainingViewer[], limit = 5): VideoStat[] {
  const { stats } = getCourseAnalytics(course, viewers);
  return [...stats].sort((a, b) => b.watchSeconds - a.watchSeconds).slice(0, limit);
}

/** Viewers sorted by most recent activity — dashboard "recent viewers". */
export function getRecentViewers(viewers: TrainingViewer[], limit = 6): TrainingViewer[] {
  return [...viewers]
    .sort((a, b) =>
      a.lastSeenKey === b.lastSeenKey ? b.lastSeenMinute - a.lastSeenMinute : a.lastSeenKey < b.lastSeenKey ? 1 : -1,
    )
    .slice(0, limit);
}

/**
 * Per-video retention curve for the editor: percentage of the video's
 * audience still watching at each 5% mark. Deterministic from the video id;
 * steeper dips land just after 2-3 pseudo-chapter moments.
 */
export function getRetentionCurve(videoItem: TrainingVideo): { t: number; pct: number }[] {
  const seed = hashId(videoItem.id);
  const endPct = 34 + (seed % 38); // finishes between 34% and 71%
  const dipCount = 2 + (seed % 2);
  const dips = Array.from({ length: dipCount }, (_, i) => 0.18 + ((seed >> (i * 5)) % 55) / 100);
  const points: { t: number; pct: number }[] = [];
  for (let step = 0; step <= 20; step++) {
    const progress = step / 20;
    let pct = 100 - (100 - endPct) * Math.pow(progress, 1.25);
    for (const dip of dips) {
      if (progress >= dip) pct -= 4.5 * Math.min(1, (progress - dip) * 12);
    }
    const wobble = (((seed >> step) & 3) - 1.5) * 0.6;
    points.push({ t: Math.round(progress * videoItem.duration), pct: Math.max(8, Math.round((pct + wobble) * 10) / 10) });
  }
  // First sample is always everyone.
  points[0] = { t: 0, pct: 100 };
  return points;
}

export const ADD_STAFF_LABELS: Record<AddStaffMode, string> = {
  auto: 'Auto',
  show: 'Show on this video',
  hidden: 'Hidden',
};

export const UNLOCK_LABELS: Record<UnlockMode, string> = {
  sequential: 'Sequential',
  free: 'Open',
};

// ---------------------------------------------------------------------------
// Authoring + progress helpers
//
// Pure functions the training context wraps in setState — kept out of the
// React layer so scripts/verify-training.ts can exercise them directly.
// ---------------------------------------------------------------------------

const slugifyTitle = (title: string): string =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';

/** Every id in use across courses, modules, sub-groups, and videos. */
export function collectIds(courses: TrainingCourse[]): Set<string> {
  const ids = new Set<string>();
  for (const course of courses) {
    ids.add(course.id);
    for (const module of course.modules) {
      ids.add(module.id);
      for (const entry of module.entries) {
        if (entry.kind === 'video') ids.add(entry.video.id);
        else {
          ids.add(entry.subgroup.id);
          for (const videoItem of entry.subgroup.videos) ids.add(videoItem.id);
        }
      }
    }
  }
  return ids;
}

export function nextFreeId(prefix: string, taken: Set<string>): string {
  for (let i = 1; ; i++) {
    const candidate = `${prefix}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Build a new draft course with a starter module. Pure and built BEFORE
 * setState: React may defer functional updaters, so a value smuggled out of
 * one is not reliably populated by the time the mutation returns.
 */
export function buildNewCourse(
  courses: TrainingCourse[],
  input: { title: string; description: string },
): TrainingCourse {
  const taken = collectIds(courses);
  const id = nextFreeId('course-new', taken);
  return {
    id,
    slug: slugifyTitle(input.title),
    title: input.title,
    description: input.description,
    status: 'draft',
    sequentialUnlock: true,
    createdKey: TODAY_KEY,
    modules: [
      { id: `${id}-m1`, title: 'Module 1', published: 'published', unlock: 'sequential', entries: [] },
    ],
  };
}

/** Build a new module with an id no existing course uses. Pure — call before setState. */
export function buildNewModule(courses: TrainingCourse[], title: string): TrainingModule {
  const taken = collectIds(courses);
  return { id: nextFreeId('mod-new', taken), title, published: 'published', unlock: 'sequential', entries: [] };
}

/** Build a new draft video with the mock "auto-encoded" duration + chapters. */
export function buildNewVideo(courses: TrainingCourse[], title: string): TrainingVideo {
  const taken = collectIds(courses);
  const id = nextFreeId('vid-new', taken);
  const duration = 180 + (hashId(`${id}:${title}`) % 300);
  const chapterCount = 4;
  return {
    id,
    title,
    duration,
    published: 'draft',
    unlock: 'sequential',
    addStaff: 'auto',
    description: [
      `Auto-generated summary: ${title}. Replace this with your own notes, or regenerate it once the final cut is uploaded.`,
    ],
    chapters: Array.from({ length: chapterCount }, (_, i) => ({
      id: `${id}-ch${i + 1}`,
      at: Math.round((duration * i) / chapterCount),
      title: ['Intro', 'Walkthrough', 'Details', 'Wrap-up'][i]!,
    })),
    thumbnailChapter: 0,
    attachments: [],
  };
}

