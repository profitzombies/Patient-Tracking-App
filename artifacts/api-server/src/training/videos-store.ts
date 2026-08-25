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
    `/training_videos?id=eq.${videoId}&select=id,title,duration_seconds,description,chapters,thumbnail_chapter,video_source,thumbnail_source`,
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
