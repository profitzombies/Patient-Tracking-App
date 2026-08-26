/**
 * Handoff between a food-photo entry point and the in-app camera screen
 * (app/food-camera).
 *
 * The camera is a full-screen ROUTE, not a component the entry points can
 * render inline, so a capture request travels module-level: the entry point
 * calls createFoodCameraRequest() and navigates to /food-camera; the screen
 * claims the pending request, runs the capture UI, and settles it with the
 * chosen shot (camera or library) or null when the patient closes without
 * one. The caller simply awaits the promise — its own blue use-photo
 * confirmation and the shared photo-prep pipeline stay exactly where they
 * were, so nothing here uploads or double-confirms.
 *
 * One request can be pending at a time: creating a new one settles a
 * still-pending predecessor with null (its screen was torn down some way
 * that skipped settling), and claiming is once-only so a re-mounted screen
 * cannot double-resolve. Settling is idempotent — the screen's unmount
 * cleanup can always settle(null) safely after a real result went through.
 */
import type { ImagePickerAsset } from 'expo-image-picker';

/** Where the settled photo came from — "Retake" relaunches the same source. */
export type FoodCameraSource = 'camera' | 'library';

export interface FoodCameraCapture {
  /** Raw picked/captured asset; the caller runs photo-prep on it. */
  asset: ImagePickerAsset;
  source: FoodCameraSource;
}

type Settle = (capture: FoodCameraCapture | null) => void;

let pending: Settle | null = null;

/**
 * Registers intent to capture and resolves with the patient's choice (null
 * when the camera screen closed without one). Call right before pushing
 * /food-camera.
 */
export function createFoodCameraRequest(): Promise<FoodCameraCapture | null> {
  pending?.(null);
  return new Promise<FoodCameraCapture | null>(resolve => {
    pending = resolve;
  });
}

export interface FoodCameraSession {
  /** Resolves the caller's promise; extra calls are no-ops. */
  settle: Settle;
}

/**
 * Claims the pending request (once). Returns null when nothing is pending —
 * the screen was reached without a caller (deep link, refresh) and should
 * bail out instead of capturing into the void.
 */
export function claimFoodCameraRequest(): FoodCameraSession | null {
  const resolve = pending;
  if (!resolve) return null;
  pending = null;
  let settled = false;
  return {
    settle(capture) {
      if (settled) return;
      settled = true;
      resolve(capture);
    },
  };
}
