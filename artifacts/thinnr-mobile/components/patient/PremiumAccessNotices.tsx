/**
 * Quiet notices for the coach surfaces, driven by the app-access seam:
 *
 *  - FreeWindowEndingNotice — the last few days of a CHARGEABLE free window
 *    (THINNR protocol window or the office's trial): when it ends and what
 *    the office charges afterwards. Never shown for offices that do not
 *    charge, never while locked, never while subscribed.
 *  - PremiumLockedNotice — the composer-side notice once the features are
 *    locked: what happened and one button to the upgrade sheet. Reading an
 *    existing conversation stays possible behind it.
 *
 * Both read the entitlement from the seam, so a tree without the provider
 * (demo, signed-out, Node suites) renders nothing. The coach-paused notice
 * is owned by the chat screen and always wins: callers render these only
 * when the coach is not paused.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useAppAccess } from '@/context/AppAccessContext';
import { useColors } from '@/hooks/useColors';
import { describeEndingDay, endingSoonNotice } from '@/lib/app-access';
import { localTodayKey } from '@/lib/live-patient-entry';

export function FreeWindowEndingNotice({ style }: { style?: object }) {
  const colors = useColors();
  const { access } = useAppAccess();
  // Entitlements exist only for real accounts, which ride the device-local
  // day — the same day the server's window boundary is expressed in.
  const notice = endingSoonNotice(access, localTodayKey());
  if (!notice) return null;
  const when = describeEndingDay(notice);
  return (
    <View
      testID="coach-ending-soon-notice"
      accessibilityRole="text"
      style={[
        styles.endingBox,
        { backgroundColor: colors.paperCardAlt, borderColor: colors.border, borderRadius: colors.radiusSm },
        style,
      ]}
    >
      <Feather name="clock" size={13} color={colors.navyLight} style={styles.icon} />
      <Text style={[styles.endingText, { color: colors.bodyText }]}>
        {`Your free access to the AI coach, photo reads and barcode lookup ends ${when}. After that your office offers them for ${notice.priceLine}. Everything else in the app stays free.`}
      </Text>
    </View>
  );
}

export function PremiumLockedNotice({ style }: { style?: object }) {
  const colors = useColors();
  const { locked, openUpgradeSheet } = useAppAccess();
  if (!locked) return null;
  return (
    <View
      testID="coach-locked-notice"
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[
        styles.lockedBox,
        { backgroundColor: colors.accent, borderColor: colors.activeBorder, borderRadius: colors.radiusSm },
        style,
      ]}
    >
      <Feather name="lock" size={14} color={colors.cobalt} style={styles.icon} />
      <View style={styles.lockedCopy}>
        <Text style={[styles.lockedTitle, { color: colors.navy }]}>AI coach is part of the app subscription</Text>
        <Text style={[styles.lockedText, { color: colors.bodyText }]}>
          Your free period has ended. You can still read this conversation; subscribing through your office brings the coach, photo reads and barcode lookup back right away.
        </Text>
        <Pressable
          testID="coach-locked-upgrade"
          accessibilityRole="button"
          accessibilityLabel="See upgrade options"
          onPress={openUpgradeSheet}
          hitSlop={6}
          style={({ pressed }) => [
            styles.lockedBtn,
            { backgroundColor: pressed ? colors.cobaltLight : colors.cobalt, borderRadius: colors.radiusSm },
          ]}
        >
          <Text style={[styles.lockedBtnText, { color: colors.primaryForeground }]}>See upgrade options</Text>
          <Feather name="chevron-right" size={13} color={colors.primaryForeground} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  endingBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 9,
  },
  endingText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    fontFamily: 'Inter_400Regular',
  },
  lockedBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 10,
  },
  icon: {
    marginTop: 2,
  },
  lockedCopy: {
    flex: 1,
    gap: 4,
  },
  lockedTitle: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
  lockedText: {
    fontSize: 12,
    lineHeight: 17,
    fontFamily: 'Inter_400Regular',
  },
  lockedBtn: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 7,
    marginTop: 4,
  },
  lockedBtnText: {
    fontSize: 12.5,
    fontFamily: 'Inter_600SemiBold',
  },
});
