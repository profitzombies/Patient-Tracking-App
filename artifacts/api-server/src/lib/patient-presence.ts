/**
 * App-presence recorder.
 *
 * Every authenticated patient request passes through `resolvePatient`; that
 * choke point calls `notePatientPresence` so simply opening the app (which
 * always fetches something, or hits the explicit heartbeat route) marks the
 * patient as an active app user for their local day. The write is
 *
 *   - throttled in memory: one upsert per patient per PRESENCE_THROTTLE
 *     window, so a busy screen never turns into a write storm;
 *   - fire-and-forget: it never delays or fails the request it rides on.
 *     Failures are logged and the throttle slot is released so the next
 *     request retries;
 *   - bounded: the throttle map is swept so idle patients fall out of it.
 *
 * The local day itself is derived server-side by the `patient_app_presence_touch`
 * RPC from the patient's profile timezone; the client only contributes the
 * platform hint the sign-in ledger already understands (`x-thinnr-platform`).
 */
import { platformOf, type Platform } from "../security/device";
import { logger } from "./logger";
import { supabaseAdmin } from "./supabase-admin";

function envSeconds(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Minimum gap between two presence writes for one patient (seconds). */
export const PRESENCE_THROTTLE_SECONDS = envSeconds("PATIENT_PRESENCE_THROTTLE_SECONDS", 180);
const SWEEP_EVERY = 500;
const MAX_TRACKED = 50_000;

export interface PresenceThrottle {
  /** True when a write should happen now; reserves the slot when it does. */
  claim(patientId: string, nowMs?: number): boolean;
  /** Give the slot back (after a failed write) so the next request retries. */
  release(patientId: string): void;
  size(): number;
}

export function createPresenceThrottle(windowMs: number): PresenceThrottle {
  const lastWrite = new Map<string, number>();
  let claims = 0;
  const sweep = (nowMs: number) => {
    for (const [id, at] of lastWrite) {
      if (nowMs - at >= windowMs) lastWrite.delete(id);
    }
    if (lastWrite.size > MAX_TRACKED) {
      // Pathological fan-out: drop the oldest half rather than grow forever.
      const entries = [...lastWrite.entries()].sort((a, b) => a[1] - b[1]);
      for (const [id] of entries.slice(0, Math.floor(entries.length / 2))) lastWrite.delete(id);
    }
  };
  return {
    claim(patientId, nowMs = Date.now()) {
      const previous = lastWrite.get(patientId);
      if (previous !== undefined && nowMs - previous < windowMs) return false;
      lastWrite.set(patientId, nowMs);
      claims += 1;
      if (claims % SWEEP_EVERY === 0) sweep(nowMs);
      return true;
    },
    release(patientId) {
      lastWrite.delete(patientId);
    },
    size: () => lastWrite.size,
  };
}

const throttle = createPresenceThrottle(PRESENCE_THROTTLE_SECONDS * 1000);

export interface PresenceTouchResult {
  localDay: string;
  firstTouchToday: boolean;
}

/** Write one presence touch now (used by the heartbeat route and the recorder). */
export async function touchPatientPresence(patientId: string, platform: Platform): Promise<PresenceTouchResult> {
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/patient_app_presence_touch", {
    p_patient_id: patientId,
    p_platform: platform,
  });
  if (result.status >= 300 || !Array.isArray(result.json) || result.json.length === 0) {
    throw new Error(`presence touch failed (${result.status})`);
  }
  const row = result.json[0] as { local_day?: unknown; first_touch_today?: unknown };
  return {
    localDay: typeof row.local_day === "string" ? row.local_day.slice(0, 10) : "",
    firstTouchToday: row.first_touch_today === true,
  };
}

export interface NotePresenceDeps {
  throttle?: PresenceThrottle;
  touch?: (patientId: string, platform: Platform) => Promise<unknown>;
  now?: () => number;
}

/**
 * Record that this patient's app is in use. Returns true when a write was
 * started (callers never await it; tests use the return value).
 */
export function notePatientPresence(
  patientId: string,
  headers: Record<string, unknown>,
  deps: NotePresenceDeps = {},
): boolean {
  const gate = deps.throttle ?? throttle;
  if (!gate.claim(patientId, deps.now?.())) return false;
  const write = deps.touch ?? touchPatientPresence;
  void write(patientId, platformOf(headers)).catch((error: unknown) => {
    gate.release(patientId);
    logger.warn({ err: error, patientId }, "patient presence write failed");
  });
  return true;
}
