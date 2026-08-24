/**
 * Static course catalog for the training-builder preview page.
 *
 * Mockup only: courses, modules, and lessons are viewable but not authorable
 * — the page is clearly labeled a preview. Lesson titles stay operational
 * (how to run the tools) and never make program or clinical claims.
 */

export type LessonKind = 'video' | 'reading' | 'checklist';

export interface TrainingLesson {
  id: string;
  title: string;
  kind: LessonKind;
  minutes: number;
}

export interface TrainingModule {
  id: string;
  title: string;
  lessons: TrainingLesson[];
}

export interface TrainingCourse {
  id: string;
  title: string;
  description: string;
  audience: string;
  status: 'published' | 'draft';
  modules: TrainingModule[];
}

export const TRAINING_COURSES: TrainingCourse[] = [
  {
    id: 'course-onboarding',
    title: 'Provider Onboarding Essentials',
    description: 'Everything a new office needs in its first two weeks — from workspace setup to the provider code patients type during mobile onboarding.',
    audience: 'New provider accounts',
    status: 'published',
    modules: [
      {
        id: 'mod-setup',
        title: 'Getting set up',
        lessons: [
          { id: 'l-tour', title: 'Welcome tour of the operations desk', kind: 'video', minutes: 6 },
          { id: 'l-profile', title: 'Complete your office profile', kind: 'checklist', minutes: 4 },
          { id: 'l-codes', title: 'Provider codes and patient linking', kind: 'reading', minutes: 5 },
        ],
      },
      {
        id: 'mod-frontdesk',
        title: 'Front desk basics',
        lessons: [
          { id: 'l-roster', title: 'Working the roster and check-ins', kind: 'video', minutes: 8 },
          { id: 'l-subs', title: 'Subscriptions and deliveries walkthrough', kind: 'video', minutes: 7 },
        ],
      },
      {
        id: 'mod-golive',
        title: 'Going live',
        lessons: [
          { id: 'l-launch', title: 'Launch-day checklist', kind: 'checklist', minutes: 5 },
          { id: 'l-demo-vs-live', title: 'Demo data vs live data', kind: 'reading', minutes: 4 },
        ],
      },
    ],
  },
  {
    id: 'course-coach',
    title: 'Coach Conversations for Care Teams',
    description: 'How office staff read coach transcripts, spot patients who need a human touchpoint, and hand off gracefully.',
    audience: 'Office care teams',
    status: 'published',
    modules: [
      {
        id: 'mod-reading',
        title: 'Reading a transcript',
        lessons: [
          { id: 'l-anatomy', title: 'Anatomy of a coach thread: cards and quick replies', kind: 'video', minutes: 5 },
          { id: 'l-tone', title: 'What supportive coaching sounds like', kind: 'reading', minutes: 6 },
        ],
      },
      {
        id: 'mod-stepin',
        title: 'When to step in',
        lessons: [
          { id: 'l-signals', title: 'Signals worth a call, not a chat', kind: 'checklist', minutes: 4 },
          { id: 'l-handoff', title: 'Handing off from coach to care team', kind: 'video', minutes: 6 },
        ],
      },
    ],
  },
  {
    id: 'course-reporting',
    title: 'THINNR HQ Reporting Deep Dive',
    description: 'For HQ analysts: how account metrics roll up, and how to read cross-account comparisons without fooling yourself.',
    audience: 'HQ staff',
    status: 'draft',
    modules: [
      {
        id: 'mod-account-metrics',
        title: 'Account metrics',
        lessons: [
          { id: 'l-metrics', title: 'The five numbers on every account card', kind: 'reading', minutes: 7 },
          { id: 'l-drill', title: 'Drilling into an office dashboard', kind: 'video', minutes: 9 },
        ],
      },
      {
        id: 'mod-rollups',
        title: 'Cross-account rollups',
        lessons: [
          { id: 'l-rollups', title: 'Why the umbrella totals always reconcile', kind: 'video', minutes: 8 },
        ],
      },
    ],
  },
];

export const LESSON_KIND_LABELS: Record<LessonKind, string> = {
  video: 'Video',
  reading: 'Reading',
  checklist: 'Checklist',
};
