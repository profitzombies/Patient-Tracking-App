import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ existsSync: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: mocks.existsSync };
});

import { inspectBloodworkFile } from "./documents";

describe("document worker artifact verification", () => {
  beforeEach(() => {
    mocks.existsSync.mockReset();
    mocks.existsSync.mockReturnValue(false);
  });

  it("fails closed rather than processing in the API process when the worker artifact is absent", async () => {
    await expect(
      inspectBloodworkFile(Buffer.from("%PDF-1.7\n"), "application/pdf"),
    ).rejects.toMatchObject({
      name: "BloodworkDocumentError",
      code: "PROCESSING_LIMIT",
      message: "Document processing worker is unavailable.",
    });
    expect(mocks.existsSync).toHaveBeenCalledTimes(1);
  });
});