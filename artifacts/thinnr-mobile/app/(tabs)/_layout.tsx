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

// iOS 26+ liquid glass native tabs
function NativeTabLayout() {
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="index">
        <Icon sf={{ default: 'house', selected: 'house.fill' }} />
        <Label>Overview</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="patients">
        <Icon sf={{ default: 'person.2', selected: 'person.2.fill' }} />
        <Label>Patients</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="outcomes">
        <Icon sf={{ default: 'chart.bar', selected: 'chart.bar.fill' }} />
        <Label>Outcomes</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="leaderboard">
        <Icon sf={{ default: 'trophy', selected: 'trophy.fill' }} />
        <Label>Leaderboard</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="subscriptions">
        <Icon sf={{ default: 'shippingbox', selected: 'shippingbox.fill' }} />
        <Label>Subscriptions</Label>
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
        name="index"
        options={{
          title: 'Overview',
          tabBarAccessibilityLabel: 'Overview',
          headerShown: false,
          tabBarLabel: ({ focused, color }) => (
            <HeritageTabLabel label="Overview" focused={focused} color={color} />
          ),
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="house" tintColor={color} size={22} />
            ) : (
              <Feather name="home" size={20} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="patients"
        options={{
          title: 'Patients',
          tabBarAccessibilityLabel: 'Patients',
          headerShown: false,
          tabBarLabel: ({ focused, color }) => (
            <HeritageTabLabel label="Patients" focused={focused} color={color} />
          ),
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="person.2" tintColor={color} size={22} />
            ) : (
              <Feather name="users" size={20} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="outcomes"
        options={{
          title: 'Outcomes',
          tabBarAccessibilityLabel: 'Outcomes',
          headerShown: false,
          tabBarLabel: ({ focused, color }) => (
            <HeritageTabLabel label="Outcomes" focused={focused} color={color} />
          ),
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="chart.bar" tintColor={color} size={22} />
            ) : (
              <Feather name="bar-chart-2" size={20} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="leaderboard"
        options={{
          title: 'Leaderboard',
          tabBarAccessibilityLabel: 'Leaderboard',
          headerShown: false,
          tabBarLabel: ({ focused, color }) => (
            <HeritageTabLabel label="Leaderboard" focused={focused} color={color} />
          ),
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="trophy" tintColor={color} size={22} />
            ) : (
              <Feather name="award" size={20} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="subscriptions"
        options={{
          title: 'Subscriptions',
          tabBarAccessibilityLabel: 'Subscriptions',
          headerShown: false,
          tabBarLabel: ({ focused, color }) => (
            <HeritageTabLabel label="Subscriptions" focused={focused} color={color} />
          ),
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="shippingbox" tintColor={color} size={22} />
            ) : (
              <Feather name="package" size={20} color={color} />
            ),
        }}
      />
    </Tabs>
  );
}

export default function TabLayout() {
  const { mode, hydrated } = useAppMode();

  if (!hydrated) return null;
  if (mode !== 'staff') {
    return <Redirect href={mode === 'patient' ? '/today' : '/persona'} />;
  }

  if (isLiquidGlassAvailable()) {
    return <NativeTabLayout />;
  }
  return <ClassicTabLayout />;
}
