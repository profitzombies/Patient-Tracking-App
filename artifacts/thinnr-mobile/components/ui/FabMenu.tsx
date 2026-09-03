/**
 * FabMenu — the shared corner launcher + popout menu behind BOTH personas'
 * floating navy circle. The provider (staff) side mounts it as its whole
 * navigation (components/provider/ProviderFabMenu); the patient side mounts
 * the same component above its tab bar for quick actions
 * (components/patient/PatientFabMenu). One implementation, two configs, so
 * the two corners can never drift apart in look or behavior.
 *
 * A round navy button floats in the bottom-right corner and never leaves
 * it. Tapping it pops out a Heritage menu card floating horizontally
 * centered at 90% of the app canvas width, raised so its bottom edge clears
 * the circle with a small gap — and the circle flips to an X that closes
 * the menu again (tap to reopen). One row per item (icon chip + label, the
 * active screen marked with the small orange tick for navigate rows), and a
 * prominent cobalt primary action pinned full-width beneath a divider — the
 * way Slack's primary action sits outside the rows. Backdrop tap, Escape,
 * hardware back, or picking a row also close the menu, returning the circle
 * to its resting icon.
 *
 * The popout rides AppModal so web keeps iPhone-canvas parity (the 90%
 * width sizes against the fixed iPhone canvas, not the browser window), the
 * backdrop dims the screen, and hardware back / Escape / a backdrop tap all
 * close it. Because a Modal is its own window on native (and a body portal
 * on web), nothing rendered outside it can draw above the backdrop — so the
 * open-state X is a twin circle rendered INSIDE the modal at the same
 * canvas coordinates. The always-mounted launcher underneath mirrors the X
 * icon, keeps `${idPrefix}-fab` queryable in both states, and gives the
 * modal's focus-restore a target after close.
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
/** Corner offset — also what the patient pill bar measures its gutter from. */
export const FAB_RIGHT = 18;
/** Gap between the open menu card's bottom edge and the circle's top. */
const MENU_GAP = 12;

/**
 * Row icon — Feather for most glyphs, MaterialCommunityIcons for the few
 * that Feather lacks (e.g. barcode-scan). Both families are preloaded by
 * the root font gate, so either renders safely anywhere.
 */
export type FabMenuIcon =
  | { family: 'feather'; name: keyof typeof Feather.glyphMap }
  | { family: 'mci'; name: keyof typeof MaterialCommunityIcons.glyphMap };

/**
 * What tapping a row (or the primary action) does. The menu always closes
 * first, with the same selection haptic:
 * - navigate: tab-style destination — shows the orange active tick when the
 *   current pathname matches, and skips navigation when already there.
 * - push: stacks a screen (modals like log-food keep their own dismissal).
 * - run: caller-provided behavior (e.g. the patient meal-photo flow, which
 *   must create its capture request before navigating).
 */
export type FabMenuAction =
  | { kind: 'navigate'; href: Href }
  | { kind: 'push'; href: Href }
  | { kind: 'run'; run: () => void };

export interface FabMenuItem {
  /** Slug used in the row's testID: `${idPrefix}-menu-${key}`. */
  key: string;
  label: string;
  icon: FabMenuIcon;
  action: FabMenuAction;
}

/**
 * A labelled group of rows. Most configs pass one ("NAVIGATE" for staff);
 * the patient menu passes two — the destinations that did not make the
 * pill bar, then the quick actions — so one card can hold both without the
 * rows running together.
 */
export interface FabMenuSection {
  /** Slug used in the group's testID: `${idPrefix}-menu-section-${key}`. */
  key: string;
  /** Small caps heading above the group's rows. */
  label: string;
  items: FabMenuItem[];
}

export interface FabMenuPrimaryAction {
  /** Slug used in the button's testID: `${idPrefix}-menu-${key}`. */
  key: string;
  label: string;
  icon: keyof typeof Feather.glyphMap;
  accessibilityLabel: string;
  action: FabMenuAction;
}

export interface FabMenuProps {
  /** testID prefix: `${idPrefix}-fab`, `${idPrefix}-menu`, `${idPrefix}-menu-${key}`, … */
  idPrefix: string;
  /** Launcher accessibility label while the menu is closed / open. */
  openAccessibilityLabel: string;
  closeAccessibilityLabel: string;
  /**
   * Glyph the closed circle rests as. Staff keep the default grid (their
   * menu IS their navigation); the patient circle rests as a plus, because
   * beside a pill bar it reads as "add something" (its primary is Log
   * food). Open, both flip to the same X.
   */
  restingIcon?: keyof typeof Feather.glyphMap;
  /** Row groups, rendered top to bottom in the order given. */
  sections: FabMenuSection[];
  /** The cobalt full-width action pinned beneath the divider. */
  primaryAction: FabMenuPrimaryAction;
  /**
   * Distance from the canvas bottom edge to the circle's bottom edge. Each
   * side computes its own anchor (staff: home-indicator inset; patient:
   * above the tab bar) — everything else about the corner is shared.
   */
  fabBottom: number;
}

export function FabMenu({
  idPrefix,
  openAccessibilityLabel,
  closeAccessibilityLabel,
  restingIcon = 'grid',
  sections,
  primaryAction,
  fabBottom,
}: FabMenuProps) {
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
    right: FAB_RIGHT,
    bottom: fabBottom,
    backgroundColor: colors.navy,
    boxShadow: FAB_SHADOW,
  };

  const toggle = () => {
    Haptics.selectionAsync();
    setOpen((current) => !current);
  };

  const isActive = (action: FabMenuAction) =>
    action.kind === 'navigate' &&
    (action.href === '/' ? pathname === '/' : pathname.startsWith(String(action.href)));

  /** Close-then-act, with the same press haptic on every row. */
  const activate = (action: FabMenuAction) => {
    Haptics.selectionAsync();
    setOpen(false);
    if (action.kind === 'navigate') {
      if (pathname !== action.href) router.navigate(action.href);
    } else if (action.kind === 'push') {
      router.push(action.href);
    } else {
      action.run();
    }
  };

  const rowIcon = (icon: FabMenuIcon, active: boolean) => {
    const color = active ? colors.cobalt : colors.navyLight;
    return icon.family === 'mci' ? (
      <MaterialCommunityIcons name={icon.name} size={15} color={color} />
    ) : (
      <Feather name={icon.name} size={15} color={color} />
    );
  };

  return (
    <>
      {/* The circle never leaves the screen. While the menu is open this
          node sits under the modal (the tappable X is the twin inside it,
          below) but mirrors the X icon and close label, so open/close reads
          as one circle swapping icons through the modal's fade. Staying
          mounted and visible keeps `${idPrefix}-fab` queryable in both
          states and gives RNW's modal focus-restore its target after close. */}
      <Pressable
        testID={`${idPrefix}-fab`}
        accessibilityRole="button"
        accessibilityLabel={open ? closeAccessibilityLabel : openAccessibilityLabel}
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        onPress={toggle}
        style={({ pressed }) => [
          styles.fab,
          fabPlacement,
          pressed && { opacity: 0.88 },
        ]}
      >
        <Feather name={open ? 'x' : restingIcon} size={21} color={colors.primaryForeground} />
      </Pressable>

      <AppModal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <View style={styles.overlay}>
          <Pressable
            testID={`${idPrefix}-menu-backdrop`}
            accessibilityRole="button"
            accessibilityLabel="Close menu"
            onPress={() => setOpen(false)}
            style={styles.backdrop}
          />
          <Animated.View
            testID={`${idPrefix}-menu`}
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
            {sections.map((section) => (
              <View
                key={section.key}
                testID={`${idPrefix}-menu-section-${section.key}`}
                style={styles.section}
              >
                <Text style={[styles.menuLabel, { color: colors.labelText }]}>
                  {section.label}
                </Text>
                {section.items.map((item) => {
                  const active = isActive(item.action);
                  return (
                    <Pressable
                      key={item.key}
                      testID={`${idPrefix}-menu-${item.key}`}
                      accessibilityRole="button"
                      accessibilityLabel={item.label}
                      accessibilityState={{ selected: active }}
                      aria-selected={active}
                      onPress={() => activate(item.action)}
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
                        {rowIcon(item.icon, active)}
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
              </View>
            ))}
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
            <Pressable
              testID={`${idPrefix}-menu-${primaryAction.key}`}
              accessibilityRole="button"
              accessibilityLabel={primaryAction.accessibilityLabel}
              onPress={() => activate(primaryAction.action)}
              style={({ pressed }) => [
                styles.primaryBtn,
                { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
                pressed && { opacity: 0.88 },
              ]}
            >
              <Feather name={primaryAction.icon} size={15} color={colors.primaryForeground} />
              <Text style={[styles.primaryText, { color: colors.primaryForeground }]}>
                {primaryAction.label}
              </Text>
            </Pressable>
          </Animated.View>
          {/* Twin of the launcher circle, rendered inside the modal so it
              sits above the dimmed backdrop and stays tappable while the
              menu is open (nothing outside a Modal can draw over it). Same
              canvas coordinates as the launcher, so visually it IS the same
              circle — now an X that closes the menu. */}
          <Pressable
            testID={`${idPrefix}-fab-close`}
            accessibilityRole="button"
            accessibilityLabel={closeAccessibilityLabel}
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
    ...StyleSheet.absoluteFill,
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
  section: {
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
  primaryBtn: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  primaryText: {
    fontSize: 13.5,
    fontFamily: 'Inter_600SemiBold',
  },
});
