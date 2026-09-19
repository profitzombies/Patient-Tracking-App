/**
 * Pure helpers for the Exports panel (kept React-free for the regression scripts).
 */
import type { ExportJobResult, ExportRequestInput } from '@workspace/api-client-react';
import { officeRequest } from '@/lib/office-api';

const EXPORT_MESSAGES = {
  unconfigured: 'Exports are not configured in this environment.',
  signedOut: 'Your session has ended. Sign in again to request an export.',
  unreachable: 'Could not reach the export service. Check your connection and try again.',
  failed: 'The export could not be requested',
};

export function requestExportJob(input: ExportRequestInput): Promise<ExportJobResult> {
  return officeRequest<ExportJobResult>('/api/exports', EXPORT_MESSAGES, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** "Expires in 23 h", "Expires in 40 min", or "Expired". */
export function expiryLabel(expiresAt: string, now: number = Date.now()): string {
  const ms = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'Expired';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `Expires in ${Math.max(1, minutes)} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Expires in ${hours} h`;
  return `Expires in ${Math.round(hours / 24)} d`;
}

export interface ExportProgressLike {
  stage: 'collecting' | 'writing' | 'ready';
  partsDone: number | null;
  partsTotal: number | null;
}

/** Archives name files, CSVs name rows. */
export function countLabel(job: { kind: string; rowCount: number | null }): string | null {
  if (job.rowCount == null) return null;
  const noun = job.kind === 'patient_record' ? 'file' : 'row';
  return `${job.rowCount.toLocaleString('en-US')} ${noun}${job.rowCount === 1 ? '' : 's'}`;
}

/** "1.2 GB", "812.4 MB", "3.1 KB". */
export function formatBytes(bytes: number | null): string | null {
  if (bytes == null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** "Part 2 of 3 · 812.4 MB · 214 files". */
export function partLabel(part: { part: number; sizeBytes: number; fileCount: number }, total: number): string {
  return `Part ${part.part} of ${total} · ${formatBytes(part.sizeBytes) ?? '—'} · ${part.fileCount.toLocaleString('en-US')} file${part.fileCount === 1 ? '' : 's'}`;
}

/**
 * One line of build progress for a multi-part archive while it is queued or
 * running. `partsDone` counts finished parts, so "Writing part 2 of 3" shows
 * while the second part streams; once every part is written the worker is
 * only finalising the job row.
 */
export function progressLabel(status: string, progress: ExportProgressLike | null): string {
  if (status === 'queued' || !progress) return status === 'queued' ? 'Waiting to start' : 'Generating…';
  if (progress.stage === 'collecting') return 'Collecting the record…';
  if (progress.stage === 'ready') return 'Finishing…';
  const done = progress.partsDone ?? 0;
  if (progress.partsTotal == null) return done > 0 ? `Writing archive · ${done} part${done === 1 ? '' : 's'} done` : 'Writing archive…';
  if (done >= progress.partsTotal) return 'Finishing…';
  return `Writing part ${done + 1} of ${progress.partsTotal}`;
}
