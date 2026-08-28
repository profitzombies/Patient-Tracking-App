/** Node stand-in for expo-symbols: SF Symbols as bare host elements. */
import React from 'react';

export function SymbolView(props: Record<string, unknown>): React.ReactElement {
  return React.createElement('SymbolView', props);
}
