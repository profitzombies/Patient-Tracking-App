/**
 * Guided-session Save pipeline — where shots go depends on who is signed in.
 *
 * REAL ACCOUNT: each shot is downscaled/re-encoded through the shared
 * photo-prep pipeline (1600px longest edge, JPEG 0.7) — no visible
 * "compressing" step, it simply happens inside Save — then handed to the
 * account's authenticated uploader (the per-patient media rail: upload-url
 * → presigned PUT → finalize), which returns the object path the account's
 * grid row will reference. The app keeps OBJECT PATHS, never URLs; the
 * grid asks progressPhotoDisplayUrl() for a fresh redirect URL at render
 * time.
 *
 * DEMO PERSONA: zero network and zero prep — the grid entry simply keeps
 * the on-device capture uri (native camera cache file; on web, the bundled
 * pose asset), exactly as the demo behaved before accounts existed.
 *
 * Failures are per-shot. A shot whose PREP failed is reported in `failed`
 * (the caller keeps the on-device shot and retries). A shot that prepped
 * but could not be UPLOADED — offline, or the rail refused it — is not a
 * failure any more: its ref keeps the prepared data URI (`deferred`), and
 * the account's offline write queue uploads it later when addPhotos
 * records the grid row. Offline devices skip the upload attempt outright.
 */
import type { ImagePickerAsset } from 'expo-image-picker';
import { photoFileUrl, type PhotoSize } from './photo-page-urls';
import { preparePhotoForUpload } from './photo-prep';
import type { GuidedAngle, GuidedShot } from './guided-photos';
import { isOnline } from './connectivity';

export interface UploadedShotRef {
  angle: GuidedAngle;
  /** Stored object path — present when the shot uploaded to the account. */
  objectPath?: string;
  /** On-device uri — present for the demo persona's local-only grid, and
   *  for an account shot whose upload is deferred to the offline queue
   *  (then it is the prepared JPEG data URI). */
  uri?: string;
  /** Account shot that prepped fine but is waiting for connectivity. */
  deferred?: boolean;
  /**
   * Upload id this shot was (or will be) uploaded under. Deferred shots
   * hand it to the offline queue so the queued upload pins the same
   * server object an interrupted in-session attempt may already hold.
   */
  uploadId?: string;
}

export interface GuidedUploadResult {
  uploaded: UploadedShotRef[];
  failed: GuidedAngle[];
}

/**
 * Uploads one prepared photo (data URI) to the signed-in account. The
 * `uploadId` pins the server-minted object path for that shot.
 */
export type ProgressPhotoUploader = (
  dataUri: string,
  options?: { uploadId?: string },
) => Promise<{ photoPath: string }>;

/**
 * Per-photo display URL for a stored shot — resolved at render, never
 * persisted. The grid prefers a one-call signed page (usePhotoPageUrls)
 * and uses this as its fallback; `size` asks for a derived variant.
 */
export function progressPhotoDisplayUrl(objectPath: string, size?: PhotoSize): string {
  return photoFileUrl(objectPath, size);
}

/**
 * Resolves shots one at a time — three small files, and sequential keeps
 * the failure story simple while staying inside the per-IP write burst.
 * Never throws: every shot ends up in `uploaded` or `failed`.
 *
 * With an `uploader` (real account) each shot is prepped and uploaded,
 * yielding an object path. Without one (demo persona) nothing leaves the
 * device: the ref keeps the capture uri and cannot fail.
 */
export async function uploadGuidedShots(
  shots: readonly GuidedShot[],
  uploader?: ProgressPhotoUploader,
  /** Stable per-session upload id for an angle (real accounts only). */
  uploadIdFor?: (angle: GuidedAngle) => string,
): Promise<GuidedUploadResult> {
  const uploaded: UploadedShotRef[] = [];
  const failed: GuidedAngle[] = [];
  for (const shot of shots) {
    if (!uploader) {
      uploaded.push({ angle: shot.angle, uri: shot.uri });
      continue;
    }
    let preparedUri: string;
    try {
      const prepared = await preparePhotoForUpload({
        uri: shot.uri,
        width: shot.width,
        height: shot.height,
        base64: shot.base64,
      } as ImagePickerAsset);
      preparedUri = prepared.uri;
    } catch (error) {
      console.error(`Progress photo prep failed (${shot.angle})`, error);
      failed.push(shot.angle);
      continue;
    }
    const uploadId = uploadIdFor?.(shot.angle);
    const pinned = uploadId ? { uploadId } : {};
    if (!isOnline()) {
      uploaded.push({ angle: shot.angle, uri: preparedUri, deferred: true, ...pinned });
      continue;
    }
    try {
      const { photoPath } = await uploader(preparedUri, uploadId ? { uploadId } : undefined);
      uploaded.push({ angle: shot.angle, objectPath: photoPath, ...pinned });
    } catch (error) {
      // A lost response after the bytes landed is indistinguishable from a
      // failed upload here; the deferred ref keeps the upload id so the
      // queue re-uploads onto the SAME object rather than a second one.
      console.error(`Progress photo upload deferred (${shot.angle})`, error);
      uploaded.push({ angle: shot.angle, uri: preparedUri, deferred: true, ...pinned });
    }
  }
  return { uploaded, failed };
}
