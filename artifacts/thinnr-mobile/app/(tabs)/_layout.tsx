/**
 * Provider (staff) section layout.
 *
 * Navigation is the floating bottom-right launcher (ProviderFabMenu) — the
 * Slack-style FAB that pops out a menu of destinations — instead of a
 * full-width bottom tab bar. The Tabs navigator stays underneath for its
 * routing and per-screen state (each destination keeps its scroll position
 * and URL), but its bar never renders: the FAB is the only chrome, so
 * screens get the full height. The old liquid-glass native tabs went with
 * the bar — one navigation surface on every platform.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Redirect, Tabs } from 'expo-router';
import { ProviderFabMenu } from '@/components/provider/ProviderFabMenu';
import { useAppMode } from '@/context/AppModeContext';

export default function TabLayout() {
  const { mode, hydrated } = useAppMode();

  if (!hydrated) return null;
  if (mode !== 'staff') {
    return <Redirect href={mode === 'patient' ? '/today' : '/persona'} />;
  }

  return (
    <View style={styles.container}>
      <Tabs tabBar={() => null} screenOptions={{ headerShown: false }}>
        <Tabs.Screen name="index" options={{ title: 'Overview' }} />
        <Tabs.Screen name="patients" options={{ title: 'Patients' }} />
        <Tabs.Screen name="outcomes" options={{ title: 'Outcomes' }} />
        <Tabs.Screen name="leaderboard" options={{ title: 'Leaderboard' }} />
        <Tabs.Screen name="subscriptions" options={{ title: 'Subscriptions' }} />
        <Tabs.Screen name="training" options={{ title: 'Training' }} />
      </Tabs>
      <ProviderFabMenu />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
