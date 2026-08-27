/**
 * Client for the API server's hosted training-video routes.
 *
 * The routes are OPEN in the demo posture — reaching the admin portal is
 * enough, no staff sign-in (the same opening as the AI Support knowledge
 * library). When the caller DOES have a Supabase session its bearer is
 * still attached — signed-in staff send exactly what they always sent; the
 * server simply ignores it. Writes ride a modest per-IP limiter server-side,
 * so denials surface here as plain-words 429 errors.
 *
 * Paths are root-relative (`/api/...`): the operations app is the ROOT
 * artifact and the API server is mounted at /api on the same domain, in dev
 * and in the published app alike. Object paths returned here are storage
 * keys, never URLs — playback URLs are short-lived and re-requested.
 */
import { supabase } from '@/lib/supabase';

export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
export const MAX_THUMBNAIL_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Container types the upload flow accepts, plus extension fallbacks for
 * browsers that report an empty MIME type (common for .mov on Windows). */
const ALLOWED_VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const EXTENSION_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};
const ALLOWED_THUMBNAIL_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const THUMBNAIL_EXTENSION_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/** Attachment types the server allow-lists, keyed by extension fallback for
 * browsers that report an empty MIME type (common for Office files). */
const ATTACHMENT_EXTENSION_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  csv: 'text/csv',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};
const ALLOWED_ATTACHMENT_TYPES = new Set(Object.values(ATTACHMENT_EXTENSION_TYPES));

/** For the file picker's accept attribute — extensions plus exact MIME types. */
export const ATTACHMENT_ACCEPT = [
  ...Object.keys(ATTACHMENT_EXTENSION_TYPES).map((ext) => `.${ext}`),
  ...ALLOWED_ATTACHMENT_TYPES,
].join(',');

export type ProcessStep = 'transcribe' | 'describe' | 'chapters' | 'thumbnail';
export const PROCESS_STEPS: readonly ProcessStep[] = ['transcribe', 'describe', 'chapters', 'thumbnail'];

export interface TranscriptSegment {
  at: number;
  end: number;
  text: string;
}

export interface TrainingMediaUrls {
  videoUrl: string;
  thumbnailUrl: string | null;
  expiresAtMs: number;
}

/** Progress/result events streamed by the AI pass. */
export interface ProcessEvent {
  step?: ProcessStep;
  status?: 'running' | 'done' | 'failed' | 'skipped';
  error?: string;
  /** Transcribe progress: minutes finished out of total. */
  done?: number | boolean;
  total?: number;
  transcript?: { segments: TranscriptSegment[] };
  description?: string[];
  chapters?: Array<{ id: string; at: number; title: string }>;
  thumbnailSource?: string;
  thumbnailUrl?: string;
}

export interface ProcessOutcome {
  ok: boolean;
  failedStep?: ProcessStep;
  blockedSteps?: ProcessStep[];
  error?: string;
}

export class TrainingMediaError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'TrainingMediaError';
    this.status = status;
  }
}

export function resolveVideoType(file: File): string | null {
  if (ALLOWED_VIDEO_TYPES.has(file.type)) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_TYPES[ext] ?? null;
}

/** Plain-words validation before any byte leaves the browser. */
export function describeFileProblem(file: File): string | null {
  if (!resolveVideoType(file)) {
    return 'That file type isn\u2019t supported \u2014 upload an MP4, WebM or MOV video.';
  }
  if (file.size === 0) return 'That file is empty.';
  if (file.size > MAX_VIDEO_BYTES) return 'That file is over the 500 MB limit.';
  return null;
}

export function resolveThumbnailType(file: File): string | null {
  if (ALLOWED_THUMBNAIL_TYPES.has(file.type)) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return THUMBNAIL_EXTENSION_TYPES[ext] ?? null;
}

export function describeThumbnailFileProblem(file: File): string | null {
  if (!resolveThumbnailType(file)) {
    return 'That file type isn’t supported — upload a JPG, PNG or WebP image.';
  }
  if (file.size === 0) return 'That thumbnail is empty.';
  if (file.size > MAX_THUMBNAIL_BYTES) return 'That thumbnail is over the 10 MB limit.';
  return null;
}

export function resolveAttachmentType(file: File): string | null {
  if (ALLOWED_ATTACHMENT_TYPES.has(file.type)) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return ATTACHMENT_EXTENSION_TYPES[ext] ?? null;
}

export function describeAttachmentProblem(file: File): string | null {
  if (!resolveAttachmentType(file)) {
    return 'That file type isn’t supported — upload a PDF, Word, Excel, PowerPoint, text, CSV, or image file.';
  }
  if (file.size === 0) return 'That file is empty.';
  if (file.size > MAX_ATTACHMENT_BYTES) return 'That file is over the 25 MB limit.';
  return null;
}

/** The session's bearer when one exists — the server ignores it either way. */
async function sessionToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await sessionToken();
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    throw new TrainingMediaError(await errorMessage(response), response.status);
  }
  return (await response.json()) as T;
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error) return body.error;
  } catch {
    // Non-JSON error body — fall through to the generic message.
  }
  return `The request failed (${response.status}) — try again.`;
}

export async function requestUploadUrl(
  videoId: string,
  file: File,
  contentType: string,
): Promise<{ uploadUrl: string; objectPath: string }> {
  return apiFetch(`/training/videos/${videoId}/upload-url`, {
    method: 'POST',
    body: JSON.stringify({ fileName: file.name, contentType, sizeBytes: file.size }),
  });
}

export async function requestThumbnailUploadUrl(
  videoId: string,
  file: File,
  contentType: string,
): Promise<{ uploadUrl: string; objectPath: string; videoSource: string }> {
  return apiFetch(`/training/videos/${videoId}/thumbnail-upload-url`, {
    method: 'POST',
    body: JSON.stringify({ fileName: file.name, contentType, sizeBytes: file.size }),
  });
}

/** PUT straight to App Storage via the presigned URL, with real progress. */
export function uploadToStorage(
  uploadUrl: string,
  file: File,
  contentType: string,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new TrainingMediaError(`Storage rejected the upload (${xhr.status}) — try again.`, xhr.status));
    };
    xhr.onerror = () =>
      reject(new TrainingMediaError('The upload connection dropped — check your network and try again.', 0));
    xhr.onabort = () => reject(new TrainingMediaError('Upload cancelled.', 0));
    xhr.send(file);
  });
}

export async function finalizeUpload(
  videoId: string,
  objectPath: string,
): Promise<{ videoSource: string; durationSeconds: number; thumbnailSource: string | null }> {
  return apiFetch(`/training/videos/${videoId}/video`, {
    method: 'POST',
    body: JSON.stringify({ objectPath }),
  });
}

export async function removeVideoFile(videoId: string): Promise<void> {
  await apiFetch(`/training/videos/${videoId}/video`, { method: 'DELETE' });
}

export async function fetchMediaUrls(videoId: string): Promise<TrainingMediaUrls> {
  return apiFetch(`/training/videos/${videoId}/media`);
}

/** null = no transcript stored yet (a plain state, not an error). */
export async function fetchTranscript(videoId: string): Promise<TranscriptSegment[] | null> {
  try {
    const result = await apiFetch<{ segments: TranscriptSegment[] }>(`/training/videos/${videoId}/transcript`);
    return result.segments;
  } catch (error) {
    if (error instanceof TrainingMediaError && error.status === 404) return null;
    throw error;
  }
}

export async function captureThumbnail(
  videoId: string,
  atSeconds: number,
): Promise<{ thumbnailSource: string; thumbnailUrl: string }> {
  return apiFetch(`/training/videos/${videoId}/thumbnail`, {
    method: 'POST',
    body: JSON.stringify({ atSeconds }),
  });
}

export async function finalizeThumbnailUpload(
  videoId: string,
  objectPath: string,
  contentType: string,
  videoSource: string,
): Promise<{ thumbnailSource: string; thumbnailUrl: string }> {
  return apiFetch(`/training/videos/${videoId}/thumbnail-upload`, {
    method: 'POST',
    body: JSON.stringify({ objectPath, contentType, videoSource }),
  });
}

// ---------------------------------------------------------------------------
// Lesson attachments — presigned PUT + verified finalize, like the video, in
// a storage folder of their own. Entries are server-written; the editor never
// saves attachment rows through the draft path.
// ---------------------------------------------------------------------------

/** One attachment entry exactly as the server stored it on the row. */
export interface AttachmentPayload {
  id: string;
  name: string;
  sizeLabel: string;
  source: string | null;
  contentType: string | null;
  sizeBytes: number | null;
}

export async function requestAttachmentUploadUrl(
  videoId: string,
  file: File,
  contentType: string,
): Promise<{ uploadUrl: string; objectPath: string }> {
  return apiFetch(`/training/videos/${videoId}/attachment-upload-url`, {
    method: 'POST',
    body: JSON.stringify({ fileName: file.name, contentType, sizeBytes: file.size }),
  });
}

export async function finalizeAttachment(
  videoId: string,
  objectPath: string,
  name: string,
  contentType: string,
): Promise<{ attachment: AttachmentPayload }> {
  return apiFetch(`/training/videos/${videoId}/attachments`, {
    method: 'POST',
    body: JSON.stringify({ objectPath, name, contentType }),
  });
}

export async function removeAttachment(videoId: string, attachmentId: string): Promise<void> {
  await apiFetch(`/training/videos/${videoId}/attachments/${attachmentId}`, { method: 'DELETE' });
}

/** Deletes every attachment entry AND its stored file — the video-deletion
 * flow calls this first so dropping the row never orphans objects. */
export async function removeAllAttachments(
  videoId: string,
): Promise<{ removed: number; deletedObjects: number }> {
  return apiFetch(`/training/videos/${videoId}/attachments`, { method: 'DELETE' });
}

/** Minted fresh per click with a short TTL — never persisted client-side,
 * which is exactly why downloads survive reloads and other browsers. */
export async function fetchAttachmentDownloadUrl(
  videoId: string,
  attachmentId: string,
): Promise<{ downloadUrl: string; name: string; expiresAtMs: number }> {
  return apiFetch(`/training/videos/${videoId}/attachments/${attachmentId}/download-url`);
}

/**
 * Navigate an invisible anchor at the signed URL. The stored object carries
 * `Content-Disposition: attachment`, so the browser downloads under the real
 * file name instead of navigating away.
 */
export function openDownload(url: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * Run the AI pass, forwarding each SSE event to `onEvent`. Resolves with the
 * stream's explicit final event; a stream that ends WITHOUT one rejects —
 * end-without-done must read as an error, never as silent success.
 */
export async function processVideo(
  videoId: string,
  steps: ProcessStep[] | undefined,
  onEvent: (event: ProcessEvent) => void,
): Promise<ProcessOutcome> {
  const token = await sessionToken();
  const response = await fetch(`/api/training/videos/${videoId}/process`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(steps && steps.length > 0 ? { steps } : {}),
  });
  if (!response.ok || !response.body) {
    throw new TrainingMediaError(await errorMessage(response), response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let outcome: ProcessOutcome | null = null;

  const handleLine = (line: string): void => {
    if (!line.startsWith('data: ')) return; // comment keepalives etc.
    let payload: ProcessEvent & { done?: boolean | number; ok?: boolean };
    try {
      payload = JSON.parse(line.slice(6));
    } catch {
      return; // A malformed line is dropped; the final done event decides.
    }
    if (payload.done === true && typeof (payload as { ok?: unknown }).ok === 'boolean') {
      const final = payload as unknown as ProcessOutcome & { done: true };
      outcome = {
        ok: final.ok,
        failedStep: final.failedStep,
        blockedSteps: final.blockedSteps,
        error: final.error,
      };
      return;
    }
    onEvent(payload);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      for (const line of chunk.split('\n')) handleLine(line);
    }
  }

  if (!outcome) {
    throw new TrainingMediaError('The processing stream ended unexpectedly — retry the AI steps.', 502);
  }
  return outcome;
}
