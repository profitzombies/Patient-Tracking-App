import type { TrainingVideo } from '../data/hq/training';

/**
 * The two storage-purge calls a lesson deletion needs, injected so the
 * sequencing below stays a pure, offline-testable contract. Both throw on a
 * refused delete (missing objects count as already gone).
 */
export interface VideoMediaPurgeDeps {
  /** Deletes every hosted attachment file, then clears their row entries. */
  clearAttachments: (videoId: string) => Promise<unknown>;
  /** Deletes the hosted video file plus its transcript/thumbnail artifacts. */
  removeHostedFile: (videoId: string) => Promise<unknown>;
}

/**
 * Purge hosted media for every given video BEFORE any row is deleted. Every
 * row-delete entry point (the video editor's danger zone, the course
 * editor's quick-remove, and module deletion, whose SQL cascade wipes video
 * rows) must funnel through this first: storage objects go out object-first,
 * and the first refusal throws so the caller keeps the rows — a kept row is
 * a retry handle, while a deleted row would strand objects nothing
 * references. Videos without hosted media are skipped, so legacy name-only
 * attachments never trigger a storage call.
 */
export async function purgeVideosMedia(videos: readonly TrainingVideo[], deps: VideoMediaPurgeDeps): Promise<void> {
  for (const video of videos) {
    if (video.attachments.some((att) => att.source)) await deps.clearAttachments(video.id);
    if (video.videoSource) await deps.removeHostedFile(video.id);
  }
}
