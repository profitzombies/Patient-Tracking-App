import React from 'react';

function svgHost(name: string) {
  return function SvgHost(props: Record<string, unknown>): React.ReactElement {
    return React.createElement(name, props);
  };
}

export default svgHost('Svg');
export const Path = svgHost('Path');
export const Circle = svgHost('Circle');
export const Line = svgHost('Line');
export const Rect = svgHost('Rect');
export const G = svgHost('G');
export const Text = svgHost('SvgText');