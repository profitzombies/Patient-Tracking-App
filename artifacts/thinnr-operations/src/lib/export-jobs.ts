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
