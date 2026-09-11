import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDocumentProxy: vi.fn(),
  getOperatorList: vi.fn(),
  getPage: vi.fn(),
  loadImage: vi.fn(),
  renderPageAsImage: vi.fn(),
}));

vi.mock("@napi-rs/canvas", () => ({ loadImage: mocks.loadImage }));
vi.mock("unpdf", () => ({
  getDocumentProxy: mocks.getDocumentProxy,
  renderPageAsImage: mocks.renderPageAsImage,
}));

import { prepareInWorker } from "./document-worker-core";

function tinyPng(): Buffer {
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    Buffer.from("0000000d494844520000000100000001080200000000000000", "hex"),
    Buffer.from("000000004944415400000000", "hex"),
    Buffer.from("0000000049454e44ae426082", "hex"),
  ]);
}

describe("admitted PDF preparation", () => {
  beforeEach(() => {
    mocks.getDocumentProxy.mockReset();
    mocks.getOperatorList.mockReset();
    mocks.getPage.mockReset();
    mocks.loadImage.mockReset();
    mocks.renderPageAsImage.mockReset();
    mocks.getOperatorList.mockResolvedValue(undefined);
    mocks.getPage.mockImplementation(async () => ({
      getViewport: () => ({ width: 100, height: 100 }),
      getOperatorList: mocks.getOperatorList,
    }));
    mocks.getDocumentProxy.mockResolvedValue({
      numPages: 100,
      getPage: mocks.getPage,
      destroy: vi.fn(),
    });
    mocks.loadImage.mockResolvedValue({ width: 1, height: 1 });
    const png = tinyPng();
    mocks.renderPageAsImage.mockResolvedValue(
      png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    );
  });

  it("uses one PDF open and skips the full page walk only for a matching admission", async () => {
    await prepareInWorker(
      Buffer.from("%PDF-1.7\nmock"),
      "application/pdf",
      [1, 100],
      { sha256: "a".repeat(64), pageCount: 100 },
    );

    expect(mocks.getDocumentProxy).toHaveBeenCalledTimes(1);
    expect(mocks.getOperatorList).not.toHaveBeenCalled();
    expect(mocks.getPage).toHaveBeenCalledTimes(2);
    expect(mocks.getPage).toHaveBeenNthCalledWith(1, 1);
    expect(mocks.getPage).toHaveBeenNthCalledWith(2, 100);
  });

  it("walks every page for a legacy receipt before rendering requested pages", async () => {
    await prepareInWorker(
      Buffer.from("%PDF-1.7\nmock"),
      "application/pdf",
      [1, 100],
      { sha256: null, pageCount: 100 },
    );

    expect(mocks.getDocumentProxy).toHaveBeenCalledTimes(1);
    expect(mocks.getOperatorList).toHaveBeenCalledTimes(100);
    expect(mocks.getPage).toHaveBeenCalledTimes(102);
  });
});