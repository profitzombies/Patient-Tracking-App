import type {
  HqFileDownloadResult,
  HqFileListResult,
  HqFileSearchResult,
} from '@workspace/api-client-react';
import {
  officeAuthToken,
  officeQuery,
  officeRequest,
  OfficeApiError,
  type OfficeRequestMessages,
} from '@/lib/office-api';

export const OFFICE_FILES_MESSAGES: OfficeRequestMessages = {
  unconfigured: 'Files are not configured in this environment.',
  signedOut: 'Sign in to see the files HQ shares with your office.',
  unreachable: 'Could not reach the file service. Check your connection and try again.',
  failed: 'The files request failed',
};

export function officeFilesQueryKey(office: string | null, folderId: string | null): readonly unknown[] {
  return ['office-files', office ?? 'self', folderId ?? 'root'];
}

export function officeFileSearchQueryKey(office: string | null, query: string): readonly unknown[] {
  return ['office-files-search', office ?? 'self', query];
}

export function fetchOfficeFiles(folderId?: string | null, office?: string | null): Promise<HqFileListResult> {
  const params = new URLSearchParams();
  if (folderId) params.set('folderId', folderId);
  return officeRequest<HqFileListResult>(`/api/office/files${officeQuery(office, params)}`, OFFICE_FILES_MESSAGES);
}

export function searchOfficeFiles(query: string, office?: string | null): Promise<HqFileSearchResult> {
  const params = new URLSearchParams({ q: query });
  return officeRequest<HqFileSearchResult>(`/api/office/files/search${officeQuery(office, params)}`, OFFICE_FILES_MESSAGES);
}

export function fetchOfficeFileDownload(fileId: string, office?: string | null): Promise<HqFileDownloadResult> {
  return officeRequest<HqFileDownloadResult>(
    `/api/office/files/${encodeURIComponent(fileId)}/download-url${officeQuery(office)}`,
    OFFICE_FILES_MESSAGES,
  );
}

export async function fetchOfficeFileContent(fileId: string, office?: string | null): Promise<Blob> {
  const token = await officeAuthToken(OFFICE_FILES_MESSAGES.unconfigured, OFFICE_FILES_MESSAGES.signedOut);
  let response: Response;
  try {
    response = await fetch(`/api/office/files/${encodeURIComponent(fileId)}/content${officeQuery(office)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new OfficeApiError(OFFICE_FILES_MESSAGES.unreachable, 0);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    throw new OfficeApiError(
      typeof body?.error === 'string' ? body.error : `${OFFICE_FILES_MESSAGES.failed} (${response.status}).`,
      response.status,
    );
  }
  return response.blob();
}

export { OfficeApiError as OfficeFilesError };