/**
 * Node stand-in for expo-sensors (DeviceMotion only): the tilt hook
 * subscribes on native, so the stub records listeners and lets a scenario
 * feed rotation events by hand. The suite's RTR runs stay on the 'web'
 * platform path where the hook reports 'unavailable' and never subscribes.
 */
type MotionListener = (event: { rotation?: { beta?: number } }) => void;

export const motionState = {
  available: true,
  intervalMs: 0,
  listeners: [] as MotionListener[],
};

export const DeviceMotion = {
  async isAvailableAsync(): Promise<boolean> {
    return motionState.available;
  },
  setUpdateInterval(ms: number): void {
    motionState.intervalMs = ms;
  },
  addListener(listener: MotionListener): { remove(): void } {
    motionState.listeners.push(listener);
    return {
      remove(): void {
        const index = motionState.listeners.indexOf(listener);
        if (index >= 0) motionState.listeners.splice(index, 1);
      },
    };
  },
};
