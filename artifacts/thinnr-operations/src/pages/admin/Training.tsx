/**
 * Training-course builder preview.
 *
 * Read-only mockup: it shows how HQ will assemble provider training (courses
 * → modules → lessons) without any authoring wired up. The preview banner and
 * the disabled-into-toast "New course" button keep that honest.
 */
import { BookOpen, ChevronDown, ListChecks, Play, Plus } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { BTN_PRIMARY, PANEL } from '@/components/patient/heritage';
import { AdminPage, CourseStatusChip, PageHeader, PreviewBanner } from '@/components/admin/primitives';
import { LESSON_KIND_LABELS, TRAINING_COURSES, type LessonKind, type TrainingCourse } from '@/data/hq/training';

const LESSON_ICONS: Record<LessonKind, React.ReactNode> = {
  video: <Play size={13} />,
  reading: <BookOpen size={13} />,
  checklist: <ListChecks size={13} />,
};

function CourseCard({ course }: { course: TrainingCourse }) {
  const lessonCount = course.modules.reduce((sum, module) => sum + module.lessons.length, 0);
  const totalMinutes = course.modules.reduce(
    (sum, module) => sum + module.lessons.reduce((inner, lesson) => inner + lesson.minutes, 0),
    0,
  );

  return (
    <section className="overflow-hidden rounded-lg border border-card-border bg-card shadow-soft" data-testid={`card-course-${course.id}`}>
      <div className="border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <CourseStatusChip status={course.status} />
          <span className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">{course.audience}</span>
        </div>
        <h2 className="mt-2 font-serif text-lg font-bold leading-snug tracking-[.01em] text-navy">{course.title}</h2>
        <p className="mt-1 max-w-[70ch] text-xs leading-relaxed text-muted-foreground">{course.description}</p>
        <p className="mt-2 text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
          {course.modules.length} modules · {lessonCount} lessons · {totalMinutes} min
        </p>
      </div>

      <div className="space-y-3 px-5 py-4">
        {course.modules.map((module, index) => (
          <details key={module.id} className={`${PANEL} group`} open={index === 0}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              <span className="min-w-0">
                <span className="block text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">Module {index + 1}</span>
                <span className="block truncate text-sm font-semibold text-navy">{module.title}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground">
                {module.lessons.length} lessons
                <ChevronDown size={14} className="transition group-open:rotate-180" aria-hidden="true" />
              </span>
            </summary>
            <ul className="border-t border-border">
              {module.lessons.map((lesson) => (
                <li key={lesson.id} className="flex items-center gap-3 border-b border-border px-4 py-2.5 text-xs last:border-b-0">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-sm bg-accent text-primary" aria-hidden="true">
                    {LESSON_ICONS[lesson.kind]}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-foreground">{lesson.title}</span>
                  <span className="shrink-0 text-[10px] font-bold uppercase tracking-[.06em] text-muted-foreground">
                    {LESSON_KIND_LABELS[lesson.kind]}
                  </span>
                  <span className="w-12 shrink-0 text-right text-[10px] text-muted-foreground">{lesson.minutes} min</span>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </div>
    </section>
  );
}

export default function Training() {
  const { toast } = useToast();

  return (
    <AdminPage>
      <PageHeader
        kicker="Enablement"
        title="Training courses"
        sub="How HQ packages onboarding and enablement for provider offices and internal teams."
        action={
          <button
            type="button"
            className={`${BTN_PRIMARY} h-9 px-3.5`}
            data-testid="button-new-course"
            onClick={() => toast({ title: 'Preview only', description: 'Course authoring arrives with the real training builder.' })}
          >
            <Plus size={14} aria-hidden="true" />
            New course
          </button>
        }
      />

      <PreviewBanner>
        This is a preview of the course builder — structure, lesson types, and timings are illustrative, and nothing here is
        editable yet.
      </PreviewBanner>

      <div className="space-y-5">
        {TRAINING_COURSES.map((course) => (
          <CourseCard key={course.id} course={course} />
        ))}
      </div>
    </AdminPage>
  );
}
