export async function uploadFileWithProgress(
  _uploadUrl: string,
  _uri: string,
  _mimeType: string,
  onProgress?: (percent: number) => void,
): Promise<void> {
  onProgress?.(100);
}