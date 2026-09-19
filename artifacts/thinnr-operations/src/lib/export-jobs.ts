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

const CANCEL_MESSAGES = {
  unconfigured: EXPORT_MESSAGES.unconfigured,
  signedOut: 'Your session has ended. Sign in again to cancel an export.',
  unreachable: EXPORT_MESSAGES.unreachable,
  failed: 'The export could not be cancelled',
};

/**
 * Stop one of the caller's queued/running exports. A queued job comes back
 * cancelled; a running one comes back with `cancelRequested` while the
 * worker stops at its next part boundary and removes what it wrote.
 */
export function cancelExportJob(exportId: string): Promise<ExportJobResult> {
  return officeRequest<ExportJobResult>(`/api/exports/${encodeURIComponent(exportId)}/cancel`, CANCEL_MESSAGES, { method: 'POST' });
}

/** Status pill copy shared by the Exports panel and the patient record dialog. */
export const EXPORT_STATUS_LABELS: Record<ExportJobResult['job']['status'], string> = {
  queued: 'Queued',
  running: 'Generating',
  ready: 'Ready',
  failed: 'Failed',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

/** True while the job can still be cancelled (queued, or running and not yet asked to stop). */
export function cancellable(job: { status: string; cancelRequested: boolean }): boolean {
  return job.status === 'queued' || (job.status === 'running' && !job.cancelRequested);
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
  stage: 'collecting' | 'writing' | 'ready' | 'patients' | 'office';
  partsDone: number | null;
  partsTotal: number | null;
  /** Office bundles: patients packed / in the office, bytes of finished parts. */
  patientsDone?: number | null;
  patientsTotal?: number | null;
  bytesWritten?: number | null;
}

/** Kinds that build numbered ZIP parts (everything else is one CSV). */
export const ARCHIVE_KINDS: ReadonlySet<string> = new Set(['patient_record', 'office_bundle']);

/** Archives name files, CSVs name rows. */
export function countLabel(job: { kind: string; rowCount: number | null }): string | null {
  if (job.rowCount == null) return null;
  const noun = ARCHIVE_KINDS.has(job.kind) ? 'file' : 'row';
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
export function progressLabel(status: string, progress: ExportProgressLike | null, cancelRequested = false): string {
  if (cancelRequested && status === 'running') return 'Stopping… removing what was written';
  if (status === 'queued' || !progress) return status === 'queued' ? 'Waiting to start' : 'Generating…';
  if (progress.stage === 'patients' || progress.stage === 'office') return bundleProgressLabel(progress);
  if (progress.stage === 'collecting') return 'Collecting the record…';
  if (progress.stage === 'ready') return 'Finishing…';
  const done = progress.partsDone ?? 0;
  if (progress.partsTotal == null) return done > 0 ? `Writing archive · ${done} part${done === 1 ? '' : 's'} done` : 'Writing archive…';
  if (done >= progress.partsTotal) return 'Finishing…';
  return `Writing part ${done + 1} of ${progress.partsTotal}`;
}

/**
 * Office bundles report patients rather than parts: "Packing patient records ·
 * 120 of 480 patients · 3 parts · 1.2 GB written", then "Writing office
 * records…" once every patient landed. Counts are absent until the job has
 * claimed the row and counted the office.
 */
export function bundleProgressLabel(progress: ExportProgressLike): string {
  if (progress.stage === 'office') return 'Writing office records (orders, payments, team, audit, activity)…';
  const done = progress.patientsDone ?? 0;
  const total = progress.patientsTotal;
  const bits = [
    total == null ? null : `${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} patient${total === 1 ? '' : 's'}`,
    progress.partsDone ? `${progress.partsDone} part${progress.partsDone === 1 ? '' : 's'}` : null,
    progress.bytesWritten ? `${formatBytes(progress.bytesWritten)} written` : null,
  ].filter(Boolean);
  return bits.length > 0 ? `Packing patient records · ${bits.join(' · ')}` : 'Packing patient records…';
}

/** "About 1.2 GB (from the Sep 18 size snapshot)" or an honest "unknown" before the first snapshot. */
export function bundleEstimateLabel(estimate: { estimatedBytes: number | null; snapshotDate: string | null }): string {
  if (estimate.estimatedBytes == null || !estimate.snapshotDate) return 'Size unknown until the first nightly size snapshot has run';
  const date = new Date(`${estimate.snapshotDate}T00:00:00Z`);
  const when = Number.isNaN(date.getTime()) ? estimate.snapshotDate : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `About ${formatBytes(estimate.estimatedBytes)} (this office's share of the ${when} size snapshot)`;
}
