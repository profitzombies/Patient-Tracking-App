import { useState, useEffect, useMemo } from 'react';
import { useParams, Link } from 'wouter';
import { Check, Play, Lock, ArrowLeft, Download, LogOut, CheckCircle2, Users } from 'lucide-react';
import { useTrainingData } from '@/contexts/training-data';
import { getOrderedVideos, courseDuration, completedCount, effectiveUnlock, frontierIndex, isVideoCompletedBy, formatClock, formatHours, type TrainingVideo, type OrderedVideo } from '@/data/hq/training';
import { CourseLiveChip, SlideFrame } from '@/components/admin/training/shared';
import { INPUT_CLASS, BTN_PRIMARY, BTN_SECONDARY } from '@/components/patient/heritage';
import { useToast } from '@/hooks/use-toast';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export default function LearnerPreview() {
  const { courseId } = useParams();
  const { courses, viewers, addViewerFromGate, inviteStaff, markVideoComplete } = useTrainingData();
  const { toast } = useToast();

  const course = useMemo(() => {
    if (!courseId) return undefined;
    return courses.find((c) => c.id === courseId || c.slug === courseId);
  }, [courses, courseId]);

  const [gateEmail, setGateEmail] = useState('');
  const [viewerId, setViewerId] = useState<string | null>(null);
  // Admins may explicitly open a draft/unpublished course; plain learner links stay blocked.
  const [draftOverride, setDraftOverride] = useState(false);

  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [selectedChapterIndex, setSelectedChapterIndex] = useState(0);
  const [showCompletionCard, setShowCompletionCard] = useState(false);
  const [addStaffOpen, setAddStaffOpen] = useState(false);
  const [addStaffEmail, setAddStaffEmail] = useState('');

  useEffect(() => {
    const stored = sessionStorage.getItem('thinnr-training-gate-email');
    if (stored) {
      const existing = viewers.find((v) => v.email.toLowerCase() === stored.toLowerCase());
      if (existing) setViewerId(existing.id);
    }
  }, [viewers]);

  const handleGateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!gateEmail || !gateEmail.includes('@')) return;
    const newViewer = addViewerFromGate(gateEmail);
    sessionStorage.setItem('thinnr-training-gate-email', newViewer.email);
    setViewerId(newViewer.id);
  };

  const handleAddStaffSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!addStaffEmail || !addStaffEmail.includes('@') || !viewer) return;
    // Really create the teammate so the toast's promise holds up in Viewers.
    inviteStaff(viewer.id, addStaffEmail);
    toast({ title: 'Invite sent', description: 'Your teammate now appears under Viewers.' });
    setAddStaffOpen(false);
    setAddStaffEmail('');
  };

  const publishedVideoList = useMemo(() => (course ? getOrderedVideos(course, true) : []), [course]);
  
  const videoIndexMap = useMemo(() => {
    const map = new Map<string, { index: number; numbering: string; ov: OrderedVideo }>();
    publishedVideoList.forEach((ov, i) => {
      map.set(ov.video.id, { index: i, numbering: ov.numbering, ov });
    });
    return map;
  }, [publishedVideoList]);

  const viewer = viewers.find((v) => v.id === viewerId);

  useEffect(() => {
    if (viewer && publishedVideoList.length > 0 && !selectedVideoId && !showCompletionCard) {
      const frontier = frontierIndex(viewer, publishedVideoList);
      if (frontier >= publishedVideoList.length) {
        setShowCompletionCard(true);
      } else {
        setSelectedVideoId(publishedVideoList[frontier]!.video.id);
      }
    }
  }, [viewer, publishedVideoList, selectedVideoId, showCompletionCard]);

  const handleSelectVideo = (videoId: string, isAvailable: boolean) => {
    if (!isAvailable) return;
    setSelectedVideoId(videoId);
    setSelectedChapterIndex(0);
    setShowCompletionCard(false);
  };

  const handleMarkComplete = () => {
    if (!viewer || !selectedVideoId) return;
    const currentIndex = publishedVideoList.findIndex((v) => v.video.id === selectedVideoId);
    if (currentIndex === -1) return;

    // Credits exactly the watched video — completing a free-unlock video out
    // of order never marks the skipped ones complete.
    markVideoComplete(viewer.id, selectedVideoId);

    // The context update lands async; navigate off a local "after" set.
    const doneAfter = new Set([...viewer.completedVideoIds, selectedVideoId]);
    const remaining = publishedVideoList.filter((ov) => !doneAfter.has(ov.video.id));
    if (remaining.length === 0) {
      setShowCompletionCard(true);
      setSelectedVideoId(null);
      return;
    }
    const nextAfter = publishedVideoList.find((ov, i) => i > currentIndex && !doneAfter.has(ov.video.id));
    setSelectedVideoId((nextAfter ?? remaining[0]!).video.id);
    setSelectedChapterIndex(0);
  };

  // State 1: Unknown Course
  if (!course) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background p-8">
        <div className="rounded-lg border border-card-border bg-card shadow-soft p-8 text-center max-w-sm w-full">
          <h1 className="font-serif text-xl font-bold text-navy mb-2">Course not found</h1>
          <p className="text-sm text-muted-foreground mb-6">This training link isn't active.</p>
          <Link href="/admin/training" className={`${BTN_SECONDARY} h-9 px-4 inline-flex`} data-testid="link-back-admin">
            Back to admin
          </Link>
        </div>
      </div>
    );
  }

  // State 1.5: Not live — learner links are dead until the course is published.
  if (course.status !== 'live' && !draftOverride) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background p-8">
        <div className="rounded-lg border border-card-border bg-card shadow-soft p-8 text-center max-w-sm w-full">
          <h1 className="font-serif text-xl font-bold text-navy mb-2">This course isn't live</h1>
          <p className="text-sm text-muted-foreground mb-6" data-testid="text-course-not-live">
            Learners can't access this course right now. Publish it to restore access.
          </p>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              className={`${BTN_PRIMARY} h-9 px-4 w-full`}
              onClick={() => setDraftOverride(true)}
              data-testid="button-draft-preview"
            >
              Open draft preview (admin)
            </button>
            <Link href="/admin/training" className={`${BTN_SECONDARY} h-9 px-4 inline-flex justify-center`} data-testid="link-back-admin-notlive">
              Back to admin
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // State 2: Email Gate
  if (!viewerId || !viewer) {
    const totalDuration = courseDuration(course, true);
    const moduleCount = course.modules.filter((m) => m.published === 'published').length;

    return (
      <div className="min-h-[100dvh] flex flex-col items-center justify-center bg-[#fff4e6] p-4 md:p-8 relative">
        <div className="absolute top-4 left-4 md:top-8 md:left-8">
          <Link href="/admin/training" className="text-[11px] font-semibold text-[#b65c22] hover:text-[#904719] flex items-center gap-1 transition-colors" data-testid="link-back-admin">
            <ArrowLeft size={12} aria-hidden="true" />
            Back to admin
          </Link>
        </div>
        <div className="rounded-lg border border-card-border bg-card shadow-soft p-8 max-w-[420px] w-full relative z-10">
          <div className="text-center mb-6">
            <p className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground mb-2">THINNR Training</p>
            <h1 className="font-serif text-[26px] font-bold leading-tight tracking-[-.01em] text-navy mb-2">{course.title}</h1>
            <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-widest">
              {moduleCount} modules · {publishedVideoList.length} videos · {formatHours(totalDuration)}
            </p>
          </div>
          <form onSubmit={handleGateSubmit} className="space-y-4">
            <p className="text-sm text-center text-foreground leading-relaxed">
              Enter your work email to start — your progress is saved for your office.
            </p>
            <div className="pt-2">
              <input
                type="email"
                required
                value={gateEmail}
                onChange={(e) => setGateEmail(e.target.value)}
                placeholder="name@office.com"
                className={`${INPUT_CLASS} w-full h-10`}
                data-testid="input-gate-email"
              />
            </div>
            <button type="submit" className={`${BTN_PRIMARY} w-full h-10 mt-2`} data-testid="button-gate-submit">
              Continue
            </button>
            <p className="text-[11px] text-center text-muted-foreground mt-4 pt-2">
              Demo gate — any email works.
            </p>
          </form>
        </div>
      </div>
    );
  }

  // State 3: Course View
  const isDraft = course.status === 'draft';
  const selectedVideoOV = publishedVideoList.find((ov) => ov.video.id === selectedVideoId);
  const selectedVideo = selectedVideoOV?.video;
  const videoIndex = selectedVideoOV ? selectedVideoOV.position - 1 : -1;
  const isVideoCompleted = !!viewer && !!selectedVideo && isVideoCompletedBy(viewer, selectedVideo.id);
  const viewerFrontier = viewer ? frontierIndex(viewer, publishedVideoList) : 0;

  let showAddStaff = false;
  if (selectedVideo) {
    if (selectedVideo.addStaff === 'show') showAddStaff = true;
    if (selectedVideo.addStaff === 'auto' && videoIndex === 0) showAddStaff = true;
  }

  const renderVideoRow = (video: TrainingVideo, indented = false) => {
    const meta = videoIndexMap.get(video.id);
    if (!meta) return null;
    const index = meta.index;
    const numbering = meta.numbering;

    let isAvailable = true;
    if (course.sequentialUnlock && effectiveUnlock(meta.ov) !== 'free') {
      isAvailable = index <= viewerFrontier || isVideoCompletedBy(viewer, video.id);
    }

    const isCompleted = isVideoCompletedBy(viewer, video.id);
    const isSelected = selectedVideoId === video.id && !showCompletionCard;

    return (
      <button
        key={video.id}
        onClick={() => handleSelectVideo(video.id, isAvailable)}
        disabled={!isAvailable}
        title={!isAvailable ? 'Complete the previous videos to unlock' : undefined}
        data-testid={`row-video-${video.id}`}
        className={`w-full flex items-start gap-3 py-2 pr-2 rounded-md text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          isSelected
            ? 'bg-card shadow-sm border border-border'
            : !isAvailable
              ? 'opacity-60 cursor-not-allowed'
              : 'hover:bg-card/50'
        } ${indented ? 'pl-6' : 'pl-2'}`}
      >
        <div className="mt-0.5 shrink-0">
          {isCompleted ? (
            <CheckCircle2 size={15} className="text-primary" aria-hidden="true" />
          ) : !isAvailable ? (
            <Lock size={15} className="text-muted-foreground" aria-hidden="true" />
          ) : (
            <Play size={15} className={isSelected ? 'text-primary' : 'text-muted-foreground'} aria-hidden="true" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[10px] font-bold text-muted-foreground tabular-nums shrink-0">{numbering}</span>
            <span className={`text-xs font-semibold leading-tight ${isSelected ? 'text-navy' : 'text-foreground'}`}>
              {video.title}
            </span>
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5 tabular-nums">{formatClock(video.duration)}</div>
        </div>
      </button>
    );
  };

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      {isDraft && (
        <div className="bg-[#fff4e6] px-4 py-2 text-center text-xs font-medium text-[#b65c22] border-b border-[#e8b47c]">
          Draft preview — learners can't see this yet.
        </div>
      )}
      <header className="flex items-center justify-between px-4 md:px-8 py-4 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="font-serif text-lg font-bold text-navy truncate">{course.title}</h1>
          <CourseLiveChip status={course.status} />
        </div>
        <div className="flex items-center gap-4 shrink-0 text-sm">
          <div className="hidden sm:flex items-center gap-2 text-muted-foreground text-xs">
            <span className="font-medium text-foreground">{viewer.email}</span>
            <span>·</span>
            <span>
              {completedCount(viewer, publishedVideoList)} of {publishedVideoList.length} complete
            </span>
          </div>
          <Link href="/admin/training" className="text-xs font-semibold text-muted-foreground hover:text-navy flex items-center gap-1.5 transition" data-testid="link-exit-preview">
            <LogOut size={14} aria-hidden="true" />
            Exit preview
          </Link>
        </div>
      </header>

      <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
        {/* Sidebar */}
        <aside className="w-full md:w-[320px] lg:w-[340px] border-r border-border bg-secondary/30 flex flex-col overflow-y-auto shrink-0">
          <div className="p-4 space-y-6">
            {course.modules.map((module) => {
              if (module.published !== 'published') return null;
              return (
                <div key={module.id} className="space-y-2">
                  <h3 className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground px-2">
                    {module.title}
                  </h3>
                  <div className="space-y-1">
                    {module.entries.map((entry) => {
                      if (entry.kind === 'video') {
                        if (entry.video.published !== 'published') return null;
                        return renderVideoRow(entry.video, false);
                      } else {
                        if (entry.subgroup.published !== 'published') return null;
                        return (
                          <div key={entry.subgroup.id} className="pt-2 pb-1 space-y-1">
                            <h4 className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground/70 px-2 pl-4">
                              {entry.subgroup.title}
                            </h4>
                            {entry.subgroup.videos.map((video) => {
                              if (video.published !== 'published') return null;
                              return renderVideoRow(video, true);
                            })}
                          </div>
                        );
                      }
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 overflow-y-auto bg-background">
          {showCompletionCard ? (
            <div className="p-8 md:p-12 lg:p-24 flex items-center justify-center min-h-full">
              <div className="rounded-lg border border-card-border bg-card shadow-soft p-10 text-center max-w-md w-full">
                <div className="mx-auto w-12 h-12 bg-[#fff4e6] text-[#b65c22] rounded-full flex items-center justify-center mb-6 border border-[#e8b47c]">
                  <Check size={24} aria-hidden="true" />
                </div>
                <h2 className="font-serif text-2xl font-bold text-navy mb-2">Course complete</h2>
                <p className="text-sm text-muted-foreground mb-8 leading-relaxed">
                  Nice work. Your progress has been saved and your team's dashboard is up to date.
                </p>
                <button
                  onClick={() => {
                    setShowCompletionCard(false);
                    setSelectedVideoId(publishedVideoList[0]?.video.id || null);
                  }}
                  className={`${BTN_SECONDARY} h-9 px-4`}
                  data-testid="button-rewatch"
                >
                  Rewatch course
                </button>
              </div>
            </div>
          ) : selectedVideo ? (
            <div className="p-4 md:p-8 lg:p-10 max-w-[1000px] mx-auto">
              <div className="space-y-8">
                {/* Player Block */}
                <div className="rounded-lg overflow-hidden bg-card border border-card-border shadow-soft relative">
                  <SlideFrame
                    video={selectedVideo}
                    chapterIndex={selectedChapterIndex}
                    className="rounded-none border-none"
                  />
                  <div className="bg-card px-4 py-3 border-t border-border flex flex-col gap-2.5">
                    <div className="h-1.5 bg-secondary rounded-full flex overflow-hidden relative">
                      {selectedVideo.chapters.map((ch, idx) => {
                        const isPast = idx < selectedChapterIndex;
                        const isCurrent = idx === selectedChapterIndex;
                        const isLast = idx === selectedVideo.chapters.length - 1;
                        const nextAt = isLast ? selectedVideo.duration : selectedVideo.chapters[idx + 1]!.at;
                        const duration = nextAt - ch.at;
                        const pct = Math.max(0, Math.min(100, (duration / selectedVideo.duration) * 100));
                        return (
                          <button
                            key={ch.id}
                            onClick={() => setSelectedChapterIndex(idx)}
                            style={{ width: `${pct}%` }}
                            className={`h-full border-r border-card last:border-0 transition-colors focus-visible:outline-none ${
                              isPast || isCurrent ? 'bg-primary' : 'bg-secondary hover:bg-muted'
                            }`}
                            title={ch.title}
                            data-testid={`timeline-chapter-${idx}`}
                          />
                        );
                      })}
                    </div>
                    <div className="flex items-center justify-between text-[10px] font-bold text-muted-foreground uppercase tracking-widest tabular-nums">
                      <span>{formatClock(selectedVideo.chapters[selectedChapterIndex]?.at || 0)}</span>
                      <span>{formatClock(selectedVideo.duration)}</span>
                    </div>
                  </div>
                </div>

                {/* Description & Resources */}
                <div className="flex flex-col md:flex-row gap-8 lg:gap-12">
                  <div className="flex-1 space-y-8">
                    <div>
                      <div className="flex flex-wrap items-center gap-3 mb-3">
                        <h2 className="font-serif text-[22px] font-bold leading-tight text-navy">
                          {selectedVideo.title}
                        </h2>
                        {isVideoCompleted && (
                          <span className="inline-flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[.12em] text-muted-foreground border border-border bg-secondary px-2 py-0.5 rounded-sm">
                            <CheckCircle2 size={12} aria-hidden="true" />
                            Completed
                          </span>
                        )}
                      </div>
                      <div className="space-y-3 text-sm text-foreground/90 leading-relaxed">
                        {selectedVideo.description.map((p, i) => (
                          <p key={i}>{p}</p>
                        ))}
                      </div>
                    </div>

                    {selectedVideo.attachments.length > 0 && (
                      <div className="space-y-3">
                        <h3 className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
                          Resources
                        </h3>
                        <div className="space-y-2">
                          {selectedVideo.attachments.map((att) => (
                            <button
                              key={att.id}
                              onClick={() => toast({ description: 'Downloads are disabled in this demo.' })}
                              className="w-full flex items-center justify-between p-3 rounded-md border border-border bg-card hover:bg-secondary/50 transition-colors text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              data-testid={`button-download-${att.id}`}
                            >
                              <div className="flex items-center gap-3 min-w-0">
                                <div className="grid w-8 h-8 place-items-center rounded bg-[#fff4e6] text-[#b65c22] shrink-0 border border-[#e8b47c]">
                                  <Download size={14} aria-hidden="true" />
                                </div>
                                <span className="text-sm font-semibold text-navy truncate">{att.name}</span>
                              </div>
                              <span className="text-xs text-muted-foreground tabular-nums shrink-0 ml-4">
                                {att.sizeLabel}
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="pt-2 flex flex-wrap items-center gap-3">
                      <button
                        onClick={handleMarkComplete}
                        className={`${BTN_PRIMARY} h-9 px-6`}
                        data-testid="button-mark-complete"
                      >
                        {isVideoCompleted ? 'Continue to next' : 'Mark complete & continue'}
                      </button>
                      {showAddStaff && (
                        <button
                          onClick={() => setAddStaffOpen(true)}
                          className={`${BTN_SECONDARY} h-9 px-4`}
                          data-testid="button-add-staff"
                        >
                          <Users size={14} aria-hidden="true" />
                          Add your staff
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Chapters List */}
                  <div className="w-full md:w-[260px] shrink-0 space-y-3">
                    <h3 className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">Chapters</h3>
                    <div className="space-y-1">
                      {selectedVideo.chapters.map((ch, idx) => {
                        const isCurrent = idx === selectedChapterIndex;
                        return (
                          <button
                            key={ch.id}
                            onClick={() => setSelectedChapterIndex(idx)}
                            className={`w-full flex items-start gap-3 p-2 rounded-md text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                              isCurrent
                                ? 'bg-secondary text-navy font-semibold border border-border'
                                : 'text-muted-foreground hover:bg-secondary/50 border border-transparent'
                            }`}
                            data-testid={`button-chapter-${idx}`}
                          >
                            <span className="text-[10px] font-bold tabular-nums pt-0.5 w-8 shrink-0">
                              {formatClock(ch.at)}
                            </span>
                            <span className="text-xs leading-snug flex-1">{ch.title}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="p-8 text-center text-sm text-muted-foreground">No playable videos found.</div>
          )}
        </main>
      </div>

      <Dialog open={addStaffOpen} onOpenChange={setAddStaffOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">Add your staff</DialogTitle>
            <DialogDescription>
              Invite teammates to get their own progress tracking and demo access.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleAddStaffSubmit}>
            <div className="py-4">
              <input
                type="email"
                required
                value={addStaffEmail}
                onChange={(e) => setAddStaffEmail(e.target.value)}
                placeholder="teammate@office.com"
                className={`${INPUT_CLASS} w-full h-10`}
                data-testid="input-staff-email"
              />
            </div>
            <DialogFooter>
              <button
                type="button"
                className={`${BTN_SECONDARY} h-9 px-4`}
                onClick={() => setAddStaffOpen(false)}
                data-testid="button-staff-cancel"
              >
                Cancel
              </button>
              <button type="submit" className={`${BTN_PRIMARY} h-9 px-4`} data-testid="button-staff-submit">
                Send invite
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
