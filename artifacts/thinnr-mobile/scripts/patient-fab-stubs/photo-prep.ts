/**
 * Node stand-in for @/lib/photo-prep (the real one re-encodes via
 * expo-image-manipulator): passes the picked asset through as an
 * already-prepared photo so the preview/send path runs unchanged.
 */
export interface PreparedPhoto {
  uri: string;
  width: number;
  height: number;
  mimeType: string;
}

export const prepCalls: { uri: string }[] = [];

export async function preparePhotoForUpload(asset: {
  uri: string;
  width?: number | null;
  height?: number | null;
}): Promise<PreparedPhoto> {
  prepCalls.push({ uri: asset.uri });
  return {
    uri: asset.uri,
    width: asset.width ?? 800,
    height: asset.height ?? 600,
    mimeType: 'image/jpeg',
  };
}
