import type { HqFile } from '@workspace/api-client-react';

export type UploadState = 'waiting' | 'uploading' | 'saving' | 'compressing' | 'done' | 'failed';

export interface UploadItem {
  id: string;
  file: File;
  folderId: string | null;
  batchId: string;
  compress?: boolean;
  progress: number;
  state: UploadState;
  result?: HqFile;
  error?: string;
}

export interface UploadTransport {
  create(item: UploadItem): Promise<{ uploadUrl: string; fileId: string; objectPath: string }>;
  finalize(item: UploadItem, upload: { fileId: string; objectPath: string }): Promise<HqFile>;
}

// Mirrors the server's storage cap (MAX_HQ_FILE_BYTES, 262144000): the drop
// zone, the picker, and the replacement picker all pre-check against this one
// number so a too-large file is refused before any upload URL is minted.
export const MAX_HQ_FILE_BYTES = 250 * 1024 * 1024;
export const HQ_FILE_LIMIT_LABEL = '250 MB';
export const exceedsHqFileLimit = (file: Pick<File, 'size'>) => file.size > MAX_HQ_FILE_BYTES;

// Mirrors the server's inline-preview ceiling: the /content route buffers the
// whole object, so larger files are download-only and the dialog never asks.
export const MAX_HQ_PREVIEW_BYTES = 50 * 1024 * 1024;

// Mirrors the server's compression ceiling: larger images are stored as-is,
// so the client must not offer a compression choice it cannot honour.
export const MAX_COMPRESS_BYTES = 25 * 1024 * 1024;
export const isCompressibleImage = (file: Pick<File, 'type' | 'size'>) =>
  ['image/jpeg', 'image/png', 'image/webp'].includes(file.type.toLowerCase()) && file.size <= MAX_COMPRESS_BYTES;

export function putFile(
  url: string,
  file: File,
  onProgress: (percent: number) => void,
  xhrFactory: () => XMLHttpRequest = () => new XMLHttpRequest(),
) {
  return new Promise<void>((resolve, reject) => {
    const xhr = xhrFactory();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onerror = () => reject(new Error('Upload to storage failed.'));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error('Upload to storage failed.'));
    };
    xhr.send(file);
  });
}

export class UploadQueue {
  private active = 0;
  private items: UploadItem[] = [];

  constructor(
    private transport: UploadTransport,
    private changed: (items: UploadItem[]) => void,
    private completed: (item: UploadItem) => void,
    private concurrency = 3,
    private xhrFactory?: () => XMLHttpRequest,
  ) {}

  get snapshot() { return [...this.items]; }

  add(files: File[], folderId: string | null, batchId: string) {
    const added = files.map((file, index): UploadItem => ({
      id: `${batchId}-${index}-${file.name}`,
      file, folderId, batchId, progress: 0, state: 'waiting',
      compress: isCompressibleImage(file) ? undefined : false,
    }));
    this.items.push(...added);
    this.emit();
    this.pump();
  }

  answer(batchId: string, compress: boolean) {
    this.items.forEach((item) => {
      if (item.batchId === batchId && isCompressibleImage(item.file) && item.compress === undefined) item.compress = compress;
    });
    this.emit();
    this.pump();
  }

  retry(id: string) {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item || item.state !== 'failed') return;
    item.error = undefined;
    item.progress = 0;
    item.state = 'waiting';
    this.emit();
    this.pump();
  }

  clearSettled() {
    this.items = this.items.filter((item) => item.state !== 'done' && item.state !== 'failed');
    this.emit();
  }

  private emit() { this.changed(this.snapshot); }

  private pump() {
    while (this.active < this.concurrency) {
      const item = this.items.find((candidate) => candidate.state === 'waiting' && candidate.compress !== undefined);
      if (!item) break;
      this.active += 1;
      void this.run(item).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  private async run(item: UploadItem) {
    try {
      item.state = 'uploading';
      this.emit();
      const upload = await this.transport.create(item);
      await putFile(upload.uploadUrl, item.file, (progress) => {
        item.progress = progress;
        this.emit();
      }, this.xhrFactory);
      item.state = item.compress ? 'compressing' : 'saving';
      item.progress = 100;
      this.emit();
      item.result = await this.transport.finalize(item, upload);
      item.state = 'done';
      this.emit();
      this.completed(item);
    } catch (error) {
      item.state = 'failed';
      item.error = error instanceof Error ? error.message : 'Upload failed.';
      this.emit();
    }
  }
}