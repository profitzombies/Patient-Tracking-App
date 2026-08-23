import React from 'react';
import { Stack } from 'expo-router';
import { useColors } from '@/hooks/useColors';

export default function OnboardingLayout() {
  const colors = useColors();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: 'slide_from_right',
        // Paper background behind the slide transition — avoids a white
        // flash between steps on the Heritage palette.
        contentStyle: { backgroundColor: colors.background },
      }}
    />
  );
}
