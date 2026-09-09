export const BLOODWORK_MAX_FILES = 10;
export const BLOODWORK_MAX_BYTES = 20_000_000;
export const BLOODWORK_TRANSCRIPTION_DISCLOSURE =
  'Saving uploads these private files for automatic AI transcription. Review extracted text against the printed report. By selecting Save & Process, you consent to this processing.';
export function emptyBloodworkDraftMetadata(): { title: string; reportDate: string } {
  return { title: '', reportDate: '' };
}

export function makeBloodworkUuid(random: () => number = Math.random): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const value = Math.floor(random() * 16);
    const nibble = character === 'x' ? value : (value & 0x3) | 0x8;
    return nibble.toString(16);
  });
}

export function assertImageCapacity(currentCount: number, incomingCount: number): void {
  if (incomingCount < 1) return;
  if (currentCount + incomingCount > BLOODWORK_MAX_FILES) {
    throw new Error('A report can contain at most 10 images. Remove an image before adding more.');
  }
}

export function assertBloodworkByteSize(size: number, kind: 'PDF' | 'Image'): void {
  if (!Number.isFinite(size) || size < 1) throw new Error(`${kind} is empty or cannot be read.`);
  if (size > BLOODWORK_MAX_BYTES) throw new Error(`${kind} exceeds the 20MB limit.`);
}

export function uploadPercent(sent: number, expected: number): number {
  if (!Number.isFinite(sent) || !Number.isFinite(expected) || expected <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((sent / expected) * 100)));
}

export function assertSuccessfulUploadStatus(status: number | undefined): void {
  if (status === undefined || status < 200 || status >= 300) {
    throw new Error(`Upload failed with status ${status ?? 'unknown'}`);
  }
}

export function canOpenProviderBloodwork(input: {
  sessionUserId: string | null;
  rosterStatus: 'loading' | 'ready' | 'unavailable' | 'error';
  rosterPatientIds: readonly string[];
  patientId: string;
}): boolean {
  return Boolean(
    input.sessionUserId
    && input.rosterStatus === 'ready'
    && input.rosterPatientIds.includes(input.patientId),
  );
}

export interface BloodworkManifestFile {
  clientFileId: string;
  mimeType: string;
  size: number;
}

export function bloodworkDraftFingerprint(
  title: string,
  reportDate: string,
  files: readonly BloodworkManifestFile[],
): string {
  return JSON.stringify({
    title: title.trim(),
    reportDate: reportDate.trim() || null,
    files: files.map(file => ({
      clientFileId: file.clientFileId,
      mimeType: file.mimeType,
      size: file.size,
    })),
  });
}

export function isCommittedUploadReplay(uploadCount: number, fileCount: number): boolean {
  return fileCount > 0 && uploadCount === 0;
}

export function clearDeletedStageRequest(
  current: { fingerprint: string; id: string } | null,
  deletedId: string,
): { fingerprint: string; id: string } | null {
  return current?.id === deletedId ? null : current;
}

export function buildBloodworkMetadataUpdate(input: {
  version: number;
  originalTitle: string;
  originalReportDate: string | null;
  titleDraft: string;
  dateDraft: string;
}): { expectedVersion: number; title: string; reportDate: string | null } | null {
  const title = input.titleDraft.trim();
  const reportDate = input.dateDraft.trim() || null;
  if (!title) return null;
  if (title === input.originalTitle && reportDate === input.originalReportDate) return null;
  return { expectedVersion: input.version, title, reportDate };
}

export class BloodworkCaptureGuard {
  private epoch = 0;
  private visible = false;
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) this.epoch += 1;
  }
  begin(): number {
    return this.epoch;
  }
  accepts(capturedEpoch: number): boolean {
    return this.visible && capturedEpoch === this.epoch;
  }
}

export class BloodworkGeneration {
  private value = 0;
  private controller: AbortController | null = null;

  begin(): { generation: number; signal: AbortSignal } {
    this.controller?.abort();
    this.controller = new AbortController();
    return { generation: ++this.value, signal: this.controller.signal };
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
    this.value += 1;
  }

  isCurrent(generation: number, signal?: AbortSignal): boolean {
    return generation === this.value && !signal?.aborted;
  }
}