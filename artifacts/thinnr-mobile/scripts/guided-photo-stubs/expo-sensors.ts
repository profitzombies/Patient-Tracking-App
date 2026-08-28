/**
 * Node stand-in for expo-sensors (DeviceMotion only — all the line-up tilt
 * loop uses). Scenarios script availability and permission, then push
 * motion measurements to whoever is listening.
 */
type MotionMeasurement = {
  rotation?: { alpha: number; beta: number; gamma: number };
  accelerationIncludingGravity?: { x: number; y: number; z: number };
};
type MotionListener = (measurement: MotionMeasurement) => void;

export const motionState = {
  available: true,
  permissionStatus: 'granted' as string,
  listeners: new Set<MotionListener>(),
  updateIntervals: [] as number[],
  /** Feed a rotation-only reading: `betaDegrees` is the pitch in degrees. */
  emitBetaDegrees(betaDegrees: number): void {
    const beta = (betaDegrees * Math.PI) / 180;
    for (const listener of [...motionState.listeners]) {
      listener({ rotation: { alpha: 0, beta, gamma: 0 } });
    }
  },
  /**
   * Feed a lean-back reading the way a real device reports it: gravity
   * vector in the y/z plane, plus a beta that saturates iOS-style (never
   * past 90°, so face-down and leaned-back betas read alike — the fold the
   * gravity math must resolve).
   */
  emitLean(leanDegrees: number): void {
    const rad = (leanDegrees * Math.PI) / 180;
    const beta = ((90 - Math.abs(leanDegrees)) * Math.PI) / 180;
    for (const listener of [...motionState.listeners]) {
      listener({
        rotation: { alpha: 0, beta, gamma: 0 },
        accelerationIncludingGravity: {
          x: 0,
          y: 9.81 * Math.cos(rad),
          z: 9.81 * Math.sin(rad),
        },
      });
    }
  },
  reset(): void {
    motionState.available = true;
    motionState.permissionStatus = 'granted';
    motionState.listeners.clear();
    motionState.updateIntervals.length = 0;
  },
};

export const DeviceMotion = {
  async isAvailableAsync(): Promise<boolean> {
    return motionState.available;
  },
  async requestPermissionsAsync(): Promise<{ status: string; granted: boolean }> {
    return {
      status: motionState.permissionStatus,
      granted: motionState.permissionStatus === 'granted',
    };
  },
  setUpdateInterval(ms: number): void {
    motionState.updateIntervals.push(ms);
  },
  addListener(listener: MotionListener): { remove(): void } {
    motionState.listeners.add(listener);
    return { remove: () => void motionState.listeners.delete(listener) };
  },
};
