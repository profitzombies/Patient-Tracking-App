import type { Request, Response } from "express";
import { recordAdminAuditEvent } from "./admin-audit";
import { objectStorage, ObjectNotFoundError } from "./objectStorage";
import { supabaseAdmin } from "./supabase-admin";

export const MAX_HQ_FILE_BYTES = 50 * 1024 * 1024;
export const DOWNLOAD_TTL_SEC = 300;
export const hqFileIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const FILE_SELECT = "id,name,content_type,size_bytes,folder_id,position,original_size_bytes,compressed_at,archived_at,created_by,created_at,updated_at,object_missing_at";
// Manual order first (null = never ordered here, shown on top, newest first).
export const ACTIVE_FILE_ORDER = "position.asc.nullsfirst,created_at.desc,id.desc";

export type HqFileReadOptions = {
  includeArchived: boolean;
  actor: {
    userId: string;
    kind: "hq" | "provider" | "team_member";
    providerId: string | null;
  };
};

export type FolderRow = {
  id: string;
  name: string;
  parent_id: string | null;
  position?: number | null;
  created_at: string;
  updated_at: string;
};

/** Sibling folders: hand-ordered ones by position, unordered ones first A-Z. */
export function sortSiblingFolders<T extends Pick<FolderRow, "name" | "position">>(folders: T[]): T[] {
  return [...folders].sort((a, b) => {
    const left = a.position ?? null;
    const right = b.position ?? null;
    if (left === null && right !== null) return -1;
    if (left !== null && right === null) return 1;
    if (left !== null && right !== null && left !== right) return left - right;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

export function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, character =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function fileDto(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    name: String(row.name),
    contentType: String(row.content_type),
    size: Number(row.size_bytes),
    folderId: typeof row.folder_id === "string" ? row.folder_id : null,
    originalSize: row.original_size_bytes == null ? null : Number(row.original_size_bytes),
    compressedAt: typeof row.compressed_at === "string" ? row.compressed_at : null,
    archivedAt: typeof row.archived_at === "string" ? row.archived_at : null,
    uploadedBy: typeof row.uploaded_by === "string" ? row.uploaded_by : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    unavailableSince: typeof row.object_missing_at === "string" ? row.object_missing_at : null,
  };
}

export function folderDto(row: FolderRow) {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function pathFor(folderId: unknown, byId: Map<string, FolderRow>) {
  const path: FolderRow[] = [];
  let current = typeof folderId === "string" ? byId.get(folderId) : undefined;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return path.map(folderDto);
}

export async function filesWithUploaders(rows: Record<string, unknown>[], byId: Map<string, FolderRow>, includePath: boolean) {
  const creatorIds = [...new Set(rows.flatMap(row => typeof row.created_by === "string" ? [row.created_by] : []))];
  const names = new Map<string, string>();
  if (creatorIds.length) {
    const memberships = await supabaseAdmin(
      "GET",
      `/rest/v1/hq_memberships?auth_user_id=in.(${creatorIds.map(encodeURIComponent).join(",")})&select=auth_user_id,display_name&limit=5000`,
    );
    if (memberships.status >= 300 || !Array.isArray(memberships.json)) {
      throw new Error(`HQ file uploaders lookup failed (${memberships.status})`);
    }
    for (const membership of memberships.json as Array<Record<string, unknown>>) {
      if (typeof membership.auth_user_id === "string" && typeof membership.display_name === "string") {
        names.set(membership.auth_user_id, membership.display_name);
      }
    }
  }
  return rows.map(row => {
    const dto = fileDto({
      ...row,
      uploaded_by: typeof row.created_by === "string" ? names.get(row.created_by) ?? null : null,
    });
    return includePath ? { ...dto, path: pathFor(row.folder_id, byId) } : dto;
  });
}

export async function allFolders(): Promise<FolderRow[]> {
  const result = await supabaseAdmin(
    "GET",
    "/rest/v1/hq_file_folders?select=id,name,parent_id,position,created_at,updated_at&limit=5000",
  );
  if (result.status >= 300 || !Array.isArray(result.json)) {
    throw new Error(`HQ folders lookup failed (${result.status})`);
  }
  return result.json as FolderRow[];
}

export async function listHqFiles(req: Request, res: Response, options: HqFileReadOptions) {
  try {
    const archived = options.includeArchived && req.query.view === "archived";
    const rawFolderId = typeof req.query.folderId === "string" ? req.query.folderId : "";
    const folderId = archived ? null : rawFolderId || null;
    if (folderId && !hqFileIdPattern.test(folderId)) {
      res.status(404).json({ error: "Folder not found." });
      return;
    }
    const folders = await allFolders();
    const byId = new Map(folders.map(folder => [folder.id, folder]));
    const folder = folderId ? byId.get(folderId) : undefined;
    if (folderId && !folder) {
      res.status(404).json({ error: "Folder not found." });
      return;
    }
    const filter = folderId ? `eq.${encodeURIComponent(folderId)}` : "is.null";
    const result = await supabaseAdmin("GET", `/rest/v1/hq_private_files?${archived ? "archived_at=not.is.null" : `folder_id=${filter}&archived_at=is.null`}&select=${FILE_SELECT}&order=${archived ? "archived_at.desc,id.desc" : ACTIVE_FILE_ORDER}&limit=500`);
    if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`HQ files list failed (${result.status})`);
    const children = sortSiblingFolders(folders.filter(candidate => candidate.parent_id === folderId));
    const breadcrumbs: FolderRow[] = [];
    let current = folder;
    while (current) {
      breadcrumbs.unshift(current);
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
    res.json({
      folder: archived ? null : folder ? folderDto(folder) : null,
      breadcrumbs: archived ? [] : breadcrumbs.map(folderDto),
      folders: archived ? [] : children.map(folderDto),
      files: await filesWithUploaders(result.json as Record<string, unknown>[], byId, true),
    });
  } catch (error) {
    req.log?.error({ err: error }, "HQ files list failed");
    res.status(502).json({ error: "Could not load files right now." });
  }
}

export async function searchHqFiles(req: Request, res: Response, _options: HqFileReadOptions) {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!query || query.length > 120) {
    res.status(400).json({ error: "Enter a file name to search for." });
    return;
  }
  try {
    const escaped = query.replace(/[%_*,()\\]/g, character => `\\${character}`);
    const [folders, result] = await Promise.all([
      allFolders(),
      supabaseAdmin(
        "GET",
        `/rest/v1/hq_private_files?archived_at=is.null&name=ilike.*${encodeURIComponent(escaped)}*&select=${FILE_SELECT}&order=created_at.desc,id.desc&limit=50`,
      ),
    ]);
    if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`HQ files search failed (${result.status})`);
    const folded = query.toLocaleLowerCase("en-US");
    const rows = (result.json as Record<string, unknown>[]).sort((left, right) => {
      const leftStarts = String(left.name).toLocaleLowerCase("en-US").startsWith(folded);
      const rightStarts = String(right.name).toLocaleLowerCase("en-US").startsWith(folded);
      return Number(rightStarts) - Number(leftStarts);
    });
    res.json({ files: await filesWithUploaders(rows, new Map(folders.map(folder => [folder.id, folder])), true) });
  } catch (error) {
    req.log?.error({ err: error }, "HQ files search failed");
    res.status(502).json({ error: "Could not search files right now." });
  }
}

export async function sendHqFileDownload(req: Request, res: Response, options: HqFileReadOptions) {
  const fileId = String(req.params.fileId);
  if (!hqFileIdPattern.test(fileId)) {
    res.status(404).json({ error: "File not found." });
    return;
  }
  try {
    const select = options.includeArchived ? "name,object_path,object_missing_at" : "name,object_path,object_missing_at,archived_at";
    const result = await supabaseAdmin("GET", `/rest/v1/hq_private_files?id=eq.${encodeURIComponent(fileId)}&select=${select}&limit=1`);
    const row = Array.isArray(result.json) ? result.json[0] as Record<string, unknown> | undefined : undefined;
    if (result.status >= 300) throw new Error(`HQ file lookup failed (${result.status})`);
    if (!row || (!options.includeArchived && row.archived_at != null)) {
      res.status(404).json({ error: "File not found." });
      return;
    }
    if (typeof row.object_missing_at === "string") {
      res.status(410).json({ error: "This file's stored bytes are missing. It can be deleted, but not downloaded." });
      return;
    }
    const url = await objectStorage.signedDownloadURL(String(row.object_path), DOWNLOAD_TTL_SEC);
    await recordAdminAuditEvent({
      action: "hq_file_downloaded", actorUserId: options.actor.userId, actorKind: options.actor.kind,
      providerId: options.actor.providerId, targetKind: "hq_file", targetId: fileId,
      requestId: req.headers["x-request-id"]?.toString() ?? null,
    }).catch(error => req.log?.error({ err: error }, "HQ file download audit failed"));
    res.json({ url, expiresIn: DOWNLOAD_TTL_SEC, name: String(row.name) });
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "File not found." });
      return;
    }
    req.log?.error({ err: error }, "HQ file download failed");
    res.status(502).json({ error: "Could not prepare the download right now." });
  }
}

export async function sendHqFileContent(req: Request, res: Response, options: HqFileReadOptions) {
  const fileId = String(req.params.fileId);
  if (!hqFileIdPattern.test(fileId)) {
    res.status(404).json({ error: "File not found." });
    return;
  }
  try {
    const select = options.includeArchived ? "name,content_type,object_path,object_missing_at" : "name,content_type,object_path,object_missing_at,archived_at";
    const result = await supabaseAdmin(
      "GET",
      `/rest/v1/hq_private_files?id=eq.${encodeURIComponent(fileId)}&select=${select}&limit=1`,
    );
    if (result.status >= 300) throw new Error(`HQ file lookup failed (${result.status})`);
    const row = Array.isArray(result.json) ? result.json[0] as Record<string, unknown> | undefined : undefined;
    if (!row || (!options.includeArchived && row.archived_at != null)) {
      res.status(404).json({ error: "File not found." });
      return;
    }
    if (typeof row.object_missing_at === "string") {
      res.status(410).json({ error: "This file's stored bytes are missing." });
      return;
    }
    const { bytes } = await objectStorage.readObjectBounded(String(row.object_path), MAX_HQ_FILE_BYTES);
    const name = String(row.name);
    const asciiName = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    res.setHeader("Content-Type", String(row.content_type));
    res.setHeader("Content-Disposition", `inline; filename="${asciiName}"; filename*=UTF-8''${rfc5987(name)}`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Length", String(bytes.byteLength));
    if (options.actor.kind !== "hq") {
      await recordAdminAuditEvent({
        action: "hq_file_previewed", actorUserId: options.actor.userId, actorKind: options.actor.kind,
        providerId: options.actor.providerId, targetKind: "hq_file", targetId: fileId,
        requestId: req.headers["x-request-id"]?.toString() ?? null,
      }).catch(error => req.log?.error({ err: error }, "HQ file preview audit failed"));
    }
    res.send(bytes);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      await supabaseAdmin(
        "PATCH",
        `/rest/v1/hq_private_files?id=eq.${encodeURIComponent(fileId)}&object_missing_at=is.null`,
        { object_missing_at: new Date().toISOString() },
      ).catch(markError => req.log?.error({ err: markError }, "HQ missing file mark failed"));
      res.status(404).json({ error: "File not found." });
      return;
    }
    req.log?.error({ err: error }, "HQ file content read failed");
    res.status(502).json({ error: "Could not open the file right now." });
  }
}