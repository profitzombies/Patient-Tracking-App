/**
 * react-native stand-in for the offline-queue suite: the shared
 * onboarding-gate stub plus the handful of primitives the sync chip and its
 * detail sheet render (Modal, ActivityIndicator, useWindowDimensions).
 * Modal renders its children only while `visible`, like the real one.
 */
import React from 'react';

export * from '../onboarding-gate-stubs/react-native';

type AnyProps = Record<string, unknown> & { children?: React.ReactNode; visible?: boolean };

export function Modal(props: AnyProps): React.ReactElement | null {
  const { children, visible, ...rest } = props;
  if (visible === false) return null;
  return React.createElement('Modal', rest, children);
}

export function ActivityIndicator(props: AnyProps): React.ReactElement {
  return React.createElement('ActivityIndicator', props);
}

export function useWindowDimensions(): { width: number; height: number; scale: number; fontScale: number } {
  return { width: 393, height: 852, scale: 3, fontScale: 1 };
}
