/**
 * Office Training — the provider office's window into THINNR enablement.
 *
 * Reads the same live training snapshot as the HQ portal, scoped to this
 * office: a "My training" card for the signed-in staffer's own progress,
 * the live course catalog, and the team roster with per-person progress.
 * Provider staff (and HQ admins drilled into an office) can add teammates
 * here — the add pre-approves the email for staff sign-up under this office
 * and puts them on the roster immediately; no invite email is sent.
 *
 * The unscoped demo office browses read-only across every office learner,
 * mirroring how the rest of the office demo shows program-wide singletons.
 */
import { useMemo, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { ArrowRight, CheckCircle2, ChevronRight, GraduationCap, Plus } from 'lucide-react';
import { useTrainingData } from '@/contexts/training-data';
import { useProviderScope } from '@/contexts/provider-scope';
import { useSession } from '@/contexts/session';
import { officeLensViewers } from '@/lib/training-lens';
import { useToast } from '@/hooks/use-toast';
import { findSeededAccount } from '@/data/hq/accounts';
import {
  completionsFor,
  countVideos,
  courseDuration,
  formatClock,
  formatHours,
  formatLastSeen,
  getOrderedVideos,
  type TrainingCourse,
} from '@/data/hq/training';
import { officeCourseStats, officeRoster, selfCourseState } from '@/data/office-training';
import { TrainingLoading, TrainingLoadError } from '@/components/admin/training/shared';
import { BTN_PRIMARY, CHIP_COBALT, INPUT_CLASS, MICRO_LABEL, SectionCard } from '@/components/patient/heritage';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** Page frame — office pages pad themselves; same rhythm as the other screens. */
const PAGE_WRAP = 'mx-auto max-w-[1320px] space-y-6 px-4 py-6 sm:px-5 sm:py-7 md:px-8';

export default function OfficeTraining() {
  const {
    status,
    errorMessage,
    refresh,
    courses,
    viewers,
    completionIndex,
    myViewer,
    canAddStaff,
    addStaffMember,
    markMyVideoComplete,
  } = useTrainingData();
  const scope = useProviderScope();
  const { authStatus, authRole, providerAccountCode } = useSession();
  const { toast } = useToast();
  // Base-aware navigate — resolves against the mount point exactly like the
  // Link component, so roster rows work standalone and under the HQ drill-in.
  const [, navigate] = useLocation();

  // Scope resolution: HQ drill-in and matched staff sign-ins arrive with a
  // provider scope; a staff sign-in whose office is not a seeded account
  // still filters by their assigned code; the demo persona stays unscoped.
  const accountId =
    scope?.id ??
    (authStatus === 'signed-in' && authRole === 'provider_staff' ? providerAccountCode : null);
  const officeName =
    scope?.officeName ?? (accountId ? (findSeededAccount(accountId)?.officeName ?? null) : null);

  const liveCourses = useMemo(
    () => courses.filter((course) => course.status === 'live'),
    [courses],
  );
  const primaryCourse = liveCourses[0] ?? null;
  const primaryOrder = useMemo(
    () => (primaryCourse ? getOrderedVideos(primaryCourse, true) : []),
    [primaryCourse],
  );
  const signedIn = authStatus === 'signed-in';
  const lensViewers = useMemo(
    () => officeLensViewers(viewers, { signedIn, accountId, selfViewerId: myViewer?.id ?? null }),
    [viewers, signedIn, accountId, myViewer],
  );
  const roster = useMemo(
    () => officeRoster(lensViewers, accountId, primaryOrder, completionIndex, myViewer?.id ?? null),
    [lensViewers, accountId, primaryOrder, completionIndex, myViewer],
  );
  const teamStats = useMemo(() => officeCourseStats(roster), [roster]);
  const self = useMemo(
    () =>
      primaryCourse && myViewer
        ? selfCourseState(primaryCourse, completionsFor(completionIndex, myViewer.id))
        : null,
    [primaryCourse, myViewer, completionIndex],
  );

  const [dialogOpen, setDialogOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [marking, setMarking] = useState(false);

  const openAddTeammate = () => {
    if (!canAddStaff) {
      toast(
        signedIn
          ? {
              title: 'You can’t add teammates',
              description: 'Your sign-in can view this office’s training but not add people to it.',
            }
          : {
              title: 'Sign in to make changes',
              description: 'The demo persona can browse training, but adding teammates needs a real staff sign-in.',
            },
      );
      return;
    }
    if (!accountId) {
      toast({
        title: 'No office on this sign-in yet',
        description: 'Your account has no office assigned, so there is nowhere to add teammates.',
      });
      return;
    }
    setDialogOpen(true);
  };

  const submitTeammate = async () => {
    if (!accountId || saving) return;
    setSaving(true);
    const viewer = await addStaffMember(accountId, { name: newName, email: newEmail });
    setSaving(false);
    if (viewer) {
      setDialogOpen(false);
      setNewName('');
      setNewEmail('');
      toast({
        variant: 'success',
        title: `${viewer.name} is on the roster`,
        description:
          'When they sign up with this email, office training access links automatically — no invite email needed.',
      });
    }
  };

  const markNext = async () => {
    if (!self?.next || marking) return;
    setMarking(true);
    const completion = await markMyVideoComplete(self.next.video.id);
    setMarking(false);
    if (completion) {
      const remaining = self.total - self.done - 1;
      toast({
        variant: 'success',
        title: `Marked "${self.next.video.title}" complete`,
        description:
          remaining > 0
            ? `${remaining} video${remaining === 1 ? '' : 's'} to go in ${primaryCourse?.title ?? 'this course'}.`
            : 'That was the last one — course complete.',
      });
    }
  };

  const header = (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className={MICRO_LABEL}>Enablement</p>
        <h1 className="mt-1 font-serif text-[32px] leading-none tracking-[-.02em] text-navy">Training</h1>
        <p className="mt-2 text-xs text-muted-foreground" data-testid="text-training-scope">
          {officeName
            ? `${officeName} — your team's THINNR program training.`
            : signedIn
              ? "Your team's THINNR program training."
              : 'THINNR program training across every office in the demo.'}
        </p>
      </div>
      <button className={`${BTN_PRIMARY} h-9 shrink-0 px-4`} onClick={openAddTeammate} data-testid="button-add-teammate">
        <Plus size={14} aria-hidden="true" />
        Add teammate
      </button>
    </header>
  );

  if (status !== 'ready') {
    return (
      <div className={PAGE_WRAP}>
        {header}
        {status === 'loading' ? <TrainingLoading /> : <TrainingLoadError message={errorMessage} onRetry={refresh} />}
      </div>
    );
  }

  return (
    <div className={PAGE_WRAP}>
      {header}

      {myViewer && primaryCourse && self && (
        <SectionCard
          title="My training"
          sub={primaryCourse.title}
          action={
            <span className={CHIP_COBALT} data-testid="chip-my-progress">
              {self.done}/{self.total} complete
            </span>
          }
        >
          <div className="px-5 py-4">
            <div className="h-2 overflow-hidden rounded-full bg-border" aria-hidden="true">
              <div className="h-full bg-primary transition-all" style={{ width: `${self.pct}%` }} />
            </div>
            {self.next ? (
              <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className={MICRO_LABEL}>Next up — {self.next.numbering}</p>
                  <Link
                    href={`/training/${primaryCourse.id}/videos/${self.next.video.id}`}
                    className="mt-0.5 block truncate rounded-sm text-sm font-semibold text-navy hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    data-testid="text-next-video"
                  >
                    {self.next.video.title}
                  </Link>
                  <p className="mt-0.5 text-xs text-muted-foreground">{formatClock(self.next.video.duration)}</p>
                </div>
                <button
                  className={`${BTN_PRIMARY} h-9 w-full px-4 sm:w-auto sm:shrink-0`}
                  onClick={() => void markNext()}
                  disabled={marking}
                  data-testid="button-mark-next-complete"
                >
                  {marking ? 'Saving…' : 'Mark complete & continue'}
                </button>
              </div>
            ) : (
              <p className="mt-4 flex items-center gap-2 text-sm font-semibold text-navy" data-testid="text-course-finished">
                <CheckCircle2 size={16} className="text-primary" aria-hidden="true" />
                All caught up — you've finished {primaryCourse.title}.
              </p>
            )}
          </div>
        </SectionCard>
      )}

      <SectionCard
        title="Live courses"
        sub="Published by THINNR HQ — the same material every office trains on."
      >
        {liveCourses.length > 0 ? (
          <div className="grid gap-px bg-border sm:grid-cols-2">
            {liveCourses.map((course) => (
              <CourseCard
                key={course.id}
                course={course}
                accountId={accountId}
                viewers={lensViewers}
                completionIndex={completionIndex}
                myViewerId={myViewer?.id ?? null}
              />
            ))}
          </div>
        ) : (
          <p className="px-5 py-8 text-center text-xs text-muted-foreground">
            No live courses yet — they appear here as soon as THINNR HQ publishes training.
          </p>
        )}
      </SectionCard>

      <SectionCard
        title="Team roster"
        sub={
          officeName
            ? 'Progress on the flagship course. Add your front desk and providers so their training is tracked.'
            : 'Office learners across the program, with flagship-course progress.'
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-border text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
                <th className="px-4 py-3 font-bold sm:px-5">Name</th>
                <th className="hidden px-3 py-3 font-bold lg:table-cell">Email</th>
                {!accountId && <th className="hidden px-3 py-3 font-bold xl:table-cell">Office</th>}
                <th className="px-3 py-3 font-bold">Progress</th>
                <th className="hidden px-3 py-3 text-right font-bold sm:table-cell">Watch time</th>
                <th className="hidden px-3 py-3 text-right font-bold sm:table-cell">Last active</th>
                {/* relative contains the absolutely-positioned sr-only span;
                    without it the span escapes the overflow-x wrapper at the
                    table's full width and widens the page on phones. */}
                <th className="relative w-10 py-3 pr-3 sm:w-12 sm:pr-4">
                  <span className="sr-only">Open teammate stats</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {roster.length > 0 ? (
                roster.map((entry) => (
                  <tr
                    key={entry.viewer.id}
                    onClick={(event) => {
                      // Pointer-only convenience: the row duplicates its real,
                      // announced control (the trailing chevron link — the
                      // row's one keyboard stop). Leave nested controls,
                      // modified clicks, and text selection alone.
                      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                      if ((event.target as Element).closest('a, button, input, select, textarea')) return;
                      if (window.getSelection()?.toString()) return;
                      navigate(`/training/team/${entry.viewer.id}`);
                    }}
                    className="group cursor-pointer border-b border-border transition-colors hover:bg-accent/40 has-[a:focus-visible]:bg-accent/60 last:border-b-0"
                    data-testid={`row-team-${entry.viewer.id}`}
                  >
                    <td className="px-4 py-3 sm:px-5">
                      <div className="flex items-center gap-2">
                        <span className="max-w-[9.5rem] truncate font-semibold text-navy sm:max-w-none">
                          {entry.viewer.name}
                        </span>
                        {entry.isSelf && (
                          <span className={`${CHIP_COBALT} shrink-0`} data-testid="chip-you">
                            You
                          </span>
                        )}
                      </div>
                      {/* The email cap sets this cell's min-content width in
                          the table algorithm — keep it narrow on phones so the
                          roster fits 390px without internal scroll. */}
                      <p className="mt-0.5 max-w-[7.5rem] truncate text-[11px] text-muted-foreground sm:max-w-[11rem] lg:hidden">
                        {entry.viewer.email}
                      </p>
                    </td>
                    <td className="hidden px-3 py-3 text-muted-foreground lg:table-cell">
                      <span className="block max-w-[260px] truncate">{entry.viewer.email}</span>
                    </td>
                    {!accountId && (
                      <td className="hidden px-3 py-3 text-muted-foreground xl:table-cell">
                        {entry.viewer.accountId
                          ? (findSeededAccount(entry.viewer.accountId)?.officeName ?? entry.viewer.accountId)
                          : '—'}
                      </td>
                    )}
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-2">
                        <span className="w-9 text-right font-semibold text-navy">
                          {entry.done}/{entry.total}
                        </span>
                        <div className="h-1.5 w-[60px] overflow-hidden rounded-full bg-border" aria-hidden="true">
                          <div className="h-full bg-primary" style={{ width: `${entry.pct}%` }} />
                        </div>
                      </div>
                    </td>
                    <td className="hidden px-3 py-3 text-right text-muted-foreground sm:table-cell">
                      {formatHours(entry.watchSeconds)}
                    </td>
                    {/* Phone keeps who + progress + open; last-active lives one
                        tap away on the teammate page (same column-hiding
                        precedent as Watch time / Email / Office). */}
                    <td className="hidden px-3 py-3 text-right text-muted-foreground whitespace-nowrap sm:table-cell">
                      {formatLastSeen(entry.viewer)}
                    </td>
                    <td className="py-2 pr-3 text-right sm:pr-4">
                      {/* The row's real control: a native link in the tab
                          order, announced by name — the row's onClick is just
                          a bigger pointer target for the same navigation. */}
                      <Link
                        href={`/training/team/${entry.viewer.id}`}
                        aria-label={`Open ${entry.viewer.name}’s training stats`}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-primary group-hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        data-testid={`link-teammate-${entry.viewer.id}`}
                      >
                        <ChevronRight size={16} aria-hidden="true" />
                      </Link>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={accountId ? 6 : 7} className="px-5 py-8 text-center text-xs text-muted-foreground">
                    No teammates on the roster yet — add your front desk and providers above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {roster.length > 0 && (
          <div className="flex flex-wrap items-center gap-4 border-t border-border px-5 py-3 text-xs text-muted-foreground">
            <span data-testid="text-team-avg">
              Team average <span className="font-semibold text-navy">{teamStats.avgPct}%</span>
            </span>
            <span data-testid="text-team-finishers">
              Finished the flagship course <span className="font-semibold text-navy">{teamStats.finishers}</span>
            </span>
          </div>
        )}
      </SectionCard>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">Add a teammate</DialogTitle>
            <DialogDescription>
              {officeName ? `They join ${officeName}'s roster right away.` : 'They join this office right away.'}{' '}
              When they sign up with this email, training access links automatically — nothing is emailed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="block">
              <span className={MICRO_LABEL}>Full name</span>
              <input
                className={`${INPUT_CLASS} mt-1 h-9 w-full`}
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder="e.g. Dana Reyes"
                data-testid="input-teammate-name"
              />
            </label>
            <label className="block">
              <span className={MICRO_LABEL}>Work email</span>
              <input
                className={`${INPUT_CLASS} mt-1 h-9 w-full`}
                type="email"
                value={newEmail}
                onChange={(event) => setNewEmail(event.target.value)}
                placeholder="name@office.com"
                data-testid="input-teammate-email"
              />
            </label>
          </div>
          <DialogFooter>
            <button
              className={`${BTN_PRIMARY} h-9 w-full px-4 sm:w-auto`}
              onClick={() => void submitTeammate()}
              disabled={saving || newName.trim() === '' || newEmail.trim() === ''}
              data-testid="button-save-teammate"
            >
              {saving ? 'Adding…' : 'Add to office'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CourseCard({
  course,
  accountId,
  viewers,
  completionIndex,
  myViewerId,
}: {
  course: TrainingCourse;
  accountId: string | null;
  viewers: Parameters<typeof officeRoster>[0];
  completionIndex: Parameters<typeof officeRoster>[3];
  myViewerId: string | null;
}) {
  const order = useMemo(() => getOrderedVideos(course, true), [course]);
  const stats = useMemo(
    () => officeCourseStats(officeRoster(viewers, accountId, order, completionIndex, myViewerId)),
    [viewers, accountId, order, completionIndex, myViewerId],
  );
  const href = `/training/${course.id}`;
  return (
    // Stretched-link card: the title anchor's ::after overlay spans this
    // relative container, so the whole card is one NATIVE link — announced
    // as a link named by the course title, Enter/middle-click/context menu
    // for free, and exactly one tab stop per card.
    <div
      className="group relative flex flex-col gap-3 bg-card px-5 py-4 transition-colors hover:bg-accent/40 has-[a:focus-visible]:bg-accent/60 has-[a:focus-visible]:outline-2 has-[a:focus-visible]:-outline-offset-2 has-[a:focus-visible]:outline-ring"
      data-testid={`card-course-${course.id}`}
    >
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-accent-border bg-accent text-primary">
          <GraduationCap size={16} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 className="font-serif text-[15px] leading-snug text-navy">
            <Link
              href={href}
              className="after:absolute after:inset-0 focus-visible:outline-none"
              data-testid={`link-open-course-${course.id}`}
            >
              {course.title}
            </Link>
          </h3>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{course.description}</p>
        </div>
      </div>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {countVideos(course, true)} videos · {formatHours(courseDuration(course, true))} · team avg{' '}
          <span className="font-semibold text-navy">{stats.avgPct}%</span>
        </span>
        {/* Decorative affordance — the card's real link is the stretched
            title anchor above; a second anchor here would only add a
            duplicate tab stop. */}
        <span
          aria-hidden="true"
          className="inline-flex items-center gap-1 text-xs font-semibold text-primary group-hover:underline"
        >
          Open <ArrowRight size={12} aria-hidden="true" />
        </span>
      </div>
    </div>
  );
}
