import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import {
  CreateHqFileUploadBody,
  FinalizeHqFileBody,
  UpdateHqSettingsBody,
} from "@workspace/api-zod";
import { recordAdminAuditEvent } from "../lib/admin-audit";
import { objectStorage, ObjectNotFoundError, UPLOAD_URL_TTL_SEC } from "../lib/objectStorage";
import { requireHqPermission, type StaffIdentity } from "../lib/staff-auth";
import { supabaseAdmin } from "../lib/supabase-admin";

const router: IRouter = Router();
const requireAdmin = requireHqPermission("settings_manage");
const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** We inspect bytes, never just GCS/client MIME metadata. This is deliberately
 * bounded: a hostile 50 MB upload cannot make finalization read the whole file. */
export const HQ_FILE_HEAD_BYTES = 64 * 1024;
const DOWNLOAD_TTL_SEC = 300;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowedTypes = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const extensionsByContentType: Record<string, readonly string[]> = {
  "application/pdf": [".pdf"],
  "application/msword": [".doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "application/vnd.ms-excel": [".xls"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  "application/vnd.ms-powerpoint": [".ppt"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [".pptx"],
  "text/plain": [".txt"],
  "text/csv": [".csv"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
  "image/gif": [".gif"],
};

router.use("/hq/settings", requireAdmin);
router.use("/hq/files", requireAdmin);

function identity(res: { locals: Record<string, unknown> }): StaffIdentity {
  return res.locals.staff as StaffIdentity;
}

export function cleanHqFileName(value: string): string | null {
  const name = value.trim().normalize("NFC");
  return name && name.length <= 240 && !/[\u0000-\u001f\u007f/\\]/.test(name) && name !== "." && name !== ".."
    ? name
    : null;
}

/** Attachment names are a second boundary: ZIP/CFB signatures alone cannot
 * distinguish Office document families. Match the safe, user-visible suffix. */
export function hqFileNameMatchesContentType(name: string, contentType: string): boolean {
  const folded = name.toLocaleLowerCase("en-US");
  return extensionsByContentType[contentType]?.some(extension =>
    folded.length > extension.length && folded.endsWith(extension)
  ) ?? false;
}

export function validHqTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function starts(head: Buffer, signature: number[]): boolean {
  return head.length >= signature.length && signature.every((byte, index) => head[index] === byte);
}

/** Validates the declared type against a bounded stored-object byte prefix. */
export function validateHqFileHead(contentType: string, head: Buffer): boolean {
  if (!head.length) return false;
  switch (contentType) {
    case "application/pdf":
      return starts(head, [0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
    case "application/msword":
    case "application/vnd.ms-excel":
    case "application/vnd.ms-powerpoint":
      return starts(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      return starts(head, [0x50, 0x4b, 0x03, 0x04]) || starts(head, [0x50, 0x4b, 0x05, 0x06]);
    case "image/png":
      return starts(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return starts(head, [0xff, 0xd8, 0xff]);
    case "image/webp":
      return head.length >= 12 && head.subarray(0, 4).toString("ascii") === "RIFF" &&
        head.subarray(8, 12).toString("ascii") === "WEBP";
    case "image/gif":
      return starts(head, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
        starts(head, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    case "text/plain":
    case "text/csv":
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(head);
        // Tabs and line separators are expected in CSV/plain text. Other C0
        // controls and DEL make this a binary payload masquerading as text.
        return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

function settingsDto(row: Record<string, unknown>) {
  return {
    organizationName: String(row.organization_name),
    supportEmail: row.support_email ? String(row.support_email) : null,
    supportPhone: row.support_phone ? String(row.support_phone) : null,
    defaultTimezone: String(row.default_timezone),
    updatedAt: String(row.updated_at),
  };
}

function fileDto(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    name: String(row.name),
    contentType: String(row.content_type),
    size: Number(row.size_bytes),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

router.get("/hq/settings", async (req, res) => {
  try {
    const result = await supabaseAdmin("GET", "/rest/v1/hq_organization_settings?singleton=eq.true&select=organization_name,support_email,support_phone,default_timezone,updated_at&limit=1");
    if (result.status >= 300 || !Array.isArray(result.json) || !result.json[0]) throw new Error(`settings read failed (${result.status})`);
    res.json(settingsDto(result.json[0] as Record<string, unknown>));
  } catch (error) {
    req.log?.error({ err: error }, "HQ settings read failed");
    res.status(502).json({ error: "Could not load organization settings right now." });
  }
});

router.put("/hq/settings", async (req, res) => {
  const parsed = UpdateHqSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Check the organization settings." });
    return;
  }
  const input = parsed.data;
  const organizationName = input.organizationName.trim();
  const supportEmail = input.supportEmail?.trim().toLowerCase() || null;
  const supportPhone = input.supportPhone?.trim() || null;
  const defaultTimezone = input.defaultTimezone.trim();
  if (
    !organizationName ||
    (supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supportEmail)) ||
    (supportPhone && !/^[+()0-9 .-]{7,40}$/.test(supportPhone)) ||
    !validHqTimezone(defaultTimezone)
  ) {
    res.status(400).json({ error: "Check the organization settings." });
    return;
  }
  try {
    const actor = identity(res);
    const now = new Date().toISOString();
    const result = await supabaseAdmin("POST", "/rest/v1/hq_organization_settings?on_conflict=singleton", {
      singleton: true, organization_name: organizationName, support_email: supportEmail,
      support_phone: supportPhone, default_timezone: defaultTimezone, updated_at: now, updated_by: actor.userId,
    }, "resolution=merge-duplicates,return=representation");
    if (result.status >= 300) throw new Error(`settings update failed (${result.status})`);
    const row = Array.isArray(result.json) ? result.json[0] : result.json;
    await recordAdminAuditEvent({
      action: "hq_settings_updated", actorUserId: actor.userId, actorKind: "hq",
      providerId: null, targetKind: "organization_settings", targetId: "singleton",
      requestId: req.headers["x-request-id"]?.toString() ?? null,
      metadata: { field: "organization_settings" },
    }).catch(error => req.log?.error({ err: error }, "HQ settings audit failed"));
    res.json(settingsDto(row as Record<string, unknown>));
  } catch (error) {
    req.log?.error({ err: error }, "HQ settings update failed");
    res.status(502).json({ error: "Could not save organization settings right now." });
  }
});

router.post("/hq/files/upload-url", async (req, res) => {
  const parsed = CreateHqFileUploadBody.safeParse(req.body);
  const name = parsed.success ? cleanHqFileName(parsed.data.name) : null;
  if (!parsed.success || !name || !Number.isInteger(parsed.data.size)) {
    res.status(400).json({ error: "Check the file details." });
    return;
  }
  if (parsed.data.size > MAX_FILE_BYTES) {
    res.status(413).json({ error: "Files must be 50 MB or smaller." });
    return;
  }
  if (!allowedTypes.has(parsed.data.contentType)) {
    res.status(415).json({ error: "That file type is not accepted." });
    return;
  }
  if (!hqFileNameMatchesContentType(name, parsed.data.contentType)) {
    res.status(415).json({ error: "The file name extension does not match its type." });
    return;
  }
  try {
    const fileId = randomUUID();
    const upload = await objectStorage.hqFileUploadURL(fileId);
    res.json({ fileId, ...upload, expiresIn: UPLOAD_URL_TTL_SEC });
  } catch (error) {
    req.log?.error({ err: error }, "HQ file upload URL failed");
    res.status(502).json({ error: "Could not prepare the upload right now." });
  }
});

router.post("/hq/files", async (req, res) => {
  const parsed = FinalizeHqFileBody.safeParse(req.body);
  const name = parsed.success ? cleanHqFileName(parsed.data.name) : null;
  if (!parsed.success || !name || !idPattern.test(parsed.data.fileId) || !Number.isInteger(parsed.data.size)) {
    res.status(400).json({ error: "Check the file details." });
    return;
  }
  const input = parsed.data;
  if (!new RegExp(`^/objects/hq-files/${input.fileId}/file-[0-9a-f-]{36}$`, "i").test(input.objectPath)) {
    res.status(400).json({ error: "That upload does not belong to this file." });
    return;
  }
  if (!hqFileNameMatchesContentType(name, input.contentType)) {
    try {
      await objectStorage.deleteObjectStrict(input.objectPath);
    } catch (error) {
      req.log?.error({ err: error }, "HQ file extension mismatch cleanup failed");
    }
    res.status(415).json({ error: "The file name extension does not match its type." });
    return;
  }
  try {
    const file = await objectStorage.entityFile(input.objectPath);
    const [metadata] = await file.getMetadata();
    const actualSize = Number(metadata.size ?? 0);
    // The sidecar signer only accepts method/path/expiry. It cannot bind PUT
    // Content-Length or Content-Type, so finalize is decisive: reject/delete
    // every declaration mismatch, size violation, or byte-signature spoof.
    if (
      input.size > MAX_FILE_BYTES ||
      !allowedTypes.has(input.contentType) ||
      actualSize !== input.size ||
      actualSize < 1 ||
      actualSize > MAX_FILE_BYTES
    ) {
      await objectStorage.deleteObjectStrict(input.objectPath);
      res.status(input.size > MAX_FILE_BYTES || actualSize > MAX_FILE_BYTES ? 413 : !allowedTypes.has(input.contentType) ? 415 : 422)
        .json({ error: "The uploaded file does not match its declared details." });
      return;
    }
    const [head] = await file.download({ start: 0, end: HQ_FILE_HEAD_BYTES - 1 });
    if (!validateHqFileHead(input.contentType, Buffer.from(head))) {
      await objectStorage.deleteObjectStrict(input.objectPath);
      res.status(422).json({ error: "The uploaded file's bytes do not match its declared type." });
      return;
    }
    await file.setMetadata({
      contentType: input.contentType,
      contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
    const actor = identity(res);
    const result = await supabaseAdmin("POST", "/rest/v1/hq_private_files", {
      id: input.fileId, name, content_type: input.contentType, size_bytes: actualSize,
      object_path: input.objectPath, created_by: actor.userId,
    }, "return=representation");
    if (result.status >= 300) {
      await objectStorage.deleteObject(input.objectPath);
      throw new Error(`HQ file metadata insert failed (${result.status})`);
    }
    const row = (Array.isArray(result.json) ? result.json[0] : result.json) as Record<string, unknown>;
    await recordAdminAuditEvent({
      action: "hq_file_uploaded", actorUserId: actor.userId, actorKind: "hq", providerId: null,
      targetKind: "hq_file", targetId: input.fileId, requestId: req.headers["x-request-id"]?.toString() ?? null,
      metadata: { size: actualSize, contentType: input.contentType },
    }).catch(error => req.log?.error({ err: error }, "HQ file upload audit failed"));
    res.json(fileDto(row));
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "The uploaded file was not found." });
      return;
    }
    req.log?.error({ err: error }, "HQ file finalize failed");
    res.status(502).json({ error: "Could not save the file right now." });
  }
});

router.get("/hq/files", async (req, res) => {
  try {
    const result = await supabaseAdmin("GET", "/rest/v1/hq_private_files?select=id,name,content_type,size_bytes,created_at,updated_at&order=created_at.desc,id.desc&limit=500");
    if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`HQ files list failed (${result.status})`);
    res.json({ files: (result.json as Record<string, unknown>[]).map(fileDto) });
  } catch (error) {
    req.log?.error({ err: error }, "HQ files list failed");
    res.status(502).json({ error: "Could not load files right now." });
  }
});

router.get("/hq/files/:fileId/download-url", async (req, res) => {
  if (!idPattern.test(req.params.fileId)) {
    res.status(404).json({ error: "File not found." });
    return;
  }
  try {
    const result = await supabaseAdmin("GET", `/rest/v1/hq_private_files?id=eq.${encodeURIComponent(req.params.fileId)}&select=name,object_path&limit=1`);
    const row = Array.isArray(result.json) ? result.json[0] as Record<string, unknown> | undefined : undefined;
    if (result.status >= 300) throw new Error(`HQ file lookup failed (${result.status})`);
    if (!row) {
      res.status(404).json({ error: "File not found." });
      return;
    }
    const url = await objectStorage.signedDownloadURL(String(row.object_path), DOWNLOAD_TTL_SEC);
    res.json({ url, expiresIn: DOWNLOAD_TTL_SEC, name: String(row.name) });
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "File not found." });
      return;
    }
    req.log?.error({ err: error }, "HQ file download failed");
    res.status(502).json({ error: "Could not prepare the download right now." });
  }
});

router.delete("/hq/files/:fileId", async (req, res) => {
  if (!idPattern.test(req.params.fileId)) {
    res.status(404).json({ error: "File not found." });
    return;
  }
  try {
    const lookup = await supabaseAdmin("GET", `/rest/v1/hq_private_files?id=eq.${encodeURIComponent(req.params.fileId)}&select=id,object_path&limit=1`);
    const row = Array.isArray(lookup.json) ? lookup.json[0] as Record<string, unknown> | undefined : undefined;
    if (lookup.status >= 300) throw new Error(`HQ file lookup failed (${lookup.status})`);
    if (!row) {
      res.status(404).json({ error: "File not found." });
      return;
    }
    await objectStorage.deleteObjectStrict(String(row.object_path));
    const deleted = await supabaseAdmin("DELETE", `/rest/v1/hq_private_files?id=eq.${encodeURIComponent(req.params.fileId)}`);
    if (deleted.status >= 300) throw new Error(`HQ file delete failed (${deleted.status})`);
    const actor = identity(res);
    await recordAdminAuditEvent({
      action: "hq_file_deleted", actorUserId: actor.userId, actorKind: "hq", providerId: null,
      targetKind: "hq_file", targetId: req.params.fileId,
      requestId: req.headers["x-request-id"]?.toString() ?? null,
    }).catch(error => req.log?.error({ err: error }, "HQ file delete audit failed"));
    res.json({ ok: true });
  } catch (error) {
    req.log?.error({ err: error }, "HQ file delete failed");
    res.status(502).json({ error: "Could not delete the file right now." });
  }
});

export default router;