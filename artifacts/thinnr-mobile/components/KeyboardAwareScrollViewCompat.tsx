import { Platform, ScrollView, ScrollViewProps } from 'react-native';
import {
  KeyboardAwareScrollView,
  KeyboardAwareScrollViewProps,
} from 'react-native-keyboard-controller';
import { scrollBoundaryProps, type ScrollBoundary } from './ui/scrollBoundary';

type Props = KeyboardAwareScrollViewProps & ScrollViewProps & { scrollBoundary?: ScrollBoundary };

export function KeyboardAwareScrollViewCompat({
  children,
  keyboardShouldPersistTaps = 'handled',
  scrollBoundary,
  ...props
}: Props) {
  const { style, ...boundary } = scrollBoundaryProps(Platform.OS, { ...props, scrollBoundary });
  const scrollStyle = style ? [props.style, style] : props.style;
  if (Platform.OS === 'web') {
    return (
      <ScrollView
        keyboardShouldPersistTaps={keyboardShouldPersistTaps}
        {...props}
        {...boundary}
        style={scrollStyle}
      >
        {children}
      </ScrollView>
    );
  }
  return (
    <KeyboardAwareScrollView
      keyboardShouldPersistTaps={keyboardShouldPersistTaps}
      {...props}
      {...boundary}
      style={scrollStyle}
    >
      {children}
    </KeyboardAwareScrollView>
  );
}
