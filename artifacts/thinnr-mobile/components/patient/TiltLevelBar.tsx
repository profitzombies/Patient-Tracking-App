/**
 * TiltLevelBar — the huge vertical level rendered over the live camera
 * preview during line-up. The indicator tracks the CONTINUOUS smoothed
 * lean angle from the motion sensor as an Animated value: sub-degree
 * resolution, lightly eased between samples, never stepping through a
 * handful of positions. Up means more lean-back. The tight green band
 * marks the 12–18° ready window a floor-propped phone should rest in;
 * while every line-up check holds green, the band fills with the
 * steady-gate progress so the patient can see the countdown approaching.
 */
import React, { useState } from 'react';
import { Animated, Platform, StyleSheet, Text, View } from 'react-native';
import {
  TILT_BAR_BOTTOM_DEG,
  TILT_BAR_TOP_DEG,
  TILT_READY_MAX_DEG,
  TILT_READY_MIN_DEG,
  classifyLean,
  leanToBarFraction,
} from '@/lib/tilt';

const READY_GREEN = '#7FD8A4';
const TRACK_BG = 'rgba(12, 18, 26, 0.44)';
const TRACK_BORDER = 'rgba(255, 255, 255, 0.38)';

type LeanAnimatedValue = InstanceType<typeof Animated.Value>;

interface TiltLevelBarProps {
  /** Continuous smoothed lean (degrees) driving the indicator position. */
  leanAnim: LeanAnimatedValue;
  /** Latest lean sample for zone color + readout; null hides the bar. */
  leanDeg: number | null;
  /** 0–1 steady-gate progress shown inside the ready band. */
  holdProgress: number;
  /** True while every line-up check is green (tilt, framing, light). */
  holdActive: boolean;
}

export function TiltLevelBar({ leanAnim, leanDeg, holdProgress, holdActive }: TiltLevelBarProps) {
  const [trackHeight, setTrackHeight] = useState(0);
  if (leanDeg === null) return null;

  const inBand = classifyLean(leanDeg) === 'ready';
  const bandTop = leanToBarFraction(TILT_READY_MAX_DEG);
  const bandBottom = leanToBarFraction(TILT_READY_MIN_DEG);
  const translateY = leanAnim.interpolate({
    inputRange: [TILT_BAR_BOTTOM_DEG, TILT_BAR_TOP_DEG],
    outputRange: [trackHeight, 0],
    extrapolate: 'clamp',
  });

  return (
    <View pointerEvents="none" style={styles.wrap} testID="guided-level-bar">
      <View
        style={[styles.track, inBand && styles.trackReady]}
        onLayout={event => setTrackHeight(event.nativeEvent.layout.height)}
      >
        <View
          style={[
            styles.band,
            {
              top: `${Math.round(bandTop * 10000) / 100}%`,
              height: `${Math.round((bandBottom - bandTop) * 10000) / 100}%`,
              borderColor: inBand ? READY_GREEN : 'rgba(127, 216, 164, 0.65)',
              backgroundColor: inBand ? 'rgba(127, 216, 164, 0.22)' : 'rgba(127, 216, 164, 0.10)',
            },
          ]}
        >
          {holdActive && holdProgress > 0 ? (
            <View
              testID="guided-hold-progress"
              style={[styles.holdFill, { width: `${Math.round(Math.min(1, holdProgress) * 1000) / 10}%` }]}
            />
          ) : null}
        </View>
      </View>
      {trackHeight > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.indicator,
            { transform: [{ translateY }] },
            inBand ? styles.indicatorReady : null,
          ]}
        />
      ) : null}
      <View style={styles.readout}>
        <Text style={styles.readoutText}>{`${leanDeg.toFixed(1)}°`}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // NOTE: never alignSelf-center an absolutely positioned box — RN-web turns
  // that into CSS align-self, which swaps the top/bottom stretch for block-axis
  // centering and collapses the wrap to content height. Center with insets.
  wrap: {
    position: 'absolute',
    top: '20%',
    bottom: '23%',
    left: '50%',
    marginLeft: -44,
    width: 88,
    alignItems: 'center',
  },
  track: {
    alignSelf: 'center',
    width: 64,
    flexGrow: 1,
    flexShrink: 1,
    borderRadius: 32,
    borderWidth: 1.5,
    borderColor: TRACK_BORDER,
    backgroundColor: TRACK_BG,
    overflow: 'hidden',
  },
  trackReady: {
    borderColor: 'rgba(127, 216, 164, 0.9)',
  },
  band: {
    position: 'absolute',
    left: 0,
    right: 0,
    borderTopWidth: 2,
    borderBottomWidth: 2,
    overflow: 'hidden',
  },
  holdFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(127, 216, 164, 0.5)',
  },
  // Sits over the track's top edge; translateY carries it to the live angle.
  indicator: {
    position: 'absolute',
    top: -7,
    left: 0,
    width: 88,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#FFFFFF',
    borderWidth: 1.5,
    borderColor: 'rgba(16, 22, 31, 0.5)',
  },
  indicatorReady: {
    backgroundColor: READY_GREEN,
    borderColor: 'rgba(46, 125, 83, 0.9)',
    // RN-web wants the CSS shorthand; native takes the shadow trio.
    ...(Platform.OS === 'web'
      ? ({ boxShadow: '0 0 16px rgba(127, 216, 164, 0.85)' } as object)
      : {
          shadowColor: READY_GREEN,
          shadowOpacity: 0.9,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 0 },
        }),
  },
  readout: {
    marginTop: 8,
    backgroundColor: 'rgba(16, 22, 31, 0.55)',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  readoutText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontFamily: 'Inter_700Bold',
    fontVariant: ['tabular-nums'],
  },
});
