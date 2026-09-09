import React, { forwardRef, useImperativeHandle } from 'react';

let resolvePending: ((photo: { uri: string; width: number; height: number }) => void) | null = null;

export const CameraView = forwardRef(function CameraView(_props, ref) {
  useImperativeHandle(ref, () => ({
    takePictureAsync: () => new Promise(resolve => {
      resolvePending = resolve;
    }),
  }));
  return React.createElement('CameraView');
});

export function resolvePicture(uri = 'file:///app-camera-raw.jpg'): void {
  resolvePending?.({ uri, width: 100, height: 200 });
}

export function useCameraPermissions() {
  return [{ granted: true, status: 'granted', canAskAgain: false }, async () => ({ granted: true })] as const;
}