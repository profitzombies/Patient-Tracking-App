import { describe, expect, it } from "vitest";
import { detectThumbnailContentType } from "./objectStorage";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

describe("thumbnail byte validation", () => {
  it("recognizes a real PNG and rejects renamed non-images", () => {
    expect(detectThumbnailContentType(ONE_PIXEL_PNG)).toBe("image/png");
    expect(detectThumbnailContentType(Buffer.from("not really a jpg"))).toBeNull();
  });

  it("rejects impossible image dimensions", () => {
    const impossible = Buffer.from(ONE_PIXEL_PNG);
    impossible.writeUInt32BE(100_000, 16);
    expect(detectThumbnailContentType(impossible)).toBeNull();
  });
});