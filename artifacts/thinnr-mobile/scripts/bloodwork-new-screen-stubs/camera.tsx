import React from 'react';
import { Pressable, Text } from 'react-native';

export function BloodworkCamera(props: {
  visible: boolean;
  onCaptureStart: () => unknown;
  onCapture: (uri: string, width: number, height: number, scope: unknown) => void;
}) {
  if (!props.visible) return null;
  return React.createElement(
    Pressable,
    {
      testID: 'mounted-camera-capture',
      onPress: () => {
        const scope = props.onCaptureStart();
        if (scope) props.onCapture('file:///camera.jpg', 100, 100, scope);
      },
    },
    React.createElement(Text, null, 'Capture'),
  );
}