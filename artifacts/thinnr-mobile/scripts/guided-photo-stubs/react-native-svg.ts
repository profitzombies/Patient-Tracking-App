/**
 * Node stand-in for react-native-svg: every element renders as a bare
 * host node (the body outline in the guided session; the weight chart on
 * the Progress screen).
 */
import React from 'react';

type AnyProps = Record<string, unknown> & { children?: React.ReactNode };

function host(name: string) {
  function Host(props: AnyProps): React.ReactElement {
    const { children, ...rest } = props;
    return React.createElement(name, rest, children);
  }
  Host.displayName = name;
  return Host;
}

const Svg = host('Svg');
export default Svg;
export const Circle = host('Circle');
export const Ellipse = host('Ellipse');
export const Line = host('Line');
export const Path = host('Path');
export const Rect = host('Rect');
export const G = host('G');
export const Text = host('SvgText');
