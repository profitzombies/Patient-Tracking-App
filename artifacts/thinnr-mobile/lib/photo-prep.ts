/**
 * Shared photo preparation for AI vision uploads (menu scan screen, coach
 * chat photo turns).
 *
 * Downscales a picked asset and re-encodes it as a JPEG data URI in memory:
 * the longest edge is capped at 1600px — enough for the model to read menu
 * print reliably — at quality 0.7, keeping payloads a few hundred KB. The
 * returned URI serves both as the on-screen preview/bubble source and as the
 * upload body; nothing is written to disk.
 */
import { Platform } from 'react-native';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import type { ImagePickerAsset } from 'expo-image-picker';

/** Longest edge of the uploaded JPEG. */
export const MAX_UPLOAD_EDGE = 1600;
export const UPLOAD_JPEG_QUALITY = 0.7;

export interface PreparedPhoto {
  /** JPEG data URI — used for both the on-screen preview and the upload. */
  uri: string;
  width: number;
  height: number;
}

/** Downscales + re-encodes a picked asset as a JPEG data URI (in memory). */
export async function preparePhotoForUpload(asset: ImagePickerAsset): Promise<PreparedPhoto> {
  // Web assets sometimes arrive as blob: URIs; the picker is asked for
  // base64 there so the manipulator always gets a stable data URI input.
  let sourceUri = asset.uri;
  if (Platform.OS === 'web' && asset.base64 && !sourceUri.startsWith('data:')) {
    sourceUri = `data:${asset.mimeType ?? 'image/jpeg'};base64,${asset.base64}`;
  }

  const context = ImageManipulator.manipulate(sourceUri);
  const largestEdge = Math.max(asset.width ?? 0, asset.height ?? 0);
  if (largestEdge > MAX_UPLOAD_EDGE) {
    if ((asset.width ?? 0) >= (asset.height ?? 0)) {
      context.resize({ width: MAX_UPLOAD_EDGE });
    } else {
      context.resize({ height: MAX_UPLOAD_EDGE });
    }
  }
  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync({
    format: SaveFormat.JPEG,
    compress: UPLOAD_JPEG_QUALITY,
    base64: true,
  });
  const base64 = saved.base64 ?? (saved.uri.startsWith('data:') ? saved.uri.split(',')[1] : null);
  if (!base64) throw new Error('Image encoding produced no base64 data');
  return {
    uri: `data:image/jpeg;base64,${base64}`,
    width: saved.width || asset.width || 3,
    height: saved.height || asset.height || 4,
  };
}
