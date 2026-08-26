import { execFile } from "child_process";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { detectThumbnailContentType } from "../lib/objectStorage";
import { captureFrame, validateThumbnailImage } from "./pipeline";

const aiState = vi.hoisted(() => ({
  create: vi.fn(async () => {
    throw new Error("frame capture must not call OpenAI");
  }),
}));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { chat: { completions: { create: aiState.create } } },
}));

const execFileAsync = promisify(execFile);

const dirs: string[] = [];
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("thumbnail image decoding", () => {
  it("decodes JPG, PNG, and WebP and rejects malformed image data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thumbnail-decode-"));
    dirs.push(dir);
    const valid = join(dir, "valid.png");
    const jpeg = join(dir, "valid.jpg");
    const webp = join(dir, "valid.webp");
    const malformed = join(dir, "malformed.png");
    await writeFile(valid, ONE_PIXEL_PNG);
    await writeFile(
      malformed,
      Buffer.concat([
        Buffer.from("\x89PNG\r\n\x1a\n", "binary"),
        Buffer.alloc(8),
        Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]),
      ]),
    );
    await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", valid, jpeg]);
    await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", valid, webp]);

    await expect(validateThumbnailImage(valid)).resolves.toBeUndefined();
    await expect(validateThumbnailImage(jpeg)).resolves.toBeUndefined();
    await expect(validateThumbnailImage(webp)).resolves.toBeUndefined();
    await expect(validateThumbnailImage(malformed)).rejects.toThrow();
  });

  it("captures a real video frame without touching OpenAI", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thumbnail-capture-"));
    dirs.push(dir);
    const video = join(dir, "source.webm");
    const frame = join(dir, "frame.jpg");
    await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=32x18:d=1",
      "-c:v",
      "libvpx-vp9",
      video,
    ]);

    await captureFrame(video, 0, frame);
    expect(detectThumbnailContentType(await readFile(frame))).toBe("image/jpeg");
    expect(aiState.create).not.toHaveBeenCalled();
  });
});