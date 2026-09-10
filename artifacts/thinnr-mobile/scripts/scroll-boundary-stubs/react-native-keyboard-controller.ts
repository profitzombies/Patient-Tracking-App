import React from 'react';

export type KeyboardAwareScrollViewProps = Record<string, unknown>;

const KeyboardAwareScrollViewHost = React.forwardRef<unknown, { children?: React.ReactNode } & Record<string, unknown>>(
  function KeyboardAwareScrollViewHost({ children, ...props }, ref) {
    React.useImperativeHandle(ref, () => ({ host: 'KeyboardAwareScrollView' }), []);
    return React.createElement('KeyboardAwareScrollView', props, children);
  },
);

export const KeyboardAwareScrollView = KeyboardAwareScrollViewHost;

export function KeyboardStickyView(props: { children?: React.ReactNode }): React.ReactElement {
  return React.createElement('KeyboardStickyView', null, props.children);
}

export const KeyboardEvents = {
  addListener(
    _event: string,
    _handler: (payload: { height: number; duration: number }) => void,
  ) {
    return { remove() {} };
  },
};