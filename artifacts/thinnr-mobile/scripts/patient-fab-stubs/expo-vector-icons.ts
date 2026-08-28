/**
 * Node stand-in for @expo/vector-icons: icons render as bare host elements.
 * Both families the shared FabMenu can draw are covered (Feather for most
 * glyphs, MaterialCommunityIcons for barcode-scan).
 */
import React from 'react';

export function Feather(props: Record<string, unknown>): React.ReactElement {
  return React.createElement('Feather', props);
}

export function MaterialCommunityIcons(props: Record<string, unknown>): React.ReactElement {
  return React.createElement('MaterialCommunityIcons', props);
}
