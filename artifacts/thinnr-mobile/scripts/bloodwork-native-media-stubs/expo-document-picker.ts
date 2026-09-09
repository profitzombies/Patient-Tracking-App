let asset = {
  uri: 'file:///app-cache/report.pdf',
  name: 'report.pdf',
  mimeType: 'application/pdf',
};

export function setDocumentAsset(next: typeof asset): void {
  asset = next;
}

export async function getDocumentAsync() {
  return { canceled: false as const, assets: [asset] };
}