export async function requestMediaLibraryPermissionsAsync(): Promise<{ granted: boolean }> {
  return { granted: true };
}
export async function launchImageLibraryAsync(): Promise<{ canceled: boolean; assets?: unknown[] }> {
  return { canceled: true };
}
export const MediaTypeOptions = { Images: 'images', All: 'all' } as const;