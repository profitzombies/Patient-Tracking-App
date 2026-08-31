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
 * Failures are per-shot: the caller learns exactly which angles landed
 * and which didn't, keeps the on-device shots, and retries only the
 * failures.
 */
import type { ImagePickerAsset } from 'expo-image-picker';
import { apiBase } from './coach-api';
import { appendMediaToken } from './media-token-holder';
import { preparePhotoForUpload } from './photo-prep';
import type { GuidedAngle, GuidedShot } from './guided-photos';

export interface UploadedShotRef {
  angle: GuidedAngle;
  /** Stored object path — present when the shot uploaded to the account. */
  objectPath?: string;
  /** On-device uri — present for the demo persona's local-only grid. */
  uri?: string;
}

export interface GuidedUploadResult {
  uploaded: UploadedShotRef[];
  failed: GuidedAngle[];
}

/** Uploads one prepared photo (data URI) to the signed-in account. */
export type ProgressPhotoUploader = (dataUri: string) => Promise<{ photoPath: string }>;

/**
 * Grid display URL for a stored shot — resolved at render, never persisted.
 * Account photos live on the per-patient media rail; anything else is a
 * legacy object from the retired anonymous rail, still served read-only.
 */
export function progressPhotoDisplayUrl(objectPath: string): string {
  if (objectPath.startsWith('/objects/patient-media/')) {
    // Account media reads are token-authorized — append the patient's
    // media token minted at hydration (absent for demo/seeded content).
    return appendMediaToken(
      `${apiBase()}/patient-media/file?path=${encodeURIComponent(objectPath)}`,
    );
  }
  return `${apiBase()}/progress-photos/file?path=${encodeURIComponent(objectPath)}`;
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
): Promise<GuidedUploadResult> {
  const uploaded: UploadedShotRef[] = [];
  const failed: GuidedAngle[] = [];
  for (const shot of shots) {
    if (!uploader) {
      uploaded.push({ angle: shot.angle, uri: shot.uri });
      continue;
    }
    try {
      const prepared = await preparePhotoForUpload({
        uri: shot.uri,
        width: shot.width,
        height: shot.height,
        base64: shot.base64,
      } as ImagePickerAsset);
      const { photoPath } = await uploader(prepared.uri);
      uploaded.push({ angle: shot.angle, objectPath: photoPath });
    } catch (error) {
      console.error(`Progress photo upload failed (${shot.angle})`, error);
      failed.push(shot.angle);
    }
  }
  return { uploaded, failed };
}
