/**
 * Patient privacy state as the server reports it: versioned consent, the
 * latest data-export job, and a pending account deletion. Parsed once at
 * hydration (rides /patient-data/state) and refreshed by the privacy routes
 * after every write. Pure — no React, no I/O — so the route gate and the
 * account controls can be proven in Node.
 */

export interface ConsentStatus {
  /** Policy version the app currently requires. */
  requiredVersion: string;
  /** Most recent version this patient recorded, or null when none. */
  recordedVersion: string | null;
  /** True only when recordedVersion === requiredVersion. */
  satisfied: boolean;
  /** Optional photo-analysis agreement on the recorded version. */
  photoAnalysis: boolean | null;
  recordedAt: string | null;
}

export type ExportStatus = 'queued' | 'running' | 'ready' | 'failed' | 'expired';

export interface ExportJob {
  id: string;
  status: ExportStatus;
  requestedAt: string;
  completedAt: string | null;
  expiresAt: string;
  sizeBytes: number | null;
  error: string | null;
}

export interface DeletionRequest {
  status: 'pending' | 'held';
  requestedAt: string;
  purgeAfter: string;
}

export interface DeletionPolicy {
  graceDays: number;
  retentionYears: number;
}

/** The published legal documents behind `consent.requiredVersion`. */
export interface LegalVersionInfo {
  version: string;
  effectiveDate: string;
  status: 'draft' | 'final';
}

export interface PrivacyState {
  consent: ConsentStatus;
  export: ExportJob | null;
  deletion: DeletionRequest | null;
  deletionPolicy: DeletionPolicy;
  /** Null only when the server predates the published-documents field. */
  legal: LegalVersionInfo | null;
}

export interface ConsentWrite {
  policyVersion: string;
  terms: true;
  privacy: true;
  healthData: true;
  photoAnalysis: boolean;
  appVersion: string;
  platform: 'ios' | 'android' | 'web';
}

export interface PrivacyApi {
  fetchPrivacy(): Promise<PrivacyState>;
  recordConsent(input: ConsentWrite): Promise<{ consent: ConsentStatus }>;
  requestExport(): Promise<{ export: ExportJob }>;
  fetchExport(): Promise<{ export: ExportJob | null }>;
  exportDownloadUrl(id: string): Promise<{ url: string; expiresInSeconds: number; fileName: string }>;
  requestDeletion(): Promise<{ deletion: DeletionRequest }>;
  cancelDeletion(): Promise<{ cancelled: boolean }>;
}

export class PrivacyParseError extends Error {
  constructor() {
    super('The server sent privacy details the app couldn’t read.');
    this.name = 'PrivacyParseError';
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export function parseConsent(raw: unknown): ConsentStatus {
  if (!isRecord(raw)) throw new PrivacyParseError();
  const requiredVersion = str(raw.requiredVersion);
  if (!requiredVersion) throw new PrivacyParseError();
  const recordedVersion = str(raw.recordedVersion);
  return {
    requiredVersion,
    recordedVersion,
    satisfied: raw.satisfied === true && recordedVersion === requiredVersion,
    photoAnalysis: typeof raw.photoAnalysis === 'boolean' ? raw.photoAnalysis : null,
    recordedAt: str(raw.recordedAt),
  };
}

const EXPORT_STATUSES: readonly ExportStatus[] = ['queued', 'running', 'ready', 'failed', 'expired'];

export function parseExport(raw: unknown): ExportJob | null {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) throw new PrivacyParseError();
  const id = str(raw.id);
  const requestedAt = str(raw.requestedAt);
  const expiresAt = str(raw.expiresAt);
  const status = raw.status;
  if (!id || !requestedAt || !expiresAt || !EXPORT_STATUSES.includes(status as ExportStatus)) {
    throw new PrivacyParseError();
  }
  return {
    id,
    status: status as ExportStatus,
    requestedAt,
    completedAt: str(raw.completedAt),
    expiresAt,
    sizeBytes: typeof raw.sizeBytes === 'number' && Number.isFinite(raw.sizeBytes) ? raw.sizeBytes : null,
    error: str(raw.error),
  };
}

export function parseDeletion(raw: unknown): DeletionRequest | null {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) throw new PrivacyParseError();
  const requestedAt = str(raw.requestedAt);
  const purgeAfter = str(raw.purgeAfter);
  if ((raw.status !== 'pending' && raw.status !== 'held') || !requestedAt || !purgeAfter) {
    throw new PrivacyParseError();
  }
  return { status: raw.status, requestedAt, purgeAfter };
}

export function parseDeletionPolicy(raw: unknown): DeletionPolicy {
  if (raw === null || raw === undefined) {
    return { graceDays: 7, retentionYears: 7 };
  }
  if (!isRecord(raw)) throw new PrivacyParseError();
  const graceDays =
    typeof raw.graceDays === 'number' && Number.isFinite(raw.graceDays) && raw.graceDays >= 0
      ? raw.graceDays
      : 7;
  const retentionYears =
    typeof raw.retentionYears === 'number' &&
    Number.isFinite(raw.retentionYears) &&
    raw.retentionYears > 0
      ? raw.retentionYears
      : 7;
  return { graceDays, retentionYears };
}

export function parseLegalVersion(raw: unknown): LegalVersionInfo | null {
  if (!isRecord(raw)) return null;
  const version = str(raw.version);
  const effectiveDate = str(raw.effectiveDate);
  const status = raw.status === 'draft' || raw.status === 'final' ? raw.status : null;
  if (!version || !effectiveDate || !status) return null;
  return { version, effectiveDate, status };
}

export function parsePrivacyState(raw: unknown): PrivacyState {
  if (!isRecord(raw)) throw new PrivacyParseError();
  return {
    consent: parseConsent(raw.consent),
    export: parseExport(raw.export),
    deletion: parseDeletion(raw.deletion),
    deletionPolicy: parseDeletionPolicy(raw.deletionPolicy),
    legal: parseLegalVersion(raw.legal),
  };
}

// ── Display helpers ─────────────────────────────────────────────────────────

/** Whole days (rounded up) until the closure moment; 0 once it has passed. */
export function graceDaysRemaining(purgeAfter: string, now: Date = new Date()): number {
  const remainingMs = Date.parse(purgeAfter) - now.getTime();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / 86_400_000);
}

export function describeGrace(purgeAfter: string, now: Date = new Date()): string {
  const days = graceDaysRemaining(purgeAfter, now);
  if (days === 0) return 'Your account closes shortly.';
  if (days === 1) return 'Your account closes in 1 day.';
  return `Your account closes in ${days} days.`;
}

export function formatArchiveSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function exportIsExpired(job: ExportJob, now: Date = new Date()): boolean {
  return job.status === 'expired' || (job.status === 'ready' && Date.parse(job.expiresAt) <= now.getTime());
}

/** Plain words for the account screen's export line. */
export function describeExport(job: ExportJob | null, now: Date = new Date()): string {
  if (!job) return 'Download a copy of everything THINNR holds for you: profile, diary, water, targets, library, check-ins, measurements, photos, and coach chats.';
  if (job.status === 'queued' || job.status === 'running') return 'We’re putting your archive together. We’ll notify you when it’s ready, usually within a few minutes.';
  if (job.status === 'failed') return job.error ? `Your last export didn’t finish: ${job.error} You can request a new one.` : 'Your last export didn’t finish. You can request a new one.';
  if (exportIsExpired(job, now)) return 'Your last archive has expired. Request a new one whenever you like.';
  const size = formatArchiveSize(job.sizeBytes);
  return `Your archive is ready${size ? ` (${size})` : ''}. The link is available until ${new Date(job.expiresAt).toLocaleString()}.`;
}
