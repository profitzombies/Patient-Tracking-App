/**
 * Upload intents: one row per issued upload URL so the abandoned-upload
 * sweep can find objects that were uploaded but never finalized (no ledger
 * row anywhere references them). Recording is best-effort — an intent write
 * failure is logged, never surfaced to the uploader — because the storage
 * reconciliation job catches anything the intent ledger misses.
 */
import { logger } from "../lib/logger";
import { supabaseAdmin } from "../lib/supabase-admin";

export const UPLOAD_SURFACES = [
  "patient_media",
  "hq_file",
  "training_video",
  "training_thumbnail",
  "training_attachment",
  "knowledge_document",
] as const;
export type UploadSurface = (typeof UPLOAD_SURFACES)[number];

export async function recordUploadIntent(input: { objectPath: string; surface: UploadSurface; ownerId?: string | null }): Promise<boolean> {
  try {
    const result = await supabaseAdmin(
      "POST",
      "/rest/v1/storage_upload_intents?on_conflict=object_path",
      { object_path: input.objectPath, surface: input.surface, owner_id: input.ownerId ?? null, issued_at: new Date().toISOString() },
      "resolution=merge-duplicates,return=minimal",
    );
    if (result.status >= 300) {
      logger.warn({ status: result.status, objectPath: input.objectPath, surface: input.surface }, "upload intent not recorded");
      return false;
    }
    return true;
  } catch (error) {
    logger.warn({ err: error, objectPath: input.objectPath, surface: input.surface }, "upload intent not recorded");
    return false;
  }
}
