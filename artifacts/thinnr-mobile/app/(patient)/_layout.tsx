import React from 'react';
import { Platform, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { Feather } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { isLiquidGlassAvailable } from 'expo-glass-effect';
import { Redirect, Tabs } from 'expo-router';
import { Icon, Label, NativeTabs } from 'expo-router/unstable-native-tabs';
import { SymbolView } from 'expo-symbols';
import { useAppMode } from '@/context/AppModeContext';
import { usePatient } from '@/context/PatientContext';
import { PatientFabMenu } from '@/components/patient/PatientFabMenu';

// iOS 26+ liquid glass native tabs
function NativeTabLayout() {
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="today">
        <Icon sf={{ default: 'sun.max', selected: 'sun.max.fill' }} />
        <Label>Today</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="diary">
        <Icon sf={{ default: 'book', selected: 'book.fill' }} />
        <Label>Diary</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="recipes">
        <Icon sf={{ default: 'square.grid.2x2', selected: 'square.grid.2x2.fill' }} />
        <Label>Library</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="progress">
        <Icon sf={{ default: 'chart.xyaxis.line', selected: 'chart.xyaxis.line' }} />
        <Label>Progress</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="plan">
        <Icon sf={{ default: 'list.bullet.rectangle', selected: 'list.bullet.rectangle.fill' }} />
        <Label>Plan</Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

/**
 * Heritage tab label: Inter label with the small orange underline tick on the
 * active tab (from the approved reference). Used by the classic (non-liquid-
 * glass) tab bar on Android, web, and older iOS.
 */
function HeritageTabLabel({
  label,
  focused,
  color,
}: {
  label: string;
  focused: boolean;
  color: string;
}) {
  const colors = useColors();
  return (
    <View style={heritageStyles.labelWrap}>
      <Text
        style={[
          heritageStyles.labelText,
          { color, fontFamily: focused ? 'Inter_600SemiBold' : 'Inter_500Medium' },
        ]}
      >
        {label}
      </Text>
      <View
        style={[
          heritageStyles.tick,
          { backgroundColor: focused ? colors.orange : 'transparent' },
        ]}
      />
    </View>
  );
}

const heritageStyles = StyleSheet.create({
  labelWrap: {
    alignItems: 'center',
  },
  labelText: {
    fontSize: 10,
  },
  tick: {
    height: 3,
    width: 16,
    borderRadius: 1.5,
    marginTop: 2,
  },
});

function ClassicTabLayout() {
  const colors = useColors();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const isIOS = Platform.OS === 'ios';
  const isWeb = Platform.OS === 'web';

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        headerShown: false,
        // The web canvas is always phone-width (WebFitShell), but react-
        // navigation's beside-icon switch reads the real browser frame via
        // getBoundingClientRect, which the shell's transform inflates on wide
        // panes — pin the iPhone label layout explicitly.
        ...(isWeb ? { tabBarLabelPosition: 'below-icon' as const } : {}),
        tabBarStyle: {
          position: 'absolute',
          backgroundColor: isIOS ? 'transparent' : colors.card,
          borderTopWidth: 1,
          borderTopColor: colors.border,
          elevation: 0,
          ...(isWeb ? { height: 84 } : {}),
        },
        tabBarBackground: () =>
          isIOS ? (
            <BlurView
              intensity={100}
              tint={isDark ? 'dark' : 'light'}
              style={StyleSheet.absoluteFill}
            />
          ) : isWeb ? (
            <View
              style={[
                StyleSheet.absoluteFill,
                { backgroundColor: colors.card },
              ]}
            />
          ) : null,
      }}
    >
      <Tabs.Screen
        name="today"
        options={{
          title: 'Today',
          tabBarAccessibilityLabel: 'Today',
          tabBarLabel: ({ focused, color }) => (
            <HeritageTabLabel label="Today" focused={focused} color={color} />
          ),
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="sun.max" tintColor={color} size={22} />
            ) : (
              <Feather name="sun" size={20} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="diary"
        options={{
          title: 'Diary',
          tabBarAccessibilityLabel: 'Diary',
          tabBarLabel: ({ focused, color }) => (
            <HeritageTabLabel label="Diary" focused={focused} color={color} />
          ),
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="book" tintColor={color} size={22} />
            ) : (
              <Feather name="book-open" size={20} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="recipes"
        options={{
          title: 'Library',
          tabBarAccessibilityLabel: 'Library',
          tabBarLabel: ({ focused, color }) => (
            <HeritageTabLabel label="Library" focused={focused} color={color} />
          ),
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="square.grid.2x2" tintColor={color} size={22} />
            ) : (
              <Feather name="grid" size={20} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="progress"
        options={{
          title: 'Progress',
          tabBarAccessibilityLabel: 'Progress',
          tabBarLabel: ({ focused, color }) => (
            <HeritageTabLabel label="Progress" focused={focused} color={color} />
          ),
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="chart.xyaxis.line" tintColor={color} size={22} />
            ) : (
              <Feather name="trending-down" size={20} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="plan"
        options={{
          title: 'Plan',
          tabBarAccessibilityLabel: 'Plan',
          tabBarLabel: ({ focused, color }) => (
            <HeritageTabLabel label="Plan" focused={focused} color={color} />
          ),
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="list.bullet.rectangle" tintColor={color} size={22} />
            ) : (
              <Feather name="clipboard" size={20} color={color} />
            ),
        }}
      />
    </Tabs>
  );
}

export default function PatientTabLayout() {
  const { mode, hydrated } = useAppMode();
  const { hydrated: patientHydrated } = usePatient();

  if (!hydrated || !patientHydrated) return null;
  if (mode !== 'patient') {
    return <Redirect href={mode === 'staff' ? '/' : '/persona'} />;
  }

  // The quick-actions FAB is a sibling of the tab navigator (same pattern
  // as the provider layout) so it floats over every patient tab.
  return (
    <View style={layoutStyles.container}>
      {isLiquidGlassAvailable() ? <NativeTabLayout /> : <ClassicTabLayout />}
      <PatientFabMenu />
    </View>
  );
}

const layoutStyles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
