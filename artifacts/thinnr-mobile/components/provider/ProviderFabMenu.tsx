/**
 * Floating navigation for the provider (staff) section — the Slack-style
 * bottom-right launcher that replaced the full-width tab bar.
 *
 * A round navy button floats in the bottom-right corner of every staff
 * screen and never leaves it. Tapping it pops out a Heritage menu card
 * floating horizontally centered at 90% of the app canvas width, raised so
 * its bottom edge clears the circle with a small gap — and the circle flips
 * to an X that closes the menu again (tap to reopen). One row per
 * destination (the same six the old tab bar held, same icons), the active
 * screen marked with the small orange tick the tabs used, and a prominent
 * cobalt "AI Support" action pinned full-width beneath a divider — the
 * staff-side AI chat lives outside the six rows the way Slack's primary
 * action does. Backdrop tap, Escape, hardware back, or picking a
 * destination also close the menu, returning the circle to its grid icon.
 *
 * The popout rides AppModal so web keeps iPhone-canvas parity (the 90%
 * width sizes against the fixed iPhone canvas, not the browser window), the
 * backdrop dims the screen, and hardware back / Escape / a backdrop tap all
 * close it. Because a Modal is its own window on native (and a body portal
 * on web), nothing rendered outside it can draw above the backdrop — so the
 * open-state X is a twin circle rendered INSIDE the modal at the same
 * canvas coordinates. The always-mounted launcher underneath mirrors the X
 * icon, keeps `provider-fab` queryable in both states, and gives the
 * modal's focus-restore a target after close.
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

/** Circle diameter; the open menu card is raised to clear it. */
const FAB_SIZE = 56;
/** Gap between the open menu card's bottom edge and the circle's top. */
const MENU_GAP = 12;

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
  // Shared placement so the in-modal X twin lands exactly on the launcher:
  // AppModal re-applies the same iPhone canvas on web and the modal fills
  // the screen on native, so identical right/bottom means the same spot.
  const fabPlacement = {
    right: 18,
    bottom: fabBottom,
    backgroundColor: colors.navy,
    boxShadow: FAB_SHADOW,
  };

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
      {/* The circle never leaves the screen. While the menu is open this
          node sits under the modal (the tappable X is the twin inside it,
          below) but mirrors the X icon and close label, so open/close reads
          as one circle swapping icons through the modal's fade. Staying
          mounted and visible keeps `provider-fab` queryable in both states
          and gives RNW's modal focus-restore its target after close. */}
      <Pressable
        testID="provider-fab"
        accessibilityRole="button"
        accessibilityLabel={open ? 'Close navigation menu' : 'Open navigation menu'}
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        onPress={toggle}
        style={({ pressed }) => [
          styles.fab,
          fabPlacement,
          pressed && { opacity: 0.88 },
        ]}
      >
        <Feather name={open ? 'x' : 'grid'} size={21} color={colors.primaryForeground} />
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
                // Raised above the circle: clear the launcher plus a small
                // gap instead of docking at the very bottom.
                marginBottom: fabBottom + FAB_SIZE + MENU_GAP,
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
          {/* Twin of the launcher circle, rendered inside the modal so it
              sits above the dimmed backdrop and stays tappable while the
              menu is open (nothing outside a Modal can draw over it). Same
              canvas coordinates as the launcher, so visually it IS the same
              circle — now an X that closes the menu. */}
          <Pressable
            testID="provider-fab-close"
            accessibilityRole="button"
            accessibilityLabel="Close navigation menu"
            accessibilityState={{ expanded: true }}
            aria-expanded={true}
            onPress={toggle}
            style={({ pressed }) => [
              styles.fab,
              fabPlacement,
              pressed && { opacity: 0.88 },
            ]}
          >
            <Feather name="x" size={21} color={colors.primaryForeground} />
          </Pressable>
        </View>
      </AppModal>
    </>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    width: FAB_SIZE,
    height: FAB_SIZE,
    borderRadius: FAB_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  overlay: {
    // Slack-style placement: the card sits centered near the bottom of the
    // canvas (raised above the circle); the absolute-fill backdrop ignores
    // the flex alignment.
    flex: 1,
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(23, 32, 46, 0.45)',
  },
  menuCard: {
    // 90% of the app canvas — AppModal keeps web percentage widths on the
    // fixed iPhone canvas, so this matches native exactly.
    width: '90%',
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
