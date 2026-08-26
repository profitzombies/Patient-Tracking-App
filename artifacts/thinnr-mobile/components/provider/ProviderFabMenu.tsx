/**
 * Floating navigation for the provider (staff) section — the Slack-style
 * bottom-right launcher that replaced the full-width tab bar.
 *
 * A round navy button floats in the bottom-right corner of every staff
 * screen. Tapping it pops out a Heritage menu card anchored above it: one
 * row per destination (the same six the old tab bar held, same icons), the
 * active screen marked with the small orange tick the tabs used, and a
 * prominent cobalt "AI Support" action beneath a divider — the staff-side
 * AI chat lives outside the six rows the way Slack's primary action does.
 *
 * The popout rides AppModal so web keeps iPhone-canvas parity, the backdrop
 * dims the screen, and hardware back / Escape / a backdrop tap all close it.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter, usePathname, type Href } from 'expo-router';
import { AppModal } from '@/components/ui/AppModal';
import { useColors } from '@/hooks/useColors';

/** Soft Heritage shadows as boxShadow strings (shadow* props warn on web). */
const FAB_SHADOW = '0 10px 26px rgba(23, 32, 46, 0.32)';
const MENU_SHADOW = '0 18px 44px rgba(23, 32, 46, 0.24)';

const DESTINATIONS: {
  key: string;
  label: string;
  icon: keyof typeof Feather.glyphMap;
  href: Href;
}[] = [
  { key: 'overview', label: 'Overview', icon: 'home', href: '/' },
  { key: 'patients', label: 'Patients', icon: 'users', href: '/patients' },
  { key: 'outcomes', label: 'Outcomes', icon: 'bar-chart-2', href: '/outcomes' },
  { key: 'leaderboard', label: 'Leaderboard', icon: 'award', href: '/leaderboard' },
  { key: 'subscriptions', label: 'Subscriptions', icon: 'package', href: '/subscriptions' },
  { key: 'training', label: 'Training', icon: 'book-open', href: '/training' },
];

export function ProviderFabMenu() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // Quick pop-in for the menu card (the modal itself only fades the backdrop).
  const reveal = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!open) return;
    reveal.setValue(0);
    Animated.timing(reveal, {
      toValue: 1,
      duration: 170,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, [open, reveal]);

  const fabBottom = Math.max(insets.bottom, 14) + 14;

  const toggle = () => {
    Haptics.selectionAsync();
    setOpen((current) => !current);
  };

  const goTo = (href: Href) => {
    Haptics.selectionAsync();
    setOpen(false);
    if (pathname !== href) router.navigate(href);
  };

  const openSupport = () => {
    Haptics.selectionAsync();
    setOpen(false);
    router.push('/support-chat');
  };

  const isActive = (href: Href) =>
    href === '/' ? pathname === '/' : pathname.startsWith(String(href));

  return (
    <>
      <Pressable
        testID="provider-fab"
        accessibilityRole="button"
        accessibilityLabel={open ? 'Close navigation menu' : 'Open navigation menu'}
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        onPress={toggle}
        style={({ pressed }) => [
          styles.fab,
          {
            right: 18,
            bottom: fabBottom,
            backgroundColor: colors.navy,
            boxShadow: FAB_SHADOW,
          },
          pressed && { opacity: 0.88 },
        ]}
      >
        <Feather name="grid" size={21} color={colors.primaryForeground} />
      </Pressable>

      <AppModal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <View style={styles.overlay}>
          <Pressable
            testID="provider-menu-backdrop"
            accessibilityRole="button"
            accessibilityLabel="Close menu"
            onPress={() => setOpen(false)}
            style={styles.backdrop}
          />
          <Animated.View
            testID="provider-menu"
            style={[
              styles.menuCard,
              {
                right: 18,
                bottom: fabBottom + 56 + 12,
                backgroundColor: colors.card,
                borderColor: colors.border,
                borderRadius: colors.radius,
                boxShadow: MENU_SHADOW,
                opacity: reveal,
                transform: [
                  {
                    translateY: reveal.interpolate({
                      inputRange: [0, 1],
                      outputRange: [10, 0],
                    }),
                  },
                  {
                    scale: reveal.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.96, 1],
                    }),
                  },
                ],
              },
            ]}
          >
            <Text style={[styles.menuLabel, { color: colors.labelText }]}>
              NAVIGATE
            </Text>
            {DESTINATIONS.map((destination) => {
              const active = isActive(destination.href);
              return (
                <Pressable
                  key={destination.key}
                  testID={`provider-menu-${destination.key}`}
                  accessibilityRole="button"
                  accessibilityLabel={destination.label}
                  accessibilityState={{ selected: active }}
                  aria-selected={active}
                  onPress={() => goTo(destination.href)}
                  style={({ pressed }) => [
                    styles.menuRow,
                    { borderRadius: colors.radiusSm },
                    active && { backgroundColor: colors.activeBg },
                    pressed && { backgroundColor: colors.accent },
                  ]}
                >
                  <View
                    style={[
                      styles.iconChip,
                      {
                        borderColor: active ? colors.activeBorder : colors.border,
                        backgroundColor: active ? colors.activeBg : colors.paperCardAlt,
                        borderRadius: 7,
                      },
                    ]}
                  >
                    <Feather
                      name={destination.icon}
                      size={15}
                      color={active ? colors.cobalt : colors.navyLight}
                    />
                  </View>
                  <Text
                    style={[
                      styles.menuRowText,
                      {
                        color: active ? colors.cobalt : colors.navy,
                        fontFamily: active ? 'Inter_700Bold' : 'Inter_600SemiBold',
                      },
                    ]}
                  >
                    {destination.label}
                  </Text>
                  {/* The Heritage active tick, carried over from the old tab bar. */}
                  <View
                    style={[
                      styles.activeTick,
                      { backgroundColor: active ? colors.orange : 'transparent' },
                    ]}
                  />
                </Pressable>
              );
            })}
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
            <Pressable
              testID="provider-menu-support"
              accessibilityRole="button"
              accessibilityLabel="Open AI Support"
              onPress={openSupport}
              style={({ pressed }) => [
                styles.supportBtn,
                { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
                pressed && { opacity: 0.88 },
              ]}
            >
              <Feather name="message-circle" size={15} color={colors.primaryForeground} />
              <Text style={[styles.supportText, { color: colors.primaryForeground }]}>
                AI Support
              </Text>
            </Pressable>
          </Animated.View>
        </View>
      </AppModal>
    </>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  overlay: {
    flex: 1,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(23, 32, 46, 0.45)',
  },
  menuCard: {
    position: 'absolute',
    width: 260,
    borderWidth: 1,
    padding: 10,
    gap: 2,
  },
  menuLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.4,
    fontFamily: 'Inter_700Bold',
    paddingHorizontal: 6,
    paddingTop: 2,
    paddingBottom: 6,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    minHeight: 46,
    paddingHorizontal: 8,
  },
  iconChip: {
    width: 30,
    height: 30,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuRowText: {
    flex: 1,
    fontSize: 14,
  },
  activeTick: {
    width: 14,
    height: 3,
    borderRadius: 1.5,
  },
  divider: {
    height: 1,
    marginVertical: 8,
    marginHorizontal: 6,
  },
  supportBtn: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  supportText: {
    fontSize: 13.5,
    fontFamily: 'Inter_600SemiBold',
  },
});
