/**
 * Node stand-in for react-native-svg used by the payments suites: every
 * primitive is a prop-preserving host element so the chart's paths, labels
 * and gradients can be inspected under react-test-renderer.
 */
import React from 'react';

function host(name: string) {
  const Component = (props: Record<string, unknown>) => React.createElement(name, props, props.children as React.ReactNode);
  Component.displayName = name;
  return Component;
}

export const Svg = host('Svg');
export default Svg;
export const Defs = host('Defs');
export const Line = host('Line');
export const LinearGradient = host('LinearGradient');
export const Path = host('Path');
export const Stop = host('Stop');
export const Text = host('SvgText');
export const Rect = host('Rect');
export const Circle = host('Circle');
export const G = host('G');
