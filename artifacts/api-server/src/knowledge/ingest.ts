/**
 * The extraction run for one uploaded knowledge document.
 *
 * Status walks uploaded → extracting → ready | failed, and EVERY persist is
 * conditional on the object path the run started from — a file replaced
 * mid-run can never receive text extracted from the old bytes (the stale
 * run's writes simply match no row, and the replacement kicked its own run).
 *
 * Runs are deduplicated per (document, file) rather than per document, so a
 * replacement can start extracting the new file even while a stale run on
 * the old one is still unwinding.
 */
import { logger } from "../lib/logger";
import { ObjectNotFoundError, objectStorage } from "../lib/objectStorage";
import { updateDocumentIfPathCurrent } from "./docs-store";
import { EmptyTextError, extractDocumentText } from "./extract";
import { writeRoutingAids } from "./summary";

export interface ExtractionTarget {
  id: string;
  title: string;
  object_path: string;
  content_type: string;
}

const activeExtractions = new Set<string>();

function runKey(documentId: string, objectPath: string): string {
  return `${documentId}\n${objectPath}`;
}

export function isExtractionActive(documentId: string, objectPath: string): boolean {
  return activeExtractions.has(runKey(documentId, objectPath));
}

/** Plain words for the failed-status message; details stay in the logs. */
function failureMessage(error: unknown): string {
  if (error instanceof ObjectNotFoundError) {
    return "The stored file is missing from storage — replace the file.";
  }
  if (error instanceof Error && error.message) {
    return error.message.length > 240 ? `${error.message.slice(0, 240)}…` : error.message;
  }
  return "Extraction failed — try again.";
}

export async function runExtraction(target: ExtractionTarget): Promise<void> {
  const { id, object_path: objectPath } = target;

  // Claim the row. No match means the file was already replaced (that
  // replacement kicked its own run) or the document was deleted — either
  // way this run has nothing left to do.
  const claimed = await updateDocumentIfPathCurrent(id, objectPath, {
    status: "extracting",
    error_message: null,
  });
  if (!claimed) return;

  let text: string;
  try {
    const file = await objectStorage.entityFile(objectPath);
    const [content] = await file.download();
    text = await extractDocumentText(content, target.content_type);
  } catch (error) {
    if (!(error instanceof EmptyTextError)) {
      logger.warn({ err: error, documentId: id }, "knowledge extraction failed");
    }
    await updateDocumentIfPathCurrent(id, objectPath, {
      status: "failed",
      error_message: failureMessage(error),
    });
    return;
  }

  // Never throws: falls back to a deterministic heuristic on model trouble.
  const aids = await writeRoutingAids(target.title, text);

  const persisted = await updateDocumentIfPathCurrent(id, objectPath, {
    status: "ready",
    error_message: null,
    extracted_text: text,
    extracted_chars: text.length,
    summary: aids.summary,
    keywords: aids.keywords,
  });
  if (!persisted) {
    logger.info({ documentId: id }, "knowledge extraction finished for a replaced file; discarded");
  }
}

/**
 * Kick extraction in the background. False when this exact (document, file)
 * pair is already being worked on. Failures inside the run mark the row
 * failed themselves; this catch is for infrastructure trouble (for example
 * the status write itself failing), which leaves the row in "extracting" —
 * the retry route clears that because the run key is released here.
 */
export function startExtraction(target: ExtractionTarget): boolean {
  const key = runKey(target.id, target.object_path);
  if (activeExtractions.has(key)) return false;
  activeExtractions.add(key);
  void runExtraction(target)
    .catch((error) => {
      logger.error({ err: error, documentId: target.id }, "knowledge extraction run crashed");
    })
    .finally(() => {
      activeExtractions.delete(key);
    });
  return true;
}
