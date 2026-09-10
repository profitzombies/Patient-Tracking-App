import React from 'react';

export function CameraView(props: Record<string, unknown>): React.ReactElement {
  return React.createElement('CameraView', props);
}
export function useCameraPermissions(): [{ granted: boolean }, () => Promise<void>] {
  return [{ granted: true }, async () => {}];
}
export const CameraType = { front: 'front', back: 'back' } as const;