export async function requestPermissionsAsync(): Promise<{ granted: boolean }> {
  return { granted: true };
}
export async function createAssetAsync(_uri: string): Promise<{ id: string }> {
  return { id: 'asset' };
}