/**
 * Shared chrome for the training portal pages.
 *
 * Owned by the integrating agent so all six pages agree on: the section tab
 * bar, the editorial SlideFrame that stands in for real video frames, the
 * Live/Draft chip, and the mock "Generate with AI" content pools. Pages reuse
 * these instead of inventing their own.
 */
import type { ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { CHIP_COBALT, CHIP_WARM } from '@/components/patient/heritage';
import { AdminPage, PageHeader } from '@/components/admin/primitives';
import { formatClock, hashId, type TrainingChapter, type TrainingVideo } from '@/data/hq/training';

// ---------------------------------------------------------------------------
// Section tabs — Dashboard / Courses / Viewers / Analytics
// ---------------------------------------------------------------------------

const TABS = [
  { path: '/admin/training', label: 'Dashboard', exact: true },
  { path: '/admin/training/courses', label: 'Courses', exact: false },
  { path: '/admin/training/viewers', label: 'Viewers', exact: false },
  { path: '/admin/training/analytics', label: 'Analytics', exact: false },
];

export function TrainingTabs() {
  const [location] = useLocation();
  return (
    <nav
      aria-label="Training sections"
      className="mb-6 inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-md border border-border bg-secondary p-1"
    >
      {TABS.map((tab) => {
        const isActive = tab.exact ? location === tab.path : location.startsWith(tab.path);
        return (
          <Link
            key={tab.path}
            href={tab.path}
            aria-current={isActive ? 'page' : undefined}
            data-testid={`link-training-tab-${tab.label.toLowerCase()}`}
            className={`whitespace-nowrap rounded-sm px-3.5 py-1.5 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              isActive ? 'bg-card text-navy shadow-soft' : 'text-muted-foreground hover:text-navy'
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

interface TrainingSectionProps {
  title: ReactNode;
  sub?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}

/** Standard scaffold for the four top-level training pages. */
export function TrainingSection({ title, sub, action, children }: TrainingSectionProps) {
  return (
    <AdminPage>
      <PageHeader kicker="Enablement — Training" title={title} sub={sub} action={action} />
      <TrainingTabs />
      {children}
    </AdminPage>
  );
}

// ---------------------------------------------------------------------------
// Live / Draft chip (courses use "Live", not "Published")
// ---------------------------------------------------------------------------

export function CourseLiveChip({ status }: { status: 'live' | 'draft' }) {
  return status === 'live' ? <span className={CHIP_COBALT}>Live</span> : <span className={CHIP_WARM}>Draft</span>;
}

// ---------------------------------------------------------------------------
// SlideFrame — the mock "video frame"
// ---------------------------------------------------------------------------
//
// Training videos in this demo are editorial slide decks: each chapter maps
// to one typographic slide. SlideFrame renders that slide in Heritage style,
// so posters, players, thumbnails, and the scrub-to-frame picker all share
// one visual language. Palette is deterministic per video+chapter.

export type SlidePalette = 'cream' | 'navy' | 'cobalt';

const PALETTE_CLASSES: Record<SlidePalette, { root: string; kicker: string; rule: string; footer: string }> = {
  cream: {
    root: 'bg-card text-navy border border-card-border',
    kicker: 'text-muted-foreground',
    rule: 'bg-navy/20',
    footer: 'text-muted-foreground',
  },
  navy: {
    root: 'bg-navy text-[#fdfcf9]',
    kicker: 'text-[#fdfcf9]/60',
    rule: 'bg-[#fdfcf9]/25',
    footer: 'text-[#fdfcf9]/60',
  },
  cobalt: {
    root: 'bg-accent text-navy border border-accent-border',
    kicker: 'text-primary',
    rule: 'bg-primary/30',
    footer: 'text-primary',
  },
};

export function slidePaletteFor(videoId: string, chapterIndex: number): SlidePalette {
  const order: SlidePalette[] = ['cream', 'navy', 'cobalt'];
  return order[(hashId(videoId) + chapterIndex) % order.length]!;
}

interface SlideFrameProps {
  video: Pick<TrainingVideo, 'id' | 'title' | 'chapters' | 'duration'>;
  chapterIndex: number;
  className?: string;
  /** Compact hides the footer row (thumbnails, tiny previews). */
  compact?: boolean;
}

export function SlideFrame({ video, chapterIndex, className, compact = false }: SlideFrameProps) {
  const total = video.chapters.length;
  const safeIndex = Math.max(0, Math.min(chapterIndex, total - 1));
  const chapter: TrainingChapter | undefined = video.chapters[safeIndex];
  const palette = PALETTE_CLASSES[slidePaletteFor(video.id, safeIndex)];
  const number = String(safeIndex + 1).padStart(2, '0');
  return (
    <div
      className={`relative flex aspect-video w-full select-none flex-col justify-between overflow-hidden rounded-md p-[6%] ${palette.root} ${className ?? ''}`}
      data-testid={`slide-frame-${video.id}-${safeIndex}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className={`text-[max(8px,0.55em)] font-bold uppercase tracking-[.18em] ${palette.kicker}`}>
          THINNR · Office Training
        </span>
        {!compact && (
          <span className={`text-[max(8px,0.55em)] font-bold uppercase tracking-[.14em] ${palette.kicker}`}>
            {formatClock(chapter?.at ?? 0)}
          </span>
        )}
      </div>
      <div className="min-h-0">
        <p className="font-serif text-[2.6em] font-bold leading-none tracking-[-.02em] opacity-90">{number}</p>
        <div className={`mt-[0.5em] h-px w-[18%] ${palette.rule}`} aria-hidden="true" />
        <p className="mt-[0.5em] line-clamp-2 font-serif text-[1.15em] font-bold leading-snug tracking-[.005em]">
          {chapter?.title ?? video.title}
        </p>
      </div>
      {!compact && (
        <div className={`flex items-center justify-between gap-3 text-[max(8px,0.55em)] font-bold uppercase tracking-[.14em] ${palette.footer}`}>
          <span className="min-w-0 truncate">{video.title}</span>
          <span className="shrink-0">
            {number} / {String(total).padStart(2, '0')}
          </span>
        </div>
      )}
    </div>
  );
}

/** Chapter index whose slide should represent the video at time `seconds`. */
export function chapterIndexAt(video: Pick<TrainingVideo, 'chapters'>, seconds: number): number {
  let index = 0;
  video.chapters.forEach((chapter, i) => {
    if (chapter.at <= seconds) index = i;
  });
  return index;
}

// ---------------------------------------------------------------------------
// Mock "Generate with AI" pools — deterministic per variant, no network
// ---------------------------------------------------------------------------

const AI_DESCRIPTION_TEMPLATES: ((title: string) => string[])[] = [
  (title) => [
    `${title} — a step-by-step walkthrough recorded on the live THINNR operations desk. Follow along with demo data; nothing here can break your real office.`,
    'By the end your team will know the screen, the two mistakes everyone makes the first week, and the habit that prevents both.',
  ],
  (title) => [
    `What this covers: ${title.toLowerCase().replace(/\.$/, '')}, shown twice — once at full speed, once click by click.`,
    'Best watched with the operations desk open in a second window. The attached worksheet mirrors the on-screen steps.',
  ],
  (title) => [
    `A focused session on ${title.toLowerCase().replace(/\.$/, '')} for front-desk and care-team staff.`,
    'Offices that practice this within 48 hours of watching retain it dramatically better — schedule ten minutes with your team this week.',
  ],
];

export function aiDescription(title: string, variant: number): string[] {
  const template = AI_DESCRIPTION_TEMPLATES[Math.abs(variant) % AI_DESCRIPTION_TEMPLATES.length]!;
  return template(title);
}

const AI_CHAPTER_POOL = [
  'Cold open',
  'The one thing to remember',
  'Screen tour',
  'Watch me do it',
  'Now you try',
  'Pitfalls to avoid',
  'Speed round',
  'Where to go next',
];

export function aiChapters(video: Pick<TrainingVideo, 'id' | 'duration'>, variant: number): TrainingChapter[] {
  const count = Math.min(AI_CHAPTER_POOL.length, video.duration <= 300 ? 4 : video.duration <= 420 ? 5 : 6);
  const offset = Math.abs(variant + hashId(video.id)) % AI_CHAPTER_POOL.length;
  return Array.from({ length: count }, (_, i) => ({
    id: `${video.id}-aigen${variant}-${i + 1}`,
    at: Math.round((video.duration * i) / count),
    title: AI_CHAPTER_POOL[(offset + i) % AI_CHAPTER_POOL.length]!,
  }));
}
