import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  audit: vi.fn(),
  resolveScope: vi.fn(),
  respondDenied: vi.fn(),
  signedDownloadURL: vi.fn(),
  readObjectBounded: vi.fn(),
}));

vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("../lib/admin-audit", () => ({ recordAdminAuditEvent: mocks.audit }));
vi.mock("../lib/objectStorage", () => ({
  ObjectNotFoundError: class ObjectNotFoundError extends Error {},
  objectStorage: {
    signedDownloadURL: mocks.signedDownloadURL,
    readObjectBounded: mocks.readObjectBounded,
  },
}));
vi.mock("../auth/office-scope", () => ({
  resolveOfficeScope: mocks.resolveScope,
  respondOfficeScopeDenied: mocks.respondDenied,
}));

import router from "./office-files";

let server: http.Server;
let base = "";
const fileId = "00000000-0000-4000-8000-000000000002";
const folderId = "00000000-0000-4000-8000-000000000004";
const childId = "00000000-0000-4000-8000-000000000005";
const objectPath = `/objects/hq-files/${fileId}/stored`;
const folders = [
  { id: folderId, name: "Policies", parent_id: null, created_at: "2026-01-01", updated_at: "2026-01-01" },
  { id: childId, name: "Clinical", parent_id: folderId, created_at: "2026-01-02", updated_at: "2026-01-02" },
];
const file = {
  id: fileId,
  name: "Playbook.pdf",
  content_type: "application/pdf",
  size_bytes: 100,
  folder_id: folderId,
  archived_at: null,
  created_at: "2026-01-03",
  updated_at: "2026-01-03",
};

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
  mocks.signedDownloadURL.mockReset().mockResolvedValue("https://signed.example/file");
  mocks.readObjectBounded.mockReset().mockResolvedValue({ bytes: Buffer.from("%PDF-1.4") });
  mocks.respondDenied.mockReset().mockImplementation((_req, res, denied) => {
    res.status(denied.status).json({ error: denied.message });
  });
  mocks.resolveScope.mockReset().mockResolvedValue({
    kind: "ok",
    scope: {
      providerId: "provider-1",
      actorUserId: "staff-user-1",
      actorKind: "team_member",
      officeRole: "staff",
      officeName: "Office",
      providerName: "Provider",
      onboardingCode: null,
      teamMemberId: "member-1",
    },
  });
});

describe("office files", () => {
  it("uses the standard office-scope denial response", async () => {
    const denied = { kind: "denied", status: 401, message: "Sign in to continue.", reason: "unauthorized" };
    mocks.resolveScope.mockResolvedValueOnce(denied);
    const response = await fetch(`${base}/office/files`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Sign in to continue." });
    expect(mocks.respondDenied).toHaveBeenCalledWith(expect.anything(), expect.anything(), denied);
  });

  it("lets staff list root and subfolders with breadcrumbs", async () => {
    mocks.admin
      .mockResolvedValueOnce({ status: 200, json: folders })
      .mockResolvedValueOnce({ status: 200, json: [] })
      .mockResolvedValueOnce({ status: 200, json: folders })
      .mockResolvedValueOnce({ status: 200, json: [file] });
    const root = await fetch(`${base}/office/files`);
    expect(root.status).toBe(200);
    const rootBody = await root.json() as { folders: Array<{ id: string }> };
    expect(rootBody.folders).toEqual([expect.objectContaining({ id: folderId })]);

    const sub = await fetch(`${base}/office/files?folderId=${childId}`);
    expect(sub.status).toBe(200);
    const body = await sub.json() as { folder: { id: string }; breadcrumbs: Array<{ id: string }> };
    expect(body.folder).toMatchObject({ id: childId });
    expect(body.breadcrumbs.map((item: { id: string }) => item.id)).toEqual([folderId, childId]);
  });

  it("shows providers the HQ manual order (unordered first, then by position)", async () => {
    const ordered = [
      folders[0], { ...folders[1], name: "Zed", position: 0 },
      { id: "00000000-0000-4000-8000-00000000000a", name: "Alpha", parent_id: folderId, position: 1, created_at: "2026-10-15T00:00:00Z", updated_at: "2026-10-15T00:00:00Z" },
      { id: "00000000-0000-4000-8000-00000000000b", name: "Newest", parent_id: folderId, position: null, created_at: "2026-10-15T00:00:00Z", updated_at: "2026-10-15T00:00:00Z" },
    ];
    mocks.admin
      .mockResolvedValueOnce({ status: 200, json: ordered })
      .mockResolvedValueOnce({ status: 200, json: [] });
    const response = await fetch(`${base}/office/files?folderId=${folderId}`);
    expect(response.status).toBe(200);
    const body = await response.json() as { folders: Array<{ name: string }> };
    expect(body.folders.map(folder => folder.name)).toEqual(["Newest", "Zed", "Alpha"]);
    expect(mocks.admin.mock.calls[1][1]).toContain("order=position.asc.nullsfirst,created_at.desc,id.desc");
  });

  it("searches active files", async () => {
    mocks.admin
      .mockResolvedValueOnce({ status: 200, json: folders })
      .mockResolvedValueOnce({ status: 200, json: [file] });
    const response = await fetch(`${base}/office/files/search?q=Play`);
    expect(response.status).toBe(200);
    const body = await response.json() as { files: Array<{ id: string; name: string }> };
    expect(body.files[0]).toMatchObject({ id: fileId, name: "Playbook.pdf" });
    expect(mocks.admin.mock.calls[1][1]).toContain("archived_at=is.null");
  });

  it("gets a download URL and audits the office actor", async () => {
    mocks.admin.mockResolvedValueOnce({
      status: 200,
      json: [{ name: file.name, object_path: objectPath, object_missing_at: null, archived_at: null }],
    });
    const response = await fetch(`${base}/office/files/${fileId}/download-url`);
    expect(response.status).toBe(200);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "hq_file_downloaded",
      actorUserId: "staff-user-1",
      actorKind: "team_member",
      providerId: "provider-1",
      targetKind: "hq_file",
      targetId: fileId,
    }));
  });

  it("streams active file content", async () => {
    mocks.admin.mockResolvedValueOnce({
      status: 200,
      json: [{ name: file.name, content_type: file.content_type, object_path: objectPath, object_missing_at: null, archived_at: null }],
    });
    const response = await fetch(`${base}/office/files/${fileId}/content`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("%PDF-1.4");
    // Previews stay bounded at the preview limit, not the 250 MB storage cap.
    expect(mocks.readObjectBounded).toHaveBeenCalledWith(objectPath, 50 * 1024 * 1024);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "hq_file_previewed", actorKind: "team_member", providerId: "provider-1", targetId: fileId,
    }));
  });

  it("hides archived files from both download endpoints", async () => {
    const archived = { name: file.name, content_type: file.content_type, object_path: objectPath, archived_at: "2026-02-01" };
    mocks.admin.mockResolvedValueOnce({ status: 200, json: [archived] });
    expect((await fetch(`${base}/office/files/${fileId}/download-url`)).status).toBe(404);
    mocks.admin.mockResolvedValueOnce({ status: 200, json: [archived] });
    expect((await fetch(`${base}/office/files/${fileId}/content`)).status).toBe(404);
    expect(mocks.signedDownloadURL).not.toHaveBeenCalled();
    expect(mocks.readObjectBounded).not.toHaveBeenCalled();
  });

  it("ignores view=archived and always lists active root files", async () => {
    mocks.admin
      .mockResolvedValueOnce({ status: 200, json: folders })
      .mockResolvedValueOnce({ status: 200, json: [file] });
    const response = await fetch(`${base}/office/files?view=archived`);
    expect(response.status).toBe(200);
    expect(mocks.admin.mock.calls[1][1]).toContain("folder_id=is.null&archived_at=is.null");
    expect(mocks.admin.mock.calls[1][1]).not.toContain("archived_at=not.is.null");
  });

  it("does not expose file or folder mutation routes", async () => {
    const requests = [
      fetch(`${base}/office/files`, { method: "POST" }),
      fetch(`${base}/office/files/${fileId}`, { method: "DELETE" }),
      fetch(`${base}/office/files/${fileId}`, { method: "PATCH" }),
      fetch(`${base}/office/folders`, { method: "POST" }),
    ];
    expect((await Promise.all(requests)).map(response => response.status)).toEqual([404, 404, 404, 404]);
    expect(mocks.resolveScope).not.toHaveBeenCalled();
  });
});