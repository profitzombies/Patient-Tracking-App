/**
 * PatientTabBar — the floating pill bar patients navigate from.
 *
 * A Heritage capsule floats in the bottom gutter holding the four screens
 * patients open daily, with the corner launcher (PatientFabMenu) sitting
 * immediately to its right as part of the same floating row — pill, gap,
 * circle. The two are laid out from one shared shelf (constants/layout) so
 * the bar can never grow under the circle.
 *
 * Four destinations, not the old five: Today (the day's numbers), Diary
 * (the log itself), Progress (the payoff), and Coach — THINNR's own thing,
 * promoted out of the small hero icon it used to hide behind. Library and
 * Plan are reference material read now and then, so they moved to the top
 * of the launcher's menu instead of spending a permanent slot here.
 *
 * Coach is a pushed screen rather than a tab (it keeps its own back
 * button), so its button pushes while the other three tab-navigate and
 * skip re-navigating when already there. A hand-rolled bar owes its own
 * accessibility: every button carries an explicit role, name, and selected
 * state, because a custom label silently drops the name react-navigation
 * would otherwise supply.
 */
import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { usePathname, useRouter, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import {
  PATIENT_BAR_HEIGHT,
  PATIENT_BAR_SIDE,
  patientBarBottom,
  patientBarRightInset,
} from '@/constants/layout';

const BAR_SHADOW = '0 10px 26px rgba(23, 32, 46, 0.18)';

interface BarItem {
  key: string;
  label: string;
  /** SF Symbol on iOS, Feather everywhere else — as the old bar did. */
  sf: SymbolViewProps['name'];
  feather: keyof typeof Feather.glyphMap;
  href: Href;
  /** Tabs swap in place; the coach chat stacks over them. */
  kind: 'navigate' | 'push';
}

const ITEMS: BarItem[] = [
  { key: 'today', label: 'Today', sf: 'sun.max', feather: 'sun', href: '/today', kind: 'navigate' },
  { key: 'diary', label: 'Diary', sf: 'book', feather: 'book-open', href: '/diary', kind: 'navigate' },
  {
    key: 'progress',
    label: 'Progress',
    sf: 'chart.xyaxis.line',
    feather: 'trending-down',
    href: '/progress',
    kind: 'navigate',
  },
  {
    key: 'coach',
    label: 'Coach',
    sf: 'message',
    feather: 'message-circle',
    href: '/coach-chat',
    kind: 'push',
  },
];

export function PatientTabBar() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pathname = usePathname();
  const isIOS = Platform.OS === 'ios';

  const press = (item: BarItem) => {
    Haptics.selectionAsync();
    if (item.kind === 'push') {
      router.push(item.href);
      return;
    }
    if (pathname !== item.href) router.navigate(item.href);
  };

  return (
    // A hand-rolled bar owes its own semantics: without the tablist/tab
    // pairing a screen reader announces four unrelated buttons instead of
    // "tab 2 of 4, selected" — everything react-navigation's bar gave us
    // for free.
    <View
      testID="patient-tab-bar"
      accessibilityRole="tablist"
      role="tablist"
      style={[
        styles.bar,
        {
          bottom: patientBarBottom(insets.bottom),
          left: PATIENT_BAR_SIDE,
          right: patientBarRightInset(),
          height: PATIENT_BAR_HEIGHT,
          backgroundColor: colors.card,
          borderColor: colors.border,
          borderRadius: PATIENT_BAR_HEIGHT / 2,
          boxShadow: BAR_SHADOW,
        },
      ]}
    >
      {ITEMS.map((item) => {
        const active = pathname.startsWith(String(item.href));
        const tint = active ? colors.cobalt : colors.mutedForeground;
        return (
          <Pressable
            key={item.key}
            testID={`patient-tab-${item.key}`}
            accessibilityRole="tab"
            role="tab"
            accessibilityLabel={item.label}
            accessibilityState={{ selected: active }}
            aria-selected={active}
            onPress={() => press(item)}
            style={({ pressed }) => [styles.item, pressed && { opacity: 0.7 }]}
          >
            {isIOS ? (
              <SymbolView name={item.sf} tintColor={tint} size={21} />
            ) : (
              <Feather name={item.feather} size={19} color={tint} />
            )}
            <Text
              style={[
                styles.label,
                {
                  color: tint,
                  fontFamily: active ? 'Inter_600SemiBold' : 'Inter_500Medium',
                },
              ]}
            >
              {item.label}
            </Text>
            {/* The Heritage active tick the old bar carried. */}
            <View
              style={[
                styles.tick,
                { backgroundColor: active ? colors.orange : 'transparent' },
              ]}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    paddingHorizontal: 4,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingVertical: 6,
  },
  label: {
    fontSize: 10,
  },
  tick: {
    height: 3,
    width: 16,
    borderRadius: 1.5,
  },
});
