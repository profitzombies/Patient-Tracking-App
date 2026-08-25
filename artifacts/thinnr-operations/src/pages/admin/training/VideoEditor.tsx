import { useState, useEffect, useRef } from 'react';
import { useRoute, useLocation, Link } from 'wouter';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Eye,
  FileText,
  Trash2,
  Image as ImageIcon,
  Film,
  Paperclip,
  Upload,
  X,
  Play,
  Pause,
  Wand2,
  RefreshCw,
  Plus
} from 'lucide-react';

import { useToast } from '@/hooks/use-toast';
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  CHIP_COBALT,
  CHIP_WARM,
  INPUT_CLASS,
  INSET,
  LINK_ACTION,
  SectionCard
} from '@/components/patient/heritage';
import { AdminPage, PageHeader } from '@/components/admin/primitives';
import {
  SlideFrame,
  TrainingTabs,
  TrainingLoading,
  TrainingLoadError,
  aiChapters,
  aiDescription,
  chapterIndexAt
} from '@/components/admin/training/shared';
import {
  formatClock,
  formatHours,
  getVideoEngagement,
  getVideoRetention,
  hashId,
  type TrainingChapter,
  type TrainingVideo,
  type VideoRetention
} from '@/data/hq/training';
import { useTrainingData, type VideoPatch } from '@/contexts/training-data';
import {
  captureThumbnail,
  describeFileProblem,
  fetchTranscript,
  finalizeUpload,
  processVideo,
  removeVideoFile,
  requestUploadUrl,
  resolveVideoType,
  uploadToStorage,
  PROCESS_STEPS,
  type ProcessEvent,
  type ProcessStep,
  type TranscriptSegment,
} from '@/lib/training-media';
import { HostedVideoPlayer, useVideoMedia } from '@/components/training/HostedVideoPlayer';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const ADD_STAFF_LABELS: Record<TrainingVideo['addStaff'], string> = {
  auto: 'Auto',
  show: 'Show on this video',
  hidden: 'Hidden'
};

const UNLOCK_LABELS: Record<TrainingVideo['unlock'], string> = {
  sequential: 'Sequential',
  free: 'Free'
};

/** Per-step UI state for the AI pass. `idle` = not attempted this visit. */
type StepStatus = 'idle' | 'pending' | 'running' | 'done' | 'failed' | 'skipped';

const IDLE_STEPS: Record<ProcessStep, StepStatus> = {
  transcribe: 'idle',
  describe: 'idle',
  chapters: 'idle',
  thumbnail: 'idle',
};

const STEP_LABELS: Record<ProcessStep, string> = {
  transcribe: 'Pull the transcript',
  describe: 'Write the description',
  chapters: 'Create the chapters',
  thumbnail: 'Set the thumbnail',
};

/**
 * Survival area chart for the Retention card — pure geometry from the sampled
 * curve (no clocks, no randomness), so the same rows always paint the same
 * shape. The stretched viewBox plus non-scaling strokes keep the line crisp
 * at any rail width.
 */
function RetentionChart({ points }: { points: VideoRetention['points'] }) {
  const width = 100;
  const height = 36;
  const duration = points[points.length - 1]?.at || 1;
  const coords = points.map(
    (point) => `${((point.at / duration) * width).toFixed(2)},${(height - (point.pct / 100) * height).toFixed(2)}`,
  );
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="block h-28 w-full text-primary"
      aria-hidden="true"
      data-testid="retention-chart"
    >
      {[0.25, 0.5, 0.75].map((fraction) => (
        <line
          key={fraction}
          x1="0"
          y1={height * fraction}
          x2={width}
          y2={height * fraction}
          className="text-border"
          stroke="currentColor"
          strokeWidth="1"
          strokeDasharray="2 4"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <polygon points={`0,${height} ${coords.join(' ')} ${width},${height}`} fill="currentColor" fillOpacity="0.14" />
      <polyline
        points={coords.join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export default function VideoEditor() {
  const [, params] = useRoute('/admin/training/courses/:courseId/videos/:videoId');
  const { locateVideo, updateVideo, moveVideoToContainer, removeVideo, completions, canEdit, status, errorMessage, refresh } =
    useTrainingData();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const locationResult = locateVideo(params?.courseId, params?.videoId);

  const [draft, setDraft] = useState<VideoPatch | null>(null);
  const [playing, setPlaying] = useState(false);
  const [scrub, setScrub] = useState(0);
  const [aiSpinner, setAiSpinner] = useState<'desc' | 'chapters' | null>(null);
  const [descVariant, setDescVariant] = useState(0);
  const [chapterVariant, setChapterVariant] = useState(0);
  
  const [draftVideoId, setDraftVideoId] = useState<string | null>(null);
  const [thumbnailDialogOpen, setThumbnailDialogOpen] = useState(false);
  const [thumbnailScrub, setThumbnailScrub] = useState(0);
  const [newAttachmentName, setNewAttachmentName] = useState('');

  // --- Hosted file: upload, AI pass, transcript, thumbnail capture ---
  const [uploadPhase, setUploadPhase] = useState<'idle' | 'uploading' | 'verifying'>('idle');
  const [uploadPct, setUploadPct] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [stepStates, setStepStates] = useState<Record<ProcessStep, StepStatus>>(IDLE_STEPS);
  const [stepErrors, setStepErrors] = useState<Partial<Record<ProcessStep, string>>>({});
  const [aiActive, setAiActive] = useState(false);
  const [aiProgress, setAiProgress] = useState<{ done: number; total: number } | null>(null);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [transcriptState, setTranscriptState] = useState<{
    status: 'idle' | 'loading' | 'ready' | 'missing' | 'error';
    segments: TranscriptSegment[];
    message?: string;
  }>({ status: 'idle', segments: [] });
  const [thumbBusy, setThumbBusy] = useState(false);
  const [removingFile, setRemovingFile] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const thumbVideoRef = useRef<HTMLVideoElement | null>(null);
  /** Which video the mounted editor is showing — a still-running upload or AI
   * stream from a previous video must not touch the current one's UI. */
  const currentVideoIdRef = useRef<string | null>(null);

  const playbackRef = useRef<number | null>(null);

  // Signed playback URLs — only for a real signed-in HQ admin (demo personas
  // have no staff session, so the fetch would just 401).
  const { media, loading: mediaLoading, error: mediaError, reload: reloadMedia } = useVideoMedia(
    locationResult?.video.id ?? '',
    locationResult?.video.videoSource ?? null,
    canEdit,
  );

  // Keep the thumbnail dialog's real-frame preview parked on the scrub time.
  useEffect(() => {
    if (!thumbnailDialogOpen) return;
    const preview = thumbVideoRef.current;
    if (preview && Number.isFinite(thumbnailScrub)) {
      try {
        preview.currentTime = thumbnailScrub;
      } catch {
        // Metadata not loaded yet — the element seeks once it is.
      }
    }
  }, [thumbnailDialogOpen, thumbnailScrub, media]);

  useEffect(() => {
    return () => {
      if (playbackRef.current) window.clearInterval(playbackRef.current);
    };
  }, []);

  useEffect(() => {
    // Re-hydrate whenever the route points at a different video — navigating
    // between videos keeps this component mounted, so `!draft` alone is stale.
    if (locationResult && (!draft || draftVideoId !== locationResult.video.id)) {
      setDraft({
        title: locationResult.video.title,
        duration: locationResult.video.duration,
        description: locationResult.video.description,
        published: locationResult.video.published,
        unlock: locationResult.video.unlock,
        addStaff: locationResult.video.addStaff,
        chapters: locationResult.video.chapters,
        thumbnailChapter: locationResult.video.thumbnailChapter,
        attachments: locationResult.video.attachments,
      });
      setDraftVideoId(locationResult.video.id);
      setScrub(0);
      setPlaying(false);
      if (playbackRef.current) {
        window.clearInterval(playbackRef.current);
        playbackRef.current = null;
      }
      // Hosted-file UI is per-video: reset it on switch. In-flight work for
      // the previous video keeps running server-side; its events are ignored
      // here thanks to currentVideoIdRef.
      currentVideoIdRef.current = locationResult.video.id;
      setUploadPhase('idle');
      setUploadPct(0);
      setUploadError(null);
      setDragOver(false);
      setStepStates(IDLE_STEPS);
      setStepErrors({});
      setAiActive(false);
      setAiProgress(null);
      setAiNote(null);
      setTranscriptOpen(false);
      setTranscriptState({ status: 'idle', segments: [] });
      setThumbBusy(false);
      setRemovingFile(false);
    }
  }, [locationResult, draft, draftVideoId]);

  if (!locationResult || !draft) {
    // Data still loading (or hydrating the draft) — don't flash "not found".
    if (status === 'loading' || status === 'error' || (locationResult && !draft)) {
      return (
        <AdminPage>
          {status === 'error' ? (
            <TrainingLoadError message={errorMessage} onRetry={refresh} />
          ) : (
            <TrainingLoading />
          )}
        </AdminPage>
      );
    }
    return (
      <AdminPage>
        <PageHeader
          kicker="Enablement — Training"
          title="Video not found"
          action={
            <Link href={params?.courseId ? `/admin/training/courses/${params.courseId}` : '/admin/training'} className={BTN_SECONDARY}>
              Back to course
            </Link>
          }
        />
        <SectionCard title="Not found" className="text-center py-12">
          <p className="text-sm text-muted-foreground">This video doesn't exist or was removed.</p>
        </SectionCard>
      </AdminPage>
    );
  }

  const { video, course, module, subgroup } = locationResult;
  const hosted = Boolean(video.videoSource);
  const durationSecs = draft.duration ?? video.duration;
  const isDirty = JSON.stringify(draft) !== JSON.stringify({
    title: video.title,
    duration: video.duration,
    description: video.description,
    published: video.published,
    unlock: video.unlock,
    addStaff: video.addStaff,
    chapters: video.chapters,
    thumbnailChapter: video.thumbnailChapter,
    attachments: video.attachments,
  });

  const handleSave = () => {
    void updateVideo(course.id, video.id, draft);
    if (canEdit) toast({ title: 'Video saved', description: 'Changes have been saved successfully.' });
  };

  const handleDiscard = () => {
    setDraft({
      title: video.title,
      duration: video.duration,
      description: video.description,
      published: video.published,
      unlock: video.unlock,
      addStaff: video.addStaff,
      chapters: video.chapters,
      thumbnailChapter: video.thumbnailChapter,
      attachments: video.attachments,
    });
    setPlaying(false);
    setScrub(0);
  };

  const togglePlayback = () => {
    if (playing) {
      if (playbackRef.current) window.clearInterval(playbackRef.current);
      setPlaying(false);
    } else {
      setPlaying(true);
      playbackRef.current = window.setInterval(() => {
        setScrub((prev) => {
          const next = prev + 1;
          if (next >= durationSecs) {
            if (playbackRef.current) window.clearInterval(playbackRef.current);
            setPlaying(false);
            return durationSecs;
          }
          return next;
        });
      }, 40); // Fake fast playback for demo
    }
  };

  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pos = (e.clientX - rect.left) / rect.width;
    setScrub(Math.round(pos * durationSecs));
  };

  const currentChapterIndex = chapterIndexAt({ chapters: draft.chapters ?? [] }, scrub);
  const engagement = getVideoEngagement(video.id, completions);
  const retention = getVideoRetention({ id: video.id, duration: durationSecs }, completions);

  /**
   * One SSE event from the AI pass. Results are already persisted server-side
   * when a step reports done — this mirrors them into the open draft so the
   * editor shows them instantly, but only if the user is still on that video.
   */
  const applyStepEvent = (runVideoId: string, event: ProcessEvent) => {
    const step = event.step;
    if (!step) return;
    const onThisVideo = currentVideoIdRef.current === runVideoId;
    if (onThisVideo && event.status) {
      setStepStates((prev) => ({ ...prev, [step]: event.status as StepStatus }));
      if (step === 'transcribe' && event.status === 'running' && typeof event.total === 'number') {
        setAiProgress({ done: typeof event.done === 'number' ? event.done : 0, total: event.total });
      }
      if (event.status === 'failed' && event.error) {
        setStepErrors((prev) => ({ ...prev, [step]: event.error }));
      }
    }
    if (event.status !== 'done') return;
    if (onThisVideo) {
      if (step === 'describe' && event.description) setDraftField('description', event.description);
      if (step === 'chapters' && event.chapters) setDraftField('chapters', event.chapters);
      if (step === 'transcribe' && event.transcript) {
        setTranscriptState({ status: 'ready', segments: event.transcript.segments });
      }
      if (step === 'thumbnail') reloadMedia();
    }
    refresh(); // the snapshot changed server-side either way
  };

  /** Start the AI pass (all steps, or a retry subset). Progress streams in. */
  const runPipeline = (runVideoId: string, steps?: ProcessStep[]) => {
    if (aiActive) return;
    const requested = steps && steps.length > 0 ? steps : [...PROCESS_STEPS];
    if (currentVideoIdRef.current === runVideoId) {
      setAiActive(true);
      setAiNote(null);
      setAiProgress(null);
      setStepStates((prev) => {
        const next = { ...prev };
        for (const step of requested) next[step] = 'pending';
        return next;
      });
      setStepErrors((prev) => {
        const next = { ...prev };
        for (const step of requested) delete next[step];
        return next;
      });
    }
    void (async () => {
      try {
        const outcome = await processVideo(runVideoId, steps, (event) => applyStepEvent(runVideoId, event));
        if (currentVideoIdRef.current === runVideoId && !outcome.ok) {
          setAiNote(outcome.error ?? 'Some AI steps failed — retry the ones marked below.');
        }
      } catch (error) {
        if (currentVideoIdRef.current === runVideoId) {
          setAiNote(error instanceof Error ? error.message : 'AI processing failed — try again.');
          setStepStates((prev) => {
            const next = { ...prev };
            for (const step of requested) {
              if (next[step] === 'pending' || next[step] === 'running') next[step] = 'failed';
            }
            return next;
          });
        }
      } finally {
        if (currentVideoIdRef.current === runVideoId) {
          setAiActive(false);
          setAiProgress(null);
        }
      }
    })();
  };

  /** Upload (or replace) the hosted file, then kick off the full AI pass. */
  const beginUpload = (file: File) => {
    if (!canEdit || uploadPhase !== 'idle') return;
    const problem = describeFileProblem(file);
    if (problem) {
      setUploadError(problem);
      return;
    }
    const contentType = resolveVideoType(file);
    if (!contentType) return; // describeFileProblem already caught this
    const runVideoId = video.id;
    setUploadError(null);
    setUploadPct(0);
    setUploadPhase('uploading');
    void (async () => {
      try {
        const { uploadUrl, objectPath } = await requestUploadUrl(runVideoId, file, contentType);
        await uploadToStorage(uploadUrl, file, contentType, (pct) => {
          if (currentVideoIdRef.current === runVideoId) setUploadPct(pct);
        });
        if (currentVideoIdRef.current === runVideoId) setUploadPhase('verifying');
        const result = await finalizeUpload(runVideoId, objectPath);
        refresh();
        if (currentVideoIdRef.current === runVideoId) {
          setDraftField('duration', result.durationSeconds);
          setUploadPhase('idle');
          setUploadPct(0);
          toast({
            title: 'Video uploaded',
            description: `Runtime ${formatClock(result.durationSeconds)} — starting the AI pass.`,
          });
        }
        runPipeline(runVideoId);
      } catch (error) {
        if (currentVideoIdRef.current === runVideoId) {
          setUploadPhase('idle');
          setUploadPct(0);
          setUploadError(error instanceof Error ? error.message : 'Upload failed — try again.');
        }
      }
    })();
  };

  const openTranscript = () => {
    setTranscriptOpen(true);
    if (transcriptState.status === 'ready' || transcriptState.status === 'loading') return;
    const runVideoId = video.id;
    setTranscriptState({ status: 'loading', segments: [] });
    void fetchTranscript(runVideoId)
      .then((segments) => {
        if (currentVideoIdRef.current !== runVideoId) return;
        setTranscriptState(
          segments ? { status: 'ready', segments } : { status: 'missing', segments: [] },
        );
      })
      .catch((error: unknown) => {
        if (currentVideoIdRef.current !== runVideoId) return;
        setTranscriptState({
          status: 'error',
          segments: [],
          message: error instanceof Error ? error.message : 'Could not load the transcript.',
        });
      });
  };

  const handleRemoveFile = () => {
    if (!hosted || removingFile) return;
    if (
      !window.confirm(
        'Removes the hosted video file, its transcript and its thumbnail from storage. The lesson entry and its metadata stay. This cannot be undone.',
      )
    )
      return;
    const runVideoId = video.id;
    setRemovingFile(true);
    void (async () => {
      try {
        await removeVideoFile(runVideoId);
        refresh();
        if (currentVideoIdRef.current === runVideoId) {
          setStepStates(IDLE_STEPS);
          setStepErrors({});
          setAiNote(null);
          setTranscriptState({ status: 'idle', segments: [] });
          toast({
            title: 'Video file removed',
            description: 'The lesson is back to the simulated slide experience.',
          });
        }
      } catch (error) {
        if (currentVideoIdRef.current === runVideoId) {
          toast({
            title: 'Could not remove the file',
            description: error instanceof Error ? error.message : 'Try again.',
          });
        }
      } finally {
        if (currentVideoIdRef.current === runVideoId) setRemovingFile(false);
      }
    })();
  };

  const generateDescription = () => {
    if (hosted) {
      // Written from the stored transcript server-side; fails plainly if
      // there is no transcript yet.
      runPipeline(video.id, ['describe']);
      return;
    }
    setAiSpinner('desc');
    setTimeout(() => {
      // Functional update: edits made during the fake generation must survive.
      setDraft((prev) => (prev ? { ...prev, description: aiDescription(prev.title ?? video.title, descVariant) } : prev));
      setDescVariant((v) => v + 1);
      setAiSpinner(null);
    }, 700);
  };

  const generateChapters = () => {
    if (hosted) {
      runPipeline(video.id, ['chapters']);
      return;
    }
    setAiSpinner('chapters');
    setTimeout(() => {
      setDraft((prev) => (prev ? { ...prev, chapters: aiChapters(video, chapterVariant) } : prev));
      setChapterVariant((v) => v + 1);
      setAiSpinner(null);
    }, 700);
  };

  const setDraftField = <K extends keyof VideoPatch>(field: K, value: VideoPatch[K]) => {
    setDraft((prev) => (prev ? { ...prev, [field]: value } : prev));
  };

  /** Next unique id within a list — demo clock is frozen, so no Date.now(). */
  const nextId = (prefix: string, existing: ReadonlyArray<{ id: string }>) => {
    let max = 0;
    for (const item of existing) {
      const m = /(\d+)$/.exec(item.id);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `${prefix}-${max + 1}`;
  };

  const addChapter = () => {
    const newChapter: TrainingChapter = {
      id: nextId('new-ch', draft.chapters ?? []),
      at: scrub,
      title: 'New Chapter'
    };
    const newChapters = [...(draft.chapters || []), newChapter].sort((a, b) => a.at - b.at);
    setDraftField('chapters', newChapters);
  };

  const updateChapter = (id: string, updates: Partial<TrainingChapter>) => {
    const current = draft.chapters ?? [];
    const newChapters = current.map(ch => ch.id === id ? { ...ch, ...updates } : ch).sort((a, b) => a.at - b.at);
    setDraftField('chapters', newChapters);
  };

  const removeChapter = (id: string) => {
    const current = draft.chapters ?? [];
    if (current.length <= 1) return;
    setDraftField('chapters', current.filter(ch => ch.id !== id));
  };

  const handleThumbnailDialog = () => {
    if (hosted) {
      // Real-frame scrubbing starts from wherever the preview is parked.
      setThumbnailScrub(Math.max(0, Math.min(scrub, Math.max(0, durationSecs - 1))));
    } else {
      setThumbnailScrub(draft.thumbnailChapter !== undefined && draft.chapters ? draft.chapters[draft.thumbnailChapter]?.at ?? 0 : 0);
    }
    setThumbnailDialogOpen(true);
  };

  const saveThumbnail = () => {
    const newIndex = chapterIndexAt({ chapters: draft.chapters ?? [] }, thumbnailScrub);
    void updateVideo(course.id, video.id, { thumbnailChapter: newIndex });
    setDraftField('thumbnailChapter', newIndex);
    if (canEdit) toast({ title: 'Thumbnail updated everywhere it appears.' });
    setThumbnailDialogOpen(false);
  };

  /** Hosted variant: the server captures the chosen frame with ffmpeg. */
  const captureHostedThumbnail = () => {
    if (thumbBusy) return;
    const runVideoId = video.id;
    setThumbBusy(true);
    void (async () => {
      try {
        await captureThumbnail(runVideoId, thumbnailScrub);
        refresh();
        if (currentVideoIdRef.current === runVideoId) {
          reloadMedia();
          setStepStates((prev) => ({ ...prev, thumbnail: 'done' }));
          toast({ title: 'Thumbnail updated everywhere it appears.' });
          setThumbnailDialogOpen(false);
        }
      } catch (error) {
        if (currentVideoIdRef.current === runVideoId) {
          toast({
            title: 'Could not capture that frame',
            description: error instanceof Error ? error.message : 'Try again.',
          });
        }
      } finally {
        if (currentVideoIdRef.current === runVideoId) setThumbBusy(false);
      }
    })();
  };
  
  const handleRemoveVideo = () => {
    const warning = hosted
      ? 'Deletes this video entry — its hosted file, transcript, chapters, attachment names and all viewer progress. This cannot be undone.'
      : 'Deletes this video entry — its chapters, attachment names and all viewer progress. This cannot be undone.';
    if (!window.confirm(warning)) return;
    void (async () => {
      if (hosted && canEdit) {
        // Take the file, transcript and thumbnail out of storage first so
        // deleting the row can't orphan them. If that fails, stop — the
        // entry stays, and the user hears why.
        try {
          await removeVideoFile(video.id);
        } catch (error) {
          toast({
            title: 'Could not remove the hosted file',
            description: `${error instanceof Error ? error.message : 'Try again.'} The video entry was not deleted.`,
          });
          return;
        }
      }
      await removeVideo(course.id, video.id);
      setLocation(`/admin/training/courses/${course.id}`);
    })();
  };
  
  const addAttachment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAttachmentName.trim()) return;
    const sizeKb = (hashId(newAttachmentName) % 800) + 50;
    const sizeLabel = sizeKb > 1024 ? `${(sizeKb / 1024).toFixed(1)} MB` : `${sizeKb} KB`;
    const current = draft.attachments ?? [];
    const newAtt = { id: nextId('att', current), name: newAttachmentName.trim(), sizeLabel };
    setDraftField('attachments', [...current, newAtt]);
    setNewAttachmentName('');
  };

  return (
    <AdminPage>
      <PageHeader
        className="mx-auto max-w-[1200px]"
        kicker="Enablement — Training"
        title={
          <span className="flex items-center gap-2">
            <Link href={`/admin/training/courses/${course.id}`} className="hover:underline opacity-60">
              {course.title}
            </Link>
            <ChevronRight size={14} className="opacity-40" />
            <span>{draft.title}</span>
          </span>
        }
        action={
          <div className="flex items-center gap-3">
            {isDirty && (
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground font-medium transition-colors"
                onClick={handleDiscard}
              >
                Discard
              </button>
            )}
            <Link href={`/admin/training/preview/${course.id}`} className={`${BTN_SECONDARY} h-9 px-3.5`}>
              <Eye size={14} /> Preview page
            </Link>
            <Link href={`/admin/training/courses/${course.id}`} className={`${BTN_SECONDARY} h-9 px-3.5`}>
              View course
            </Link>
            <button
              type="button"
              className={`${BTN_PRIMARY} h-9 px-4 disabled:cursor-not-allowed disabled:opacity-50`}
              onClick={handleSave}
              disabled={!isDirty}
              data-testid="button-save-video"
            >
              Save changes
            </button>
          </div>
        }
      />

      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 lg:flex-row">
        <div className="flex min-w-0 flex-col gap-6 lg:w-[60%]">
          
          {/* Player Card — real playback once a file is hosted, else the
              simulated slide deck (demo personas always get the deck: they
              have no staff session to stream with). */}
          <SectionCard title={null} className="p-0 overflow-hidden">
            {hosted && canEdit ? (
              media ? (
                <HostedVideoPlayer
                  src={media.videoUrl}
                  poster={media.thumbnailUrl}
                  chapters={draft.chapters ?? []}
                  durationSeconds={durationSecs}
                  onTimeChange={(seconds) => setScrub(Math.round(seconds))}
                  testId="player-hosted"
                />
              ) : mediaLoading ? (
                <div
                  className="flex aspect-video w-full items-center justify-center bg-navy/90"
                  data-testid="player-loading"
                >
                  <p className="text-xs font-semibold text-card">Loading the video…</p>
                </div>
              ) : (
                <div
                  className="flex aspect-video w-full flex-col items-center justify-center gap-3 bg-navy/90 px-6 text-center"
                  data-testid="player-error"
                >
                  <p className="text-xs font-semibold text-card" role="alert">
                    {mediaError ?? 'Could not load the video.'}
                  </p>
                  <button type="button" className={`${BTN_SECONDARY} h-8 px-3 text-[11px]`} onClick={reloadMedia}>
                    Try again
                  </button>
                </div>
              )
            ) : (
              <>
             <SlideFrame 
              video={{ ...video, title: draft.title ?? video.title, chapters: draft.chapters ?? [] }} 
              chapterIndex={currentChapterIndex} 
              className="rounded-none border-x-0 border-t-0"
            />
            <div className="bg-secondary px-4 py-3 flex items-center gap-4">
              <button 
                type="button" 
                className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={togglePlayback}
              >
                {playing ? <Pause size={14} className="fill-current" /> : <Play size={14} className="fill-current ml-0.5" />}
              </button>
              
              <div 
                className="flex-1 h-10 flex items-center relative cursor-pointer group"
                onClick={handleTimelineClick}
                data-testid="timeline-track"
              >
                <div className="absolute inset-x-0 h-1.5 bg-border rounded-full overflow-hidden">
                  <div 
                    className="absolute inset-y-0 left-0 bg-primary" 
                    style={{ width: `${(scrub / durationSecs) * 100}%` }}
                  />
                </div>
                {(draft.chapters ?? []).map((ch, i) => {
                   const pos = (ch.at / durationSecs) * 100;
                   return (
                     <div 
                       key={ch.id} 
                       className="absolute top-1/2 -mt-1 w-0.5 h-2 bg-foreground rounded-full group-hover:bg-primary z-10 transition-colors"
                       style={{ left: `${pos}%` }}
                     >
                       <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity bg-navy text-card text-[10px] font-bold px-2 py-1 rounded whitespace-nowrap pointer-events-none">
                         {formatClock(ch.at)} · {ch.title}
                       </div>
                     </div>
                   );
                })}
              </div>
              
              <div className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground w-16 text-right shrink-0">
                {formatClock(scrub)} / {formatClock(durationSecs)}
              </div>
            </div>
                {hosted && (
                  <p className="border-t border-border bg-secondary/50 px-4 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
                    A video file is hosted for this lesson — sign in as THINNR HQ to play it here.
                  </p>
                )}
              </>
            )}
          </SectionCard>

          {/* Details Card */}
          <SectionCard title="Details">
            <div className="p-5 space-y-5">
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground mb-1.5">
                  Title
                </label>
                <input
                  type="text"
                  className={`${INPUT_CLASS} w-full h-9 font-serif text-sm`}
                  value={draft.title ?? ''}
                  onChange={(e) => setDraftField('title', e.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground mb-1.5">
                    Sub-group
                  </label>
                  <select
                    className={`${INPUT_CLASS} w-full h-9`}
                    value={subgroup ? subgroup.id : ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      moveVideoToContainer(course.id, video.id, { 
                        moduleId: module.id, 
                        subgroupId: val || null 
                      });
                      toast({ title: 'Video moved.' });
                    }}
                  >
                    <option value="">None (no section)</option>
                    {module.entries.filter(e => e.kind === 'subgroup').map(e => e.kind === 'subgroup' ? (
                      <option key={e.subgroup.id} value={e.subgroup.id}>{e.subgroup.title}</option>
                    ) : null)}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground mb-1.5">
                    Published
                  </label>
                  <select
                    className={`${INPUT_CLASS} w-full h-9`}
                    value={draft.published}
                    onChange={(e) => setDraftField('published', e.target.value as any)}
                  >
                    <option value="published">Published</option>
                    <option value="draft">Draft</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground mb-1.5">
                    Unlock
                  </label>
                  <select
                    className={`${INPUT_CLASS} w-full h-9`}
                    value={draft.unlock}
                    onChange={(e) => setDraftField('unlock', e.target.value as any)}
                  >
                    <option value="sequential">Sequential</option>
                    <option value="free">Free</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground mb-1.5">
                    Add Staff
                  </label>
                  <select
                    className={`${INPUT_CLASS} w-full h-9`}
                    value={draft.addStaff}
                    onChange={(e) => setDraftField('addStaff', e.target.value as any)}
                  >
                    <option value="auto">Auto</option>
                    <option value="show">Show</option>
                    <option value="hidden">Hidden</option>
                  </select>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
                    Description
                  </label>
                  <button 
                    type="button"
                    className="text-[10px] font-bold uppercase tracking-[.12em] text-primary hover:text-primary/80 flex items-center gap-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={generateDescription}
                    disabled={hosted ? aiActive : aiSpinner === 'desc'}
                    title={hosted ? 'Written from the video transcript' : undefined}
                  >
                    {(hosted ? aiActive && (stepStates.describe === 'pending' || stepStates.describe === 'running') : aiSpinner === 'desc')
                      ? <RefreshCw size={12} className="animate-spin" />
                      : <Wand2 size={12} />}
                    Generate with AI
                  </button>
                </div>
                <textarea
                  className={`${INPUT_CLASS} w-full py-2 min-h-[120px]`}
                  value={(draft.description ?? []).join('\n\n')}
                  onChange={(e) => setDraftField('description', e.target.value.split('\n\n'))}
                />
              </div>
            </div>
          </SectionCard>

          {/* Chapters Card */}
          <SectionCard 
            title="Chapters" 
            sub="Chapters drive the slides, the timeline ticks and the thumbnail picker."
            action={
              <button 
                type="button"
                className="text-[10px] font-bold uppercase tracking-[.12em] text-primary hover:text-primary/80 flex items-center gap-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                onClick={generateChapters}
                disabled={hosted ? aiActive : aiSpinner === 'chapters'}
                title={hosted ? 'Created from the video transcript' : undefined}
              >
                {(hosted ? aiActive && (stepStates.chapters === 'pending' || stepStates.chapters === 'running') : aiSpinner === 'chapters')
                  ? <RefreshCw size={12} className="animate-spin" />
                  : <Wand2 size={12} />}
                Generate with AI
              </button>
            }
          >
             <div className="p-4 border-b border-border bg-card">
               <button 
                 type="button"
                 className="flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
                 onClick={addChapter}
               >
                 <Plus size={12} /> Add at current time
               </button>
             </div>
             <div className="divide-y divide-border">
               {(draft.chapters ?? []).map((ch, i) => (
                 <div key={ch.id} className="flex items-center gap-3 p-3 bg-card hover:bg-secondary/50 group">
                   <span className="text-[10px] font-bold text-muted-foreground w-6 text-center">{i + 1}</span>
                   <input
                     type="text"
                     className={`${INPUT_CLASS} w-16 h-8 text-center px-1 font-mono`}
                     value={formatClock(ch.at)}
                     onChange={(e) => {
                       const parts = e.target.value.split(':');
                       if (parts.length === 2 && !isNaN(Number(parts[0])) && !isNaN(Number(parts[1]))) {
                         updateChapter(ch.id, { at: Number(parts[0]) * 60 + Number(parts[1]) });
                       }
                     }}
                   />
                   <input
                     type="text"
                     className={`${INPUT_CLASS} flex-1 h-8`}
                     value={ch.title}
                     onChange={(e) => updateChapter(ch.id, { title: e.target.value })}
                   />
                   <button 
                     type="button"
                     className="text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity p-1.5"
                     onClick={() => removeChapter(ch.id)}
                     disabled={(draft.chapters ?? []).length <= 1}
                   >
                     <Trash2 size={14} />
                   </button>
                 </div>
               ))}
             </div>
          </SectionCard>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-6">
          
          {/* Media Card */}
          <SectionCard title="Media">
             <div className="p-4 space-y-5">
               <div>
                 <p className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground mb-2">Video file</p>
                 {hosted ? (
                   <div className="flex items-center gap-3 rounded-md border border-border bg-card p-3" data-testid="notice-video-on-file">
                     <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-accent-border bg-accent text-primary">
                       <Film size={16} aria-hidden="true" />
                     </span>
                     <div className="min-w-0 flex-1">
                       <p className="text-xs font-semibold text-foreground">Video on file · {formatClock(video.duration)}</p>
                       <p className="text-[10px] leading-relaxed text-muted-foreground">
                         Streams from App Storage for signed-in staff{canEdit ? ' — drop a new file below to replace it' : ''}.
                       </p>
                     </div>
                   </div>
                 ) : (
                   <div className="w-full border border-dashed border-border rounded-md bg-secondary/50 p-5 flex flex-col items-center justify-center gap-2 text-center" data-testid="notice-no-video-file">
                     <Film size={18} className="text-muted-foreground" aria-hidden="true" />
                     <p className="text-xs font-medium text-foreground">No video file yet</p>
                     <p className="text-[10px] leading-relaxed text-muted-foreground">
                       {canEdit
                         ? 'Learners see the simulated workbook slides until one is uploaded. Drop a file below — AI pulls the transcript, writes the description, creates the chapters and sets the thumbnail.'
                         : 'Learners see the simulated workbook slides. Sign in as THINNR HQ to upload a file.'}
                     </p>
                   </div>
                 )}

                 {canEdit && (
                   <>
                     <div
                       className={`mt-3 w-full rounded-md border border-dashed p-4 text-center transition-colors ${dragOver ? 'border-primary bg-accent/40' : 'border-border bg-secondary/50'}`}
                       onDragOver={(e) => {
                         e.preventDefault();
                         setDragOver(true);
                       }}
                       onDragLeave={() => setDragOver(false)}
                       onDrop={(e) => {
                         e.preventDefault();
                         setDragOver(false);
                         const file = e.dataTransfer.files?.[0];
                         if (file) beginUpload(file);
                       }}
                       data-testid="dropzone-video-upload"
                     >
                       {uploadPhase === 'idle' ? (
                         <div className="flex flex-col items-center gap-2">
                           <Upload size={16} className="text-muted-foreground" aria-hidden="true" />
                           <p className="text-xs font-medium text-foreground">
                             {hosted ? 'Drop a new video here to replace the current one' : 'Drag a video here'}
                           </p>
                           <button
                             type="button"
                             className={`${BTN_SECONDARY} h-8 px-3 text-[11px]`}
                             onClick={() => fileInputRef.current?.click()}
                             data-testid="button-browse-video"
                           >
                             Browse files
                           </button>
                           <p className="text-[10px] text-muted-foreground">MP4, WebM or MOV · up to 500 MB</p>
                         </div>
                       ) : uploadPhase === 'uploading' ? (
                         <div className="space-y-2" data-testid="progress-video-upload">
                           <p className="text-xs font-medium text-foreground">Uploading… {uploadPct}%</p>
                           <div
                             className="h-1.5 w-full overflow-hidden rounded-full bg-border"
                             role="progressbar"
                             aria-valuemin={0}
                             aria-valuemax={100}
                             aria-valuenow={uploadPct}
                             aria-label="Upload progress"
                           >
                             <div className="h-full bg-primary transition-[width]" style={{ width: `${uploadPct}%` }} />
                           </div>
                         </div>
                       ) : (
                         <p
                           className="flex items-center justify-center gap-2 text-xs font-medium text-foreground"
                           data-testid="text-upload-verifying"
                         >
                           <RefreshCw size={12} className="animate-spin text-primary" aria-hidden="true" />
                           Checking the file and reading its runtime…
                         </p>
                       )}
                     </div>
                     <input
                       ref={fileInputRef}
                       type="file"
                       accept="video/mp4,video/webm,video/quicktime,.mp4,.m4v,.webm,.mov"
                       className="hidden"
                       onChange={(e) => {
                         const file = e.target.files?.[0];
                         if (file) beginUpload(file);
                         e.target.value = '';
                       }}
                       data-testid="input-video-file"
                     />
                     {uploadError && (
                       <p className="mt-2 text-[11px] font-medium text-destructive" role="alert" data-testid="text-upload-error">
                         {uploadError}
                       </p>
                     )}
                   </>
                 )}

                 {hosted && canEdit && (
                   <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                     <button
                       type="button"
                       className="flex items-center gap-1.5 text-xs font-semibold text-foreground transition-colors hover:text-primary"
                       onClick={openTranscript}
                       data-testid="button-view-transcript"
                     >
                       <FileText size={13} aria-hidden="true" /> View transcript
                     </button>
                     <button
                       type="button"
                       className="flex items-center gap-1.5 text-xs font-semibold text-foreground transition-colors hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
                       onClick={() => runPipeline(video.id)}
                       disabled={aiActive}
                       data-testid="button-run-ai"
                     >
                       <Wand2 size={13} aria-hidden="true" /> Run AI processing
                     </button>
                   </div>
                 )}

                 {hosted && canEdit && (aiActive || aiNote !== null || PROCESS_STEPS.some((step) => stepStates[step] !== 'idle')) && (
                   <div className="mt-3 rounded-md border border-border bg-card" data-testid="panel-ai-steps">
                     <p className="border-b border-border px-3 py-2 text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
                       AI processing
                     </p>
                     <ul className="divide-y divide-border">
                       {PROCESS_STEPS.map((step) => {
                         const state = stepStates[step];
                         return (
                           <li key={step} className="flex items-start gap-2.5 px-3 py-2" data-testid={`step-ai-${step}`}>
                             <span className="mt-0.5 shrink-0">
                               {state === 'running' ? (
                                 <RefreshCw size={13} className="animate-spin text-primary" aria-hidden="true" />
                               ) : state === 'done' ? (
                                 <CheckCircle2 size={13} className="text-primary" aria-hidden="true" />
                               ) : state === 'failed' ? (
                                 <AlertTriangle size={13} className="text-destructive" aria-hidden="true" />
                               ) : (
                                 <span
                                   className={`block h-[13px] w-[13px] rounded-full border ${state === 'pending' ? 'border-primary/50' : 'border-border'}`}
                                   aria-hidden="true"
                                 />
                               )}
                             </span>
                             <span className="min-w-0 flex-1">
                               <span className="block text-xs font-medium text-foreground">{STEP_LABELS[step]}</span>
                               <span className="block text-[10px] leading-relaxed text-muted-foreground" data-testid={`status-ai-${step}`}>
                                 {state === 'running' && step === 'transcribe' && aiProgress
                                   ? `Transcribing minute ${Math.min(aiProgress.done + 1, aiProgress.total)} of ${aiProgress.total}…`
                                   : state === 'running'
                                     ? 'Working…'
                                     : state === 'done'
                                       ? 'Done'
                                       : state === 'failed'
                                         ? stepErrors[step] ?? 'Failed — retry below.'
                                         : state === 'skipped'
                                           ? 'Skipped — waiting on the transcript.'
                                           : state === 'pending'
                                             ? 'Queued'
                                             : 'Not run yet'}
                               </span>
                             </span>
                           </li>
                         );
                       })}
                     </ul>
                     {(aiNote !== null ||
                       (!aiActive && PROCESS_STEPS.some((s) => stepStates[s] === 'failed' || stepStates[s] === 'skipped'))) && (
                       <div className="space-y-2 border-t border-border px-3 py-2.5">
                         {aiNote && (
                           <p className="text-[11px] font-medium text-destructive" role="alert" data-testid="text-ai-note">
                             {aiNote}
                           </p>
                         )}
                         {!aiActive && PROCESS_STEPS.some((s) => stepStates[s] === 'failed' || stepStates[s] === 'skipped') && (
                           <button
                             type="button"
                             className={`${BTN_SECONDARY} h-8 gap-1.5 px-3 text-[11px]`}
                             onClick={() =>
                               runPipeline(
                                 video.id,
                                 PROCESS_STEPS.filter((s) => stepStates[s] === 'failed' || stepStates[s] === 'skipped'),
                               )
                             }
                             data-testid="button-retry-ai"
                           >
                             <RefreshCw size={12} aria-hidden="true" /> Retry failed steps
                           </button>
                         )}
                       </div>
                     )}
                   </div>
                 )}

                 <div className="mt-3">
                   {hosted ? (
                     <div data-testid="text-video-duration-hosted">
                       <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">Duration</p>
                       <p className="font-mono text-sm text-foreground">{formatClock(durationSecs)}</p>
                       <p className="mt-1.5 text-[10px] text-muted-foreground">Measured from the uploaded file.</p>
                     </div>
                   ) : (
                     <>
                       <label htmlFor="video-duration" className="mb-1.5 block text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
                         Duration (mm:ss)
                       </label>
                       <input
                         id="video-duration"
                         type="text"
                         className={`${INPUT_CLASS} h-8 w-24 px-1 text-center font-mono`}
                         value={formatClock(durationSecs)}
                         onChange={(e) => {
                           const parts = e.target.value.split(':');
                           if (parts.length === 2 && !isNaN(Number(parts[0])) && !isNaN(Number(parts[1]))) {
                             setDraftField('duration', Math.max(30, Number(parts[0]) * 60 + Number(parts[1])));
                           }
                         }}
                         data-testid="input-video-duration"
                       />
                       <p className="mt-1.5 text-[10px] text-muted-foreground">
                         Listed runtime for learners — it fills in automatically once a video file is uploaded.
                       </p>
                     </>
                   )}
                 </div>
               </div>
               
               <div>
                 <p className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground mb-2">Thumbnail</p>
                 <div className="flex gap-4">
                   <div className="w-[120px] shrink-0 border border-border rounded overflow-hidden">
                     {hosted && media?.thumbnailUrl ? (
                       <img
                         src={media.thumbnailUrl}
                         alt="Current thumbnail — a frame captured from the video"
                         className="block aspect-video w-full object-cover"
                         data-testid="img-video-thumbnail"
                       />
                     ) : (
                       <SlideFrame
                         video={{ ...video, title: draft.title ?? video.title, chapters: draft.chapters ?? [] }}
                         chapterIndex={draft.thumbnailChapter ?? 0}
                         compact
                       />
                     )}
                   </div>
                   <div className="flex flex-col justify-center gap-2">
                     <button 
                       type="button" 
                       className="text-xs font-semibold text-foreground flex items-center gap-2 hover:text-primary transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                       onClick={handleThumbnailDialog}
                       disabled={hosted && canEdit && !media}
                     >
                       <ImageIcon size={13} /> Generate thumbnail
                     </button>
                     <p className="text-[10px] leading-relaxed text-muted-foreground">
                       {hosted
                         ? 'Scrub the real video and capture any frame — the AI pass starts with the first frame.'
                         : 'Thumbnails come from chapter slides — upload a video to capture real frames.'}
                     </p>
                   </div>
                 </div>
               </div>
             </div>
          </SectionCard>

          {/* File Attachments Card */}
          <SectionCard 
            title="File attachments"
            sub="Name-only metadata — the files themselves aren't hosted yet."
          >
            <div className="divide-y divide-border">
              {(draft.attachments ?? []).length === 0 && (
                <div className="p-4 text-center text-xs text-muted-foreground">
                  No attachments yet. Add worksheets, PDFs, or other resources.
                </div>
              )}
              {(draft.attachments ?? []).map((att) => (
                <div key={att.id} className="flex items-center gap-3 p-3 bg-card group">
                  <Paperclip size={14} className="text-muted-foreground shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-foreground truncate">{att.name}</p>
                    <p className="text-[10px] text-muted-foreground">{att.sizeLabel}</p>
                  </div>
                  <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                     <button 
                       type="button" 
                       className="text-[10px] font-bold uppercase tracking-[.12em] text-primary hover:underline px-2"
                       onClick={() => toast({ title: 'No file to download', description: 'Attachments are name-only metadata — only the lesson video itself is hosted.' })}
                     >
                       Download
                     </button>
                     <button 
                       type="button" 
                       className="text-muted-foreground hover:text-destructive p-1"
                       onClick={() => {
                         const current = draft.attachments ?? [];
                         setDraftField('attachments', current.filter(a => a.id !== att.id));
                       }}
                     >
                       <X size={14} />
                     </button>
                  </div>
                </div>
              ))}
              <div className="p-3 bg-secondary/30">
                <form onSubmit={addAttachment} className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Add file name..."
                    className={`${INPUT_CLASS} flex-1 h-8`}
                    value={newAttachmentName}
                    onChange={(e) => setNewAttachmentName(e.target.value)}
                  />
                  <button type="submit" className={`${BTN_SECONDARY} h-8 px-3 text-[11px]`}>
                    Add
                  </button>
                </form>
              </div>
            </div>
          </SectionCard>

          {/* Retention Card — survival curve + this video's live engagement numbers */}
          <SectionCard
            title="Retention"
            sub="Share of viewers still watching at each point of the timeline."
          >
            <div className="p-5">
              {retention.points.length > 0 ? (
                <div data-testid="panel-retention-curve">
                  <div
                    role="img"
                    aria-label={`Retention curve: 100% of viewers at the start, ${retention.points[retention.points.length - 1]!.pct}% still watching at ${formatClock(durationSecs)}.`}
                    className="overflow-hidden rounded-md border border-border bg-secondary/30 p-2"
                  >
                    <RetentionChart points={retention.points} />
                  </div>
                  <div aria-hidden="true" className="mt-1.5 flex items-center justify-between text-[9px] font-bold uppercase tracking-[.12em] text-muted-foreground">
                    <span>0:00</span>
                    <span>{formatClock(durationSecs)}</span>
                  </div>
                  <p className="mt-2.5 text-[11px] leading-relaxed text-muted-foreground" data-testid="text-retention-caption">
                    {retention.viewers} {retention.viewers === 1 ? 'viewer' : 'viewers'} — deep drops show where people stop watching
                  </p>
                </div>
              ) : (
                <p
                  className="rounded-md border border-dashed border-border bg-secondary/30 px-4 py-6 text-center text-xs text-muted-foreground"
                  data-testid="text-retention-empty"
                >
                  No viewer has opened this video yet — the retention curve fills in as people watch.
                </p>
              )}

              <div className="mt-5 grid grid-cols-2 gap-4 border-t border-border pt-4">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">Started</p>
                  <p className="mt-1 font-serif text-[22px] font-bold leading-none text-navy" data-testid="text-engagement-started">
                    {engagement.started}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">Completed</p>
                  <p className="mt-1 font-serif text-[22px] font-bold leading-none text-navy" data-testid="text-engagement-completed">
                    {engagement.completed}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">Completion rate</p>
                  <p className="mt-1 font-serif text-[22px] font-bold leading-none text-navy" data-testid="text-engagement-rate">
                    {engagement.completionPct === null ? '—' : `${engagement.completionPct}%`}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">Watch time</p>
                  <p className="mt-1 font-serif text-[22px] font-bold leading-none text-navy" data-testid="text-engagement-watch">
                    {formatHours(engagement.totalWatchSeconds)}
                  </p>
                </div>
              </div>
            </div>
          </SectionCard>

        </div>
      </div>

      {/* Danger Zone — the page's very last section, below both columns */}
      <div className="mx-auto mt-6 w-full max-w-[1200px] rounded-lg border border-destructive/30 bg-[#fff0f0]/30 p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-destructive mb-1.5">Danger Zone</h3>
        {hosted && canEdit && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card px-4 py-3">
            <p className="max-w-[52ch] text-xs leading-relaxed text-muted-foreground">
              <span className="font-semibold text-foreground">Remove the video file.</span> Takes the hosted file,
              its transcript and its thumbnail out of storage — the lesson entry and its metadata stay.
            </p>
            <button
              type="button"
              className="h-8 rounded-md border border-border bg-card px-3 text-xs font-semibold text-foreground transition-colors hover:border-destructive hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
              onClick={handleRemoveFile}
              disabled={removingFile}
              data-testid="button-remove-video-file"
            >
              {removingFile ? 'Removing…' : 'Remove video file'}
            </button>
          </div>
        )}
        <p className="text-xs text-muted-foreground mb-4 leading-relaxed max-w-[68ch]">
          {hosted
            ? 'Deletes this video entry — its hosted file, transcript, chapters, attachment names and all viewer progress. This cannot be undone.'
            : 'Deletes this video entry — its chapters, attachment names and all viewer progress. There is no hosted file to remove. This cannot be undone.'}
        </p>
        <button
          type="button"
          className="h-8 px-3 text-xs font-semibold text-destructive border border-destructive bg-card rounded-md hover:bg-destructive hover:text-white transition-colors"
          onClick={handleRemoveVideo}
        >
          Delete video
        </button>
      </div>

      <Dialog open={thumbnailDialogOpen} onOpenChange={setThumbnailDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">Scrub to the frame you want</DialogTitle>
            <DialogDescription>
              {formatClock(thumbnailScrub)} / {formatClock(durationSecs)}
            </DialogDescription>
          </DialogHeader>
          
          <div className="my-4">
             {hosted && media ? (
               <div className="mb-4 overflow-hidden rounded-md border border-border bg-navy">
                 <video
                   ref={thumbVideoRef}
                   src={media.videoUrl}
                   preload="auto"
                   muted
                   playsInline
                   className="block aspect-video w-full object-contain"
                   data-testid="video-thumbnail-preview"
                 />
               </div>
             ) : (
             <div className="rounded-md border border-border overflow-hidden bg-muted/20 mb-4 flex justify-center p-4">
               <div className="w-[80%]">
                 <SlideFrame 
                   video={{ ...video, title: draft.title ?? video.title, chapters: draft.chapters ?? [] }} 
                   chapterIndex={chapterIndexAt({ chapters: draft.chapters ?? [] }, thumbnailScrub)}
                 />
               </div>
             </div>
             )}
             
             <input
               type="range"
               min={0}
               max={Math.max(1, hosted ? Math.max(0, Math.floor(durationSecs - 1)) : durationSecs)}
               step={1}
               value={thumbnailScrub}
               onChange={(e) => setThumbnailScrub(Number(e.target.value))}
               className="w-full accent-primary"
               aria-label="Scrub to a frame"
               data-testid="input-thumbnail-scrub"
             />
          </div>

          <DialogFooter>
            <button type="button" className={`${BTN_SECONDARY} h-9 px-4`} onClick={() => setThumbnailDialogOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className={`${BTN_PRIMARY} h-9 px-4`}
              onClick={hosted ? captureHostedThumbnail : saveThumbnail}
              disabled={hosted && (thumbBusy || !media)}
              data-testid="button-use-frame"
            >
              {hosted && thumbBusy ? 'Capturing…' : 'Use this frame'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={transcriptOpen} onOpenChange={setTranscriptOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">Transcript</DialogTitle>
            <DialogDescription>
              Pulled from the video&rsquo;s audio — the description and chapters are written from it.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1" data-testid="dialog-transcript-body">
            {transcriptState.status === 'loading' && (
              <p className="text-xs text-muted-foreground">Loading the transcript…</p>
            )}
            {transcriptState.status === 'missing' && (
              <p className="text-xs text-muted-foreground" data-testid="text-transcript-missing">
                No transcript yet — run AI processing to pull one from the video&rsquo;s audio.
              </p>
            )}
            {transcriptState.status === 'error' && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-destructive" role="alert">
                  {transcriptState.message}
                </p>
                <button type="button" className={`${BTN_SECONDARY} h-8 px-3 text-[11px]`} onClick={openTranscript}>
                  Try again
                </button>
              </div>
            )}
            {transcriptState.status === 'ready' &&
              transcriptState.segments.map((segment) => (
                <div key={segment.at} className="flex gap-3">
                  <span className="w-12 shrink-0 pt-0.5 text-right text-[10px] font-bold tabular-nums text-muted-foreground">
                    {formatClock(segment.at)}
                  </span>
                  <p className="min-w-0 flex-1 text-xs leading-relaxed text-foreground/90">{segment.text}</p>
                </div>
              ))}
          </div>
          <DialogFooter>
            <button type="button" className={`${BTN_SECONDARY} h-9 px-4`} onClick={() => setTranscriptOpen(false)}>
              Close
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  );
}
