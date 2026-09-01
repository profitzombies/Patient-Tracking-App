import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Redirect, Tabs } from 'expo-router';
import { useAppMode } from '@/context/AppModeContext';
import { usePatient } from '@/context/PatientContext';
import { PatientFabMenu } from '@/components/patient/PatientFabMenu';
import { PatientTabBar } from '@/components/patient/PatientTabBar';

/**
 * The five patient screens still live in a tab navigator — swapping between
 * them keeps each one's scroll position and state, and deep links into
 * /diary or /plan keep working — but the navigator draws no bar of its own.
 * Navigation is the floating row mounted below: the pill bar (Today, Diary,
 * Progress, Coach) and the corner launcher, which carries Library and Plan
 * at the top of its menu.
 */
function PatientTabs() {
  return (
    <Tabs
      screenOptions={{ headerShown: false }}
      tabBar={() => null}
    >
      <Tabs.Screen name="today" options={{ title: 'Today' }} />
      <Tabs.Screen name="diary" options={{ title: 'Diary' }} />
      <Tabs.Screen name="recipes" options={{ title: 'Library' }} />
      <Tabs.Screen name="progress" options={{ title: 'Progress' }} />
      <Tabs.Screen name="plan" options={{ title: 'Plan' }} />
    </Tabs>
  );
}

export default function PatientTabLayout() {
  const { mode, hydrated } = useAppMode();
  const { hydrated: patientHydrated } = usePatient();

  if (!hydrated || !patientHydrated) return null;
  if (mode !== 'patient') {
    return <Redirect href={mode === 'staff' ? '/' : '/patient-welcome'} />;
  }

  // The floating row mounts once here, beside the navigator, so every
  // patient screen shows the same bar + circle (mirrors the staff layout's
  // launcher mount in app/(tabs)/_layout.tsx).
  return (
    <View style={layoutStyles.container}>
      <PatientTabs />
      <PatientTabBar />
      <PatientFabMenu />
    </View>
  );
}

const layoutStyles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
