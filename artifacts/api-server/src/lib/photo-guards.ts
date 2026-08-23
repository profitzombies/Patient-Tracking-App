/**
 * Shared guards for routes that accept a photo as a data URI inside JSON.
 *
 * Both photo-carrying routes (the standalone menu scan and the coach chat's
 * photo turn) mount their own large-body JSON parser — app.ts skips the
 * global 100kb parser for exactly those paths — and validate the photo
 * against the same format allow-list and decoded-size cap before spending a
 * paid vision call on it. Photos are analyzed in request memory only: never
 * logged, written to disk, or stored.
 */

/**
 * Body cap for photo routes only. The app downscales photos to ~1600px JPEG
 * (typically 100-400 KB as base64) before upload; 8mb leaves generous
 * headroom without accepting arbitrary uploads.
 */
export const PHOTO_BODY_LIMIT = "8mb";

/** Raster formats the vision model accepts (the app always sends JPEG). */
export const PHOTO_DATA_URI_PATTERN =
  /^data:image\/(?:jpeg|jpg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Hard cap on the decoded photo size. */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export const INVALID_PHOTO_MESSAGE =
  "That photo could not be used. Please choose a JPEG or PNG photo and try again.";
export const PHOTO_TOO_LARGE_MESSAGE = "That photo is too large. Please try a smaller one.";

/** Decoded byte size of a base64 data URI, without materializing the bytes. */
export function decodedPhotoBytes(image: string): number {
  const base64Length = image.length - image.indexOf(",") - 1;
  return Math.floor((base64Length * 3) / 4);
}
