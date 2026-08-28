/**
 * Phone-tilt readout for the guided session's setup step.
 *
 * The phone leans against a wall or bag on the floor, camera facing the
 * patient. DeviceMotion's rotation.beta is the pitch away from lying flat
 * (0° = flat on the floor, 90° = standing perfectly upright), so the sweet
 * spot for a floor-propped, slightly leaned-back phone is a wide band just
 * shy of vertical. The zone copy tells the patient which way to adjust in
 * plain words; the thresholds are exported so the verify suite pins them.
 *
 * expo-sensors has no web support, and some tablets lack the sensor — the
 * hook then reports 'unavailable' and the setup screen simply hides the
 * meter rather than showing a dead widget.
 */
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { DeviceMotion } from 'expo-sensors';

export type TiltZone = 'unavailable' | 'too_flat' | 'almost' | 'ready' | 'too_upright';

export const TILT_READY_MIN_DEG = 50;
export const TILT_READY_MAX_DEG = 86;
export const TILT_ALMOST_MIN_DEG = 30;

export const TILT_MESSAGES: Record<Exclude<TiltZone, 'unavailable'>, string> = {
  too_flat: 'Prop the phone up — it is lying too flat.',
  almost: 'Tilt the phone up a little more.',
  ready: 'Angle looks good.',
  too_upright: 'Lean the phone back just a touch.',
};

export function classifyTilt(degrees: number | null): TiltZone {
  if (degrees === null || !Number.isFinite(degrees)) return 'unavailable';
  const d = Math.abs(degrees);
  if (d < TILT_ALMOST_MIN_DEG) return 'too_flat';
  if (d < TILT_READY_MIN_DEG) return 'almost';
  if (d <= TILT_READY_MAX_DEG) return 'ready';
  return 'too_upright';
}

const UPDATE_INTERVAL_MS = 250;

export function useDeviceTilt(active: boolean): { zone: TiltZone; degrees: number | null } {
  const [degrees, setDegrees] = useState<number | null>(null);
  const [available, setAvailable] = useState<boolean | null>(Platform.OS === 'web' ? false : null);

  useEffect(() => {
    if (!active || Platform.OS === 'web') return;
    let cancelled = false;
    let subscription: { remove(): void } | null = null;
    (async () => {
      try {
        const ok = await DeviceMotion.isAvailableAsync();
        if (cancelled) return;
        setAvailable(ok);
        if (!ok) return;
        DeviceMotion.setUpdateInterval(UPDATE_INTERVAL_MS);
        subscription = DeviceMotion.addListener(measurement => {
          const beta = measurement.rotation?.beta;
          if (typeof beta === 'number' && Number.isFinite(beta)) {
            setDegrees(Math.abs((beta * 180) / Math.PI));
          }
        });
      } catch {
        if (!cancelled) setAvailable(false);
      }
    })();
    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [active]);

  if (available === false) return { zone: 'unavailable', degrees: null };
  return { zone: classifyTilt(degrees), degrees };
}
