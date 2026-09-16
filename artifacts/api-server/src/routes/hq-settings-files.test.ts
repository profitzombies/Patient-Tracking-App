import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signedDownloadURL: vi.fn(),
  admin: vi.fn(),
  audit: vi.fn(),
  deleteObject: vi.fn(),
  deleted: vi.fn(),
  entityFile: vi.fn(),
  readObjectBounded: vi.fn(),
  uploadUrl: vi.fn(),
}));
vi.mock("../lib/staff-auth", () => ({
  requireHqPermission: () => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.headers.authorization === "Bearer lower") {
      res.status(403).json({ error: "denied" });
      return;
    }
    res.locals.staff = { userId: "00000000-0000-4000-8000-000000000001" };
    next();
  },
}));
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("../lib/admin-audit", () => ({ recordAdminAuditEvent: mocks.audit }));
vi.mock("../lib/objectStorage", () => ({
  UPLOAD_URL_TTL_SEC: 900,
  ObjectNotFoundError: class ObjectNotFoundError extends Error {},
  objectStorage: {
    deleteObjectStrict: mocks.deleted,
    deleteObject: mocks.deleteObject,
    entityFile: mocks.entityFile,
    hqFileUploadURL: mocks.uploadUrl,
    readObjectBounded: mocks.readObjectBounded,
    signedDownloadURL: mocks.signedDownloadURL,
  },
}));
import router from "./hq-settings-files";

let server: http.Server;
let base = "";
const fileId = "00000000-0000-4000-8000-000000000002";
const objectPath = `/objects/hq-files/${fileId}/file-00000000-0000-4000-8000-000000000003`;
const folderId = "00000000-0000-4000-8000-000000000004";
const childId = "00000000-0000-4000-8000-000000000005";
const folderRow = (id = folderId, name = "Policies", parent_id: string | null = null) => ({
  id, name, parent_id, created_at: "2026-10-15T00:00:00Z", updated_at: "2026-10-15T00:00:00Z",
});
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  mocks.admin.mockReset();
  mocks.audit.mockReset().mockResolvedValue(undefined);
  mocks.deleteObject.mockReset().mockResolvedValue(undefined);
  mocks.deleted.mockReset().mockResolvedValue(undefined);
  mocks.entityFile.mockReset().mockResolvedValue({
    getMetadata: vi.fn().mockResolvedValue([{ size: "8", contentType: "application/pdf" }]),
    download: vi.fn().mockResolvedValue([Buffer.from("not-a-pdf")]),
    setMetadata: vi.fn(),
    save: vi.fn(),
  });
  mocks.readObjectBounded.mockReset().mockResolvedValue({ bytes: Buffer.from("%PDF-1.4") });
  mocks.uploadUrl.mockReset().mockResolvedValue({ uploadUrl: "https://upload.example", objectPath });
});

describe("HQ settings and file finalization", () => {
  it("enforces settings Admin/Super Admin authorization", async () => {
    expect((await fetch(`${base}/hq/settings`, { headers: { authorization: "Bearer lower" } })).status).toBe(403);
  });

  it("deletes a spoofed MIME object before metadata persistence", async () => {
    const response = await fetch(`${base}/hq/files`, {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ fileId, objectPath, name: "policy.pdf", contentType: "application/pdf", size: 8 }),
    });
    expect(response.status).toBe(422);
    expect(mocks.deleted).toHaveBeenCalledWith(objectPath);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("deletes an uploaded object when finalize has a mismatched extension", async () => {
    const response = await fetch(`${base}/hq/files`, {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ fileId, objectPath, name: "archive.zip", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 8 }),
    });
    expect(response.status).toBe(415);
    expect(mocks.deleted).toHaveBeenCalledWith(objectPath);
    expect(mocks.entityFile).not.toHaveBeenCalled();
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("rejects a mismatched extension before issuing an upload URL", async () => {
    const response = await fetch(`${base}/hq/files/upload-url`, {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "archive.zip", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 8 }),
    });
    expect(response.status).toBe(415);
  });

  it("deletes stored objects whose actual size exceeds the cap", async () => {
    mocks.entityFile.mockResolvedValueOnce({
      getMetadata: vi.fn().mockResolvedValue([{ size: String(50 * 1024 * 1024 + 1) }]),
      download: vi.fn(),
      setMetadata: vi.fn(),
    });
    const response = await fetch(`${base}/hq/files`, {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ fileId, objectPath, name: "policy.pdf", contentType: "application/pdf", size: 8 }),
    });
    expect(response.status).toBe(413);
    expect(mocks.deleted).toHaveBeenCalledWith(objectPath);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
});

describe("HQ file downloads", () => {
  it("records an audit event naming the file, never the URL", async () => {
    mocks.admin.mockResolvedValueOnce({ status: 200, json: [{ name: "Playbook.pdf", object_path: objectPath }] });
    mocks.signedDownloadURL.mockReset().mockResolvedValue("https://signed.example/secret");
    const res = await fetch(`${base}/hq/files/${fileId}/download-url`, { headers: { authorization: "Bearer admin" } });
    expect(res.status).toBe(200);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    const event = mocks.audit.mock.calls[0][0];
    expect(event).toMatchObject({ action: "hq_file_downloaded", actorKind: "hq", targetKind: "hq_file", targetId: fileId });
    expect(JSON.stringify(event)).not.toContain("signed.example");
  });

  it("serves inline private content with hardened headers and reports reconciled missing bytes", async () => {
    mocks.admin.mockResolvedValueOnce({ status: 200, json: [{
      name: "HQ plan.pdf", content_type: "application/pdf", object_path: objectPath, object_missing_at: null,
    }] });
    const shown = await fetch(`${base}/hq/files/${fileId}/content`, { headers: { authorization: "Bearer admin" } });
    expect(shown.status).toBe(200);
    expect(shown.headers.get("content-type")).toContain("application/pdf");
    expect(shown.headers.get("content-disposition")).toContain("inline;");
    expect(shown.headers.get("content-disposition")).toContain("filename*=UTF-8''HQ%20plan.pdf");
    expect(shown.headers.get("cache-control")).toBe("private, no-store");
    expect(shown.headers.get("x-content-type-options")).toBe("nosniff");
    expect(mocks.readObjectBounded).toHaveBeenCalledWith(objectPath, 50 * 1024 * 1024);

    mocks.admin.mockReset().mockResolvedValueOnce({ status: 200, json: [{
      name: "HQ plan.pdf", content_type: "application/pdf", object_path: objectPath,
      object_missing_at: "2026-10-16T01:00:00Z",
    }] });
    const gone = await fetch(`${base}/hq/files/${fileId}/content`, { headers: { authorization: "Bearer admin" } });
    expect(gone.status).toBe(410);
  });

  it("does not audit a download that never happened", async () => {
    mocks.admin.mockResolvedValueOnce({ status: 200, json: [] });
    const res = await fetch(`${base}/hq/files/${fileId}/download-url`, { headers: { authorization: "Bearer admin" } });
    expect(res.status).toBe(404);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("refuses to mint a link for a file whose bytes reconciliation found missing", async () => {
    mocks.admin.mockResolvedValueOnce({ status: 200, json: [{ name: "Playbook.pdf", object_path: objectPath, object_missing_at: "2026-09-06T03:00:00Z" }] });
    mocks.signedDownloadURL.mockReset();
    const res = await fetch(`${base}/hq/files/${fileId}/download-url`, { headers: { authorization: "Bearer admin" } });
    expect(res.status).toBe(410);
    expect(mocks.signedDownloadURL).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("lists the unavailable-since stamp so the UI can show an honest state", async () => {
    mocks.admin.mockResolvedValueOnce({ status: 200, json: [] }).mockResolvedValueOnce({ status: 200, json: [
      { id: "f-ok", name: "A.pdf", content_type: "application/pdf", size_bytes: 8, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", object_missing_at: null },
      { id: "f-gone", name: "B.pdf", content_type: "application/pdf", size_bytes: 8, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", object_missing_at: "2026-09-06T03:00:00Z" },
    ] });
    const res = await fetch(`${base}/hq/files`, { headers: { authorization: "Bearer admin" } });
    expect(res.status).toBe(200);
    const [, path] = mocks.admin.mock.calls[1];
    expect(path).toContain("object_missing_at");
    const body = await res.json() as { files: Array<{ id: string; unavailableSince: string | null }> };
    expect(body.files.map((f) => [f.id, f.unavailableSince])).toEqual([["f-ok", null], ["f-gone", "2026-09-06T03:00:00Z"]]);
  });
});

describe("HQ file drive folders", () => {
  it("excludes archived files from folders and returns archived files with paths and uploader names", async () => {
    const archived = {
      id: fileId, name: "Old.pdf", content_type: "application/pdf", size_bytes: 8,
      folder_id: childId, original_size_bytes: null, compressed_at: null,
      archived_at: "2026-10-16T02:00:00Z", created_by: "00000000-0000-4000-8000-000000000001",
      created_at: "2026-10-15T00:00:00Z", updated_at: "2026-10-16T02:00:00Z", object_missing_at: null,
    };
    mocks.admin
      .mockResolvedValueOnce({ status: 200, json: [folderRow(folderId), folderRow(childId, "Child", folderId)] })
      .mockResolvedValueOnce({ status: 200, json: [{
        id: "active-file", name: "Current.pdf", content_type: "application/pdf", size_bytes: 8,
        folder_id: childId, archived_at: null, created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z",
      }] });
    const active = await fetch(`${base}/hq/files?folderId=${childId}`, { headers: { authorization: "Bearer admin" } });
    expect(active.status).toBe(200);
    expect(mocks.admin.mock.calls[1][1]).toContain("archived_at=is.null");
    expect((await active.json() as any).files[0].path).toEqual([
      expect.objectContaining({ id: folderId }),
      expect.objectContaining({ id: childId }),
    ]);

    mocks.admin.mockReset()
      .mockResolvedValueOnce({ status: 200, json: [folderRow(folderId), folderRow(childId, "Child", folderId)] })
      .mockResolvedValueOnce({ status: 200, json: [archived] })
      .mockResolvedValueOnce({ status: 200, json: [{ auth_user_id: archived.created_by, display_name: "Avery Admin" }] });
    const response = await fetch(`${base}/hq/files?view=archived&folderId=ignored`, { headers: { authorization: "Bearer admin" } });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body).toMatchObject({ folder: null, breadcrumbs: [], folders: [] });
    expect(body.files[0]).toMatchObject({
      archivedAt: archived.archived_at, uploadedBy: "Avery Admin",
      path: [{ id: folderId }, { id: childId }],
    });
    expect(mocks.admin.mock.calls[1][1]).toContain("archived_at=not.is.null");
    expect(mocks.admin.mock.calls[2][1]).toContain("/hq_memberships?");
  });

  it("searches only active files, escapes wildcard names, and ranks prefix matches first", async () => {
    const contains = {
      id: "f-contains", name: "Notes 100%_done.txt", content_type: "text/plain", size_bytes: 2,
      folder_id: null, archived_at: null, created_at: "2026-10-16T02:00:00Z", updated_at: "x",
    };
    const starts = { ...contains, id: "f-starts", name: "100%_done notes.txt", created_at: "2026-10-15T02:00:00Z" };
    mocks.admin
      .mockResolvedValueOnce({ status: 200, json: [] })
      .mockResolvedValueOnce({ status: 200, json: [contains, starts] });
    const response = await fetch(`${base}/hq/files/search?q=${encodeURIComponent("100%_done")}`, {
      headers: { authorization: "Bearer admin" },
    });
    expect(response.status).toBe(200);
    expect((await response.json() as any).files.map((file: any) => file.id)).toEqual(["f-starts", "f-contains"]);
    const query = mocks.admin.mock.calls[1][1] as string;
    expect(query).toContain("archived_at=is.null");
    expect(query).toContain("100%5C%25%5C_done");
  });

  it("lists folders case-insensitively with root-to-current breadcrumbs", async () => {
    mocks.admin
      .mockResolvedValueOnce({ status: 200, json: [
        folderRow(folderId, "Policies"),
        folderRow(childId, "Annual", folderId),
        folderRow("00000000-0000-4000-8000-000000000006", "zebra", childId),
        folderRow("00000000-0000-4000-8000-000000000007", "Alpha", childId),
      ] })
      .mockResolvedValueOnce({ status: 200, json: [] });
    const response = await fetch(`${base}/hq/files?folderId=${childId}`, {
      headers: { authorization: "Bearer admin" },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      folder: { id: string };
      breadcrumbs: Array<{ id: string }>;
      folders: Array<{ name: string }>;
    };
    expect(body.folder.id).toBe(childId);
    expect(body.breadcrumbs.map(folder => folder.id)).toEqual([folderId, childId]);
    expect(body.folders.map(folder => folder.name)).toEqual(["Alpha", "zebra"]);
  });

  it("creates folders and rejects duplicate siblings and excessive depth", async () => {
    mocks.admin
      .mockResolvedValueOnce({ status: 200, json: [] })
      .mockResolvedValueOnce({ status: 201, json: [folderRow()] });
    const created = await fetch(`${base}/hq/folders`, {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: " Policies " }),
    });
    expect(created.status).toBe(200);

    mocks.admin.mockReset().mockResolvedValueOnce({ status: 200, json: [folderRow()] });
    const duplicate = await fetch(`${base}/hq/folders`, {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "policies" }),
    });
    expect(duplicate.status).toBe(409);

    const chain = Array.from({ length: 10 }, (_, index) =>
      folderRow(
        `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
        `Level ${index + 1}`,
        index === 0 ? null : `00000000-0000-4000-8000-${String(index + 9).padStart(12, "0")}`,
      )
    );
    mocks.admin.mockReset().mockResolvedValueOnce({ status: 200, json: chain });
    const tooDeep = await fetch(`${base}/hq/folders`, {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "Level 11", parentId: chain[9].id }),
    });
    expect(tooDeep.status).toBe(422);
  });

  it("rejects moving a folder into a descendant", async () => {
    mocks.admin.mockResolvedValueOnce({
      status: 200,
      json: [folderRow(folderId), folderRow(childId, "Child", folderId)],
    });
    const response = await fetch(`${base}/hq/folders/${folderId}`, {
      method: "PATCH",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ parentId: childId }),
    });
    expect(response.status).toBe(422);
    expect(mocks.admin).toHaveBeenCalledTimes(1);
  });

  it("passes folder destinations through upload URL and finalization", async () => {
    mocks.admin.mockResolvedValueOnce({ status: 200, json: [folderRow()] });
    const upload = await fetch(`${base}/hq/files/upload-url`, {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "policy.pdf", contentType: "application/pdf", size: 8, folderId }),
    });
    expect(upload.status).toBe(200);

    const pdf = Buffer.from("%PDF-1.4");
    mocks.entityFile.mockResolvedValueOnce({
      getMetadata: vi.fn().mockResolvedValue([{ size: String(pdf.length) }]),
      download: vi.fn().mockResolvedValue([pdf]),
      setMetadata: vi.fn(),
      save: vi.fn(),
    });
    mocks.admin.mockReset()
      .mockResolvedValueOnce({ status: 200, json: [folderRow()] })
      .mockResolvedValueOnce({
        status: 201,
        json: [{
          id: fileId, name: "policy.pdf", content_type: "application/pdf", size_bytes: pdf.length,
          folder_id: folderId, original_size_bytes: null, compressed_at: null,
          created_at: "2026-10-15T00:00:00Z", updated_at: "2026-10-15T00:00:00Z",
        }],
      })
      .mockResolvedValueOnce({ status: 200, json: [folderRow()] });
    const finalize = await fetch(`${base}/hq/files`, {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({
        fileId, objectPath, name: "policy.pdf", contentType: "application/pdf",
        size: pdf.length, folderId, compress: false,
      }),
    });
    expect(finalize.status).toBe(200);
    expect(mocks.admin.mock.calls[1][2]).toMatchObject({ folder_id: folderId });
    expect((await finalize.json() as any).path).toEqual([expect.objectContaining({ id: folderId })]);
  });

  it("compresses a real PNG onto the same object only when smaller", async () => {
    const uploaded = await sharp({
      create: { width: 128, height: 128, channels: 3, background: { r: 240, g: 220, b: 180 } },
    }).png({ compressionLevel: 0 }).toBuffer();
    const save = vi.fn().mockResolvedValue(undefined);
    const download = vi.fn()
      .mockResolvedValueOnce([uploaded.subarray(0, 64 * 1024)])
      .mockResolvedValueOnce([uploaded]);
    mocks.entityFile.mockResolvedValueOnce({
      getMetadata: vi.fn().mockResolvedValue([{ size: String(uploaded.length) }]),
      download,
      setMetadata: vi.fn(),
      save,
    });
    mocks.admin
      .mockResolvedValueOnce({
        status: 201,
        json: [{
          id: fileId, name: "photo.png", content_type: "image/png", size_bytes: 300,
          folder_id: null, original_size_bytes: uploaded.length, compressed_at: "2026-10-15T00:00:00Z",
          created_at: "2026-10-15T00:00:00Z", updated_at: "2026-10-15T00:00:00Z",
        }],
      })
      .mockResolvedValueOnce({ status: 200, json: [] });
    const response = await fetch(`${base}/hq/files`, {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({
        fileId, objectPath, name: "photo.png", contentType: "image/png",
        size: uploaded.length, compress: true,
      }),
    });
    expect(response.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].length).toBeLessThan(uploaded.length);
    expect(mocks.admin.mock.calls[0][2]).toMatchObject({
      object_path: objectPath,
      original_size_bytes: uploaded.length,
    });
  });

  it("validates rename extensions and moves files", async () => {
    mocks.admin.mockResolvedValueOnce({
      status: 200,
      json: [{ id: fileId, name: "old.pdf", content_type: "application/pdf", folder_id: null }],
    });
    const badRename = await fetch(`${base}/hq/files/${fileId}`, {
      method: "PATCH",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "wrong.png" }),
    });
    expect(badRename.status).toBe(415);

    mocks.admin.mockReset()
      .mockResolvedValueOnce({
        status: 200,
        json: [{ id: fileId, name: "old.pdf", content_type: "application/pdf", folder_id: null }],
      })
      .mockResolvedValueOnce({ status: 200, json: [folderRow()] })
      .mockResolvedValueOnce({
        status: 200,
        json: [{
          id: fileId, name: "old.pdf", content_type: "application/pdf", size_bytes: 8,
          folder_id: folderId, created_at: "x", updated_at: "y",
        }],
      })
      .mockResolvedValueOnce({ status: 200, json: [folderRow()] });
    const moved = await fetch(`${base}/hq/files/${fileId}`, {
      method: "PATCH",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ folderId }),
    });
    expect(moved.status).toBe(200);
    expect(mocks.admin.mock.calls[2][2]).toMatchObject({ folder_id: folderId });
  });

  it("restores an archived file whose folder was deleted into the root", async () => {
    mocks.admin
      .mockResolvedValueOnce({ status: 200, json: [{
        id: fileId, name: "old.pdf", content_type: "application/pdf", folder_id: folderId,
        archived_at: "2026-10-16T00:00:00Z",
      }] })
      .mockResolvedValueOnce({ status: 200, json: [] })
      .mockResolvedValueOnce({ status: 200, json: [{
        id: fileId, name: "old.pdf", content_type: "application/pdf", size_bytes: 8,
        folder_id: null, archived_at: null, created_at: "x", updated_at: "y",
      }] })
      .mockResolvedValueOnce({ status: 200, json: [] });
    const response = await fetch(`${base}/hq/files/${fileId}`, {
      method: "PATCH",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ archived: false }),
    });
    expect(response.status).toBe(200);
    expect(mocks.admin.mock.calls[2][2]).toMatchObject({ archived_at: null, folder_id: null });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "hq_file_restored" }));
  });

  it("replaces verified bytes, preserves a compatible name, and deletes the old object after updating", async () => {
    const replacementPath = `/objects/hq-files/${fileId}/file-00000000-0000-4000-8000-000000000009`;
    const pdf = Buffer.from("%PDF-1.4");
    mocks.entityFile.mockResolvedValueOnce({
      getMetadata: vi.fn().mockResolvedValue([{ size: String(pdf.length) }]),
      download: vi.fn().mockResolvedValue([pdf]),
      setMetadata: vi.fn(), save: vi.fn(),
    });
    mocks.admin
      .mockResolvedValueOnce({ status: 200, json: [{
        id: fileId, name: "Kept.pdf", object_path: objectPath, size_bytes: 20,
        updated_at: "2026-10-16T00:00:00Z",
      }] })
      .mockResolvedValueOnce({ status: 200, json: [{
        id: fileId, name: "Kept.pdf", content_type: "application/pdf", size_bytes: pdf.length,
        object_path: replacementPath, archived_at: "2026-10-15T00:00:00Z", created_at: "x", updated_at: "y",
      }] })
      .mockResolvedValueOnce({ status: 200, json: [] });
    const response = await fetch(`${base}/hq/files/${fileId}/replace`, {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "Uploaded.pdf", contentType: "application/pdf", size: pdf.length, objectPath: replacementPath, compress: false }),
    });
    expect(response.status).toBe(200);
    expect(mocks.admin.mock.calls[1][2]).toMatchObject({ name: "Kept.pdf", object_path: replacementPath, object_missing_at: null });
    expect(mocks.admin.mock.calls[1][1]).toContain("object_path=eq.");
    expect(mocks.admin.mock.calls[1][1]).toContain("updated_at=eq.");
    expect(mocks.deleted).toHaveBeenCalledWith(objectPath);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "hq_file_replaced", metadata: { previousSize: 20, size: pdf.length, contentType: "application/pdf" },
    }));
  });

  it("uses the uploaded replacement name when the old extension does not match and rejects foreign paths", async () => {
    const foreign = "/objects/hq-files/00000000-0000-4000-8000-000000000099/file-00000000-0000-4000-8000-000000000009";
    const rejected = await fetch(`${base}/hq/files/${fileId}/replace`, {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "New.png", contentType: "image/png", size: 8, objectPath: foreign }),
    });
    expect(rejected.status).toBe(422);
    expect(mocks.admin).not.toHaveBeenCalled();

    const replacementPath = `/objects/hq-files/${fileId}/file-00000000-0000-4000-8000-000000000009`;
    const pdf = Buffer.from("%PDF-1.4");
    mocks.entityFile.mockResolvedValueOnce({
      getMetadata: vi.fn().mockResolvedValue([{ size: String(pdf.length) }]),
      download: vi.fn().mockResolvedValue([pdf]), setMetadata: vi.fn(), save: vi.fn(),
    });
    mocks.admin
      .mockResolvedValueOnce({ status: 200, json: [{
        id: fileId, name: "Old.png", object_path: objectPath, size_bytes: 8,
        updated_at: "2026-10-16T00:00:00Z",
      }] })
      .mockResolvedValueOnce({ status: 200, json: [{
        id: fileId, name: "New.pdf", content_type: "application/pdf", size_bytes: pdf.length,
        object_path: replacementPath, created_at: "x", updated_at: "y",
      }] })
      .mockResolvedValueOnce({ status: 200, json: [] });
    const renamed = await fetch(`${base}/hq/files/${fileId}/replace`, {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "New.pdf", contentType: "application/pdf", size: pdf.length, objectPath: replacementPath }),
    });
    expect(renamed.status).toBe(200);
    expect(mocks.admin.mock.calls[1][2]).toMatchObject({ name: "New.pdf" });
  });

  it("returns a replacement conflict and deletes only the candidate object when the guarded update loses", async () => {
    const replacementPath = `/objects/hq-files/${fileId}/file-00000000-0000-4000-8000-000000000009`;
    const pdf = Buffer.from("%PDF-1.4");
    mocks.entityFile.mockResolvedValueOnce({
      getMetadata: vi.fn().mockResolvedValue([{ size: String(pdf.length) }]),
      download: vi.fn().mockResolvedValue([pdf]), setMetadata: vi.fn(), save: vi.fn(),
    });
    mocks.admin
      .mockResolvedValueOnce({ status: 200, json: [{
        id: fileId, name: "Kept.pdf", object_path: objectPath, size_bytes: 20,
        updated_at: "2026-10-16T00:00:00Z",
      }] })
      .mockResolvedValueOnce({ status: 200, json: [] });
    const response = await fetch(`${base}/hq/files/${fileId}/replace`, {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({
        name: "Uploaded.pdf", contentType: "application/pdf", size: pdf.length,
        objectPath: replacementPath, compress: false,
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "This file changed while you were replacing it. Reload and try again.",
    });
    expect(mocks.deleteObject).toHaveBeenCalledWith(replacementPath);
    expect(mocks.deleted).not.toHaveBeenCalledWith(objectPath);
    expect(mocks.admin.mock.calls[1][1]).toContain("object_path=eq.");
    expect(mocks.admin.mock.calls[1][1]).toContain("updated_at=eq.");
  });

  it("guards a replacement metadata update by both the prior object path and update timestamp", async () => {
    const replacementPath = `/objects/hq-files/${fileId}/file-00000000-0000-4000-8000-000000000009`;
    const pdf = Buffer.from("%PDF-1.4");
    mocks.entityFile.mockResolvedValueOnce({
      getMetadata: vi.fn().mockResolvedValue([{ size: String(pdf.length) }]),
      download: vi.fn().mockResolvedValue([pdf]), setMetadata: vi.fn(), save: vi.fn(),
    });
    mocks.admin
      .mockResolvedValueOnce({ status: 200, json: [{
        id: fileId, name: "Kept.pdf", object_path: objectPath, size_bytes: 20,
        updated_at: "2026-10-16T00:00:00Z",
      }] })
      .mockResolvedValueOnce({ status: 200, json: [{
        id: fileId, name: "Kept.pdf", content_type: "application/pdf", size_bytes: pdf.length,
        object_path: replacementPath, created_at: "x", updated_at: "y",
      }] })
      .mockResolvedValueOnce({ status: 200, json: [] });
    const response = await fetch(`${base}/hq/files/${fileId}/replace`, {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({
        name: "Uploaded.pdf", contentType: "application/pdf", size: pdf.length,
        objectPath: replacementPath, compress: false,
      }),
    });
    expect(response.status).toBe(200);
    const guardedUrl = mocks.admin.mock.calls[1][1] as string;
    expect(guardedUrl).toContain("object_path=eq.");
    expect(guardedUrl).toContain("updated_at=eq.");
  });

  it("deletes every descendant object and row before cascading folders", async () => {
    mocks.admin
      .mockResolvedValueOnce({
        status: 200,
        json: [folderRow(folderId), folderRow(childId, "Child", folderId)],
      })
      .mockResolvedValueOnce({
        status: 200,
        json: [
          { id: fileId, object_path: objectPath },
          {
            id: "00000000-0000-4000-8000-000000000008",
            object_path: "/objects/hq-files/a/file-b",
            archived_at: "2026-10-16T00:00:00Z",
          },
        ],
      })
      .mockResolvedValue({ status: 204, json: null });
    const response = await fetch(`${base}/hq/folders/${folderId}`, {
      method: "DELETE",
      headers: { authorization: "Bearer admin" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, deletedFiles: 2, deletedFolders: 2 });
    expect(mocks.deleted).toHaveBeenCalledTimes(2);
    expect(mocks.admin.mock.calls[1][1]).not.toContain("archived_at");
    expect(mocks.admin.mock.calls.at(-1)?.[1]).toContain("/hq_file_folders");
  });

  describe("manual drive order", () => {
    const otherId = "00000000-0000-4000-8000-000000000009";
    const put = (body: unknown) => fetch(`${base}/hq/files/order`, {
      method: "PUT",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    it("lists children in saved order with unordered items first", async () => {
      mocks.admin
        .mockResolvedValueOnce({ status: 200, json: [
          folderRow(childId, "Zebra"), { ...folderRow(otherId, "Apple"), position: 1 }, { ...folderRow(folderId, "Mango"), position: 0 },
        ] })
        .mockResolvedValueOnce({ status: 200, json: [] });
      const response = await fetch(`${base}/hq/files`, { headers: { authorization: "Bearer admin" } });
      expect(response.status).toBe(200);
      const body = await response.json() as { folders: Array<{ id: string }> };
      expect(body.folders.map(folder => folder.id)).toEqual([childId, folderId, otherId]);
      expect(mocks.admin.mock.calls[1][1]).toContain("order=position.asc.nullsfirst,created_at.desc,id.desc");
    });

    it("rejects malformed, duplicate, and unknown-parent requests", async () => {
      expect((await put({ parentId: null, fileIds: ["nope"] })).status).toBe(400);
      expect((await put({ parentId: null, fileIds: [fileId, fileId] })).status).toBe(400);
      expect((await put({ fileIds: [fileId] })).status).toBe(400);
      mocks.admin.mockResolvedValueOnce({ status: 200, json: [] });
      expect((await put({ parentId: folderId, fileIds: [fileId] })).status).toBe(404);
      expect(mocks.admin).toHaveBeenCalledTimes(1);
    });

    it("writes folder and file order through the one-statement RPC", async () => {
      mocks.admin
        .mockResolvedValueOnce({ status: 200, json: [folderRow()] })
        .mockResolvedValueOnce({ status: 200, json: 2 })
        .mockResolvedValueOnce({ status: 200, json: 1 });
      const response = await put({ parentId: folderId, folderIds: [childId, otherId], fileIds: [fileId] });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, folders: 2, files: 1 });
      expect(mocks.admin.mock.calls[1]).toEqual(["POST", "/rest/v1/rpc/hq_reorder_drive_items", { p_kind: "folders", p_parent_id: folderId, p_ids: [childId, otherId] }]);
      expect(mocks.admin.mock.calls[2]).toEqual(["POST", "/rest/v1/rpc/hq_reorder_drive_items", { p_kind: "files", p_parent_id: folderId, p_ids: [fileId] }]);
    });

    it("reports a stale listing when the RPC touches fewer rows than sent", async () => {
      mocks.admin.mockResolvedValueOnce({ status: 200, json: 1 });
      const response = await put({ parentId: null, fileIds: [fileId, otherId] });
      expect(response.status).toBe(409);
    });

    it("forgets a file's position when it moves to another folder", async () => {
      mocks.admin
        .mockResolvedValueOnce({ status: 200, json: [{ id: fileId, name: "old.pdf", content_type: "application/pdf", folder_id: null }] })
        .mockResolvedValueOnce({ status: 200, json: [folderRow()] })
        .mockResolvedValueOnce({ status: 200, json: [{ id: fileId, name: "old.pdf", content_type: "application/pdf", size_bytes: 8, folder_id: folderId, created_at: "x", updated_at: "y" }] })
        .mockResolvedValueOnce({ status: 200, json: [folderRow()] });
      const moved = await fetch(`${base}/hq/files/${fileId}`, {
        method: "PATCH",
        headers: { authorization: "Bearer admin", "content-type": "application/json" },
        body: JSON.stringify({ folderId }),
      });
      expect(moved.status).toBe(200);
      expect(mocks.admin.mock.calls[2][2]).toMatchObject({ folder_id: folderId, position: null });

      mocks.admin.mockReset()
        .mockResolvedValueOnce({ status: 200, json: [{ id: fileId, name: "old.pdf", content_type: "application/pdf", folder_id: folderId }] })
        .mockResolvedValueOnce({ status: 200, json: [folderRow()] })
        .mockResolvedValueOnce({ status: 200, json: [{ id: fileId, name: "new.pdf", content_type: "application/pdf", size_bytes: 8, folder_id: folderId, created_at: "x", updated_at: "y" }] })
        .mockResolvedValueOnce({ status: 200, json: [folderRow()] });
      const renamed = await fetch(`${base}/hq/files/${fileId}`, {
        method: "PATCH",
        headers: { authorization: "Bearer admin", "content-type": "application/json" },
        body: JSON.stringify({ name: "new.pdf" }),
      });
      expect(renamed.status).toBe(200);
      expect(mocks.admin.mock.calls[2][2]).not.toHaveProperty("position");
    });
  });
});
