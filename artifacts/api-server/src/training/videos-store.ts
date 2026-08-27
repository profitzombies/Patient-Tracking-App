/**
 * Service-role access to the training video rows the media routes manage.
 *
 * Writes here bypass RLS on purpose: the routes verify the caller's own
 * Supabase staff session first (lib/staff-auth.ts), then persist server-owned
 * fields — object paths, probed duration, AI results — that no client policy
 * allows. Only object PATHS are stored, never signed URLs.
 */

export interface TranscriptSegment {
  /** Segment start, seconds from the top of the video. */
  at: number;
  /** Segment end, seconds. */
  end: number;
  text: string;
}

export interface TrainingVideoRecord {
  id: string;
  title: string;
  duration_seconds: number;
  description: unknown;
  chapters: unknown;
  thumbnail_chapter: number;
  video_source: string | null;
  thumbnail_source: string | null;
  /** Raw jsonb attachment list — the routes sanitize; junk entries ride along untouched. */
  attachments: unknown;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isVideoId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function base(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL is not configured");
  return url.replace(/\/$/, "");
}

function headers(extra?: Record<string, string>): Record<string, string> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function rest(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${base()}/rest/v1${path}`, {
    method,
    headers: headers(
      method === "GET" ? undefined : { Prefer: "return=representation,resolution=merge-duplicates" },
    ),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase ${method} ${path.split("?")[0]} failed (${response.status}): ${text.slice(0, 200)}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function getVideoRecord(videoId: string): Promise<TrainingVideoRecord | null> {
  if (!isVideoId(videoId)) return null;
  const rows = (await rest(
    "GET",
    `/training_videos?id=eq.${videoId}&select=id,title,duration_seconds,description,chapters,thumbnail_chapter,video_source,thumbnail_source,attachments`,
  )) as TrainingVideoRecord[];
  return rows[0] ?? null;
}

export async function updateVideoRecord(
  videoId: string,
  patch: Partial<{
    video_source: string | null;
    thumbnail_source: string | null;
    duration_seconds: number;
    description: string[];
    chapters: Array<{ id: string; at: number; title: string }>;
  }>,
): Promise<void> {
  if (!isVideoId(videoId)) throw new Error("Invalid video id");
  await rest("PATCH", `/training_videos?id=eq.${videoId}`, patch);
}

/**
 * Atomically replace a thumbnail only while both the hosted video and prior
 * thumbnail still match the state the caller validated. The conditional
 * PATCH closes the read/write race between simultaneous frame captures,
 * custom uploads, video replacement, and removal.
 */
export async function replaceThumbnailIfCurrent(
  videoId: string,
  expectedVideoSource: string,
  expectedThumbnailSource: string | null,
  thumbnailSource: string,
): Promise<boolean> {
  if (!isVideoId(videoId)) throw new Error("Invalid video id");
  const videoFilter = `video_source=eq.${encodeURIComponent(expectedVideoSource)}`;
  const thumbnailFilter = expectedThumbnailSource === null
    ? "thumbnail_source=is.null"
    : `thumbnail_source=eq.${encodeURIComponent(expectedThumbnailSource)}`;
  const rows = (await rest(
    "PATCH",
    `/training_videos?id=eq.${videoId}&${videoFilter}&${thumbnailFilter}&select=id`,
    { thumbnail_source: thumbnailSource },
  )) as Array<{ id: string }> | null;
  return Array.isArray(rows) && rows.length === 1;
}

export async function updateHostedMediaIfCurrent(
  videoId: string,
  expectedVideoSource: string | null,
  expectedThumbnailSource: string | null,
  patch: {
    video_source: string | null;
    thumbnail_source: string | null;
    duration_seconds?: number;
  },
): Promise<boolean> {
  if (!isVideoId(videoId)) throw new Error("Invalid video id");
  const videoFilter = expectedVideoSource === null
    ? "video_source=is.null"
    : `video_source=eq.${encodeURIComponent(expectedVideoSource)}`;
  const thumbnailFilter = expectedThumbnailSource === null
    ? "thumbnail_source=is.null"
    : `thumbnail_source=eq.${encodeURIComponent(expectedThumbnailSource)}`;
  const rows = (await rest(
    "PATCH",
    `/training_videos?id=eq.${videoId}&${videoFilter}&${thumbnailFilter}&select=id`,
    patch,
  )) as Array<{ id: string }> | null;
  return Array.isArray(rows) && rows.length === 1;
}

/**
 * Atomically replace the attachments list only while it still matches the
 * state the caller read. jsonb equality is structural, so the expected raw
 * value round-trips safely through the filter; a mismatch means another
 * append or removal landed first and the caller re-reads and retries.
 */
export async function updateAttachmentsIfCurrent(
  videoId: string,
  expectedAttachments: unknown,
  attachments: unknown[],
): Promise<boolean> {
  if (!isVideoId(videoId)) throw new Error("Invalid video id");
  const filter = expectedAttachments === null || expectedAttachments === undefined
    ? "attachments=is.null"
    : `attachments=eq.${encodeURIComponent(JSON.stringify(expectedAttachments))}`;
  const rows = (await rest(
    "PATCH",
    `/training_videos?id=eq.${videoId}&${filter}&select=id`,
    { attachments },
  )) as Array<{ id: string }> | null;
  return Array.isArray(rows) && rows.length === 1;
}

export async function getTranscript(videoId: string): Promise<TranscriptSegment[] | null> {
  if (!isVideoId(videoId)) return null;
  const rows = (await rest(
    "GET",
    `/training_video_transcripts?video_id=eq.${videoId}&select=segments`,
  )) as Array<{ segments: unknown }>;
  const segments = rows[0]?.segments;
  if (!Array.isArray(segments)) return null;
  const cleaned = segments
    .filter(
      (seg): seg is TranscriptSegment =>
        typeof seg === "object" &&
        seg !== null &&
        typeof (seg as TranscriptSegment).at === "number" &&
        typeof (seg as TranscriptSegment).end === "number" &&
        typeof (seg as TranscriptSegment).text === "string",
    )
    .sort((a, b) => a.at - b.at);
  return cleaned.length > 0 ? cleaned : null;
}

export async function upsertTranscript(videoId: string, segments: TranscriptSegment[]): Promise<void> {
  if (!isVideoId(videoId)) throw new Error("Invalid video id");
  await rest("POST", `/training_video_transcripts?on_conflict=video_id`, {
    video_id: videoId,
    segments,
  });
}

export async function deleteTranscript(videoId: string): Promise<void> {
  if (!isVideoId(videoId)) return;
  await rest("DELETE", `/training_video_transcripts?video_id=eq.${videoId}`);
}

// ---------------------------------------------------------------------------
// Storage-cleanup ledger — durable retry handles for refused object deletes.
//
// Replace/displace flows must not fail the caller when storage refuses to
// delete an object the row no longer references (the new file is already
// live). The refused path lands here instead, and later training-media
// writes drain the table: a row leaves only after storage confirms.
// ---------------------------------------------------------------------------

export interface MediaCleanupRow {
  id: string;
  object_path: string;
  video_id: string | null;
}

export async function queueMediaCleanup(
  objectPath: string,
  videoId: string | null,
  reason: "displaced" | "stray",
): Promise<void> {
  // rest() sends Prefer: resolution=merge-duplicates, so re-queuing the same
  // path is an idempotent upsert on the object_path unique key.
  await rest("POST", `/training_media_cleanup?on_conflict=object_path`, {
    object_path: objectPath,
    video_id: videoId && isVideoId(videoId) ? videoId : null,
    reason,
  });
}

export async function listMediaCleanup(limit: number): Promise<MediaCleanupRow[]> {
  const rows = (await rest(
    "GET",
    `/training_media_cleanup?select=id,object_path,video_id&order=created_at.asc&limit=${Math.max(1, Math.min(50, limit))}`,
  )) as MediaCleanupRow[] | null;
  return Array.isArray(rows) ? rows : [];
}

export async function deleteMediaCleanup(id: string): Promise<void> {
  await rest("DELETE", `/training_media_cleanup?id=eq.${encodeURIComponent(id)}`);
}

/** Remove a ledger row by object path — used to settle a pre-registration. */
export async function dequeueMediaCleanup(objectPath: string): Promise<void> {
  await rest("DELETE", `/training_media_cleanup?object_path=eq.${encodeURIComponent(objectPath)}`);
}
