export type TestFile = {
  clientFileId: string;
  uri: string;
  mimeType: string;
  size: number;
  fileName: string;
  appOwned: boolean;
};
export type BloodworkDraftFile = TestFile;

export let nextPdf: TestFile | null = null;
export const disposed: string[] = [];
export const prepareCalls: string[] = [];

export function resetMedia(): void {
  nextPdf = {
    clientFileId: 'file-a',
    uri: 'file:///report.pdf',
    mimeType: 'application/pdf',
    size: 100,
    fileName: 'report.pdf',
    appOwned: false,
  };
  disposed.length = 0;
  prepareCalls.length = 0;
}

export async function pickBloodworkPdf(): Promise<TestFile | null> {
  return nextPdf;
}

export async function prepareBloodworkImage() {
  prepareCalls.push('image');
  throw new Error('camera is not used by this screen behavior suite');
}

export async function prepareBloodworkImageBatch() {
  prepareCalls.push('batch');
  throw new Error('library is not used by this screen behavior suite');
}

export async function disposeBloodworkDraftFiles(files: readonly TestFile[]): Promise<void> {
  disposed.push(...files.map(file => file.clientFileId));
}

export async function disposeBloodworkOwnedUri(uri: string): Promise<void> {
  disposed.push(uri);
}