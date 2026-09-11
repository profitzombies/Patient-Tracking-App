export interface BloodworkReport {
  id: string;
  patientId: string;
  title: string;
  reportDate: string | null;
  uploadedAt: string;
  version: number;
  kind: 'images' | 'pdf';
  fileCount: number;
  pageCount: number;
  extractionStatus: 'queued' | 'processing' | 'completed' | 'failed';
  extractionError: string | null;
  reviewStatus: 'unreviewed';
  processing?: BloodworkProcessingMetadata | null;
}

/**
 * The API keeps processing metadata nested under report.processing so the
 * ordinary report DTO remains useful to list views. Keep this client shape
 * deliberately additive: older servers may omit it while a report is queued.
 */
export interface BloodworkProcessingMetadata {
  phase?: 'waiting' | 'reading_pages' | 'preparing_results' | 'completed' | 'failed';
  completedPages?: number | null;
  totalPages?: number | null;
  startedAt?: string | null;
  updatedAt?: string | null;
  completedAt?: string | null;
  observedAt?: string | null;
  activity?: 'active' | 'waiting' | 'delayed' | 'unknown';
  elapsedSeconds?: number | null;
  leaseUntil?: string | null;
  error?: string | null;
}

export type BloodworkReportLike = BloodworkReport;

export interface BloodworkProcessingSnapshot {
  phase: BloodworkProcessingMetadata['phase'];
  activity: BloodworkProcessingMetadata['activity'];
  completedPages: number | null;
  totalPages: number | null;
  startedAt: string | null;
  updatedAt: string | null;
  elapsedSeconds: number | null;
}

export type BloodworkProcessingLabel =
  | 'checking'
  | 'queued'
  | 'reading'
  | 'organizing'
  | 'completed'
  | 'failed';

function boundedPageCount(value: unknown, total: number | null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return null;
  }
  if (total !== null && value > total) return total;
  return value;
}

export function getBloodworkProcessingSnapshot(report: unknown): BloodworkProcessingSnapshot {
  const source = report as {
    pageCount?: unknown;
    extractionStatus?: unknown;
    processing?: BloodworkProcessingMetadata | null;
  } | null;
  const raw = source?.processing;
  const reportPageCount = typeof source?.pageCount === 'number'
    && Number.isFinite(source.pageCount)
    && Number.isInteger(source.pageCount)
    && source.pageCount > 0
    ? source.pageCount
    : null;
  const total = typeof raw?.totalPages === 'number'
    && Number.isFinite(raw.totalPages)
    && Number.isInteger(raw.totalPages)
    && raw.totalPages > 0
    ? raw.totalPages
    : reportPageCount;
  const rawPhase = raw?.phase === 'waiting'
    || raw?.phase === 'reading_pages'
    || raw?.phase === 'preparing_results'
    || raw?.phase === 'completed'
    || raw?.phase === 'failed'
    ? raw.phase
    : undefined;
  const phase = rawPhase
    ?? (source?.extractionStatus === 'queued'
      ? 'waiting'
      : source?.extractionStatus === 'processing'
        ? 'reading_pages'
        : source?.extractionStatus === 'completed'
          ? 'completed'
          : source?.extractionStatus === 'failed'
            ? 'failed'
            : undefined);
  const rawCompletedPages = boundedPageCount(raw?.completedPages, total);
  const completedPages = rawCompletedPages
    ?? (source?.extractionStatus === 'completed' ? total : null);
  const activity = raw?.activity === 'active'
    || raw?.activity === 'waiting'
    || raw?.activity === 'delayed'
    || raw?.activity === 'unknown'
    ? raw.activity
    : undefined;
  return {
    phase,
    activity,
    completedPages,
    totalPages: total,
    startedAt: typeof raw?.startedAt === 'string' && !Number.isNaN(Date.parse(raw.startedAt))
      ? raw.startedAt
      : null,
    updatedAt: typeof raw?.updatedAt === 'string' && !Number.isNaN(Date.parse(raw.updatedAt))
      ? raw.updatedAt
      : null,
    elapsedSeconds: typeof raw?.elapsedSeconds === 'number'
      && Number.isFinite(raw.elapsedSeconds)
      && raw.elapsedSeconds >= 0
      ? Math.floor(raw.elapsedSeconds)
      : null,
  };
}

/**
 * The API only reports page-reading and result-preparation phases. The
 * client deliberately maps those server facts to copy instead of estimating a
 * percentage or a completion time. "Checking" is reserved for a response
 * that has not supplied a reliable phase yet.
 */
export function getBloodworkProcessingLabel(report: unknown): BloodworkProcessingLabel {
  const source = report as {
    extractionStatus?: unknown;
    processing?: BloodworkProcessingMetadata | null;
  } | null;
  if (source?.extractionStatus === 'completed') return 'completed';
  if (source?.extractionStatus === 'failed') return 'failed';
  if (source?.processing?.phase === 'preparing_results') return 'organizing';
  if (source?.processing?.phase === 'reading_pages') return 'reading';
  if (source?.extractionStatus === 'queued' || source?.processing?.phase === 'waiting') {
    return 'queued';
  }
  if (source?.extractionStatus === 'processing') {
    return 'reading';
  }
  return 'checking';
}

export function formatBloodworkElapsed(startedAt: string | null, now = Date.now()): string | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start) || start > now) return null;
  const seconds = Math.floor((now - start) / 1000);
  return formatBloodworkElapsedSeconds(seconds);
}

export function formatBloodworkElapsedSeconds(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export interface BloodworkFile {
  id: string;
  position: number;
  mimeType: string;
  size: number;
  pageCount: number;
  width: number | null;
  height: number | null;
}

export interface BloodworkResult {
  id: string;
  reportId: string;
  sourceFileId: string;
  sourcePage: number;
  position: number;
  testName: string | null;
  valueText: string | null;
  units: string | null;
  referenceRange: string | null;
  labFlag: string | null;
  uncertain: boolean;
  version: number;
  reviewStatus: 'unreviewed';
  updatedAt: string;
  corrected: boolean;
}

export interface BloodworkDetail {
  report: BloodworkReport;
  files: BloodworkFile[];
  results: BloodworkResult[];
}

export interface BloodworkCorrection {
  id: string;
  resultId: string;
  actorRole: 'patient' | 'provider' | 'hq';
  createdAt: string;
  before: {
    testName: string | null;
    valueText: string | null;
    units: string | null;
    referenceRange: string | null;
    labFlag: string | null;
    uncertain: boolean;
  };
  after: {
    testName: string | null;
    valueText: string | null;
    units: string | null;
    referenceRange: string | null;
    labFlag: string | null;
    uncertain: boolean;
  };
  version: number;
}
