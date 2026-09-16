import { randomUUID } from "node:crypto";
import { recordUploadIntent } from "../jobs/upload-intents";
import { Router, type IRouter } from "express";
import {
  CreateHqFolderBody,
  CreateHqFileUploadBody,
  CreateHqFileReplacementBody,
  FinalizeHqFileBody,
  ReorderHqDriveBody,
  ReplaceHqFileBody,
  UpdateHqFileBody,
  UpdateHqFolderBody,
  UpdateHqSettingsBody,
} from "@workspace/api-zod";
import sharp from "sharp";
import { recordAdminAuditEvent } from "../lib/admin-audit";
import { objectStorage, ObjectNotFoundError, UPLOAD_URL_TTL_SEC } from "../lib/objectStorage";
import { requireHqPermission, type StaffIdentity } from "../lib/staff-auth";
import { supabaseAdmin } from "../lib/supabase-admin";
import {
  POLICY_SECTIONS,
  SETTINGS_SELECT,
  policyFromRow,
  policyToColumns,
  primeOrgPolicyCache,
  readOrgSettingsRow,
  sectionChangesFromRow,
} from "../lib/org-policy";
import { INVALID_SETTINGS, diffPolicy, hqActorName, mergePolicyInput, settingsDto, validHqTimezone } from "../lib/org-policy-edit";
import {
  FILE_SELECT,
  MAX_HQ_FILE_BYTES,
  allFolders,
  filesWithUploaders,
  folderDto,
  hqFileIdPattern,
  listHqFiles,
  rfc5987,
  searchHqFiles,
  sendHqFileContent,
  sendHqFileDownload,
  type FolderRow,
} from "../lib/hq-files-read";

export { validHqTimezone };

const router: IRouter = Router();
const requireAdmin = requireHqPermission("settings_manage");
const MAX_FILE_BYTES = MAX_HQ_FILE_BYTES;
const MAX_COMPRESS_BYTES = 25 * 1024 * 1024;
const MAX_FOLDER_DEPTH = 10;
/** We inspect bytes, never just GCS/client MIME metadata. This is deliberately
 * bounded: a hostile 50 MB upload cannot make finalization read the whole file. */
export const HQ_FILE_HEAD_BYTES = 64 * 1024;
const idPattern = hqFileIdPattern;
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
router.use("/hq/folders", requireAdmin);

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

/** One-file responses (finalize, replace, patch) resolve the uploader like listings do. */
async function singleFileDto(row: Record<string, unknown>) {
  const folders = await allFolders();
  const [dto] = await filesWithUploaders([row], new Map(folders.map(folder => [folder.id, folder])), true);
  return dto;
}

class UploadValidationError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function verifiedStoredFile(input: {
  objectPath: string;
  contentType: string;
  size: number;
  name: string;
  compress?: boolean;
}, log?: { error: (value: unknown, message: string) => void }) {
  const file = await objectStorage.entityFile(input.objectPath);
  const [metadata] = await file.getMetadata();
  const actualSize = Number(metadata.size ?? 0);
  if (
    input.size > MAX_FILE_BYTES ||
    !allowedTypes.has(input.contentType) ||
    actualSize !== input.size ||
    actualSize < 1 ||
    actualSize > MAX_FILE_BYTES
  ) {
    await objectStorage.deleteObjectStrict(input.objectPath);
    throw new UploadValidationError(
      input.size > MAX_FILE_BYTES || actualSize > MAX_FILE_BYTES ? 413 : !allowedTypes.has(input.contentType) ? 415 : 422,
      "The uploaded file does not match its declared details.",
    );
  }
  const [head] = await file.download({ start: 0, end: HQ_FILE_HEAD_BYTES - 1 });
  if (!validateHqFileHead(input.contentType, Buffer.from(head))) {
    await objectStorage.deleteObjectStrict(input.objectPath);
    throw new UploadValidationError(422, "The uploaded file's bytes do not match its declared type.");
  }
  const contentDisposition = `attachment; filename*=UTF-8''${rfc5987(input.name)}`;
  let storedSize = actualSize;
  let originalSize: number | null = null;
  let compressedAt: string | null = null;
  if (
    input.compress === true &&
    actualSize <= MAX_COMPRESS_BYTES &&
    (input.contentType === "image/png" || input.contentType === "image/jpeg" || input.contentType === "image/webp")
  ) {
    try {
      const [uploaded] = await file.download();
      const pipeline = sharp(Buffer.from(uploaded));
      const compressed = input.contentType === "image/png"
        ? await pipeline.png({ compressionLevel: 9, effort: 10, palette: false }).toBuffer()
        : input.contentType === "image/webp"
          ? await pipeline.webp({ lossless: true, effort: 6 }).toBuffer()
          : await pipeline.rotate().jpeg({ quality: 90, mozjpeg: true, chromaSubsampling: "4:4:4" }).toBuffer();
      if (compressed.length < actualSize) {
        await file.save(compressed, {
          metadata: { contentType: input.contentType, contentDisposition },
          resumable: false,
        });
        storedSize = compressed.length;
        originalSize = actualSize;
        compressedAt = new Date().toISOString();
      }
    } catch (error) {
      log?.error({ err: error }, "HQ image compression failed; retaining original");
    }
  }
  if (originalSize === null) await file.setMetadata({ contentType: input.contentType, contentDisposition });
  return { storedSize, originalSize, compressedAt };
}

function cleanFolderName(value: string): string | null {
  const name = value.trim().normalize("NFC");
  return name && name.length <= 120 && !/[\u0000-\u001f\u007f/\\]/.test(name) ? name : null;
}

function folderDepth(folderId: string | null, byId: Map<string, FolderRow>): number | null {
  let depth = 0;
  let current = folderId;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current)) return null;
    seen.add(current);
    const row = byId.get(current);
    if (!row) return null;
    depth += 1;
    current = row.parent_id;
  }
  return depth;
}

function subtreeIds(rootId: string, folders: FolderRow[]): Set<string> {
  const ids = new Set([rootId]);
  for (let level = 0; level < MAX_FOLDER_DEPTH; level += 1) {
    let changed = false;
    for (const folder of folders) {
      if (!ids.has(folder.id) && folder.parent_id && ids.has(folder.parent_id)) {
        ids.add(folder.id);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return ids;
}

function deepestRelativeDepth(rootId: string, folders: FolderRow[]): number {
  const byId = new Map(folders.map(folder => [folder.id, folder]));
  let deepest = 0;
  for (const folder of folders) {
    let current: FolderRow | undefined = folder;
    let distance = 0;
    const seen = new Set<string>();
    while (current && current.id !== rootId) {
      if (seen.has(current.id)) break;
      seen.add(current.id);
      distance += 1;
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
    if (current?.id === rootId) deepest = Math.max(deepest, distance);
  }
  return deepest;
}

function isDuplicateFolder(name: string, parentId: string | null, folders: FolderRow[], excluding?: string): boolean {
  const folded = name.toLocaleLowerCase("en-US");
  return folders.some(folder =>
    folder.id !== excluding && folder.parent_id === parentId &&
    folder.name.toLocaleLowerCase("en-US") === folded
  );
}

router.get("/hq/settings", async (req, res) => {
  try {
    const row = await readOrgSettingsRow();
    res.json(settingsDto(row));
  } catch (error) {
    req.log?.error({ err: error }, "HQ settings read failed");
    res.status(502).json({ error: "Could not load organization settings right now." });
  }
});

router.put("/hq/settings", async (req, res) => {
  const parsed = UpdateHqSettingsBody.strict().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: INVALID_SETTINGS });
    return;
  }
  try {
    const actor = identity(res);
    const currentRow = await readOrgSettingsRow();
    const current = policyFromRow(currentRow);
    if (parsed.data.expectedVersion !== undefined && parsed.data.expectedVersion !== current.version) {
      res.status(409).json({ error: "Someone else saved these settings first. Reload to see the latest values.", version: current.version });
      return;
    }
    const merged = mergePolicyInput(current, parsed.data);
    if (!merged.ok) {
      res.status(400).json({ error: merged.error });
      return;
    }
    const changes = diffPolicy(current, merged.policy);
    if (changes.length === 0) {
      res.json(settingsDto(currentRow));
      return;
    }
    const now = new Date().toISOString();
    const actorName = await hqActorName(actor.userId);
    const sections = sectionChangesFromRow(currentRow);
    const nextSections: Record<string, { at: string; by: string; name: string | null }> = {};
    for (const section of POLICY_SECTIONS) {
      const prior = sections[section];
      if (prior) nextSections[section] = { at: prior.changedAt, by: prior.changedBy ?? "", name: prior.changedByName };
    }
    for (const change of changes) {
      nextSections[change.section] = { at: now, by: actor.userId, name: actorName };
    }
    const nextVersion = current.version + 1;
    const result = await supabaseAdmin(
      "PATCH",
      `/rest/v1/hq_organization_settings?singleton=eq.true&version=eq.${current.version}&select=${SETTINGS_SELECT}`,
      { ...policyToColumns(merged.policy), version: nextVersion, updated_at: now, updated_by: actor.userId, section_changes: nextSections },
      "return=representation",
    );
    if (result.status >= 300) throw new Error(`settings update failed (${result.status})`);
    const row = Array.isArray(result.json) ? (result.json[0] as Record<string, unknown> | undefined) : undefined;
    if (!row) {
      // The guarded PATCH matched nothing: a concurrent save won the version race.
      res.status(409).json({ error: "Someone else saved these settings first. Reload to see the latest values.", version: current.version });
      return;
    }
    primeOrgPolicyCache(policyFromRow(row));
    const requestId = req.headers["x-request-id"]?.toString() ?? null;
    await Promise.all(
      changes.map(change =>
        recordAdminAuditEvent({
          action: "hq_settings_updated", actorUserId: actor.userId, actorKind: "hq",
          providerId: null, targetKind: "organization_settings", targetId: "singleton", requestId,
          metadata: { field: change.field, section: change.section, from: change.from, to: change.to, version: nextVersion },
        }).catch(error => req.log?.error({ err: error, field: change.field }, "HQ settings audit failed")),
      ),
    );
    res.json(settingsDto(row));
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
    const folderId = parsed.data.folderId ?? null;
    if (folderId) {
      if (!idPattern.test(folderId)) {
        res.status(404).json({ error: "Folder not found." });
        return;
      }
      const folders = await allFolders();
      if (!folders.some(folder => folder.id === folderId)) {
        res.status(404).json({ error: "Folder not found." });
        return;
      }
    }
    const fileId = randomUUID();
    const upload = await objectStorage.hqFileUploadURL(fileId);
    await recordUploadIntent({ objectPath: upload.objectPath, surface: "hq_file", ownerId: identity(res).userId });
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
    const folderId = input.folderId ?? null;
    if (folderId) {
      if (!idPattern.test(folderId) || !(await allFolders()).some(folder => folder.id === folderId)) {
        res.status(404).json({ error: "Folder not found." });
        return;
      }
    }
    const { storedSize, originalSize, compressedAt } = await verifiedStoredFile({
      objectPath: input.objectPath, contentType: input.contentType, size: input.size, name, compress: input.compress,
    }, req.log);
    const actor = identity(res);
    const result = await supabaseAdmin("POST", "/rest/v1/hq_private_files", {
      id: input.fileId, name, content_type: input.contentType, size_bytes: storedSize,
      object_path: input.objectPath, created_by: actor.userId, folder_id: folderId,
      original_size_bytes: originalSize, compressed_at: compressedAt,
    }, "return=representation");
    if (result.status >= 300) {
      await objectStorage.deleteObject(input.objectPath);
      throw new Error(`HQ file metadata insert failed (${result.status})`);
    }
    const row = (Array.isArray(result.json) ? result.json[0] : result.json) as Record<string, unknown>;
    await recordAdminAuditEvent({
      action: "hq_file_uploaded", actorUserId: actor.userId, actorKind: "hq", providerId: null,
      targetKind: "hq_file", targetId: input.fileId, requestId: req.headers["x-request-id"]?.toString() ?? null,
       metadata: { size: storedSize, originalSize, contentType: input.contentType },
    }).catch(error => req.log?.error({ err: error }, "HQ file upload audit failed"));
    res.json(await singleFileDto(row));
  } catch (error) {
    if (error instanceof UploadValidationError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "The uploaded file was not found." });
      return;
    }
    req.log?.error({ err: error }, "HQ file finalize failed");
    res.status(502).json({ error: "Could not save the file right now." });
  }
});

router.get("/hq/files", (req, res) => listHqFiles(req, res, {
  includeArchived: true,
  actor: { userId: identity(res).userId, kind: "hq", providerId: null },
}));

router.get("/hq/files/search", (req, res) => searchHqFiles(req, res, {
  includeArchived: true,
  actor: { userId: identity(res).userId, kind: "hq", providerId: null },
}));

router.post("/hq/files/:fileId/replace-url", async (req, res) => {
  if (!idPattern.test(req.params.fileId)) {
    res.status(404).json({ error: "File not found." });
    return;
  }
  if (typeof req.body?.size === "number" && req.body.size > MAX_FILE_BYTES) {
    res.status(413).json({ error: "Files must be 50 MB or smaller." });
    return;
  }
  const parsed = CreateHqFileReplacementBody.safeParse(req.body);
  const name = parsed.success ? cleanHqFileName(parsed.data.name) : null;
  if (!parsed.success || !name || !Number.isInteger(parsed.data.size)) {
    res.status(400).json({ error: "Check the file details." });
    return;
  }
  if (parsed.data.size > MAX_FILE_BYTES) {
    res.status(413).json({ error: "Files must be 50 MB or smaller." });
    return;
  }
  if (!allowedTypes.has(parsed.data.contentType) || !hqFileNameMatchesContentType(name, parsed.data.contentType)) {
    res.status(415).json({ error: "That file type or file name is not accepted." });
    return;
  }
  try {
    const lookup = await supabaseAdmin(
      "GET",
      `/rest/v1/hq_private_files?id=eq.${encodeURIComponent(req.params.fileId)}&select=id,object_path&limit=1`,
    );
    if (lookup.status >= 300) throw new Error(`HQ file lookup failed (${lookup.status})`);
    const existing = Array.isArray(lookup.json) ? lookup.json[0] as Record<string, unknown> | undefined : undefined;
    if (!existing) {
      res.status(404).json({ error: "File not found." });
      return;
    }
    let upload = await objectStorage.hqFileUploadURL(req.params.fileId);
    if (upload.objectPath === existing.object_path) upload = await objectStorage.hqFileUploadURL(req.params.fileId);
    if (upload.objectPath === existing.object_path) throw new Error("Replacement upload path was not unique");
    await recordUploadIntent({ objectPath: upload.objectPath, surface: "hq_file", ownerId: identity(res).userId });
    res.json({ fileId: req.params.fileId, ...upload, expiresIn: UPLOAD_URL_TTL_SEC });
  } catch (error) {
    req.log?.error({ err: error }, "HQ file replacement URL failed");
    res.status(502).json({ error: "Could not prepare the replacement right now." });
  }
});

router.post("/hq/files/:fileId/replace", async (req, res) => {
  if (!idPattern.test(req.params.fileId)) {
    res.status(404).json({ error: "File not found." });
    return;
  }
  if (typeof req.body?.size === "number" && req.body.size > MAX_FILE_BYTES) {
    res.status(413).json({ error: "Files must be 50 MB or smaller." });
    return;
  }
  const parsed = ReplaceHqFileBody.safeParse(req.body);
  const uploadedName = parsed.success ? cleanHqFileName(parsed.data.name) : null;
  if (!parsed.success || !uploadedName || !Number.isInteger(parsed.data.size)) {
    res.status(400).json({ error: "Check the file details." });
    return;
  }
  const input = parsed.data;
  if (!new RegExp(`^/objects/hq-files/${req.params.fileId}/file-[0-9a-f-]{36}$`, "i").test(input.objectPath)) {
    res.status(422).json({ error: "That upload does not belong to this file." });
    return;
  }
  if (!hqFileNameMatchesContentType(uploadedName, input.contentType)) {
    res.status(415).json({ error: "The file name extension does not match its type." });
    return;
  }
  try {
    const lookup = await supabaseAdmin(
      "GET",
      `/rest/v1/hq_private_files?id=eq.${encodeURIComponent(req.params.fileId)}&select=id,name,object_path,size_bytes,updated_at&limit=1`,
    );
    if (lookup.status >= 300) throw new Error(`HQ file lookup failed (${lookup.status})`);
    const existing = Array.isArray(lookup.json) ? lookup.json[0] as Record<string, unknown> | undefined : undefined;
    if (!existing) {
      res.status(404).json({ error: "File not found." });
      return;
    }
    if (input.objectPath === existing.object_path) {
      res.status(422).json({ error: "Choose a newly uploaded replacement." });
      return;
    }
    const name = hqFileNameMatchesContentType(String(existing.name), input.contentType) ? String(existing.name) : uploadedName;
    const { storedSize, originalSize, compressedAt } = await verifiedStoredFile({
      objectPath: input.objectPath, contentType: input.contentType, size: input.size, name, compress: input.compress,
    }, req.log);
    const now = new Date().toISOString();
    // Compare-and-swap on the path and version we read: a concurrent replace
    // or rename makes this PATCH match nothing, and we then discard OUR
    // candidate object instead of deleting a path someone else now owns.
    const updated = await supabaseAdmin(
      "PATCH",
      `/rest/v1/hq_private_files?id=eq.${encodeURIComponent(req.params.fileId)}&object_path=eq.${encodeURIComponent(String(existing.object_path))}&updated_at=eq.${encodeURIComponent(String(existing.updated_at))}`,
      {
        name, object_path: input.objectPath, content_type: input.contentType, size_bytes: storedSize,
        original_size_bytes: originalSize, compressed_at: compressedAt, object_missing_at: null, updated_at: now,
      },
      "return=representation",
    );
    if (updated.status >= 300) throw new Error(`HQ file replacement update failed (${updated.status})`);
    const row = (Array.isArray(updated.json) ? updated.json[0] : undefined) as Record<string, unknown> | undefined;
    if (!row) {
      await objectStorage.deleteObject(input.objectPath);
      res.status(409).json({ error: "This file changed while you were replacing it. Reload and try again." });
      return;
    }
    try {
      await objectStorage.deleteObjectStrict(String(existing.object_path));
    } catch (error) {
      if (!(error instanceof ObjectNotFoundError)) req.log?.error({ err: error }, "HQ old replacement object cleanup failed");
    }
    const actor = identity(res);
    await recordAdminAuditEvent({
      action: "hq_file_replaced", actorUserId: actor.userId, actorKind: "hq", providerId: null,
      targetKind: "hq_file", targetId: req.params.fileId,
      requestId: req.headers["x-request-id"]?.toString() ?? null,
      metadata: { previousSize: Number(existing.size_bytes), size: storedSize, contentType: input.contentType },
    }).catch(error => req.log?.error({ err: error }, "HQ file replacement audit failed"));
    res.json(await singleFileDto(row));
  } catch (error) {
    if (error instanceof UploadValidationError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "The uploaded file was not found." });
      return;
    }
    req.log?.error({ err: error }, "HQ file replacement failed");
    res.status(502).json({ error: "Could not replace the file right now." });
  }
});

router.put("/hq/files/order", async (req, res) => {
  const parsed = ReorderHqDriveBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Check the order details." });
    return;
  }
  const parentId = parsed.data.parentId ?? null;
  const folderIds = parsed.data.folderIds ?? [];
  const fileIds = parsed.data.fileIds ?? [];
  const wellFormed = (ids: string[]) => ids.every(id => idPattern.test(id)) && new Set(ids).size === ids.length;
  if ((parentId && !idPattern.test(parentId)) || !wellFormed(folderIds) || !wellFormed(fileIds)) {
    res.status(400).json({ error: "Check the order details." });
    return;
  }
  if (!folderIds.length && !fileIds.length) {
    res.json({ ok: true, folders: 0, files: 0 });
    return;
  }
  try {
    if (parentId) {
      const folders = await allFolders();
      if (!folders.some(folder => folder.id === parentId)) {
        res.status(404).json({ error: "Folder not found." });
        return;
      }
    }
    const reorder = async (kind: "folders" | "files", ids: string[]) => {
      if (!ids.length) return 0;
      const result = await supabaseAdmin("POST", "/rest/v1/rpc/hq_reorder_drive_items", { p_kind: kind, p_parent_id: parentId, p_ids: ids });
      if (result.status >= 300) throw new Error(`HQ drive reorder failed (${result.status})`);
      return Number(result.json);
    };
    // Folders first, then files: a stale file list should not undo a folder
    // order that already landed, and vice versa is reported as 409 below.
    const folders = await reorder("folders", folderIds);
    if (folders !== folderIds.length) {
      res.status(409).json({ error: "This folder changed. Reload and try again." });
      return;
    }
    const files = await reorder("files", fileIds);
    if (files !== fileIds.length) {
      res.status(409).json({ error: "This folder changed. Reload and try again." });
      return;
    }
    res.json({ ok: true, folders, files });
  } catch (error) {
    req.log?.error({ err: error }, "HQ drive reorder failed");
    res.status(502).json({ error: "Could not save the new order right now." });
  }
});

router.patch("/hq/files/:fileId", async (req, res) => {
  if (!idPattern.test(req.params.fileId)) {
    res.status(404).json({ error: "File not found." });
    return;
  }
  const parsed = UpdateHqFileBody.safeParse(req.body);
  const hasName = Object.prototype.hasOwnProperty.call(req.body ?? {}, "name");
  const hasFolder = Object.prototype.hasOwnProperty.call(req.body ?? {}, "folderId");
  const hasArchived = Object.prototype.hasOwnProperty.call(req.body ?? {}, "archived");
  const name = parsed.success && hasName ? cleanHqFileName(parsed.data.name ?? "") : null;
  if (!parsed.success || (!hasName && !hasFolder && !hasArchived) || (hasName && !name)) {
    res.status(400).json({ error: "Check the file details." });
    return;
  }
  try {
    const lookup = await supabaseAdmin(
      "GET",
       `/rest/v1/hq_private_files?id=eq.${encodeURIComponent(req.params.fileId)}&select=id,name,content_type,folder_id,archived_at&limit=1`,
    );
    if (lookup.status >= 300) throw new Error(`HQ file lookup failed (${lookup.status})`);
    const existing = Array.isArray(lookup.json) ? lookup.json[0] as Record<string, unknown> | undefined : undefined;
    if (!existing) {
      res.status(404).json({ error: "File not found." });
      return;
    }
    if (name && !hqFileNameMatchesContentType(name, String(existing.content_type))) {
      res.status(415).json({ error: "The file name extension does not match its type." });
      return;
    }
    let folderId = hasFolder ? parsed.data.folderId ?? null :
      typeof existing.folder_id === "string" ? existing.folder_id : null;
    const folders = folderId ? await allFolders() : [];
    if (folderId && hasFolder && (!idPattern.test(folderId) || !folders.some(folder => folder.id === folderId))) {
      res.status(404).json({ error: "Folder not found." });
      return;
    }
    if (hasArchived && parsed.data.archived === false && folderId && !folders.some(folder => folder.id === folderId)) {
      folderId = null;
    }
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (name) update.name = name;
    if (hasFolder) update.folder_id = folderId;
    if (hasArchived) {
      update.archived_at = parsed.data.archived === true ? (typeof existing.archived_at === "string" ? existing.archived_at : new Date().toISOString()) : null;
      if (parsed.data.archived === false && folderId !== existing.folder_id) update.folder_id = folderId;
    }
    // A file that changes folders (or comes back from the archive) has no
    // place in its destination's manual order yet: it lands at the top.
    if ((hasFolder && folderId !== (typeof existing.folder_id === "string" ? existing.folder_id : null)) || (hasArchived && parsed.data.archived === false)) {
      update.position = null;
    }
    const result = await supabaseAdmin(
      "PATCH",
      `/rest/v1/hq_private_files?id=eq.${encodeURIComponent(req.params.fileId)}`,
      update,
      "return=representation",
    );
    if (result.status >= 300) throw new Error(`HQ file update failed (${result.status})`);
    const row = (Array.isArray(result.json) ? result.json[0] : result.json) as Record<string, unknown>;
    if (hasFolder && folderId !== (typeof existing.folder_id === "string" ? existing.folder_id : null)) {
      const actor = identity(res);
      await recordAdminAuditEvent({
        action: "hq_file_moved", actorUserId: actor.userId, actorKind: "hq", providerId: null,
        targetKind: "hq_file", targetId: req.params.fileId,
        requestId: req.headers["x-request-id"]?.toString() ?? null,
        metadata: {
          fromFolderId: typeof existing.folder_id === "string" ? existing.folder_id : null,
          toFolderId: folderId,
        },
      }).catch(error => req.log?.error({ err: error }, "HQ file move audit failed"));
    }
    const wasArchived = typeof existing.archived_at === "string";
    if (hasArchived && parsed.data.archived !== wasArchived) {
      const actor = identity(res);
      await recordAdminAuditEvent({
        action: parsed.data.archived ? "hq_file_archived" : "hq_file_restored",
        actorUserId: actor.userId, actorKind: "hq", providerId: null,
        targetKind: "hq_file", targetId: req.params.fileId,
        requestId: req.headers["x-request-id"]?.toString() ?? null,
      }).catch(error => req.log?.error({ err: error }, "HQ file archive audit failed"));
    }
    res.json(await singleFileDto(row));
  } catch (error) {
    req.log?.error({ err: error }, "HQ file update failed");
    res.status(502).json({ error: "Could not update the file right now." });
  }
});

router.post("/hq/folders", async (req, res) => {
  const parsed = CreateHqFolderBody.safeParse(req.body);
  const name = parsed.success ? cleanFolderName(parsed.data.name) : null;
  if (!parsed.success || !name) {
    res.status(400).json({ error: "Check the folder details." });
    return;
  }
  try {
    const parentId = parsed.data.parentId ?? null;
    if (parentId && !idPattern.test(parentId)) {
      res.status(404).json({ error: "Parent folder not found." });
      return;
    }
    const folders = await allFolders();
    const byId = new Map(folders.map(folder => [folder.id, folder]));
    const parentDepth = folderDepth(parentId, byId);
    if (parentDepth === null) {
      res.status(404).json({ error: "Parent folder not found." });
      return;
    }
    if (parentDepth + 1 > MAX_FOLDER_DEPTH) {
      res.status(422).json({ error: "Folders can be nested at most 10 levels deep." });
      return;
    }
    if (isDuplicateFolder(name, parentId, folders)) {
      res.status(409).json({ error: "A folder with that name already exists here." });
      return;
    }
    const actor = identity(res);
    const result = await supabaseAdmin("POST", "/rest/v1/hq_file_folders", {
      id: randomUUID(), name, parent_id: parentId, created_by: actor.userId,
    }, "return=representation");
    if (result.status === 409) {
      res.status(409).json({ error: "A folder with that name already exists here." });
      return;
    }
    if (result.status >= 300) throw new Error(`HQ folder create failed (${result.status})`);
    const row = (Array.isArray(result.json) ? result.json[0] : result.json) as FolderRow;
    await recordAdminAuditEvent({
      action: "hq_folder_created", actorUserId: actor.userId, actorKind: "hq", providerId: null,
      targetKind: "hq_folder", targetId: row.id,
      requestId: req.headers["x-request-id"]?.toString() ?? null,
      metadata: { parentId },
    }).catch(error => req.log?.error({ err: error }, "HQ folder create audit failed"));
    res.json(folderDto(row));
  } catch (error) {
    req.log?.error({ err: error }, "HQ folder create failed");
    res.status(502).json({ error: "Could not create the folder right now." });
  }
});

router.patch("/hq/folders/:folderId", async (req, res) => {
  if (!idPattern.test(req.params.folderId)) {
    res.status(404).json({ error: "Folder not found." });
    return;
  }
  const parsed = UpdateHqFolderBody.safeParse(req.body);
  const hasName = Object.prototype.hasOwnProperty.call(req.body ?? {}, "name");
  const hasParent = Object.prototype.hasOwnProperty.call(req.body ?? {}, "parentId");
  const name = parsed.success && hasName ? cleanFolderName(parsed.data.name ?? "") : null;
  if (!parsed.success || (!hasName && !hasParent) || (hasName && !name)) {
    res.status(400).json({ error: "Check the folder details." });
    return;
  }
  try {
    const folders = await allFolders();
    const existing = folders.find(folder => folder.id === req.params.folderId);
    if (!existing) {
      res.status(404).json({ error: "Folder not found." });
      return;
    }
    const parentId = hasParent ? parsed.data.parentId ?? null : existing.parent_id;
    const nextName = name ?? existing.name;
    if (parentId === existing.id || subtreeIds(existing.id, folders).has(parentId ?? "")) {
      res.status(422).json({ error: "A folder cannot be moved into itself or one of its subfolders." });
      return;
    }
    const byId = new Map(folders.map(folder => [folder.id, folder]));
    const parentDepth = folderDepth(parentId, byId);
    if (parentDepth === null) {
      res.status(404).json({ error: "Parent folder not found." });
      return;
    }
    if (parentDepth + 1 + deepestRelativeDepth(existing.id, folders) > MAX_FOLDER_DEPTH) {
      res.status(422).json({ error: "Folders can be nested at most 10 levels deep." });
      return;
    }
    if (isDuplicateFolder(nextName, parentId, folders, existing.id)) {
      res.status(409).json({ error: "A folder with that name already exists here." });
      return;
    }
    const result = await supabaseAdmin(
      "PATCH",
      `/rest/v1/hq_file_folders?id=eq.${encodeURIComponent(existing.id)}`,
      {
        name: nextName, parent_id: parentId, updated_at: new Date().toISOString(),
        // Moving under a new parent forgets the old manual position (lands at the top there).
        ...(parentId !== existing.parent_id ? { position: null } : {}),
      },
      "return=representation",
    );
    if (result.status === 409) {
      res.status(409).json({ error: "A folder with that name already exists here." });
      return;
    }
    if (result.status >= 300) throw new Error(`HQ folder update failed (${result.status})`);
    const row = (Array.isArray(result.json) ? result.json[0] : result.json) as FolderRow;
    res.json(folderDto(row));
  } catch (error) {
    req.log?.error({ err: error }, "HQ folder update failed");
    res.status(502).json({ error: "Could not update the folder right now." });
  }
});

router.delete("/hq/folders/:folderId", async (req, res) => {
  if (!idPattern.test(req.params.folderId)) {
    res.status(404).json({ error: "Folder not found." });
    return;
  }
  try {
    const folders = await allFolders();
    if (!folders.some(folder => folder.id === req.params.folderId)) {
      res.status(404).json({ error: "Folder not found." });
      return;
    }
    const ids = subtreeIds(req.params.folderId, folders);
    const fileLookup = await supabaseAdmin(
      "GET",
      `/rest/v1/hq_private_files?folder_id=in.(${[...ids].join(",")})&select=id,object_path&limit=5000`,
    );
    if (fileLookup.status >= 300 || !Array.isArray(fileLookup.json)) {
      throw new Error(`HQ folder files lookup failed (${fileLookup.status})`);
    }
    const files = fileLookup.json as Array<{ id: string; object_path: string }>;
    for (const file of files) {
      try {
        await objectStorage.deleteObjectStrict(file.object_path);
      } catch (error) {
        if (!(error instanceof ObjectNotFoundError)) throw error;
      }
      const deleted = await supabaseAdmin(
        "DELETE",
        `/rest/v1/hq_private_files?id=eq.${encodeURIComponent(file.id)}`,
      );
      if (deleted.status >= 300) throw new Error(`HQ folder file delete failed (${deleted.status})`);
    }
    const deleted = await supabaseAdmin(
      "DELETE",
      `/rest/v1/hq_file_folders?id=eq.${encodeURIComponent(req.params.folderId)}`,
    );
    if (deleted.status >= 300) throw new Error(`HQ folder delete failed (${deleted.status})`);
    const actor = identity(res);
    await recordAdminAuditEvent({
      action: "hq_folder_deleted", actorUserId: actor.userId, actorKind: "hq", providerId: null,
      targetKind: "hq_folder", targetId: req.params.folderId,
      requestId: req.headers["x-request-id"]?.toString() ?? null,
      metadata: { deletedFiles: files.length, deletedFolders: ids.size },
    }).catch(error => req.log?.error({ err: error }, "HQ folder delete audit failed"));
    res.json({ ok: true, deletedFiles: files.length, deletedFolders: ids.size });
  } catch (error) {
    req.log?.error({ err: error }, "HQ folder delete failed");
    res.status(502).json({ error: "Could not delete the folder right now." });
  }
});

router.get("/hq/files/:fileId/download-url", (req, res) => sendHqFileDownload(req, res, {
  includeArchived: true,
  actor: { userId: identity(res).userId, kind: "hq", providerId: null },
}));

router.get("/hq/files/:fileId/content", (req, res) => sendHqFileContent(req, res, {
  includeArchived: true,
  actor: { userId: identity(res).userId, kind: "hq", providerId: null },
}));

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