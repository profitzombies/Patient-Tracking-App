/** Node stand-in for @expo/vector-icons: icons render as bare host elements. */
import React from 'react';

export function Feather(props: Record<string, unknown>): React.ReactElement {
  return React.createElement('Feather', props);
}
