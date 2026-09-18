/**
 * Display variants for patient photos (progress grid + chat previews).
 *
 * Originals are never touched. Each photo gets two derived siblings, stored
 * under the SAME owner prefix so the purge (prefix delete) and the storage
 * reconciliation (prefix listing) see them as the patient's objects:
 *
 *   <original>          the bytes the phone uploaded (already ~1600 px)
 *   <original>.thumb    longest edge 320 px  — grids and chat bubbles
 *   <original>.medium   longest edge 1024 px — tap-in / lightbox views
 *
 * The ".thumb"/".medium" suffix deliberately fails `isPatientMediaPath` (no
 * dots in a minted id), so a variant can never be finalized, listed, or
 * signed as if it were an original. Availability is recorded on the
 * patient_media ledger row (`variants text[]`), and readers fall back to the
 * original until a variant exists; the backfill job fills the gaps.
 */
import sharp from "sharp";
import { objectStorage } from "./objectStorage";

export const PHOTO_VARIANTS = ["thumb", "medium"] as const;
export type PhotoVariant = (typeof PHOTO_VARIANTS)[number];

/** What a client may ask for; "original" is the stored upload itself. */
export type PhotoSize = PhotoVariant | "original";

export const PHOTO_VARIANT_LONG_EDGE_PX: Record<PhotoVariant, number> = {
  thumb: 320,
  medium: 1024,
};

/** Media kinds that get variants (the task's scope: progress grid + chat). */
export const PHOTO_VARIANT_KINDS = new Set(["progress", "chat"]);

/** Variants are always JPEG — photos, not artwork; alpha is flattened. */
export const PHOTO_VARIANT_CONTENT_TYPE = "image/jpeg";

/** Upper bound on decoded pixels; the phone-side prep never exceeds ~3 MP. */
const MAX_INPUT_PIXELS = 64_000_000;

export function isPhotoVariant(value: unknown): value is PhotoVariant {
  return value === "thumb" || value === "medium";
}

export function isPhotoSize(value: unknown): value is PhotoSize {
  return value === "original" || isPhotoVariant(value);
}

export function photoVariantPath(originalPath: string, variant: PhotoVariant): string {
  return `${originalPath}.${variant}`;
}

/** Every derived sibling of an original, whether or not it exists yet. */
export function photoVariantPaths(originalPath: string): string[] {
  return PHOTO_VARIANTS.map((variant) => photoVariantPath(originalPath, variant));
}

/**
 * Recognizes a stored variant object and names its original. Anything else
 * (an original, an unrelated object) is null.
 */
export function parsePhotoVariantPath(
  objectPath: string,
): { originalPath: string; variant: PhotoVariant } | null {
  for (const variant of PHOTO_VARIANTS) {
    const suffix = `.${variant}`;
    if (objectPath.endsWith(suffix) && objectPath.length > suffix.length) {
      return { originalPath: objectPath.slice(0, -suffix.length), variant };
    }
  }
  return null;
}

/** Normalizes a ledger `variants` column into the known variant names. */
export function availableVariants(raw: unknown): PhotoVariant[] {
  if (!Array.isArray(raw)) return [];
  return PHOTO_VARIANTS.filter((variant) => raw.includes(variant));
}

export function hasAllVariants(raw: unknown): boolean {
  const have = availableVariants(raw);
  return PHOTO_VARIANTS.every((variant) => have.includes(variant));
}

/**
 * Resolves the object path to sign for a requested size: the variant when
 * the ledger says it exists, otherwise the original. Never invents a path
 * for a variant that was not recorded — a signed URL to a missing object is
 * a broken image, not a fallback.
 */
export function resolvePhotoObjectPath(
  originalPath: string,
  size: PhotoSize,
  recordedVariants: unknown,
): { objectPath: string; size: PhotoSize } {
  if (size !== "original" && availableVariants(recordedVariants).includes(size)) {
    return { objectPath: photoVariantPath(originalPath, size), size };
  }
  return { objectPath: originalPath, size: "original" };
}

/**
 * Renders both variants from the original bytes. EXIF orientation is baked
 * in (`rotate()`), so the derived files display upright without metadata;
 * nothing is enlarged, so a small original simply yields same-size copies.
 */
export async function renderPhotoVariants(
  original: Buffer,
): Promise<Record<PhotoVariant, Buffer>> {
  const out = {} as Record<PhotoVariant, Buffer>;
  for (const variant of PHOTO_VARIANTS) {
    const edge = PHOTO_VARIANT_LONG_EDGE_PX[variant];
    out[variant] = await sharp(original, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: variant === "thumb" ? 78 : 84, mozjpeg: true })
      .toBuffer();
  }
  return out;
}

/**
 * Downloads an original, renders, and stores both siblings. Returns the
 * variants now in storage. Throws when the original can't be decoded or a
 * write fails — callers decide whether that is fatal (the backfill records
 * the attempt; finalize keeps the upload and lets the backfill retry).
 */
export async function generatePhotoVariants(originalPath: string): Promise<PhotoVariant[]> {
  const file = await objectStorage.entityFile(originalPath);
  const [downloaded] = await file.download();
  const rendered = await renderPhotoVariants(Buffer.from(downloaded));
  const stored: PhotoVariant[] = [];
  for (const variant of PHOTO_VARIANTS) {
    await objectStorage.saveBuffer(
      photoVariantPath(originalPath, variant),
      rendered[variant],
      PHOTO_VARIANT_CONTENT_TYPE,
    );
    stored.push(variant);
  }
  return stored;
}

/**
 * Strict delete of an original AND its variants. Missing objects are fine
 * (retries stay idempotent); a real storage failure throws after the
 * original went, leaving at worst an unreferenced variant for the sweep.
 */
export async function deletePhotoWithVariants(originalPath: string): Promise<void> {
  await objectStorage.deleteObjectStrict(originalPath);
  for (const variantPath of photoVariantPaths(originalPath)) {
    await objectStorage.deleteObjectStrict(variantPath);
  }
}
