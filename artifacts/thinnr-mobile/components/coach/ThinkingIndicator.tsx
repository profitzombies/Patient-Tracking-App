/**
 * Animated "coach is thinking" cue for the reply bubble.
 *
 * Shown while the reasoning model is still silent (no revealed text yet), in
 * place of the old static "Thinking…" label. Three small squares pulse in a
 * traveling wave — Cobalt Ledger styling keeps the geometry square (no
 * circles, no emoji spinners) and the motion subtle.
 */
import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

const SQUARE_COUNT = 3;
/** Rise, fall, and rest per cycle; the stagger keeps a clean traveling wave. */
const PULSE_MS = 260;
const RECOVER_MS = 340;
const REST_MS = 220;
const STAGGER_MS = 170;
const DIM_OPACITY = 0.25;

function PulsingSquare({ order, color }: { order: number; color: string }) {
  const pulse = useSharedValue(0);

  useEffect(() => {
    pulse.value = withDelay(
      order * STAGGER_MS,
      withRepeat(
        withSequence(
          withTiming(1, { duration: PULSE_MS, easing: Easing.out(Easing.quad) }),
          withTiming(0, { duration: RECOVER_MS, easing: Easing.in(Easing.quad) }),
          withTiming(0, { duration: REST_MS }),
        ),
        -1,
      ),
    );
    return () => cancelAnimation(pulse);
  }, [order, pulse]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: DIM_OPACITY + pulse.value * (1 - DIM_OPACITY),
  }));

  return <Animated.View style={[styles.square, { backgroundColor: color }, animatedStyle]} />;
}

export function ThinkingIndicator({ color }: { color: string }) {
  return (
    <View
      testID="coach-thinking"
      accessible
      accessibilityLabel="Coach is thinking"
      style={styles.row}
    >
      {Array.from({ length: SQUARE_COUNT }, (_, order) => (
        <PulsingSquare key={order} order={order} color={color} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    // Match the line height of bubble text so the bubble doesn't jump when
    // the first revealed characters replace the indicator.
    height: 21,
  },
  square: {
    width: 6,
    height: 6,
  },
});
