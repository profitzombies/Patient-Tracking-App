let asset: { uri: string; name: string; mimeType: string; file?: File } | null = null;
export function setDocumentAsset(next: typeof asset): void {
  asset = next;
}
export async function getDocumentAsync() {
  return asset ? { canceled: false as const, assets: [asset] } : { canceled: true as const, assets: [] };
}