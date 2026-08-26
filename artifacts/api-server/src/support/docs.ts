/**
 * The AI Support chat's view of the knowledge library: every READY document
 * with its routing aids and full extracted text.
 *
 * Reads ride the same service-role REST helpers as the HQ document routes.
 * The metadata list is fetched fresh on every turn (it is a few KB), so
 * uploads, replaces, and deletes are picked up immediately; the heavy
 * extracted text is cached per document, keyed by `updated_at`, so each
 * document version is downloaded at most once per process.
 */
import {
  getDocumentDetailRecord,
  listDocumentRecords,
  type KnowledgeDocumentRecord,
} from "../knowledge/docs-store";

export interface SupportDocument {
  id: string;
  title: string;
  /** Routing aids written at ingest; ready rows always carry them. */
  summary: string;
  keywords: string[];
  /** Full extracted text — the grounding material. */
  text: string;
}

interface TextCacheEntry {
  version: string;
  text: string;
}

const textCache = new Map<string, TextCacheEntry>();

/** Test hook: forget cached document text between cases. */
export function clearSupportDocumentCache(): void {
  textCache.clear();
}

function keywordsOf(record: KnowledgeDocumentRecord): string[] {
  if (!Array.isArray(record.keywords)) return [];
  return record.keywords
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * Loads every ready document, oldest first (stable prompt order as HQ adds
 * new files). A document whose text cannot be read right now (replaced
 * mid-request, or flipped away from ready) is skipped rather than failing
 * the whole turn.
 */
export async function loadSupportDocuments(): Promise<SupportDocument[]> {
  const records = (await listDocumentRecords()).filter((record) => record.status === "ready");
  records.sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );

  const loaded = await Promise.all(
    records.map(async (record): Promise<SupportDocument | null> => {
      const cached = textCache.get(record.id);
      let text: string;
      if (cached && cached.version === record.updated_at) {
        text = cached.text;
      } else {
        // Cache miss or a newer version: fetch the detail row. A replace can
        // land between the list and this read — the detail row is the newer
        // truth, so its own updated_at keys the cache entry.
        const detail = await getDocumentDetailRecord(record.id);
        if (!detail || detail.status !== "ready" || typeof detail.extracted_text !== "string") {
          return null;
        }
        text = detail.extracted_text;
        textCache.set(record.id, { version: detail.updated_at, text });
      }
      return {
        id: record.id,
        title: record.title,
        summary: record.summary ?? "",
        keywords: keywordsOf(record),
        text,
      };
    }),
  );

  // Drop cache entries for documents that no longer exist.
  const liveIds = new Set(records.map((record) => record.id));
  for (const id of textCache.keys()) {
    if (!liveIds.has(id)) textCache.delete(id);
  }

  return loaded.filter((doc): doc is SupportDocument => doc !== null);
}
