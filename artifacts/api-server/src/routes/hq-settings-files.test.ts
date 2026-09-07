import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signedDownloadURL: vi.fn(),
  admin: vi.fn(),
  audit: vi.fn(),
  deleted: vi.fn(),
  entityFile: vi.fn(),
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
    deleteObject: vi.fn(),
    entityFile: mocks.entityFile,
    hqFileUploadURL: vi.fn(),
    signedDownloadURL: mocks.signedDownloadURL,
  },
}));
import router from "./hq-settings-files";

let server: http.Server;
let base = "";
const fileId = "00000000-0000-4000-8000-000000000002";
const objectPath = `/objects/hq-files/${fileId}/file-00000000-0000-4000-8000-000000000003`;
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
  mocks.deleted.mockReset().mockResolvedValue(undefined);
  mocks.entityFile.mockReset().mockResolvedValue({
    getMetadata: vi.fn().mockResolvedValue([{ size: "8", contentType: "application/pdf" }]),
    download: vi.fn().mockResolvedValue([Buffer.from("not-a-pdf")]),
    setMetadata: vi.fn(),
  });
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

  it("does not audit a download that never happened", async () => {
    mocks.admin.mockResolvedValueOnce({ status: 200, json: [] });
    const res = await fetch(`${base}/hq/files/${fileId}/download-url`, { headers: { authorization: "Bearer admin" } });
    expect(res.status).toBe(404);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
