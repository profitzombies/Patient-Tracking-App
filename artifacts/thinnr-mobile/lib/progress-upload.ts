/**
 * Silent compress-and-upload for saved session photos.
 *
 * When the patient taps Save, each kept shot is quietly re-encoded to a
 * phone-friendly JPEG (long edge ~1080, quality 0.7 — no spinner theater,
 * just a small progress line) and pushed to the clinic's private App
 * Storage bucket through the api-server's presigned-URL contract:
 *
 *   POST /api/progress-photos/upload-url  → { uploadUrl, objectPath }
 *   PUT  bytes → uploadUrl                (storage, not our server)
 *   POST /api/progress-photos/finalize    → server verifies the object
 *
 * A failure at any step raises ProgressUploadError with the angle and
 * stage attached: the surface shows an explicit, retryable error and the
 * shots STAY on device — a retry skips angles that already uploaded via
 * the `alreadyUploaded` map, so nothing is ever double-sent.
 */
import { fetch as expoFetch } from 'expo/fetch';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { apiBase } from '@/lib/coach-api';
import { base64ToBytes } from '@/lib/photo-analysis';
import type { SessionAngle } from '@/lib/progress-session';

export const UPLOAD_TARGET_WIDTH = 1080;
export const UPLOAD_JPEG_QUALITY = 0.7;
export const UPLOAD_CONTENT_TYPE = 'image/jpeg';

export type UploadStage = 'compress' | 'request' | 'put' | 'finalize';

export class ProgressUploadError extends Error {
  constructor(
    message: string,
    readonly angle: SessionAngle,
    readonly stage: UploadStage,
  ) {
    super(message);
    this.name = 'ProgressUploadError';
  }
}

export interface ShotToUpload {
  angle: SessionAngle;
  /** Local uri — file:// from the camera, data: from the web sim. */
  uri: string;
  /** Capture width, used to skip pointless upscales. */
  width: number;
}

export interface CompressedShot {
  base64: string;
  byteLength: number;
}

type FetchLike = typeof expoFetch;

/**
 * Re-encode one shot for upload. Shots narrower than the target width are
 * re-encoded without resizing (never upscale a small frame).
 */
export async function compressShotToJpeg(shot: ShotToUpload): Promise<CompressedShot> {
  let context = ImageManipulator.manipulate(shot.uri);
  if (shot.width > UPLOAD_TARGET_WIDTH) {
    context = context.resize({ width: UPLOAD_TARGET_WIDTH });
  }
  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync({
    format: SaveFormat.JPEG,
    compress: UPLOAD_JPEG_QUALITY,
    base64: true,
  });
  const base64 = saved.base64;
  if (!base64) {
    throw new Error('Compression produced no image data');
  }
  return { base64, byteLength: base64ToBytes(base64).byteLength };
}

/**
 * Upload every shot not already covered by `alreadyUploaded`. Returns the
 * angle → objectPath map for ALL shots (existing entries included), which
 * is what the save path records next to each grid photo. Progress fires
 * once per finished shot, counting the skipped ones up front.
 */
export async function uploadProgressShots(
  shots: ShotToUpload[],
  alreadyUploaded: Partial<Record<SessionAngle, string>>,
  onProgress?: (done: number, total: number) => void,
  fetchImpl: FetchLike = expoFetch,
): Promise<Record<SessionAngle, string>> {
  const result: Partial<Record<SessionAngle, string>> = { ...alreadyUploaded };
  const total = shots.length;
  let done = shots.filter(shot => result[shot.angle] !== undefined).length;
  if (done > 0) onProgress?.(done, total);

  for (const shot of shots) {
    if (result[shot.angle] !== undefined) continue;

    let compressed: CompressedShot;
    try {
      compressed = await compressShotToJpeg(shot);
    } catch (error) {
      console.error('Progress photo compression failed', error);
      throw new ProgressUploadError('This photo could not be prepared.', shot.angle, 'compress');
    }

    let uploadUrl: string;
    let objectPath: string;
    try {
      const response = await fetchImpl(`${apiBase()}/progress-photos/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentType: UPLOAD_CONTENT_TYPE,
          sizeBytes: compressed.byteLength,
          angle: shot.angle,
        }),
      });
      if (!response.ok) throw new Error(`upload-url answered ${response.status}`);
      const body = (await response.json()) as { uploadUrl?: string; objectPath?: string };
      if (!body.uploadUrl || !body.objectPath) throw new Error('upload-url answer incomplete');
      uploadUrl = body.uploadUrl;
      objectPath = body.objectPath;
    } catch (error) {
      console.error('Progress photo upload-url failed', error);
      throw new ProgressUploadError('The upload could not be started.', shot.angle, 'request');
    }

    try {
      // Copy into a standalone ArrayBuffer: Buffer-backed views share the
      // Node pool (a plain .buffer would leak unrelated bytes), and the
      // fetch body types accept ArrayBuffer, not Uint8Array.
      const bytes = base64ToBytes(compressed.base64);
      const body = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(body).set(bytes);
      const putResponse = await fetchImpl(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': UPLOAD_CONTENT_TYPE },
        body,
      });
      if (!putResponse.ok) throw new Error(`storage answered ${putResponse.status}`);
    } catch (error) {
      console.error('Progress photo PUT failed', error);
      throw new ProgressUploadError('The photo bytes could not be uploaded.', shot.angle, 'put');
    }

    try {
      const finalizeResponse = await fetchImpl(`${apiBase()}/progress-photos/finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ objectPath }),
      });
      if (!finalizeResponse.ok) throw new Error(`finalize answered ${finalizeResponse.status}`);
    } catch (error) {
      console.error('Progress photo finalize failed', error);
      throw new ProgressUploadError('The upload could not be confirmed.', shot.angle, 'finalize');
    }

    result[shot.angle] = objectPath;
    done += 1;
    onProgress?.(done, total);
  }

  return result as Record<SessionAngle, string>;
}
