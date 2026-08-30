/**
 * AI Support knowledge base routes.
 *
 * The library is global and uses service-role storage/database access, so
 * every route under /knowledge requires the explicit HQ content permission.
 * The middleware is path-scoped because this router is mounted without a
 * prefix alongside the rest of the API routers.
 *
 * Storage model: browsers upload straight to App Storage via a presigned PUT
 * bound to the document's prefix, then hit a finalize call that verifies the
 * object actually landed (existence + size cap) BEFORE any row exists or
 * changes. Extraction runs in the background with per-step persisted status
 * (uploaded → extracting → ready | failed) so the page can simply poll.
 * Replacement clears the old file's extracted text, summary, and keywords in
 * the same conditional write that swaps the object path — stale knowledge
 * never describes new bytes — then deletes the replaced object.
 */
import { randomUUID } from "crypto";
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import {
  KnowledgeCreateDocumentBody,
  KnowledgeRenameDocumentBody,
  KnowledgeReplaceFileBody,
  KnowledgeUploadUrlBody,
} from "@workspace/api-zod";
import { acquireKnowledgeWriteSlot } from "../support/limits";
import { ObjectNotFoundError, objectStorage } from "../lib/objectStorage";
import {
  deleteDocumentRecord,
  getDocumentDetailRecord,
  getDocumentRecord,
  insertDocumentRecord,
  isDocumentId,
  listDocumentRecords,
  renameDocumentRecord,
  updateDocumentIfPathCurrent,
  type KnowledgeDocumentDetailRecord,
  type KnowledgeDocumentRecord,
} from "../knowledge/docs-store";
import { DOCUMENT_CONTENT_TYPES } from "../knowledge/extract";
import { isExtractionActive, startExtraction } from "../knowledge/ingest";
import { requireHqPermission } from "../lib/staff-auth";

const router: IRouter = Router();
// The knowledge library is a global service-role catalog; both reads and
// mutations require the explicit content permission.
router.use("/knowledge", requireHqPermission("content_manage"));

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

const TYPE_ERROR = "Upload a PDF, Word (.docx), text, or Markdown file.";
const SIZE_ERROR = "That file is over the 25 MB limit.";

/**
 * Per-IP limit on every document WRITE — the stand-in for the retired
 * sign-in gate. Limit first, like the chat route: denials are cheap JSON
 * answers before any storage or database work.
 */
function limitWrites(req: Request, res: Response, next: NextFunction): void {
  const slot = acquireKnowledgeWriteSlot(req.ip ?? "unknown");
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }
  // "close" fires whether the response finished or the connection died
  // mid-request, and release is idempotent — concurrency can never leak.
  res.on("close", slot.release);
  next();
}

/** The object-path prefix every file of this document must live under. */
function documentPrefix(documentId: string): string {
  return `/objects/knowledge-docs/${documentId}/`;
}

function isDocumentObjectPath(documentId: string, objectPath: string): boolean {
  const prefix = documentPrefix(documentId);
  const name = objectPath.slice(prefix.length);
  return objectPath.startsWith(prefix) && name.startsWith("doc-") && !name.includes("/");
}

/** "Thinnr_Approved_Foods.pdf" → "Thinnr_Approved_Foods"; admins rename later. */
function titleFromFileName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.(pdf|docx|txt|md)$/i, "");
  const title = withoutExtension.trim().slice(0, 200);
  return title || "Untitled document";
}

/**
 * Status-correct rejection for the declared type and size, checked on the
 * RAW body so a bad declaration maps to 415/413 rather than a generic zod
 * 400. The zod parse afterwards remains the actual gate.
 */
function uploadPolicyError(body: unknown): { status: number; error: string } | null {
  const raw = (body ?? {}) as Record<string, unknown>;
  if (typeof raw.contentType === "string" && !DOCUMENT_CONTENT_TYPES.has(raw.contentType)) {
    return { status: 415, error: TYPE_ERROR };
  }
  if (typeof raw.sizeBytes === "number" && raw.sizeBytes > MAX_DOCUMENT_BYTES) {
    return { status: 413, error: SIZE_ERROR };
  }
  return null;
}

function keywordsOf(row: KnowledgeDocumentRecord): string[] {
  return Array.isArray(row.keywords)
    ? row.keywords.filter((keyword): keyword is string => typeof keyword === "string")
    : [];
}

function toDocumentDto(row: KnowledgeDocumentRecord) {
  return {
    id: row.id,
    title: row.title,
    originalFilename: row.original_filename,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes) || 0,
    status: row.status,
    errorMessage: row.error_message,
    summary: row.summary,
    keywords: keywordsOf(row),
    extractedChars: Number(row.extracted_chars) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDetailDto(row: KnowledgeDocumentDetailRecord) {
  return { ...toDocumentDto(row), extractedText: row.extracted_text };
}

async function loadDocumentOr404(
  documentId: string,
  res: Response,
): Promise<KnowledgeDocumentRecord | null> {
  if (!isDocumentId(documentId)) {
    res.status(404).json({ error: "No such knowledge document." });
    return null;
  }
  const record = await getDocumentRecord(documentId);
  if (!record) {
    res.status(404).json({ error: "No such knowledge document." });
    return null;
  }
  return record;
}

/**
 * Verify the uploaded object actually landed and fits the cap; rejected
 * uploads are deleted so nothing orphaned lingers under the prefix. Returns
 * the true stored size, or null after writing the error response.
 */
async function verifyUploadedObject(objectPath: string, res: Response): Promise<number | null> {
  let file;
  try {
    file = await objectStorage.entityFile(objectPath);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "The uploaded file never arrived — try the upload again." });
      return null;
    }
    throw error;
  }
  const [metadata] = await file.getMetadata();
  const sizeBytes = Number(metadata.size ?? 0);
  if (sizeBytes === 0) {
    await objectStorage.deleteObject(objectPath);
    res.status(422).json({ error: "The uploaded file is empty." });
    return null;
  }
  if (sizeBytes > MAX_DOCUMENT_BYTES) {
    await objectStorage.deleteObject(objectPath);
    res.status(413).json({ error: SIZE_ERROR });
    return null;
  }
  return sizeBytes;
}

// ---------------------------------------------------------------------------
// Presigned upload (new document)
// ---------------------------------------------------------------------------

router.post(
  "/knowledge/upload-url",
  limitWrites,
  async (req: Request, res: Response) => {
    try {
      const policyError = uploadPolicyError(req.body);
      if (policyError) {
        res.status(policyError.status).json({ error: policyError.error });
        return;
      }
      const parsed = KnowledgeUploadUrlBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }
      const documentId = randomUUID();
      const { uploadUrl, objectPath } = await objectStorage.knowledgeUploadURL(documentId);
      res.json({ documentId, uploadUrl, objectPath });
    } catch (error) {
      req.log?.error({ err: error }, "knowledge upload-url failed");
      res.status(500).json({ error: "Could not prepare the upload — try again." });
    }
  },
);

// ---------------------------------------------------------------------------
// Create (verify the uploaded object, insert the row, kick extraction)
// ---------------------------------------------------------------------------

router.post(
  "/knowledge/documents",
  limitWrites,
  async (req: Request, res: Response) => {
    try {
      const policyError = uploadPolicyError(req.body);
      if (policyError) {
        res.status(policyError.status).json({ error: policyError.error });
        return;
      }
      const parsed = KnowledgeCreateDocumentBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }
      const { documentId, objectPath, fileName, contentType } = parsed.data;
      if (!isDocumentId(documentId)) {
        res.status(400).json({ error: "That document id isn't valid." });
        return;
      }
      if (!isDocumentObjectPath(documentId, objectPath)) {
        res.status(400).json({ error: "That upload doesn't belong to this document." });
        return;
      }
      const existing = await getDocumentRecord(documentId);
      if (existing) {
        res.status(409).json({ error: "That upload was already finalized." });
        return;
      }
      const sizeBytes = await verifyUploadedObject(objectPath, res);
      if (sizeBytes === null) return;
      const row = await insertDocumentRecord({
        id: documentId,
        title: titleFromFileName(fileName),
        original_filename: fileName,
        object_path: objectPath,
        content_type: contentType,
        size_bytes: sizeBytes,
        status: "uploaded",
      });
      if (!row) {
        res.status(409).json({ error: "That upload was already finalized." });
        return;
      }
      startExtraction(row);
      res.json(toDocumentDto(row));
    } catch (error) {
      req.log?.error({ err: error }, "knowledge create failed");
      res.status(500).json({ error: "Could not save the document — try again." });
    }
  },
);

// ---------------------------------------------------------------------------
// List / detail
// ---------------------------------------------------------------------------

router.get("/knowledge/documents", async (req: Request, res: Response) => {
  try {
    const rows = await listDocumentRecords();
    res.json({ documents: rows.map(toDocumentDto) });
  } catch (error) {
    req.log?.error({ err: error }, "knowledge list failed");
    res.status(500).json({ error: "Could not load the knowledge library — try again." });
  }
});

router.get(
  "/knowledge/documents/:documentId",
  async (req: Request, res: Response) => {
    try {
      const documentId = String(req.params.documentId);
      if (!isDocumentId(documentId)) {
        res.status(404).json({ error: "No such knowledge document." });
        return;
      }
      const row = await getDocumentDetailRecord(documentId);
      if (!row) {
        res.status(404).json({ error: "No such knowledge document." });
        return;
      }
      res.json(toDetailDto(row));
    } catch (error) {
      req.log?.error({ err: error }, "knowledge detail failed");
      res.status(500).json({ error: "Could not load the document — try again." });
    }
  },
);

// ---------------------------------------------------------------------------
// Rename (the stored file is untouched)
// ---------------------------------------------------------------------------

router.patch(
  "/knowledge/documents/:documentId",
  limitWrites,
  async (req: Request, res: Response) => {
    try {
      const parsed = KnowledgeRenameDocumentBody.safeParse(req.body);
      const title = parsed.success ? parsed.data.title.trim() : "";
      if (!title) {
        res.status(400).json({ error: "Give the document a name." });
        return;
      }
      const documentId = String(req.params.documentId);
      if (!isDocumentId(documentId)) {
        res.status(404).json({ error: "No such knowledge document." });
        return;
      }
      const row = await renameDocumentRecord(documentId, title);
      if (!row) {
        res.status(404).json({ error: "No such knowledge document." });
        return;
      }
      res.json(toDocumentDto(row));
    } catch (error) {
      req.log?.error({ err: error }, "knowledge rename failed");
      res.status(500).json({ error: "Could not rename the document — try again." });
    }
  },
);

// ---------------------------------------------------------------------------
// Delete (stored file first, then the row)
// ---------------------------------------------------------------------------

router.delete(
  "/knowledge/documents/:documentId",
  limitWrites,
  async (req: Request, res: Response) => {
    try {
      const record = await loadDocumentOr404(String(req.params.documentId), res);
      if (!record) return;
      await objectStorage.deleteObject(record.object_path);
      await deleteDocumentRecord(record.id);
      res.json({ deleted: true });
    } catch (error) {
      req.log?.error({ err: error }, "knowledge delete failed");
      res.status(500).json({ error: "Could not delete the document — try again." });
    }
  },
);

// ---------------------------------------------------------------------------
// Replace: presigned upload under the SAME document, then a conditional swap
// ---------------------------------------------------------------------------

router.post(
  "/knowledge/documents/:documentId/upload-url",
  limitWrites,
  async (req: Request, res: Response) => {
    try {
      const policyError = uploadPolicyError(req.body);
      if (policyError) {
        res.status(policyError.status).json({ error: policyError.error });
        return;
      }
      const parsed = KnowledgeUploadUrlBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }
      const record = await loadDocumentOr404(String(req.params.documentId), res);
      if (!record) return;
      const { uploadUrl, objectPath } = await objectStorage.knowledgeUploadURL(record.id);
      res.json({ documentId: record.id, uploadUrl, objectPath });
    } catch (error) {
      req.log?.error({ err: error }, "knowledge replace upload-url failed");
      res.status(500).json({ error: "Could not prepare the upload — try again." });
    }
  },
);

router.post(
  "/knowledge/documents/:documentId/file",
  limitWrites,
  async (req: Request, res: Response) => {
    try {
      const policyError = uploadPolicyError(req.body);
      if (policyError) {
        res.status(policyError.status).json({ error: policyError.error });
        return;
      }
      const parsed = KnowledgeReplaceFileBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }
      const record = await loadDocumentOr404(String(req.params.documentId), res);
      if (!record) return;
      const { objectPath, fileName, contentType } = parsed.data;
      if (!isDocumentObjectPath(record.id, objectPath)) {
        res.status(400).json({ error: "That upload doesn't belong to this document." });
        return;
      }
      const sizeBytes = await verifyUploadedObject(objectPath, res);
      if (sizeBytes === null) return;

      // One conditional write swaps the file AND clears everything the old
      // file produced — text, summary, keywords, failure state. Losing the
      // condition means someone else replaced or deleted in between.
      const updated = await updateDocumentIfPathCurrent(record.id, record.object_path, {
        object_path: objectPath,
        content_type: contentType,
        size_bytes: sizeBytes,
        original_filename: fileName,
        status: "uploaded",
        error_message: null,
        extracted_text: null,
        extracted_chars: 0,
        summary: null,
        keywords: [],
      });
      if (!updated) {
        await objectStorage.deleteObject(objectPath);
        res.status(409).json({ error: "The document changed while finalizing — upload the file again." });
        return;
      }
      await objectStorage.deleteObject(record.object_path);
      startExtraction(updated);
      res.json(toDocumentDto(updated));
    } catch (error) {
      req.log?.error({ err: error }, "knowledge replace failed");
      res.status(500).json({ error: "Could not replace the file — try again." });
    }
  },
);

// ---------------------------------------------------------------------------
// Retry extraction (also unsticks "extracting" after a server restart)
// ---------------------------------------------------------------------------

router.post(
  "/knowledge/documents/:documentId/extract",
  limitWrites,
  async (req: Request, res: Response) => {
    try {
      const record = await loadDocumentOr404(String(req.params.documentId), res);
      if (!record) return;
      if (isExtractionActive(record.id, record.object_path) || !startExtraction(record)) {
        res.status(409).json({ error: "An extraction run is already in progress." });
        return;
      }
      res.status(202).json({ status: "extracting" });
    } catch (error) {
      req.log?.error({ err: error }, "knowledge extract retry failed");
      res.status(500).json({ error: "Could not restart extraction — try again." });
    }
  },
);

export default router;
