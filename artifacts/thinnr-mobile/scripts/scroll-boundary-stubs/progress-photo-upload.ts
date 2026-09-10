export function progressPhotoDisplayUrl(photo: unknown): string | undefined {
  return typeof photo === 'object' && photo !== null && 'uri' in photo
    ? String((photo as { uri?: unknown }).uri)
    : undefined;
}