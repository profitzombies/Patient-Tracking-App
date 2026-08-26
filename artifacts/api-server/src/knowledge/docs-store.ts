/**
 * Service-role access to the AI Support knowledge document rows.
 *
 * Writes here bypass RLS on purpose: the routes verify the caller's own
 * Supabase staff session first (lib/staff-auth.ts), then persist
 * server-owned fields — object paths, extraction status, extracted text —
 * that no client policy allows. Only object PATHS are stored, never signed
 * URLs.
 *
 * Every extraction-side write is CONDITIONAL on the object path it
 * extracted from (`object_path=eq.…`), so a file replaced mid-extraction
 * can never receive text that describes the old bytes.
 */

export type KnowledgeStatus = "uploaded" | "extracting" | "ready" | "failed";

export interface KnowledgeDocumentRecord {
  id: string;
  title: string;
  original_filename: string;
  object_path: string;
  content_type: string;
  size_bytes: number;
  status: KnowledgeStatus;
  error_message: string | null;
  extracted_chars: number;
  summary: string | null;
  keywords: unknown;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeDocumentDetailRecord extends KnowledgeDocumentRecord {
  extracted_text: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDocumentId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** List payloads never carry extracted_text — it can be hundreds of KB. */
const LIST_COLUMNS =
  "id,title,original_filename,object_path,content_type,size_bytes,status,error_message,extracted_chars,summary,keywords,created_at,updated_at";
const DETAIL_COLUMNS = `${LIST_COLUMNS},extracted_text`;

function base(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL is not configured");
  return url.replace(/\/$/, "");
}

function headers(extra?: Record<string, string>): Record<string, string> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

export class RestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "RestError";
    Object.setPrototypeOf(this, RestError.prototype);
  }
}

async function rest(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${base()}/rest/v1${path}`, {
    method,
    headers: headers(method === "GET" ? undefined : { Prefer: "return=representation" }),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new RestError(
      `Supabase ${method} ${path.split("?")[0]} failed (${response.status}): ${text.slice(0, 200)}`,
      response.status,
    );
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function listDocumentRecords(): Promise<KnowledgeDocumentRecord[]> {
  const rows = (await rest(
    "GET",
    `/knowledge_documents?select=${LIST_COLUMNS}&order=created_at.desc`,
  )) as KnowledgeDocumentRecord[];
  return Array.isArray(rows) ? rows : [];
}

export async function getDocumentRecord(documentId: string): Promise<KnowledgeDocumentRecord | null> {
  if (!isDocumentId(documentId)) return null;
  const rows = (await rest(
    "GET",
    `/knowledge_documents?id=eq.${documentId}&select=${LIST_COLUMNS}`,
  )) as KnowledgeDocumentRecord[];
  return rows[0] ?? null;
}

export async function getDocumentDetailRecord(
  documentId: string,
): Promise<KnowledgeDocumentDetailRecord | null> {
  if (!isDocumentId(documentId)) return null;
  const rows = (await rest(
    "GET",
    `/knowledge_documents?id=eq.${documentId}&select=${DETAIL_COLUMNS}`,
  )) as KnowledgeDocumentDetailRecord[];
  return rows[0] ?? null;
}

/** Insert the finalized upload; null when that id already has a row. */
export async function insertDocumentRecord(row: {
  id: string;
  title: string;
  original_filename: string;
  object_path: string;
  content_type: string;
  size_bytes: number;
  status: KnowledgeStatus;
}): Promise<KnowledgeDocumentRecord | null> {
  if (!isDocumentId(row.id)) throw new Error("Invalid document id");
  try {
    const rows = (await rest(
      "POST",
      `/knowledge_documents?select=${LIST_COLUMNS}`,
      row,
    )) as KnowledgeDocumentRecord[];
    return rows[0] ?? null;
  } catch (error) {
    if (error instanceof RestError && error.status === 409) return null;
    throw error;
  }
}

export async function renameDocumentRecord(
  documentId: string,
  title: string,
): Promise<KnowledgeDocumentRecord | null> {
  if (!isDocumentId(documentId)) return null;
  const rows = (await rest(
    "PATCH",
    `/knowledge_documents?id=eq.${documentId}&select=${LIST_COLUMNS}`,
    { title },
  )) as KnowledgeDocumentRecord[] | null;
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}

/**
 * Update a document only while its stored file is still the one the caller
 * validated. The `object_path` filter closes both races at once: a replace
 * landing during extraction (the old run's writes match nothing), and two
 * replaces landing at once (the loser's conditional swap matches nothing).
 */
export async function updateDocumentIfPathCurrent(
  documentId: string,
  expectedObjectPath: string,
  patch: Partial<{
    object_path: string;
    content_type: string;
    size_bytes: number;
    original_filename: string;
    status: KnowledgeStatus;
    error_message: string | null;
    extracted_text: string | null;
    extracted_chars: number;
    summary: string | null;
    keywords: string[];
  }>,
): Promise<KnowledgeDocumentRecord | null> {
  if (!isDocumentId(documentId)) return null;
  const filter = `object_path=eq.${encodeURIComponent(expectedObjectPath)}`;
  const rows = (await rest(
    "PATCH",
    `/knowledge_documents?id=eq.${documentId}&${filter}&select=${LIST_COLUMNS}`,
    patch,
  )) as KnowledgeDocumentRecord[] | null;
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}

/** True when a row was actually removed. */
export async function deleteDocumentRecord(documentId: string): Promise<boolean> {
  if (!isDocumentId(documentId)) return false;
  const rows = (await rest(
    "DELETE",
    `/knowledge_documents?id=eq.${documentId}&select=id`,
  )) as Array<{ id: string }> | null;
  return Array.isArray(rows) && rows.length > 0;
}
