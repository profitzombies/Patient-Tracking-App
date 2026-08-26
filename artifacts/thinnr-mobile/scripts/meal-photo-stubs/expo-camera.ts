/**
 * Node stand-in for expo-camera: the suite scripts permission state, the
 * next capture result, and mount failures. CameraView renders as a bare
 * host element whose imperative takePictureAsync() the surface reaches
 * through its ref, exactly like the real component.
 */
import React from 'react';

export type CameraType = 'back' | 'front';

export interface StubPermission {
  granted: boolean;
  canAskAgain: boolean;
  status: 'undetermined' | 'granted' | 'denied';
}

export const cameraState = {
  /** Permission as first read by useCameraPermissions. */
  permission: { granted: true, canAskAgain: true, status: 'granted' } as StubPermission,
  /** What a requestPermission() call resolves (and updates the state) to. */
  requestOutcome: { granted: true, canAskAgain: true, status: 'granted' } as StubPermission,
  requestCount: 0,
  /** Next takePictureAsync result — or an Error to throw. */
  capture: { uri: 'file:///captured.jpg', width: 1200, height: 1600 } as
    | { uri: string; width: number; height: number }
    | Error,
  /** When set, a mounting CameraView reports this failure immediately. */
  mountError: null as { message: string } | null,
  /** How many CameraViews ever mounted (denied paths must stay at zero). */
  mounted: 0,
};

export function resetCameraStub(): void {
  cameraState.permission = { granted: true, canAskAgain: true, status: 'granted' };
  cameraState.requestOutcome = { granted: true, canAskAgain: true, status: 'granted' };
  cameraState.requestCount = 0;
  cameraState.capture = { uri: 'file:///captured.jpg', width: 1200, height: 1600 };
  cameraState.mountError = null;
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
  onMountError?: (event: { message: string }) => void;
}

export const CameraView = React.forwardRef(function CameraView(
  props: CameraViewProps,
  ref: React.Ref<unknown>,
) {
  React.useImperativeHandle(ref, () => ({
    async takePictureAsync(_options?: unknown) {
      if (cameraState.capture instanceof Error) throw cameraState.capture;
      return cameraState.capture;
    },
  }));
  const onMountError = props.onMountError;
  React.useEffect(() => {
    cameraState.mounted += 1;
    if (cameraState.mountError && onMountError) onMountError(cameraState.mountError);
    // Mount-only effect, mirroring the real camera's startup callback.
  }, [onMountError]);
  const { children, ...rest } = props;
  return React.createElement('CameraView', rest as Record<string, unknown>, children);
});
