import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useTrainingData } from '@/contexts/training-data';
import { countVideos, courseDuration, formatHours, type TrainingCourse } from '@/data/hq/training';
import {
  TrainingSection,
  TrainingLoading,
  TrainingLoadError,
  TrainingEmpty,
  CourseLiveChip,
} from '@/components/admin/training/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLASS } from '@/components/patient/heritage';
import { copyText } from '@/components/admin/primitives';
import { useToast } from '@/hooks/use-toast';
import { Link2, Plus } from 'lucide-react';

function courseDurationLabel(course: TrainingCourse): string {
  return formatHours(courseDuration(course));
}

function trainingShareUrl(course: TrainingCourse): string {
  return `/admin/training/preview/${course.id}`;
}

export default function TrainingCourses() {
  const { courses, addCourse, updateCourse, status, errorMessage, refresh } = useTrainingData();
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const [newCourseOpen, setNewCourseOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    if (!newTitle.trim() || creating) return;
    setCreating(true);
    try {
      const created = await addCourse({ title: newTitle.trim(), description: newDesc.trim() });
      if (!created) return;
      setNewCourseOpen(false);
      setNewTitle('');
      setNewDesc('');
      setLocation(`/admin/training/courses/${created.id}`);
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async (course: TrainingCourse) => {
    const url = `${window.location.origin}/admin/training/preview/${course.id}`;
    const landed = await copyText(url);
    toast(
      landed
        ? { title: 'Link copied', description: 'Anyone with this link gets the learner view while the course is live.' }
        : { title: 'Copy unavailable', description: 'Select the link text and copy it manually.' },
    );
  };

  const handleToggleLive = (course: TrainingCourse) => {
    if (course.status === 'live') {
      if (!window.confirm(`Unpublish "${course.title}"? Learners will immediately lose access.`)) return;
      void updateCourse(course.id, { status: 'draft' });
    } else {
      void updateCourse(course.id, { status: 'live' });
    }
  };

  return (
    <TrainingSection
      title="Courses"
      sub="Share a course link to give access — viewers unlock content by progressing through it."
      action={
        <button
          type="button"
          className={`${BTN_PRIMARY} h-9 px-3.5`}
          onClick={() => setNewCourseOpen(true)}
          data-testid="button-new-course"
        >
          <Plus size={14} aria-hidden="true" />
          New course
        </button>
      }
    >
      {status !== 'ready' ? (
        status === 'loading' ? (
          <TrainingLoading />
        ) : (
          <TrainingLoadError message={errorMessage} onRetry={refresh} />
        )
      ) : courses.length === 0 ? (
        <TrainingEmpty
          title="No courses yet"
          sub="Courses live in the database now — create the first one and it appears for every HQ admin, in any browser."
          action={
            <button
              type="button"
              className={`${BTN_PRIMARY} h-9 px-3.5`}
              onClick={() => setNewCourseOpen(true)}
              data-testid="button-empty-new-course"
            >
              <Plus size={14} aria-hidden="true" />
              New course
            </button>
          }
        />
      ) : (
        <>
          <div className="mb-4 text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground" data-testid="text-total-courses">
            {courses.length} course{courses.length === 1 ? '' : 's'}
          </div>

          <div className="grid gap-4">
            {courses.map((course) => {
              const isDraft = course.status === 'draft';
              return (
                <div
                  key={course.id}
                  className={`flex flex-col justify-between gap-4 rounded-lg border border-card-border bg-card p-5 shadow-soft md:flex-row md:items-start ${
                    isDraft ? 'opacity-80 grayscale-[20%]' : ''
                  }`}
                  data-testid={`row-course-${course.id}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-3">
                      <h3 className="font-serif text-[18px] font-bold tracking-[.01em] text-navy truncate">{course.title}</h3>
                      <CourseLiveChip status={course.status} />
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[13px] text-muted-foreground">
                      <span>{course.modules.length} modules</span>
                      <span>·</span>
                      <span>{countVideos(course, false)} videos</span>
                      <span>·</span>
                      <span>{courseDurationLabel(course)}</span>
                    </div>
                    <div className="mt-3 inline-flex items-center gap-1.5 rounded-sm bg-secondary px-2 py-1 font-mono text-[11px] text-muted-foreground">
                      <Link2 size={12} />
                      {trainingShareUrl(course)}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-3">
                    <button
                      type="button"
                      onClick={() => handleCopy(course)}
                      className="text-xs font-semibold text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
                      data-testid={`button-copy-${course.id}`}
                    >
                      Copy link
                    </button>
                    <button
                      type="button"
                      onClick={() => handleToggleLive(course)}
                      className="text-xs font-semibold text-foreground hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
                      data-testid={`button-toggle-${course.id}`}
                    >
                      {course.status === 'live' ? 'Unpublish' : 'Go live'}
                    </button>
                    <Link
                      href={`/admin/training/courses/${course.id}`}
                      className={`${BTN_SECONDARY} h-8 px-3`}
                      data-testid={`button-edit-${course.id}`}
                    >
                      Edit
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <Dialog open={newCourseOpen} onOpenChange={setNewCourseOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">New course</DialogTitle>
            <DialogDescription>
              Courses start as drafts — viewers can't see them until you go live.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-1.5">
              <label htmlFor="course-title" className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
                Title
              </label>
              <input
                id="course-title"
                className={INPUT_CLASS + ' h-9'}
                placeholder="e.g. Client Onboarding Mastery"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                data-testid="input-new-course-title"
              />
            </div>
            <div className="grid gap-1.5">
              <label htmlFor="course-desc" className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
                Description (optional)
              </label>
              <textarea
                id="course-desc"
                className={INPUT_CLASS + ' min-h-[80px] py-2'}
                placeholder="What this course covers"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                data-testid="input-new-course-desc"
              />
            </div>
          </div>
          <DialogFooter>
            <button
              type="button"
              className={`${BTN_SECONDARY} h-9 px-3.5`}
              onClick={() => setNewCourseOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className={`${BTN_PRIMARY} h-9 px-3.5`}
              onClick={handleCreate}
              disabled={!newTitle.trim() || creating}
              data-testid="button-create-course"
            >
              {creating ? 'Creating…' : 'Create course'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TrainingSection>
  );
}
