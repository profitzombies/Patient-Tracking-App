/**
 * Native probe pipeline for the guided session's positioning phase: grab a
 * throwaway low-quality still from the front camera, shrink it to a tiny
 * PNG, and decode that PNG to the grayscale grid lib/photo-detection reads.
 *
 * PNG (not JPEG) because a PNG at 18×24 is decodable in ~80 lines of plain
 * TypeScript with an inflate (pako) — no native module, no AI service, and
 * the same decoder runs under Node in the verification suite against
 * synthetic fixture PNGs.
 */
import { inflate } from 'pako';
import type { CameraView } from 'expo-camera';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import type { LumaFrame } from '@/lib/photo-detection';

/** Probe grid width; height follows the camera's aspect ratio. */
export const PROBE_WIDTH = 18;

// Kept as a re-export so existing consumers (photo-detection suites, the
// guided session) keep their import path; the implementation lives in the
// dependency-free lib/base64 so non-camera modules can share it.
export { decodeBase64 } from './base64';
import { decodeBase64 } from './base64';

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Minimal PNG → luma decoder: 8-bit depth, color types 0 (gray), 2 (RGB),
 * 4 (gray+alpha), 6 (RGBA), no interlace — exactly what the manipulator
 * emits for a tiny resize. Anything else throws; the caller treats a throw
 * as "probe unavailable" and falls back to timed countdowns.
 */
export function decodePngToLuma(bytes: Uint8Array): LumaFrame {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) throw new Error('not a PNG');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatParts: Uint8Array[] = [];
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const dataStart = offset + 8;
    if (type === 'IHDR') {
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
      bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
      if (bytes[dataStart + 12] !== 0) throw new Error('interlaced PNG unsupported');
    } else if (type === 'IDAT') {
      idatParts.push(bytes.subarray(dataStart, dataStart + length));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataStart + length + 4; // skip CRC
  }
  if (width === 0 || height === 0) throw new Error('PNG missing IHDR');
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (channels === 0) throw new Error(`unsupported color type ${colorType}`);

  const compressed = new Uint8Array(idatParts.reduce((sum, p) => sum + p.length, 0));
  let cursor = 0;
  for (const part of idatParts) {
    compressed.set(part, cursor);
    cursor += part.length;
  }
  const raw = inflate(compressed);

  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  let rawIndex = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rawIndex++];
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[rawIndex++];
      const left = x >= channels ? pixels[rowStart + x - channels] : 0;
      const up = y > 0 ? pixels[prevStart + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[prevStart + x - channels] : 0;
      let decoded: number;
      switch (filter) {
        case 0:
          decoded = value;
          break;
        case 1:
          decoded = value + left;
          break;
        case 2:
          decoded = value + up;
          break;
        case 3:
          decoded = value + Math.floor((left + up) / 2);
          break;
        case 4:
          decoded = value + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`unsupported PNG filter ${filter}`);
      }
      pixels[rowStart + x] = decoded & 0xff;
    }
  }

  const luma = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const p = i * channels;
    luma[i] =
      channels >= 3
        ? Math.round(0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2])
        : pixels[p];
  }
  return { width, height, luma };
}

/**
 * One positioning probe: throwaway still → tiny PNG → luma grid. Returns
 * null on any failure (camera busy, manipulator hiccup, odd PNG) so a
 * single bad probe never breaks the loop — and a STREAK of nulls tells the
 * surface to fall back to timed countdowns.
 */
export async function probeCameraFrame(camera: CameraView): Promise<LumaFrame | null> {
  try {
    const shot = await camera.takePictureAsync({
      quality: 0.2,
      skipProcessing: true,
      shutterSound: false,
    });
    if (!shot?.uri) return null;
    const context = ImageManipulator.manipulate(shot.uri);
    context.resize({ width: PROBE_WIDTH });
    const rendered = await context.renderAsync();
    const saved = await rendered.saveAsync({ format: SaveFormat.PNG, base64: true });
    const base64 = saved.base64 ?? (saved.uri.startsWith('data:') ? saved.uri.split(',')[1] : null);
    if (!base64) return null;
    return decodePngToLuma(decodeBase64(base64));
  } catch {
    return null;
  }
}
