/**
 * Deterministic simulated shots for the guided session's web preview.
 *
 * The workspace preview runs in a sandboxed desktop iframe where the real
 * front camera is unavailable or blocked, so on web the session renders a
 * simulated feed and "captures" synthetic frames instead — clearly labeled
 * in the UI. The frames are drawn as grayscale (mid-gray room, darker
 * figure whose silhouette width varies per angle, exactly like a person
 * rotating in place) and encoded through the same jpeg-js pipeline real
 * shots go through, so the demo exercises the REAL no-AI analysis path and
 * lands on clean verdicts.
 */
import {
  encodeGrayToJpegBase64,
  type GrayFrame,
} from '@/lib/photo-analysis';
import type { SessionAngle } from '@/lib/progress-session';

export const SIM_FRAME_WIDTH = 384;
export const SIM_FRAME_HEIGHT = 512;

/** Silhouette half-widths (px at 384-wide) — a side profile is narrower. */
const HALF_WIDTH: Record<SessionAngle, number> = {
  front: 58,
  side: 34,
  back: 58,
};

/** Draw one synthetic "room + person at six feet" frame. */
export function buildSimulatedGrayFrame(angle: SessionAngle): GrayFrame {
  const w = SIM_FRAME_WIDTH;
  const h = SIM_FRAME_HEIGHT;
  const data = new Uint8Array(w * h);

  // Room: soft vertical gradient, brighter toward the top (a lit wall),
  // with a slightly darker floor band.
  for (let y = 0; y < h; y += 1) {
    const base = 158 - Math.round((y / h) * 26);
    for (let x = 0; x < w; x += 1) {
      data[y * w + x] = base;
    }
  }

  // Person: a rounded dark column centered horizontally, occupying about
  // 78% of the frame height — the "right distance" the checks expect.
  const top = Math.round(h * 0.11);
  const bottom = Math.round(h * 0.89);
  const centerX = Math.round(w / 2);
  const half = HALF_WIDTH[angle];
  const headRadius = Math.round(half * 0.52);
  const headCenterY = top + headRadius;
  const shouldersY = headCenterY + headRadius + Math.round(h * 0.015);

  for (let y = top; y <= bottom; y += 1) {
    let rowHalf: number;
    if (y < shouldersY) {
      // Head: circle around headCenterY.
      const dy = y - headCenterY;
      const inside = headRadius * headRadius - dy * dy;
      rowHalf = inside > 0 ? Math.round(Math.sqrt(inside)) : 0;
    } else {
      // Torso→legs: gentle taper.
      const t = (y - shouldersY) / Math.max(1, bottom - shouldersY);
      rowHalf = Math.round(half * (1 - 0.28 * t));
    }
    if (rowHalf <= 0) continue;
    const x0 = Math.max(0, centerX - rowHalf);
    const x1 = Math.min(w - 1, centerX + rowHalf);
    for (let x = x0; x <= x1; x += 1) {
      data[y * w + x] = 72;
    }
  }

  return { width: w, height: h, data };
}

/** JPEG data URI for one simulated capture. */
export function buildSimulatedShotDataUri(angle: SessionAngle): string {
  const frame = buildSimulatedGrayFrame(angle);
  return `data:image/jpeg;base64,${encodeGrayToJpegBase64(frame, 85)}`;
}
