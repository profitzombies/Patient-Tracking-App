import { useState } from 'react';
import { Link, useParams } from 'wouter';
import {
  ChevronLeft,
  Copy,
  GripVertical,
  Link2,
  Lock,
  Pencil,
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  Eye,
  EyeOff,
} from 'lucide-react';
import {
  useTrainingData,
  type VideoPatch,
} from '@/contexts/training-data';
import {
  formatClock,
  getOrderedVideos,
  type TrainingCourse,
  type TrainingModule,
  type TrainingSubgroup,
  type TrainingVideo,
} from '@/data/hq/training';
import { AdminPage, PageHeader, copyText } from '@/components/admin/primitives';
import { CourseLiveChip, TrainingLoading, TrainingLoadError } from '@/components/admin/training/shared';
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  CHIP_COBALT,
  CHIP_WARM,
  INPUT_CLASS,
  INSET,
  LINK_ACTION,
} from '@/components/patient/heritage';
import { useToast } from '@/hooks/use-toast';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const UNLOCK_LABELS = {
  sequential: 'Sequential',
  free: 'Video by video',
};

const ADD_STAFF_LABELS = {
  auto: 'Add Staff: Auto',
  show: 'Add Staff: Show',
  hidden: 'Add Staff: Hidden',
};

// ---------------------------------------------------------------------------
// Helper Components
// ---------------------------------------------------------------------------

function InlineRename({ value, onSave, className = '' }: { value: string; onSave: (v: string) => void; className?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (!editing) {
    return (
      <div className={`group flex items-center gap-2 ${className}`}>
        <span>{value}</span>
        <button
          type="button"
          onClick={() => {
            setDraft(value);
            setEditing(true);
          }}
          className="opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100 text-muted-foreground hover:text-navy"
          aria-label="Rename"
        >
          <Pencil size={12} />
        </button>
      </div>
    );
  }

  const handleSave = () => {
    if (draft.trim() && draft.trim() !== value) onSave(draft.trim());
    setEditing(false);
  };

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <input
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        className={`${INPUT_CLASS} h-7 py-0 text-[inherit] font-[inherit] w-[200px]`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSave();
          if (e.key === 'Escape') setEditing(false);
        }}
        onBlur={handleSave}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Video Row
// ---------------------------------------------------------------------------

function VideoRow({
  course,
  module,
  subgroup,
  video,
  numbering,
  position,
  totalVideos,
}: {
  course: TrainingCourse;
  module: TrainingModule;
  subgroup: TrainingSubgroup | null;
  video: TrainingVideo;
  numbering: string;
  position: number;
  totalVideos: number;
}) {
  const { updateVideo, removeVideo, moveVideo, moveVideoToContainer } = useTrainingData();

  const handleMove = (direction: 'up' | 'down') => {
    moveVideo(course.id, video.id, direction);
  };

  const handleContainerChange = (val: string) => {
    const [moduleId, subgroupId] = val.split('::');
    moveVideoToContainer(course.id, video.id, {
      moduleId: moduleId!,
      subgroupId: subgroupId || null,
    });
  };

  return (
    <div
      className="group flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border py-2 text-xs first:border-t-0"
      data-testid={`row-video-${video.id}`}
    >
      <div className="flex shrink-0 items-center gap-2 text-muted-foreground">
        <GripVertical size={14} className="opacity-30" />
        <span className="w-8 font-mono text-[10px] tracking-wider">{numbering}</span>
      </div>

      <div className="flex min-w-[200px] flex-1 items-center gap-3">
        <Link
          href={`/admin/training/courses/${course.id}/videos/${video.id}`}
          className="font-medium text-navy hover:underline"
        >
          {video.title}
        </Link>
        <span className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
          {formatClock(video.duration)}
        </span>
        {video.published === 'draft' && (
          <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[.12em] text-muted-foreground">
            Draft
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Select
          value={video.unlock}
          onValueChange={(val: any) => updateVideo(course.id, video.id, { unlock: val })}
        >
          <SelectTrigger className="h-7 w-[110px] border-none bg-transparent px-2 py-0 text-[11px] shadow-none hover:bg-secondary focus:ring-0">
            <div className="flex items-center gap-1.5">
              <Lock size={12} className="text-muted-foreground" />
              <SelectValue />
            </div>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="sequential">Sequential</SelectItem>
            <SelectItem value="free">Video by video</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={video.published}
          onValueChange={(val: any) => updateVideo(course.id, video.id, { published: val })}
        >
          <SelectTrigger
            className={`h-7 w-[100px] border-none bg-transparent px-2 py-0 text-[11px] shadow-none hover:bg-secondary focus:ring-0 ${
              video.published === 'published' ? 'text-primary' : 'text-muted-foreground'
            }`}
            title="Draft hides it from learners; admins still see it"
          >
            <div className="flex items-center gap-1.5">
              {video.published === 'published' ? <Eye size={12} /> : <EyeOff size={12} />}
              <SelectValue />
            </div>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="published">Published</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={video.addStaff}
          onValueChange={(val: any) => updateVideo(course.id, video.id, { addStaff: val })}
        >
          <SelectTrigger
            className="h-7 w-[130px] border-none bg-transparent px-2 py-0 text-[11px] shadow-none hover:bg-secondary focus:ring-0"
            title="Auto shows the Add-staff button only on the first video of the course"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Auto (on first)</SelectItem>
            <SelectItem value="show">Show button</SelectItem>
            <SelectItem value="hidden">Hide button</SelectItem>
          </SelectContent>
        </Select>

        <div className="mx-2 h-4 w-px bg-border" />

        <Select
          value={`${module.id}::${subgroup?.id || ''}`}
          onValueChange={handleContainerChange}
        >
          <SelectTrigger className="h-7 w-[140px] border-none bg-transparent px-2 py-0 text-[11px] shadow-none hover:bg-secondary focus:ring-0">
            Move...
          </SelectTrigger>
          <SelectContent>
            {course.modules.map((m) => (
              <div key={m.id}>
                <SelectItem value={`${m.id}::`} className="font-bold">
                  {m.title} (root)
                </SelectItem>
                {m.entries.map(
                  (entry) =>
                    entry.kind === 'subgroup' && (
                      <SelectItem
                        key={entry.subgroup.id}
                        value={`${m.id}::${entry.subgroup.id}`}
                        className="pl-6"
                      >
                        ↳ {entry.subgroup.title}
                      </SelectItem>
                    ),
                )}
              </div>
            ))}
          </SelectContent>
        </Select>

        <div className="flex items-center gap-0.5">
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-navy disabled:opacity-30"
            disabled={position === 1}
            onClick={() => handleMove('up')}
            aria-label="Move up"
          >
            <ArrowUp size={14} />
          </button>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-navy disabled:opacity-30"
            disabled={position === totalVideos}
            onClick={() => handleMove('down')}
            aria-label="Move down"
          >
            <ArrowDown size={14} />
          </button>
        </div>

        <button
          type="button"
          className="ml-2 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          onClick={() => {
            if (window.confirm('Remove this video?')) {
              removeVideo(course.id, video.id);
            }
          }}
          aria-label="Remove video"
        >
          <Trash2 size={14} />
        </button>

        <Link
          href={`/admin/training/courses/${course.id}/videos/${video.id}`}
          className={`${BTN_SECONDARY} ml-2 h-7 px-2.5 text-[11px]`}
        >
          <Pencil size={12} className="mr-1" /> Edit
        </Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Course Editor
// ---------------------------------------------------------------------------

export default function CourseEditor() {
  const params = useParams();
  const courseId = params.courseId;
  const {
    findCourse,
    updateCourse,
    addModule,
    updateModule,
    removeModule,
    addSubgroup,
    updateSubgroup,
    removeSubgroup,
    addVideo,
    status,
    errorMessage,
    refresh,
  } = useTrainingData();
  const { toast } = useToast();

  const course = findCourse(courseId);

  // Form states
  const [addingModule, setAddingModule] = useState(false);
  const [newModuleName, setNewModuleName] = useState('');
  const [addingSubgroupTo, setAddingSubgroupTo] = useState<string | null>(null);
  const [newSubgroupName, setNewSubgroupName] = useState('');
  const [addingVideoTo, setAddingVideoTo] = useState<{ moduleId: string; subgroupId?: string | null } | null>(null);
  const [newVideoTitle, setNewVideoTitle] = useState('');

  if (!course) {
    return (
      <AdminPage>
        {status === 'loading' ? (
          <TrainingLoading />
        ) : status === 'error' ? (
          <TrainingLoadError message={errorMessage} onRetry={refresh} />
        ) : (
          <div className="py-12 text-center text-muted-foreground">Course not found.</div>
        )}
      </AdminPage>
    );
  }

  const handleCopyLink = async () => {
    const url = `${window.location.origin}/admin/training/preview/${course.id}`;
    const landed = await copyText(url);
    toast(
      landed
        ? { title: 'Link copied', description: 'Anyone with this link gets the learner view while the course is live.' }
        : { title: 'Copy unavailable', description: 'Select the link text and copy it manually.' },
    );
  };

  const handleAddModule = () => {
    if (newModuleName.trim()) {
      void addModule(course.id, newModuleName.trim());
    }
    setAddingModule(false);
    setNewModuleName('');
  };

  const handleAddSubgroup = (moduleId: string) => {
    if (newSubgroupName.trim()) {
      void addSubgroup(course.id, moduleId, newSubgroupName.trim());
    }
    setAddingSubgroupTo(null);
    setNewSubgroupName('');
  };

  const handleAddVideo = async (target: { moduleId: string; subgroupId?: string | null }) => {
    const title = newVideoTitle.trim();
    setAddingVideoTo(null);
    setNewVideoTitle('');
    if (!title) return;
    const vid = await addVideo(course.id, target, title);
    if (vid) {
      toast({
        title: 'Video entry added',
        description: `"${vid.title}" is a draft entry (${formatClock(vid.duration)}) — open it to upload the video file.`,
      });
    }
  };

  const orderedVideos = getOrderedVideos(course, false);
  const totalVideos = orderedVideos.length;

  return (
    <AdminPage>
      <div className="mb-6">
        <Link href="/admin/training/courses" className="inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-navy">
          <ChevronLeft size={14} />
          All courses
        </Link>
      </div>

      <div className="mb-8 rounded-lg border border-card-border bg-card p-6 shadow-soft">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <InlineRename
                value={course.title}
                onSave={(v) => updateCourse(course.id, { title: v })}
                className="font-serif text-2xl font-bold tracking-tight text-navy"
              />
              <CourseLiveChip status={course.status} />
              {course.sequentialUnlock && (
                <span className="flex items-center gap-1 rounded-sm border border-border bg-secondary px-2 py-0.5 text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
                  <Lock size={10} /> Sequential unlock
                </span>
              )}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Reorder videos with the arrows, or move them between modules and sub-groups with the Move menu.
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <div className="flex h-9 items-center gap-2 rounded-md border border-border bg-secondary px-3 text-xs text-muted-foreground">
              <Link2 size={14} />
              <code className="min-w-0 max-w-[260px] truncate font-mono text-[11px]">
                /admin/training/preview/{course.id}
              </code>
            </div>
            <button type="button" className={`${BTN_SECONDARY} h-9 px-3`} onClick={handleCopyLink}>
              <Copy size={14} />
              Copy
            </button>
          </div>
        </div>
      </div>

      <div className="grid gap-6">
        {course.modules.map((module, mIndex) => (
          <div key={module.id} className="rounded-lg border border-card-border bg-card shadow-soft">
            <div className="flex items-center justify-between border-b border-border bg-secondary/50 px-5 py-3">
              <div className="flex items-center gap-3">
                <span className="font-serif text-lg font-bold text-navy opacity-50">{mIndex + 1}.</span>
                <InlineRename
                  value={module.title}
                  onSave={(v) => updateModule(course.id, module.id, { title: v })}
                  className="font-serif text-lg font-bold text-navy"
                />
              </div>
              <div className="flex items-center gap-2">
                <Select
                  value={module.unlock}
                  onValueChange={(val: any) => updateModule(course.id, module.id, { unlock: val })}
                >
                  <SelectTrigger className="h-8 w-[120px] bg-card text-xs">
                    <div className="flex items-center gap-1.5">
                      <Lock size={12} className="text-muted-foreground" />
                      <SelectValue />
                    </div>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sequential">Sequential</SelectItem>
                    <SelectItem value="free">Video by video</SelectItem>
                  </SelectContent>
                </Select>

                <Select
                  value={module.published}
                  onValueChange={(val: any) => updateModule(course.id, module.id, { published: val })}
                >
                  <SelectTrigger
                    className={`h-8 w-[110px] bg-card text-xs ${
                      module.published === 'published' ? 'text-primary' : 'text-muted-foreground'
                    }`}
                    title="Draft hides it from learners; admins still see it"
                  >
                    <div className="flex items-center gap-1.5">
                      {module.published === 'published' ? <Eye size={12} /> : <EyeOff size={12} />}
                      <SelectValue />
                    </div>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="published">Published</SelectItem>
                    <SelectItem value="draft">Draft</SelectItem>
                  </SelectContent>
                </Select>

                <button
                  type="button"
                  className="ml-2 rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => {
                    if (window.confirm('Delete this entire module?')) removeModule(course.id, module.id);
                  }}
                  aria-label="Remove module"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>

            <div className="px-5 py-4">
              {module.entries.length === 0 ? (
                <div className="py-4 text-center text-xs text-muted-foreground">No videos yet</div>
              ) : (
                <div className="flex flex-col">
                  {module.entries.map((entry) => {
                    if (entry.kind === 'video') {
                      const ov = orderedVideos.find((ov) => ov.video.id === entry.video.id);
                      if (!ov) return null;
                      return (
                        <VideoRow
                          key={entry.video.id}
                          course={course}
                          module={module}
                          subgroup={null}
                          video={entry.video}
                          numbering={ov.numbering}
                          position={ov.position}
                          totalVideos={totalVideos}
                        />
                      );
                    }

                    const sg = entry.subgroup;
                    return (
                      <div key={sg.id} className="mt-4 first:mt-0">
                        <div className="mb-2 flex items-center justify-between rounded-md bg-secondary/80 px-3 py-1.5">
                          <InlineRename
                            value={sg.title}
                            onSave={(v) => updateSubgroup(course.id, sg.id, { title: v })}
                            className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground"
                          />
                          <div className="flex items-center gap-2">
                            <Select
                              value={sg.published}
                              onValueChange={(val: any) => updateSubgroup(course.id, sg.id, { published: val })}
                            >
                              <SelectTrigger
                                className={`h-6 border-none bg-transparent px-2 py-0 text-[10px] uppercase tracking-wide shadow-none hover:bg-black/5 focus:ring-0 ${
                                  sg.published === 'published' ? 'text-primary' : 'text-muted-foreground'
                                }`}
                              >
                                <div className="flex items-center gap-1.5">
                                  {sg.published === 'published' ? <Eye size={12} /> : <EyeOff size={12} />}
                                  <SelectValue />
                                </div>
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="published">Published</SelectItem>
                                <SelectItem value="draft">Draft</SelectItem>
                              </SelectContent>
                            </Select>

                            <Select
                              value={sg.unlock}
                              onValueChange={(val: any) => updateSubgroup(course.id, sg.id, { unlock: val })}
                            >
                              <SelectTrigger className="h-6 border-none bg-transparent px-2 py-0 text-[10px] uppercase tracking-wide shadow-none hover:bg-black/5 focus:ring-0 text-muted-foreground">
                                <div className="flex items-center gap-1.5">
                                  <Lock size={12} />
                                  <SelectValue />
                                </div>
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="sequential">Sequential</SelectItem>
                                <SelectItem value="free">Video by video</SelectItem>
                              </SelectContent>
                            </Select>

                            <button
                              type="button"
                              className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                              onClick={() => {
                                if (
                                  window.confirm(
                                    sg.videos.length > 0
                                      ? 'Delete this sub-group? Its videos will be moved back to the module level.'
                                      : 'Delete this sub-group?',
                                  )
                                ) {
                                  removeSubgroup(course.id, sg.id);
                                }
                              }}
                              aria-label="Remove sub-group"
                            >
                              <Trash2 size={12} />
                            </button>
                            <button
                              type="button"
                              className="ml-2 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-primary hover:underline"
                              onClick={() => setAddingVideoTo({ moduleId: module.id, subgroupId: sg.id })}
                            >
                              <Plus size={10} /> Add video
                            </button>
                          </div>
                        </div>

                        <div className="pl-4">
                          {sg.videos.length === 0 ? (
                            <div className="py-2 text-xs text-muted-foreground">Empty</div>
                          ) : (
                            sg.videos.map((vid) => {
                              const ov = orderedVideos.find((ov) => ov.video.id === vid.id);
                              if (!ov) return null;
                              return (
                                <VideoRow
                                  key={vid.id}
                                  course={course}
                                  module={module}
                                  subgroup={sg}
                                  video={vid}
                                  numbering={ov.numbering}
                                  position={ov.position}
                                  totalVideos={totalVideos}
                                />
                              );
                            })
                          )}
                          {addingVideoTo?.subgroupId === sg.id && (
                            <div className="mt-2 flex items-center gap-2 border-t border-border py-2">
                              <input
                                // eslint-disable-next-line jsx-a11y/no-autofocus
                                autoFocus
                                className={`${INPUT_CLASS} h-8 flex-1`}
                                placeholder="New video title..."
                                value={newVideoTitle}
                                onChange={(e) => setNewVideoTitle(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleAddVideo(addingVideoTo);
                                  if (e.key === 'Escape') setAddingVideoTo(null);
                                }}
                              />
                              <button
                                type="button"
                                className={`${BTN_PRIMARY} h-8 px-3 text-[11px]`}
                                onClick={() => handleAddVideo(addingVideoTo)}
                              >
                                Add
                              </button>
                              <button
                                type="button"
                                className={`${BTN_SECONDARY} h-8 px-3 text-[11px]`}
                                onClick={() => setAddingVideoTo(null)}
                              >
                                Cancel
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Module-level Add Video Form */}
              {addingVideoTo?.moduleId === module.id && !addingVideoTo.subgroupId && (
                <div className="mt-4 flex items-center gap-2 border-t border-border pt-4">
                  <input
                    // eslint-disable-next-line jsx-a11y/no-autofocus
                    autoFocus
                    className={`${INPUT_CLASS} h-8 flex-1`}
                    placeholder="New video title..."
                    value={newVideoTitle}
                    onChange={(e) => setNewVideoTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleAddVideo(addingVideoTo);
                      if (e.key === 'Escape') setAddingVideoTo(null);
                    }}
                  />
                  <button
                    type="button"
                    className={`${BTN_PRIMARY} h-8 px-3 text-[11px]`}
                    onClick={() => handleAddVideo(addingVideoTo)}
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    className={`${BTN_SECONDARY} h-8 px-3 text-[11px]`}
                    onClick={() => setAddingVideoTo(null)}
                  >
                    Cancel
                  </button>
                </div>
              )}

              {/* Module-level Add Subgroup Form */}
              {addingSubgroupTo === module.id && (
                <div className="mt-4 flex items-center gap-2 border-t border-border pt-4">
                  <input
                    // eslint-disable-next-line jsx-a11y/no-autofocus
                    autoFocus
                    className={`${INPUT_CLASS} h-8 flex-1`}
                    placeholder="New sub-group name (e.g. Contacts Walk Through)"
                    value={newSubgroupName}
                    onChange={(e) => setNewSubgroupName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleAddSubgroup(module.id);
                      if (e.key === 'Escape') setAddingSubgroupTo(null);
                    }}
                  />
                  <button
                    type="button"
                    className={`${BTN_PRIMARY} h-8 px-3 text-[11px]`}
                    onClick={() => handleAddSubgroup(module.id)}
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    className={`${BTN_SECONDARY} h-8 px-3 text-[11px]`}
                    onClick={() => setAddingSubgroupTo(null)}
                  >
                    Cancel
                  </button>
                </div>
              )}

              <div className="mt-4 flex items-center justify-end gap-3 border-t border-border pt-4">
                <button
                  type="button"
                  className={`${BTN_SECONDARY} h-8 px-3 text-[11px]`}
                  onClick={() => {
                    setAddingSubgroupTo(module.id);
                    setAddingVideoTo(null);
                    setNewSubgroupName('');
                  }}
                >
                  <Plus size={12} /> Add sub-group
                </button>
                <button
                  type="button"
                  className={`${BTN_SECONDARY} h-8 px-3 text-[11px]`}
                  onClick={() => {
                    setAddingVideoTo({ moduleId: module.id, subgroupId: null });
                    setAddingSubgroupTo(null);
                    setNewVideoTitle('');
                  }}
                >
                  <Plus size={12} /> Add video
                </button>
              </div>
            </div>
          </div>
        ))}

        {addingModule ? (
          <div className="rounded-lg border border-card-border bg-card p-4 shadow-soft">
            <div className="flex items-center gap-2">
              <input
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                className={`${INPUT_CLASS} h-8 flex-1`}
                placeholder="New module title (e.g. Advanced Reporting)"
                value={newModuleName}
                onChange={(e) => setNewModuleName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddModule();
                  if (e.key === 'Escape') setAddingModule(false);
                }}
                data-testid="input-new-module"
              />
              <button
                type="button"
                className={`${BTN_PRIMARY} h-8 px-3 text-[11px]`}
                onClick={handleAddModule}
                data-testid="button-add-module-confirm"
              >
                Add
              </button>
              <button
                type="button"
                className={`${BTN_SECONDARY} h-8 px-3 text-[11px]`}
                onClick={() => setAddingModule(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className={`${BTN_SECONDARY} h-9 w-full justify-center border-dashed`}
            onClick={() => {
              setAddingModule(true);
              setNewModuleName('');
              setAddingSubgroupTo(null);
              setAddingVideoTo(null);
            }}
            data-testid="button-add-module"
          >
            <Plus size={14} /> Add module
          </button>
        )}
      </div>
    </AdminPage>
  );
}
