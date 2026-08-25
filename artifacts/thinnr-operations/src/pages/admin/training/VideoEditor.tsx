import { useState, useEffect, useRef } from 'react';
import { useRoute, useLocation, Link } from 'wouter';
import {
  ChevronRight,
  Eye,
  Trash2,
  Image as ImageIcon,
  Film,
  Paperclip,
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
  hashId,
  type TrainingChapter,
  type TrainingVideo
} from '@/data/hq/training';
import { useTrainingData, type VideoPatch } from '@/contexts/training-data';
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

  const playbackRef = useRef<number | null>(null);

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

  const generateDescription = () => {
    setAiSpinner('desc');
    setTimeout(() => {
      // Functional update: edits made during the fake generation must survive.
      setDraft((prev) => (prev ? { ...prev, description: aiDescription(prev.title ?? video.title, descVariant) } : prev));
      setDescVariant((v) => v + 1);
      setAiSpinner(null);
    }, 700);
  };

  const generateChapters = () => {
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
    setThumbnailScrub(draft.thumbnailChapter !== undefined && draft.chapters ? draft.chapters[draft.thumbnailChapter]?.at ?? 0 : 0);
    setThumbnailDialogOpen(true);
  };

  const saveThumbnail = () => {
    const newIndex = chapterIndexAt({ chapters: draft.chapters ?? [] }, thumbnailScrub);
    void updateVideo(course.id, video.id, { thumbnailChapter: newIndex });
    setDraftField('thumbnailChapter', newIndex);
    if (canEdit) toast({ title: 'Thumbnail updated everywhere it appears.' });
    setThumbnailDialogOpen(false);
  };
  
  const handleRemoveVideo = () => {
    if (!window.confirm('Deletes this video entry — its chapters, attachment names and all viewer progress. This cannot be undone.')) return;
    void (async () => {
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
            <Link href={`/admin/training/preview/${course.id}`} className={BTN_SECONDARY}>
              <Eye size={14} /> Preview page
            </Link>
            <Link href={`/admin/training/courses/${course.id}`} className={BTN_SECONDARY}>
              View course
            </Link>
            <button
              type="button"
              className={BTN_PRIMARY}
              onClick={handleSave}
              disabled={!isDirty}
              data-testid="button-save-video"
            >
              Save changes
            </button>
          </div>
        }
      />

      <div className="flex flex-col lg:flex-row gap-6">
        <div className="flex-1 flex flex-col gap-6 min-w-0">
          
          {/* Player Card */}
          <SectionCard title={null} className="p-0 overflow-hidden">
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
          </SectionCard>

          {/* Chapters Card */}
          <SectionCard 
            title="Chapters" 
            sub="Chapters drive the slides, the timeline ticks and the thumbnail picker."
            action={
              <button 
                type="button"
                className="text-[10px] font-bold uppercase tracking-[.12em] text-primary hover:text-primary/80 flex items-center gap-1.5 transition-colors"
                onClick={generateChapters}
                disabled={aiSpinner === 'chapters'}
              >
                {aiSpinner === 'chapters' ? <RefreshCw size={12} className="animate-spin" /> : <Wand2 size={12} />}
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
                    className="text-[10px] font-bold uppercase tracking-[.12em] text-primary hover:text-primary/80 flex items-center gap-1.5 transition-colors"
                    onClick={generateDescription}
                    disabled={aiSpinner === 'desc'}
                  >
                    {aiSpinner === 'desc' ? <RefreshCw size={12} className="animate-spin" /> : <Wand2 size={12} />}
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
        </div>

        <div className="lg:w-[360px] flex flex-col gap-6 shrink-0">
          
          {/* Media Card */}
          <SectionCard title="Media">
             <div className="p-4 space-y-5">
               <div>
                 <p className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground mb-2">Video file</p>
                 <div className="w-full border border-dashed border-border rounded-md bg-secondary/50 p-5 flex flex-col items-center justify-center gap-2 text-center" data-testid="notice-no-video-file">
                   <Film size={18} className="text-muted-foreground" aria-hidden="true" />
                   <p className="text-xs font-medium text-foreground">No video file — hosting isn&rsquo;t set up yet</p>
                   <p className="text-[10px] leading-relaxed text-muted-foreground">
                     This entry stores metadata only: title, duration, chapters and attachment names. A storage
                     provider can be plugged in later without losing anything here.
                   </p>
                 </div>
                 <div className="mt-3">
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
                     Listed runtime for learners — there&rsquo;s no file to measure, so set it here.
                   </p>
                 </div>
               </div>
               
               <div>
                 <p className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground mb-2">Thumbnail</p>
                 <div className="flex gap-4">
                   <div className="w-[120px] shrink-0 border border-border rounded overflow-hidden">
                     <SlideFrame 
                       video={{ ...video, title: draft.title ?? video.title, chapters: draft.chapters ?? [] }} 
                       chapterIndex={draft.thumbnailChapter ?? 0}
                       compact
                     />
                   </div>
                   <div className="flex flex-col justify-center gap-2">
                     <button 
                       type="button" 
                       className="text-xs font-semibold text-foreground flex items-center gap-2 hover:text-primary transition-colors"
                       onClick={handleThumbnailDialog}
                     >
                       <ImageIcon size={13} /> Generate thumbnail
                     </button>
                     <p className="text-[10px] leading-relaxed text-muted-foreground">
                       Thumbnails come from chapter slides — image uploads need file hosting.
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
                       onClick={() => toast({ title: 'No file to download', description: "Attachments are metadata only — file hosting isn't set up yet." })}
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

          {/* Engagement Card — real numbers from completion rows */}
          <SectionCard 
            title="Engagement"
            sub="Live numbers from this video's completion rows."
          >
            <div className="p-5">
              <div className="grid grid-cols-2 gap-4">
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
              {engagement.started === 0 && (
                <p className="mt-4 text-[10px] leading-relaxed text-muted-foreground">
                  No viewer has opened this video yet.
                </p>
              )}
            </div>
          </SectionCard>

          {/* Danger Zone */}
          <div className="border border-destructive/30 rounded-lg p-5 bg-[#fff0f0]/30 shadow-sm mt-4">
             <h3 className="text-sm font-semibold text-destructive mb-1.5">Danger Zone</h3>
             <p className="text-xs text-muted-foreground mb-4 leading-relaxed">
               Deletes this video entry — its chapters, attachment names and all viewer progress. There is no hosted
               file to remove. This cannot be undone.
             </p>
             <button 
               type="button"
               className="h-8 px-3 text-xs font-semibold text-destructive border border-destructive bg-card rounded-md hover:bg-destructive hover:text-white transition-colors"
               onClick={handleRemoveVideo}
             >
               Delete video
             </button>
          </div>

        </div>
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
             <div className="rounded-md border border-border overflow-hidden bg-muted/20 mb-4 flex justify-center p-4">
               <div className="w-[80%]">
                 <SlideFrame 
                   video={{ ...video, title: draft.title ?? video.title, chapters: draft.chapters ?? [] }} 
                   chapterIndex={chapterIndexAt({ chapters: draft.chapters ?? [] }, thumbnailScrub)}
                 />
               </div>
             </div>
             
             <input
               type="range"
               min={0}
               max={durationSecs}
               step={1}
               value={thumbnailScrub}
               onChange={(e) => setThumbnailScrub(Number(e.target.value))}
               className="w-full accent-primary"
             />
          </div>

          <DialogFooter>
            <button type="button" className={BTN_SECONDARY} onClick={() => setThumbnailDialogOpen(false)}>
              Cancel
            </button>
            <button type="button" className={BTN_PRIMARY} onClick={saveThumbnail}>
              Use this frame
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  );
}
