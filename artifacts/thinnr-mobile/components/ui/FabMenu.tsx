/**
 * Shared floating corner menu — the Slack-style bottom-right launcher used
 * by BOTH app sides. The provider (staff) section renders it through
 * ProviderFabMenu; the patient section through PatientFabMenu. One
 * implementation so the two menus can never drift apart visually.
 *
 * A round navy button floats in the bottom-right corner and never leaves
 * it. Tapping it pops out a Heritage menu card floating horizontally
 * centered at 90% of the app canvas width, raised so its bottom edge clears
 * the circle with a small gap — and the circle flips to an X that closes
 * the menu again (tap to reopen). One row per entry (icon chip + label,
 * the active row marked with the small orange tick), and a prominent cobalt
 * call-to-action pinned full-width beneath a divider — the side's primary
 * chat action lives outside the rows the way Slack's primary action does.
 * Backdrop tap, Escape, hardware back, or picking a row also close the
 * menu, returning the circle to its grid icon.
 *
 * The popout rides AppModal so web keeps iPhone-canvas parity (the 90%
 * width sizes against the fixed iPhone canvas, not the browser window), the
 * backdrop dims the screen, and hardware back / Escape / a backdrop tap all
 * close it. Because a Modal is its own window on native (and a body portal
 * on web), nothing rendered outside it can draw above the backdrop — so the
 * open-state X is a twin circle rendered INSIDE the modal at the same
 * canvas coordinates. The always-mounted launcher underneath mirrors the X
 * icon, keeps the launcher testID queryable in both states, and gives the
 * modal's focus-restore a target after close.
 *
 * Everything visual (sizes, colors, shadows, spacing, the 170ms reveal) is
 * fixed here; callers only supply placement (`bottom`), rows, labels, and
 * testIDs. The provider config is the original and must stay byte-identical
 * in look and behavior — change this file with both sides in mind.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter, usePathname, type Href } from 'expo-router';
import { AppModal } from '@/components/ui/AppModal';
import { useColors } from '@/hooks/useColors';

/** Soft Heritage shadows as boxShadow strings (shadow* props warn on web). */
const FAB_SHADOW = '0 10px 26px rgba(23, 32, 46, 0.32)';
const MENU_SHADOW = '0 18px 44px rgba(23, 32, 46, 0.24)';

/** Circle diameter; the open menu card is raised to clear it. */
export const FAB_SIZE = 56;
/** Gap between the open menu card's bottom edge and the circle's top. */
const MENU_GAP = 12;

/**
 * Feather covers almost every row; `material-community` exists for the one
 * glyph Feather lacks (the barcode) so the menu can reuse the exact icon
 * patients already see on the diary's scan chip.
 */
type FabMenuItemIcon =
  | { iconSet?: 'feather'; icon: keyof typeof Feather.glyphMap }
  | { iconSet: 'material-community'; icon: keyof typeof MaterialCommunityIcons.glyphMap };

export type FabMenuItem = FabMenuItemIcon & {
  /** Row testID suffix: `${menuTestID}-${key}`. */
  key: string;
  label: string;
  /** Screen-reader label; defaults to `label`. */
  a11yLabel?: string;
  /**
   * Navigation target. With `method: 'navigate'` (default) the row dedupes
   * against the current pathname — tab-style destinations; with `'push'` it
   * always stacks — modal-style actions. The active-row tick compares this
   * href to the current pathname (string hrefs only).
   */
  href?: Href;
  method?: 'navigate' | 'push';
  /** Escape hatch: runs INSTEAD of href navigation (after close + haptics). */
  onSelect?: () => void;
};

export type FabMenuConfig = {
  /** Launcher testID; the in-modal X twin is `${fabTestID}-close`. */
  fabTestID: string;
  /** Card testID; rows are `${menuTestID}-${key}`, backdrop `-backdrop`. */
  menuTestID: string;
  /** Tiny all-caps section label above the rows (e.g. "NAVIGATE"). */
  sectionLabel: string;
  openA11yLabel: string;
  closeA11yLabel: string;
  /** Absolute distance from the container's bottom edge to the circle. */
  bottom: number;
  items: FabMenuItem[];
  /** The cobalt full-width action beneath the divider. */
  primary: {
    testID: string;
    label: string;
    a11yLabel: string;
    icon: keyof typeof Feather.glyphMap;
    onSelect: () => void;
  };
};

export function FabMenu({ config }: { config: FabMenuConfig }) {
  const colors = useColors();
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

  // Shared placement so the in-modal X twin lands exactly on the launcher:
  // AppModal re-applies the same iPhone canvas on web and the modal fills
  // the screen on native, so identical right/bottom means the same spot.
  const fabPlacement = {
    right: 18,
    bottom: config.bottom,
    backgroundColor: colors.navy,
    boxShadow: FAB_SHADOW,
  };

  const toggle = () => {
    Haptics.selectionAsync();
    setOpen((current) => !current);
  };

  const selectItem = (item: FabMenuItem) => {
    Haptics.selectionAsync();
    setOpen(false);
    if (item.onSelect) {
      item.onSelect();
      return;
    }
    if (item.href === undefined) return;
    if (item.method === 'push') {
      router.push(item.href);
      return;
    }
    if (pathname !== item.href) router.navigate(item.href);
  };

  const selectPrimary = () => {
    Haptics.selectionAsync();
    setOpen(false);
    config.primary.onSelect();
  };

  const isActive = (href: FabMenuItem['href']) => {
    if (typeof href !== 'string') return false;
    return href === '/' ? pathname === '/' : pathname.startsWith(href);
  };

  return (
    <>
      {/* The circle never leaves the screen. While the menu is open this
          node sits under the modal (the tappable X is the twin inside it,
          below) but mirrors the X icon and close label, so open/close reads
          as one circle swapping icons through the modal's fade. Staying
          mounted and visible keeps the launcher testID queryable in both
          states and gives RNW's modal focus-restore its target after close. */}
      <Pressable
        testID={config.fabTestID}
        accessibilityRole="button"
        accessibilityLabel={open ? config.closeA11yLabel : config.openA11yLabel}
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
            testID={`${config.menuTestID}-backdrop`}
            accessibilityRole="button"
            accessibilityLabel="Close menu"
            onPress={() => setOpen(false)}
            style={styles.backdrop}
          />
          <Animated.View
            testID={config.menuTestID}
            style={[
              styles.menuCard,
              {
                // Raised above the circle: clear the launcher plus a small
                // gap instead of docking at the very bottom.
                marginBottom: config.bottom + FAB_SIZE + MENU_GAP,
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
              {config.sectionLabel}
            </Text>
            {config.items.map((item) => {
              const active = isActive(item.href);
              return (
                <Pressable
                  key={item.key}
                  testID={`${config.menuTestID}-${item.key}`}
                  accessibilityRole="button"
                  accessibilityLabel={item.a11yLabel ?? item.label}
                  accessibilityState={{ selected: active }}
                  aria-selected={active}
                  onPress={() => selectItem(item)}
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
                    {item.iconSet === 'material-community' ? (
                      <MaterialCommunityIcons
                        name={item.icon}
                        size={15}
                        color={active ? colors.cobalt : colors.navyLight}
                      />
                    ) : (
                      <Feather
                        name={item.icon}
                        size={15}
                        color={active ? colors.cobalt : colors.navyLight}
                      />
                    )}
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
                    {item.label}
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
              testID={config.primary.testID}
              accessibilityRole="button"
              accessibilityLabel={config.primary.a11yLabel}
              onPress={selectPrimary}
              style={({ pressed }) => [
                styles.supportBtn,
                { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
                pressed && { opacity: 0.88 },
              ]}
            >
              <Feather name={config.primary.icon} size={15} color={colors.primaryForeground} />
              <Text style={[styles.supportText, { color: colors.primaryForeground }]}>
                {config.primary.label}
              </Text>
            </Pressable>
          </Animated.View>
          {/* Twin of the launcher circle, rendered inside the modal so it
              sits above the dimmed backdrop and stays tappable while the
              menu is open (nothing outside a Modal can draw over it). Same
              canvas coordinates as the launcher, so visually it IS the same
              circle — now an X that closes the menu. */}
          <Pressable
            testID={`${config.fabTestID}-close`}
            accessibilityRole="button"
            accessibilityLabel={config.closeA11yLabel}
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
