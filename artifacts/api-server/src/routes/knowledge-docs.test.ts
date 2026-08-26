/**
 * The knowledge routes' upload contract over real HTTP: finalize verifies
 * the object landed under the minted prefix and fits the cap BEFORE a row
 * exists, replacement clears everything the old file produced in one
 * conditional swap and deletes the replaced object, and every route demands
 * an HQ-admin session.
 */
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const DOC_ID = "44444444-4444-4444-8444-444444444444";
const DOC_PATH = `/objects/knowledge-docs/${DOC_ID}/doc-current`;

interface StoredRow {
  id: string;
  title: string;
  original_filename: string;
  object_path: string;
  content_type: string;
  size_bytes: number;
  status: string;
  error_message: string | null;
  extracted_text: string | null;
  extracted_chars: number;
  summary: string | null;
  keywords: string[];
  created_at: string;
  updated_at: string;
}

const state = vi.hoisted(() => ({
  rows: new Map<string, StoredRow>(),
  rolesDemanded: [] as string[][],
  deleted: [] as string[],
  minted: [] as string[],
  objectExists: true,
  objectSize: 2048,
  insertConflict: false,
  extractActive: false,
  extractionStarts: [] as Array<{ id: string; object_path: string }>,
  startResult: true,
}));

function makeRow(overrides: Partial<StoredRow> = {}): StoredRow {
  return {
    id: DOC_ID,
    title: "Approved foods",
    original_filename: "approved-foods.pdf",
    object_path: DOC_PATH,
    content_type: "application/pdf",
    size_bytes: 2048,
    status: "ready",
    error_message: null,
    extracted_text: "Old extracted text",
    extracted_chars: 18,
    summary: "Old summary",
    keywords: ["old"],
    created_at: "2026-08-20T10:00:00Z",
    updated_at: "2026-08-20T10:05:00Z",
    ...overrides,
  };
}

vi.mock("../lib/staff-auth", () => ({
  requireStaff: (roles: string[]) => {
    state.rolesDemanded.push(roles);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));

vi.mock("../lib/objectStorage", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/objectStorage")>();
  return {
    ...original,
    objectStorage: {
      knowledgeUploadURL: vi.fn(async (documentId: string) => {
        const objectPath = `/objects/knowledge-docs/${documentId}/doc-minted-${state.minted.length}`;
        state.minted.push(objectPath);
        return { uploadUrl: `https://storage.example.com/put/${documentId}`, objectPath };
      }),
      entityFile: vi.fn(async (objectPath: string) => {
        if (!state.objectExists) throw new original.ObjectNotFoundError();
        return {
          getMetadata: async () => [{ size: String(state.objectSize) }],
          name: objectPath,
        };
      }),
      deleteObject: vi.fn(async (objectPath: string) => {
        state.deleted.push(objectPath);
      }),
    },
  };
});

vi.mock("../knowledge/docs-store", async (importOriginal) => {
  const original = await importOriginal<typeof import("../knowledge/docs-store")>();
  const strip = ({ extracted_text: _text, ...row }: StoredRow) => ({ ...row });
  return {
    ...original,
    listDocumentRecords: vi.fn(async () =>
      [...state.rows.values()]
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map(strip),
    ),
    getDocumentRecord: vi.fn(async (id: string) => {
      const row = state.rows.get(id);
      return row ? strip(row) : null;
    }),
    getDocumentDetailRecord: vi.fn(async (id: string) => {
      const row = state.rows.get(id);
      return row ? { ...row } : null;
    }),
    insertDocumentRecord: vi.fn(async (row: Omit<StoredRow, "created_at" | "updated_at">) => {
      if (state.insertConflict || state.rows.has(row.id)) return null;
      const stored = makeRow({
        ...row,
        error_message: null,
        extracted_text: null,
        extracted_chars: 0,
        summary: null,
        keywords: [],
        created_at: "2026-08-26T12:00:00Z",
        updated_at: "2026-08-26T12:00:00Z",
      });
      state.rows.set(row.id, stored);
      return strip(stored);
    }),
    renameDocumentRecord: vi.fn(async (id: string, title: string) => {
      const row = state.rows.get(id);
      if (!row) return null;
      row.title = title;
      return strip(row);
    }),
    updateDocumentIfPathCurrent: vi.fn(
      async (id: string, expectedPath: string, patch: Partial<StoredRow>) => {
        const row = state.rows.get(id);
        if (!row || row.object_path !== expectedPath) return null;
        Object.assign(row, patch);
        return strip(row);
      },
    ),
    deleteDocumentRecord: vi.fn(async (id: string) => state.rows.delete(id)),
  };
});

vi.mock("../knowledge/ingest", () => ({
  isExtractionActive: vi.fn(() => state.extractActive),
  startExtraction: vi.fn((target: { id: string; object_path: string }) => {
    state.extractionStarts.push({ id: target.id, object_path: target.object_path });
    return state.startResult;
  }),
}));

import knowledgeDocsRouter from "./knowledge-docs";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(knowledgeDocsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  state.rows.clear();
  state.deleted = [];
  state.minted = [];
  state.objectExists = true;
  state.objectSize = 2048;
  state.insertConflict = false;
  state.extractActive = false;
  state.extractionStarts = [];
  state.startResult = true;
});

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: response.status, json };
}

const GOOD_UPLOAD = { fileName: "handbook.pdf", contentType: "application/pdf", sizeBytes: 2048 };

describe("auth", () => {
  it("every knowledge route demands an HQ admin session", () => {
    expect(state.rolesDemanded.length).toBeGreaterThanOrEqual(9);
    for (const roles of state.rolesDemanded) {
      expect(roles).toEqual(["hq_admin"]);
    }
  });
});

describe("POST /knowledge/upload-url", () => {
  it("mints a document id with a matching prefixed object path", async () => {
    const { status, json } = await call("POST", "/knowledge/upload-url", GOOD_UPLOAD);
    expect(status).toBe(200);
    const documentId = String(json?.documentId);
    expect(documentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(String(json?.objectPath)).toContain(`/objects/knowledge-docs/${documentId}/doc-`);
    expect(String(json?.uploadUrl)).toContain("https://");
  });

  it("rejects types outside the allowlist with 415", async () => {
    const { status, json } = await call("POST", "/knowledge/upload-url", {
      ...GOOD_UPLOAD,
      fileName: "notes.doc",
      contentType: "application/msword",
    });
    expect(status).toBe(415);
    expect(String(json?.error)).toMatch(/PDF, Word/);
  });

  it("rejects oversized declarations with 413", async () => {
    const { status } = await call("POST", "/knowledge/upload-url", {
      ...GOOD_UPLOAD,
      sizeBytes: 26 * 1024 * 1024,
    });
    expect(status).toBe(413);
  });

  it("rejects malformed bodies with 400", async () => {
    const { status } = await call("POST", "/knowledge/upload-url", { fileName: "x.pdf" });
    expect(status).toBe(400);
  });
});

describe("POST /knowledge/documents (finalize-create)", () => {
  const CREATE = {
    documentId: DOC_ID,
    objectPath: DOC_PATH,
    fileName: "Thinnr_Approved_Foods.pdf",
    contentType: "application/pdf",
  };

  it("verifies the object, inserts the row, and kicks extraction", async () => {
    const { status, json } = await call("POST", "/knowledge/documents", CREATE);
    expect(status).toBe(200);
    expect(json).toMatchObject({
      id: DOC_ID,
      title: "Thinnr_Approved_Foods",
      originalFilename: "Thinnr_Approved_Foods.pdf",
      status: "uploaded",
      sizeBytes: 2048,
      keywords: [],
    });
    expect(json).not.toHaveProperty("extractedText");
    expect(state.extractionStarts).toEqual([{ id: DOC_ID, object_path: DOC_PATH }]);
  });

  it("rejects an object path outside the document's prefix", async () => {
    const { status } = await call("POST", "/knowledge/documents", {
      ...CREATE,
      objectPath: "/objects/knowledge-docs/55555555-5555-4555-8555-555555555555/doc-x",
    });
    expect(status).toBe(400);
    expect(state.extractionStarts).toHaveLength(0);
  });

  it("404s when the uploaded object never arrived", async () => {
    state.objectExists = false;
    const { status, json } = await call("POST", "/knowledge/documents", CREATE);
    expect(status).toBe(404);
    expect(String(json?.error)).toMatch(/never arrived/);
  });

  it("422s an empty upload and deletes the orphan object", async () => {
    state.objectSize = 0;
    const { status } = await call("POST", "/knowledge/documents", CREATE);
    expect(status).toBe(422);
    expect(state.deleted).toEqual([DOC_PATH]);
    expect(state.rows.size).toBe(0);
  });

  it("413s an oversized upload by TRUE stored size and deletes it", async () => {
    state.objectSize = 26 * 1024 * 1024;
    const { status } = await call("POST", "/knowledge/documents", CREATE);
    expect(status).toBe(413);
    expect(state.deleted).toEqual([DOC_PATH]);
  });

  it("409s a duplicate finalize", async () => {
    state.rows.set(DOC_ID, makeRow());
    const { status } = await call("POST", "/knowledge/documents", CREATE);
    expect(status).toBe(409);
  });

  it("409s when the insert loses the race", async () => {
    state.insertConflict = true;
    const { status } = await call("POST", "/knowledge/documents", CREATE);
    expect(status).toBe(409);
  });
});

describe("list and detail", () => {
  it("lists newest-first without extracted text", async () => {
    state.rows.set(DOC_ID, makeRow());
    state.rows.set(
      "55555555-5555-4555-8555-555555555555",
      makeRow({
        id: "55555555-5555-4555-8555-555555555555",
        title: "Newer",
        created_at: "2026-08-25T09:00:00Z",
      }),
    );
    const { status, json } = await call("GET", "/knowledge/documents");
    expect(status).toBe(200);
    const documents = json?.documents as Array<Record<string, unknown>>;
    expect(documents.map((doc) => doc.title)).toEqual(["Newer", "Approved foods"]);
    for (const doc of documents) {
      expect(doc).not.toHaveProperty("extractedText");
      expect(doc).not.toHaveProperty("object_path");
    }
  });

  it("returns extracted text on the detail route", async () => {
    state.rows.set(DOC_ID, makeRow());
    const { status, json } = await call("GET", `/knowledge/documents/${DOC_ID}`);
    expect(status).toBe(200);
    expect(json).toMatchObject({ extractedText: "Old extracted text", status: "ready" });
  });

  it("404s an unknown or malformed document id", async () => {
    expect((await call("GET", `/knowledge/documents/${DOC_ID}`)).status).toBe(404);
    expect((await call("GET", "/knowledge/documents/not-a-uuid")).status).toBe(404);
  });
});

describe("rename and delete", () => {
  it("renames without touching the stored file", async () => {
    state.rows.set(DOC_ID, makeRow());
    const { status, json } = await call("PATCH", `/knowledge/documents/${DOC_ID}`, {
      title: "Approved foods (2026)",
    });
    expect(status).toBe(200);
    expect(json?.title).toBe("Approved foods (2026)");
    expect(state.deleted).toHaveLength(0);
    expect(state.rows.get(DOC_ID)?.object_path).toBe(DOC_PATH);
  });

  it("rejects blank titles", async () => {
    state.rows.set(DOC_ID, makeRow());
    const { status } = await call("PATCH", `/knowledge/documents/${DOC_ID}`, { title: "   " });
    expect(status).toBe(400);
  });

  it("deletes the stored object and then the row", async () => {
    state.rows.set(DOC_ID, makeRow());
    const { status, json } = await call("DELETE", `/knowledge/documents/${DOC_ID}`);
    expect(status).toBe(200);
    expect(json).toEqual({ deleted: true });
    expect(state.deleted).toEqual([DOC_PATH]);
    expect(state.rows.size).toBe(0);
  });

  it("404s deleting a document that does not exist", async () => {
    expect((await call("DELETE", `/knowledge/documents/${DOC_ID}`)).status).toBe(404);
  });
});

describe("replace flow", () => {
  it("mints replacement uploads under the SAME document id", async () => {
    state.rows.set(DOC_ID, makeRow());
    const { status, json } = await call(
      "POST",
      `/knowledge/documents/${DOC_ID}/upload-url`,
      GOOD_UPLOAD,
    );
    expect(status).toBe(200);
    expect(json?.documentId).toBe(DOC_ID);
    expect(String(json?.objectPath)).toContain(`/objects/knowledge-docs/${DOC_ID}/doc-`);
  });

  it("swaps the file, clears old extraction output, deletes the old object, re-extracts", async () => {
    state.rows.set(DOC_ID, makeRow());
    const newPath = `/objects/knowledge-docs/${DOC_ID}/doc-replacement`;
    const { status, json } = await call("POST", `/knowledge/documents/${DOC_ID}/file`, {
      objectPath: newPath,
      fileName: "handbook-v2.docx",
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({
      status: "uploaded",
      originalFilename: "handbook-v2.docx",
      summary: null,
      errorMessage: null,
      keywords: [],
      extractedChars: 0,
      title: "Approved foods",
    });
    const row = state.rows.get(DOC_ID);
    expect(row?.object_path).toBe(newPath);
    expect(row?.extracted_text).toBeNull();
    expect(state.deleted).toEqual([DOC_PATH]);
    expect(state.extractionStarts).toEqual([{ id: DOC_ID, object_path: newPath }]);
  });

  it("409s a stale swap and deletes the just-uploaded object instead", async () => {
    state.rows.set(DOC_ID, makeRow({ object_path: `${DOC_PATH}-already-swapped` }));
    const newPath = `/objects/knowledge-docs/${DOC_ID}/doc-late`;
    const getRecord = (await import("../knowledge/docs-store")).getDocumentRecord;
    vi.mocked(getRecord).mockResolvedValueOnce(makeRow() as never);
    const { status } = await call("POST", `/knowledge/documents/${DOC_ID}/file`, {
      objectPath: newPath,
      fileName: "late.pdf",
      contentType: "application/pdf",
    });
    expect(status).toBe(409);
    expect(state.deleted).toEqual([newPath]);
    expect(state.extractionStarts).toHaveLength(0);
  });

  it("rejects replacement paths outside this document's prefix", async () => {
    state.rows.set(DOC_ID, makeRow());
    const { status } = await call("POST", `/knowledge/documents/${DOC_ID}/file`, {
      objectPath: "/objects/training-videos/evil/doc-x",
      fileName: "handbook.pdf",
      contentType: "application/pdf",
    });
    expect(status).toBe(400);
  });
});

describe("POST /knowledge/documents/:id/extract (retry)", () => {
  it("restarts extraction and answers 202", async () => {
    state.rows.set(DOC_ID, makeRow({ status: "failed", error_message: "No selectable text" }));
    const { status, json } = await call("POST", `/knowledge/documents/${DOC_ID}/extract`);
    expect(status).toBe(202);
    expect(json).toEqual({ status: "extracting" });
    expect(state.extractionStarts).toEqual([{ id: DOC_ID, object_path: DOC_PATH }]);
  });

  it("409s while a run for this file is active", async () => {
    state.rows.set(DOC_ID, makeRow());
    state.extractActive = true;
    const { status } = await call("POST", `/knowledge/documents/${DOC_ID}/extract`);
    expect(status).toBe(409);
    expect(state.extractionStarts).toHaveLength(0);
  });

  it("409s when the start itself loses the race", async () => {
    state.rows.set(DOC_ID, makeRow());
    state.startResult = false;
    const { status } = await call("POST", `/knowledge/documents/${DOC_ID}/extract`);
    expect(status).toBe(409);
  });
});
