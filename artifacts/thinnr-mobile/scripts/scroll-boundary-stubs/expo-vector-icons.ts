import React from 'react';

function iconHost(name: string) {
  return function Icon(props: Record<string, unknown>): React.ReactElement {
    return React.createElement(name, props);
  };
}

export const Feather = iconHost('Feather');
export const MaterialCommunityIcons = iconHost('MaterialCommunityIcons');
export const Ionicons = iconHost('Ionicons');
export const FontAwesome = iconHost('FontAwesome');