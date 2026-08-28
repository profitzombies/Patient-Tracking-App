/**
 * Node stand-in for react-native-svg: bare host elements so BodyOutline
 * renders under react-test-renderer (its testID stays queryable).
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

export const Svg = host('Svg');
export const Circle = host('Circle');
export const Ellipse = host('Ellipse');
export const Path = host('Path');
export const Rect = host('Rect');
export const Line = host('Line');
export const G = host('G');
export default Svg;
