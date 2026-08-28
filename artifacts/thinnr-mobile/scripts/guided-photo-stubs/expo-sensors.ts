/**
 * Node stand-in for expo-sensors (DeviceMotion only — all the tilt meter
 * uses). Scenarios script availability and permission, then push rotation
 * measurements to whoever is listening.
 */
type MotionMeasurement = { rotation?: { alpha: number; beta: number; gamma: number } };
type MotionListener = (measurement: MotionMeasurement) => void;

export const motionState = {
  available: true,
  permissionStatus: 'granted' as string,
  listeners: new Set<MotionListener>(),
  updateIntervals: [] as number[],
  /** Feed a tilt reading: `betaDegrees` is the phone's pitch in degrees. */
  emitBetaDegrees(betaDegrees: number): void {
    const beta = (betaDegrees * Math.PI) / 180;
    for (const listener of [...motionState.listeners]) {
      listener({ rotation: { alpha: 0, beta, gamma: 0 } });
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
