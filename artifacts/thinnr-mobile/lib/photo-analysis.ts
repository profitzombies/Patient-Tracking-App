/**
 * No-AI quality checks for guided progress-photo sessions.
 *
 * Everything here is plain, deterministic image math on small grayscale
 * frames — no models, no network:
 *
 * - Lighting: a luminance histogram per shot. A frame whose pixels sit
 *   mostly at the bottom of the range reads "too dark"; mostly pinned at
 *   the top reads "washed out".
 * - Subject presence/distance: the three shots share one scene — the same
 *   room, the same spot, a person who ROTATES between shots. Differencing
 *   the downsampled frames against each other isolates the person (the
 *   background cancels out; a front silhouette never matches a side
 *   profile), so the changed region's vertical extent estimates how much
 *   of the frame the person fills: a tiny changed area means nobody made
 *   it into frame, a floor-to-ceiling one means they are on top of the
 *   camera, a short one means they are too far away. No empty-room
 *   baseline is needed — which matters, because the patient is in front
 *   of the lens from the moment they tap Start.
 *
 * Verdict thresholds are exported constants so the verify suite pins them
 * and a future retune is a reviewed diff, not a silent drift.
 */
import { decode as decodeJpeg, encode as encodeJpeg } from 'jpeg-js';
import type { SessionAngle } from '@/lib/progress-session';

/** Row-major 8-bit grayscale frame. */
export interface GrayFrame {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Analysis frames are downsampled to this width (aspect preserved). */
export const ANALYSIS_WIDTH = 96;

// ── Lighting thresholds (0–255 luminance) ─────────────────────────────
export const DARK_MEAN_MAX = 58;
export const DARK_P85_MAX = 88;
export const BRIGHT_MEAN_MIN = 198;
export const BRIGHT_P15_MIN = 168;

// ── Subject thresholds ────────────────────────────────────────────────
/** Per-pixel |a-b| above this counts as "changed between shots". */
export const DIFF_THRESHOLD = 26;
/** A row counts toward the subject when this fraction of it changed. */
export const ROW_CHANGED_MIN_FRAC = 0.08;
/** Below this overall changed fraction, no person was found at all. */
export const PRESENCE_MIN_CHANGED_FRAC = 0.02;
/** Subject spanning nearly the whole frame height = standing too close. */
export const TOO_CLOSE_HEIGHT_FRAC = 0.93;
/** Or: most of the frame churning between shots = filling the lens. */
export const TOO_CLOSE_CHANGED_FRAC = 0.5;
/** Subject shorter than this fraction of the frame = too far away. */
export const TOO_FAR_HEIGHT_FRAC = 0.45;

export interface LightingVerdict {
  kind: 'ok' | 'too_dark' | 'too_bright';
  meanLuma: number;
}

export interface SubjectMetrics {
  /** Fraction of pixels that changed between any pair of shots. */
  changedFrac: number;
  /** Vertical extent of the changed region as a fraction of frame height. */
  heightFrac: number;
  /** First/last rows (inclusive) of the changed region, -1 when none. */
  topRow: number;
  bottomRow: number;
}

export interface SubjectVerdict extends SubjectMetrics {
  kind: 'ok' | 'not_detected' | 'too_close' | 'too_far';
}

/** Plain-language reshoot reasons, written for the review screen. */
export const LIGHTING_MESSAGES: Record<'too_dark' | 'too_bright', string> = {
  too_dark: 'This one looks too dark. Turn on a light, then retake it.',
  too_bright: 'This one looks washed out. Avoid a bright window behind you, then retake it.',
};

export const SUBJECT_MESSAGES: Record<'not_detected' | 'too_close' | 'too_far', string> = {
  not_detected:
    'We could not spot you in these photos. Stand inside the outline before the timer ends.',
  too_close: 'You look very close to the camera. Take a step or two back.',
  too_far: 'You look far from the camera. Move a step or two closer.',
};

export const MISSING_SHOT_MESSAGE = 'This photo did not capture. Retake it.';

// ── Base64 helpers (Node Buffer when present, atob elsewhere) ─────────

export function base64ToBytes(base64: string): Uint8Array {
  const cleaned = base64.replace(/^data:[^,]*,/, '');
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(cleaned, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = globalThis.atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return globalThis.btoa(binary);
}

// ── Decode / encode ───────────────────────────────────────────────────

/**
 * Decode a JPEG (base64, with or without a data: prefix) and box-downsample
 * to a small grayscale frame. jpeg-js is pure JS, so the exact same code
 * runs on device, on web, and under the Node verify suite.
 */
export function decodeJpegBase64ToGray(base64: string, targetWidth = ANALYSIS_WIDTH): GrayFrame {
  const bytes = base64ToBytes(base64);
  const decoded = decodeJpeg(bytes, {
    useTArray: true,
    formatAsRGBA: true,
    maxMemoryUsageInMB: 96,
  });
  return grayFromRgba(decoded.width, decoded.height, decoded.data, targetWidth);
}

/** RGBA → downsampled grayscale via box averaging. */
export function grayFromRgba(
  width: number,
  height: number,
  rgba: Uint8Array,
  targetWidth = ANALYSIS_WIDTH,
): GrayFrame {
  const outW = Math.max(1, Math.min(targetWidth, width));
  const outH = Math.max(1, Math.round((height / width) * outW));
  const out = new Uint8Array(outW * outH);
  for (let oy = 0; oy < outH; oy += 1) {
    const y0 = Math.floor((oy * height) / outH);
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * height) / outH));
    for (let ox = 0; ox < outW; ox += 1) {
      const x0 = Math.floor((ox * width) / outW);
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * width) / outW));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y += 1) {
        const rowBase = (y * width + x0) * 4;
        for (let x = 0; x < x1 - x0; x += 1) {
          const i = rowBase + x * 4;
          // Rec. 601 luma, integer math.
          sum += (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
          count += 1;
        }
      }
      out[oy * outW + ox] = count > 0 ? Math.round(sum / count) : 0;
    }
  }
  return { width: outW, height: outH, data: out };
}

/** Grayscale → JPEG base64 (no data: prefix). Used by the web sim + tests. */
export function encodeGrayToJpegBase64(frame: GrayFrame, quality = 82): string {
  const rgba = new Uint8Array(frame.width * frame.height * 4);
  for (let i = 0; i < frame.data.length; i += 1) {
    const v = frame.data[i];
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  const encoded = encodeJpeg({ width: frame.width, height: frame.height, data: rgba }, quality);
  return bytesToBase64(encoded.data);
}

// ── Lighting ──────────────────────────────────────────────────────────

export function assessLighting(frame: GrayFrame): LightingVerdict {
  const histogram = new Uint32Array(256);
  for (let i = 0; i < frame.data.length; i += 1) histogram[frame.data[i]] += 1;
  const total = frame.data.length;
  let sum = 0;
  for (let v = 0; v < 256; v += 1) sum += v * histogram[v];
  const mean = total > 0 ? sum / total : 0;
  const p15 = percentile(histogram, total, 0.15);
  const p85 = percentile(histogram, total, 0.85);
  if (mean <= DARK_MEAN_MAX || p85 <= DARK_P85_MAX) {
    return { kind: 'too_dark', meanLuma: mean };
  }
  if (mean >= BRIGHT_MEAN_MIN || p15 >= BRIGHT_P15_MIN) {
    return { kind: 'too_bright', meanLuma: mean };
  }
  return { kind: 'ok', meanLuma: mean };
}

function percentile(histogram: Uint32Array, total: number, frac: number): number {
  if (total === 0) return 0;
  const target = total * frac;
  let cumulative = 0;
  for (let v = 0; v < 256; v += 1) {
    cumulative += histogram[v];
    if (cumulative >= target) return v;
  }
  return 255;
}

// ── Subject (cross-shot differencing) ─────────────────────────────────

/**
 * Raw metrics of the between-shots changed region. Frames may differ
 * slightly in size (mixed real/reshoot sources); everything is compared
 * over the shared top-left region, which is where the subject lives.
 */
export function computeSubjectMetrics(frames: GrayFrame[]): SubjectMetrics {
  if (frames.length < 2) {
    return { changedFrac: 0, heightFrac: 0, topRow: -1, bottomRow: -1 };
  }
  const width = Math.min(...frames.map(f => f.width));
  const height = Math.min(...frames.map(f => f.height));
  let changed = 0;
  let topRow = -1;
  let bottomRow = -1;
  for (let y = 0; y < height; y += 1) {
    let rowChanged = 0;
    for (let x = 0; x < width; x += 1) {
      let maxDiff = 0;
      for (let a = 0; a < frames.length - 1; a += 1) {
        const va = frames[a].data[y * frames[a].width + x];
        for (let b = a + 1; b < frames.length; b += 1) {
          const vb = frames[b].data[y * frames[b].width + x];
          const d = va > vb ? va - vb : vb - va;
          if (d > maxDiff) maxDiff = d;
        }
      }
      if (maxDiff > DIFF_THRESHOLD) rowChanged += 1;
    }
    changed += rowChanged;
    if (rowChanged / width >= ROW_CHANGED_MIN_FRAC) {
      if (topRow === -1) topRow = y;
      bottomRow = y;
    }
  }
  const changedFrac = changed / (width * height);
  const heightFrac = topRow === -1 ? 0 : (bottomRow - topRow + 1) / height;
  return { changedFrac, heightFrac, topRow, bottomRow };
}

/**
 * Distance/presence verdict for the whole session (the patient stands on
 * one spot for all three shots, so this is scene-level, not per-shot).
 * Returns null when fewer than two decodable shots exist — with nothing to
 * compare, staying silent beats guessing.
 */
export function assessSubject(frames: GrayFrame[]): SubjectVerdict | null {
  if (frames.length < 2) return null;
  const metrics = computeSubjectMetrics(frames);
  if (metrics.changedFrac < PRESENCE_MIN_CHANGED_FRAC) {
    return { kind: 'not_detected', ...metrics };
  }
  if (metrics.heightFrac >= TOO_CLOSE_HEIGHT_FRAC || metrics.changedFrac >= TOO_CLOSE_CHANGED_FRAC) {
    return { kind: 'too_close', ...metrics };
  }
  if (metrics.heightFrac < TOO_FAR_HEIGHT_FRAC) {
    return { kind: 'too_far', ...metrics };
  }
  return { kind: 'ok', ...metrics };
}

// ── Session-level rollup ──────────────────────────────────────────────

export interface SessionAnalysis {
  lighting: Partial<Record<SessionAngle, LightingVerdict>>;
  subject: SubjectVerdict | null;
  /** Plain-language reshoot reasons per angle (empty array = clean shot). */
  reasons: Record<SessionAngle, string[]>;
  /** Angles the review screen should pre-tick for reshoot. */
  preselect: Record<SessionAngle, boolean>;
}

/**
 * Run every check over the session's shots. `angles` lists what SHOULD
 * exist — an angle without a decodable frame gets the missing-shot reason.
 * A subject-level problem (nobody in frame / too close / too far) applies
 * to every captured shot, because the fix is the patient's position, not
 * one photo.
 */
export function analyzeSession(
  angles: readonly SessionAngle[],
  frames: Partial<Record<SessionAngle, GrayFrame>>,
): SessionAnalysis {
  const lighting: Partial<Record<SessionAngle, LightingVerdict>> = {};
  const reasons = { front: [], side: [], back: [] } as Record<SessionAngle, string[]>;
  const preselect = { front: false, side: false, back: false } as Record<SessionAngle, boolean>;

  const present = angles.filter(angle => frames[angle] !== undefined);
  for (const angle of angles) {
    const frame = frames[angle];
    if (!frame) {
      reasons[angle].push(MISSING_SHOT_MESSAGE);
      preselect[angle] = true;
      continue;
    }
    const verdict = assessLighting(frame);
    lighting[angle] = verdict;
    if (verdict.kind !== 'ok') {
      reasons[angle].push(LIGHTING_MESSAGES[verdict.kind]);
      preselect[angle] = true;
    }
  }

  const subject = assessSubject(present.map(angle => frames[angle]!));
  if (subject && subject.kind !== 'ok') {
    for (const angle of present) {
      reasons[angle].push(SUBJECT_MESSAGES[subject.kind]);
      preselect[angle] = true;
    }
  }

  return { lighting, subject, reasons, preselect };
}
