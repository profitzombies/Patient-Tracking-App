import React, { forwardRef } from 'react';
import {
  TextInput as NativeTextInput,
  type TextInputProps,
  type TextStyle,
} from 'react-native';

/**
 * Typography contract for ordinary editable text on native and RN web.
 *
 * Keep this style last: callers may customize the field, but cannot
 * accidentally reintroduce tracked editable text.
 */
export const ORDINARY_EDITABLE_TEXT: TextStyle = Object.freeze({
  letterSpacing: 0,
});

export const OrdinaryTextInput = forwardRef<NativeTextInput, TextInputProps>(
  function OrdinaryTextInput({ style, ...props }, ref) {
    return (
      <NativeTextInput
        ref={ref}
        {...props}
        style={[style, ORDINARY_EDITABLE_TEXT]}
      />
    );
  },
);
