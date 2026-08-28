/**
 * Silent compress-and-upload pipeline behind the guided session's Save.
 *
 * Each shot is downscaled/re-encoded through the shared photo-prep
 * pipeline (1600px longest edge, JPEG 0.7) — no visible "compressing"
 * step, it simply happens inside Save — then travels the API server's
 * presigned contract: upload-url → PUT the bytes straight to App Storage
 * → finalize verifies the stored object. The app keeps OBJECT PATHS,
 * never URLs; the grid asks progressPhotoDisplayUrl() for a fresh
 * redirect URL at render time.
 *
 * Failures are per-shot: the caller learns exactly which angles landed
 * and which didn't, keeps the on-device shots, and retries only the
 * failures.
 */
import { fetch as expoFetch } from 'expo/fetch';
import type { ImagePickerAsset } from 'expo-image-picker';
import { apiBase } from './coach-api';
import { preparePhotoForUpload } from './photo-prep';
import { decodeBase64 } from './photo-probe';
import type { GuidedAngle, GuidedShot } from './guided-photos';

export interface UploadedShotRef {
  angle: GuidedAngle;
  objectPath: string;
}

export interface GuidedUploadResult {
  uploaded: UploadedShotRef[];
  failed: GuidedAngle[];
}

/** Grid display URL for a stored shot — resolved at render, never persisted. */
export function progressPhotoDisplayUrl(objectPath: string): string {
  return `${apiBase()}/progress-photos/file?path=${encodeURIComponent(objectPath)}`;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await expoFetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const data = (await response.json()) as { error?: unknown };
      if (typeof data.error === 'string' && data.error) message = data.error;
    } catch {
      // Non-JSON error body — the status alone tells the story.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

async function uploadOne(shot: GuidedShot): Promise<UploadedShotRef> {
  const prepared = await preparePhotoForUpload({
    uri: shot.uri,
    width: shot.width,
    height: shot.height,
    base64: shot.base64,
  } as ImagePickerAsset);
  // photo-prep always returns a JPEG data URI; the upload wants raw bytes.
  const commaAt = prepared.uri.indexOf(',');
  const bytes = decodeBase64(prepared.uri.slice(commaAt + 1));
  const body = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const { uploadUrl, objectPath } = await postJson<{ uploadUrl: string; objectPath: string }>(
    '/progress-photos/upload-url',
    { angle: shot.angle, contentType: 'image/jpeg', sizeBytes: bytes.byteLength },
  );
  const put = await expoFetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg' },
    body,
  });
  if (!put.ok) {
    throw new Error(`Storage upload failed (${put.status})`);
  }
  await postJson<{ objectPath: string }>('/progress-photos/finalize', { objectPath });
  return { angle: shot.angle, objectPath };
}

/**
 * Uploads shots one at a time — three small files, and sequential keeps
 * the failure story simple while staying inside the per-IP write burst.
 * Never throws: every shot ends up in `uploaded` or `failed`.
 */
export async function uploadGuidedShots(
  shots: readonly GuidedShot[],
): Promise<GuidedUploadResult> {
  const uploaded: UploadedShotRef[] = [];
  const failed: GuidedAngle[] = [];
  for (const shot of shots) {
    try {
      uploaded.push(await uploadOne(shot));
    } catch (error) {
      console.error(`Progress photo upload failed (${shot.angle})`, error);
      failed.push(shot.angle);
    }
  }
  return { uploaded, failed };
}
