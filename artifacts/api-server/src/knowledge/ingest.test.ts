/**
 * Status transitions for the extraction run: uploaded → extracting →
 * ready | failed, with every persist CONDITIONAL on the object path the run
 * started from. A replace landing mid-run must orphan the stale run's
 * writes, and a failure must always leave a plain-words message.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  updates: [] as Array<{ id: string; expectedPath: string; patch: Record<string, unknown> }>,
  // Which conditional updates match; false simulates "row changed underneath".
  matchPath: true,
  fileExists: true,
  fileContent: Buffer.from("raw bytes"),
  extractResult: { kind: "text" as "text" | "empty" | "error", text: "Extracted body text." },
  aids: { summary: "A short summary.", keywords: ["alpha", "beta"] },
}));

vi.mock("./docs-store", () => ({
  updateDocumentIfPathCurrent: vi.fn(
    async (id: string, expectedPath: string, patch: Record<string, unknown>) => {
      state.updates.push({ id, expectedPath, patch });
      if (!state.matchPath) return null;
      return { id, object_path: expectedPath, ...patch };
    },
  ),
}));

vi.mock("../lib/objectStorage", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/objectStorage")>();
  return {
    ...original,
    objectStorage: {
      entityFile: vi.fn(async () => {
        if (!state.fileExists) throw new original.ObjectNotFoundError();
        return { download: async () => [state.fileContent] };
      }),
    },
  };
});

vi.mock("./extract", async (importOriginal) => {
  const original = await importOriginal<typeof import("./extract")>();
  return {
    ...original,
    extractDocumentText: vi.fn(async () => {
      if (state.extractResult.kind === "empty") {
        throw new original.EmptyTextError("No selectable text found — scanned or image-only.");
      }
      if (state.extractResult.kind === "error") {
        throw new Error("That file couldn't be read as a PDF — re-export it and upload again.");
      }
      return state.extractResult.text;
    }),
  };
});

vi.mock("./summary", () => ({
  writeRoutingAids: vi.fn(async () => state.aids),
}));

import { isExtractionActive, runExtraction, startExtraction } from "./ingest";

const DOC = {
  id: "33333333-3333-4333-8333-333333333333",
  title: "Approved foods",
  object_path: "/objects/knowledge-docs/33333333-3333-4333-8333-333333333333/doc-a",
  content_type: "application/pdf",
};

function statuses(): unknown[] {
  return state.updates.map((update) => update.patch.status);
}

beforeEach(() => {
  state.updates = [];
  state.matchPath = true;
  state.fileExists = true;
  state.extractResult = { kind: "text", text: "Extracted body text." };
});

describe("runExtraction", () => {
  it("walks extracting → ready and persists text plus routing aids", async () => {
    await runExtraction(DOC);
    expect(statuses()).toEqual(["extracting", "ready"]);
    const ready = state.updates[1];
    expect(ready.expectedPath).toBe(DOC.object_path);
    expect(ready.patch).toMatchObject({
      extracted_text: "Extracted body text.",
      extracted_chars: "Extracted body text.".length,
      summary: "A short summary.",
      keywords: ["alpha", "beta"],
      error_message: null,
    });
  });

  it("does nothing further when the claim misses (replaced or deleted)", async () => {
    state.matchPath = false;
    await runExtraction(DOC);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].patch.status).toBe("extracting");
  });

  it("marks empty documents failed with the no-OCR message", async () => {
    state.extractResult = { kind: "empty", text: "" };
    await runExtraction(DOC);
    expect(statuses()).toEqual(["extracting", "failed"]);
    expect(String(state.updates[1].patch.error_message)).toMatch(/scanned or image-only/);
  });

  it("marks parse failures failed with the parser's plain words", async () => {
    state.extractResult = { kind: "error", text: "" };
    await runExtraction(DOC);
    expect(statuses()).toEqual(["extracting", "failed"]);
    expect(String(state.updates[1].patch.error_message)).toMatch(/couldn't be read as a PDF/);
  });

  it("marks a vanished stored file failed with the missing-file message", async () => {
    state.fileExists = false;
    await runExtraction(DOC);
    expect(statuses()).toEqual(["extracting", "failed"]);
    expect(String(state.updates[1].patch.error_message)).toMatch(/missing from storage/);
  });

  it("every persist is conditional on the object path the run started from", async () => {
    await runExtraction(DOC);
    for (const update of state.updates) {
      expect(update.expectedPath).toBe(DOC.object_path);
    }
  });
});

describe("startExtraction", () => {
  it("dedupes the same (document, file) pair while a run is active", async () => {
    let release = () => {};
    state.fileContent = Buffer.from("slow");
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { extractDocumentText } = await import("./extract");
    vi.mocked(extractDocumentText).mockImplementationOnce(async () => {
      await gate;
      return "late text";
    });

    expect(startExtraction(DOC)).toBe(true);
    expect(isExtractionActive(DOC.id, DOC.object_path)).toBe(true);
    expect(startExtraction(DOC)).toBe(false);
    // A REPLACED file on the same document is a different run key.
    expect(isExtractionActive(DOC.id, `${DOC.object_path}-next`)).toBe(false);

    release();
    await vi.waitFor(() => {
      expect(isExtractionActive(DOC.id, DOC.object_path)).toBe(false);
    });
    expect(startExtraction(DOC)).toBe(true);
    await vi.waitFor(() => {
      expect(isExtractionActive(DOC.id, DOC.object_path)).toBe(false);
    });
  });
});
