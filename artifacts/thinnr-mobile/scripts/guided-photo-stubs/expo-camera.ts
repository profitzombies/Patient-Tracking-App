/**
 * Node stand-in for expo-camera for the guided-photos suite. Unlike the
 * meal-photo stub, captures route through a scriptable HANDLER (the
 * positioning loop takes a throwaway probe still roughly once a second,
 * then the real capture fires at countdown zero — one scenario needs a
 * sequence of different results, distinguished by the options the caller
 * passed), and a mounting CameraView reports readiness through
 * onCameraReady the way the real one does.
 */
import React from 'react';

export interface StubPermission {
  granted: boolean;
  canAskAgain: boolean;
  status: 'undetermined' | 'granted' | 'denied';
}

export type StubCaptureResult = { uri: string; width: number; height: number; base64?: string };

export const cameraState = {
  /** Permission as first read by useCameraPermissions. */
  permission: { granted: true, canAskAgain: true, status: 'granted' } as StubPermission,
  /** What a requestPermission() call resolves (and updates the state) to. */
  requestOutcome: { granted: true, canAskAgain: true, status: 'granted' } as StubPermission,
  requestCount: 0,
  /** Whether a mounting camera fires onCameraReady. */
  ready: true,
  mounted: 0,
  /** Every takePictureAsync options object, in call order. */
  calls: [] as Array<Record<string, unknown>>,
  /** Scripted capture handler — scenarios swap this. Throw to fail. */
  handler: ((_options: Record<string, unknown>) => ({
    uri: 'data:image/jpeg;base64,QkFTRQ==',
    width: 1200,
    height: 1600,
  })) as (options: Record<string, unknown>) => StubCaptureResult | Promise<StubCaptureResult>,
};

export function resetCameraStub(): void {
  cameraState.permission = { granted: true, canAskAgain: true, status: 'granted' };
  cameraState.requestOutcome = { granted: true, canAskAgain: true, status: 'granted' };
  cameraState.requestCount = 0;
  cameraState.ready = true;
  cameraState.mounted = 0;
  cameraState.calls = [];
  cameraState.handler = () => ({
    uri: 'data:image/jpeg;base64,QkFTRQ==',
    width: 1200,
    height: 1600,
  });
}

export function useCameraPermissions(): [StubPermission, () => Promise<StubPermission>] {
  const [permission, setPermission] = React.useState(cameraState.permission);
  const request = React.useCallback(async () => {
    cameraState.requestCount += 1;
    cameraState.permission = cameraState.requestOutcome;
    setPermission(cameraState.requestOutcome);
    return cameraState.requestOutcome;
  }, []);
  return [permission, request];
}

interface CameraViewProps extends Record<string, unknown> {
  children?: React.ReactNode;
  onCameraReady?: () => void;
}

export const CameraView = React.forwardRef(function CameraView(
  props: CameraViewProps,
  ref: React.Ref<unknown>,
) {
  React.useImperativeHandle(ref, () => ({
    async takePictureAsync(options?: Record<string, unknown>) {
      cameraState.calls.push(options ?? {});
      return cameraState.handler(options ?? {});
    },
  }));
  const onCameraReady = props.onCameraReady;
  React.useEffect(() => {
    cameraState.mounted += 1;
    if (!cameraState.ready || !onCameraReady) return;
    // The real camera goes ready asynchronously after mount.
    const timer = setTimeout(() => onCameraReady(), 0);
    return () => clearTimeout(timer);
  }, [onCameraReady]);
  const { children, ...rest } = props;
  return React.createElement('CameraView', rest as Record<string, unknown>, children);
});
