/** Node stand-in for expo-image: the preview photo as a bare host element. */
import React from 'react';

export function Image(props: Record<string, unknown>): React.ReactElement {
  return React.createElement('ExpoImage', props);
}
