/**
 * Client for the API server's AI Support knowledge-base routes.
 *
 * Transport: paths are root-relative `/api/...`, and files go STRAIGHT to
 * App Storage via a presigned PUT — the JSON API only mints upload URLs and
 * finalizes them. The routes have no sign-in gate (demo posture): anyone in
 * the admin portal manages the library, and the server bounds writes with a
 * per-IP limiter instead. When a real Supabase session exists its bearer is
 * still attached (signed-in staff send exactly what they always sent); a
 * missing session simply means an anonymous call, never a refusal.
 */
import { supabase } from '@/lib/supabase';
import { uploadToStorage } from '@/lib/training-media';

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

export type KnowledgeStatus = 'uploaded' | 'extracting' | 'ready' | 'failed';

export interface KnowledgeDocument {
  id: string;
  title: string;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
  status: KnowledgeStatus;
  errorMessage: string | null;
  summary: string | null;
  keywords: string[];
  extractedChars: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeDocumentDetail extends KnowledgeDocument {
  extractedText: string | null;
}

export class KnowledgeError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'KnowledgeError';
    this.status = status;
  }
}

/** Accepted upload types, plus extension fallbacks for browsers that report
 * an empty or vendor-specific MIME (common for .md, occasional for .docx). */
const DOCUMENT_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
]);
const EXTENSION_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  md: 'text/markdown',
};

export const UPLOAD_ACCEPT = '.pdf,.docx,.txt,.md';

export function resolveDocumentType(file: File): string | null {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  // Extension first: browsers mislabel .md and sometimes .docx, and the
  // picker already filtered on extensions.
  return EXTENSION_TYPES[ext] ?? (DOCUMENT_TYPES.has(file.type) ? file.type : null);
}

/** Plain-words validation before any byte leaves the browser. */
export function describeDocumentProblem(file: File): string | null {
  if (!resolveDocumentType(file)) {
    return 'That file type isn\u2019t supported \u2014 upload a PDF, Word (.docx), text, or Markdown file.';
  }
  if (file.size === 0) return 'That file is empty.';
  if (file.size > MAX_DOCUMENT_BYTES) return 'That file is over the 25 MB limit.';
  return null;
}

export function documentTypeLabel(contentType: string): string {
  switch (contentType) {
    case 'application/pdf':
      return 'PDF';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return 'Word';
    case 'text/markdown':
      return 'Markdown';
    default:
      return 'Text';
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** The real app session's bearer when one exists; null means anonymous. */
async function sessionToken(): Promise<string | null> {
  if (!supabase) return null;
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error) return body.error;
  } catch {
    // Non-JSON error body — fall through to the generic message.
  }
  return `The request failed (${response.status}) \u2014 try again.`;
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await sessionToken();
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    throw new KnowledgeError(await errorMessage(response), response.status);
  }
  return (await response.json()) as T;
}

export async function listKnowledgeDocuments(): Promise<KnowledgeDocument[]> {
  const result = await apiFetch<{ documents: KnowledgeDocument[] }>('/knowledge/documents');
  return result.documents;
}

export async function fetchKnowledgeDocument(documentId: string): Promise<KnowledgeDocumentDetail> {
  return apiFetch(`/knowledge/documents/${documentId}`);
}

export async function renameKnowledgeDocument(
  documentId: string,
  title: string,
): Promise<KnowledgeDocument> {
  return apiFetch(`/knowledge/documents/${documentId}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
}

export async function deleteKnowledgeDocument(documentId: string): Promise<void> {
  await apiFetch(`/knowledge/documents/${documentId}`, { method: 'DELETE' });
}

export async function retryExtraction(documentId: string): Promise<void> {
  await apiFetch(`/knowledge/documents/${documentId}/extract`, { method: 'POST' });
}

/**
 * Upload a NEW document end to end: mint the presigned URL, PUT the bytes
 * straight to storage (progress via `onProgress`), then finalize — the
 * finalize call verifies the object server-side and kicks off extraction.
 */
export async function uploadKnowledgeDocument(
  file: File,
  contentType: string,
  onProgress: (pct: number) => void,
): Promise<KnowledgeDocument> {
  const { documentId, uploadUrl, objectPath } = await apiFetch<{
    documentId: string;
    uploadUrl: string;
    objectPath: string;
  }>('/knowledge/upload-url', {
    method: 'POST',
    body: JSON.stringify({ fileName: file.name, contentType, sizeBytes: file.size }),
  });
  await uploadToStorage(uploadUrl, file, contentType, onProgress);
  return apiFetch<KnowledgeDocument>('/knowledge/documents', {
    method: 'POST',
    body: JSON.stringify({ documentId, objectPath, fileName: file.name, contentType }),
  });
}

/**
 * Replace the file behind an existing document. The server clears the old
 * extracted text, summary, and keywords in the same swap and re-extracts
 * from the new file — stale knowledge never survives a replacement.
 */
export async function replaceKnowledgeDocument(
  documentId: string,
  file: File,
  contentType: string,
  onProgress: (pct: number) => void,
): Promise<KnowledgeDocument> {
  const { uploadUrl, objectPath } = await apiFetch<{
    uploadUrl: string;
    objectPath: string;
  }>(`/knowledge/documents/${documentId}/upload-url`, {
    method: 'POST',
    body: JSON.stringify({ fileName: file.name, contentType, sizeBytes: file.size }),
  });
  await uploadToStorage(uploadUrl, file, contentType, onProgress);
  return apiFetch<KnowledgeDocument>(`/knowledge/documents/${documentId}/file`, {
    method: 'POST',
    body: JSON.stringify({ objectPath, fileName: file.name, contentType }),
  });
}
