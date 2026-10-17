/**
 * UpgradeSheet — the ONE prompt every locked premium entry point opens
 * (coach launcher, coach composer, meal/menu/label photo reads, barcode
 * scanner). Mounted once by AppAccessProvider so the surfaces share a
 * single instance and identical wording.
 *
 * Fair, not punitive: it names what the office charges (price + cadence),
 * lists exactly what the subscription restores, and offers one action —
 * the office's checkout page in the browser — beside an equally visible
 * "Not now". Nothing else in the app is touched: food logging, the
 * approved list, saved recipes, shop, orders, care-team chat, check-ins,
 * photos and rewards all keep working behind this sheet.
 *
 * The checkout link arrives with the entitlement read; while the lock came
 * from a 402 reply (no link attached) the button waits on the re-read
 * instead of inventing a URL. Returning from the browser re-reads the
 * entitlement (the provider owns that), so a finished payment unlocks the
 * features without a restart.
 */
import React from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { AppModal } from '@/components/ui/AppModal';
import { useColors } from '@/hooks/useColors';
import {
  PREMIUM_FEATURES,
  appAccessPriceLine,
  type PatientAppAccess,
} from '@/lib/app-access';

export interface UpgradeSheetProps {
  visible: boolean;
  access: PatientAppAccess | null;
  /** True while the checkout page is being opened. */
  opening: boolean;
  onOpenCheckout: () => void;
  onClose: () => void;
}

export function UpgradeSheet({ visible, access, opening, onOpenCheckout, onClose }: UpgradeSheetProps) {
  const colors = useColors();
  const priceLine = appAccessPriceLine(access);
  const checkoutUrl = access?.checkout_url ?? null;
  const windowKind = access?.free_window?.kind ?? null;
  const lapsed = access?.subscription != null && access.subscription.state !== 'none';

  const lead = lapsed
    ? 'Your app subscription has ended, so the AI features are paused. Everything else in the app keeps working.'
    : windowKind === 'trial'
      ? 'Your free trial of the AI features has ended. Everything else in the app keeps working as before.'
      : 'Your free period for the AI features has ended. Everything else in the app keeps working as before.';

  return (
    <AppModal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View
          testID="upgrade-sheet"
          accessibilityViewIsModal
          style={[
            styles.sheet,
            { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius },
          ]}
        >
          <Text style={[styles.label, { color: colors.labelText }]}>AI FEATURES</Text>
          <Text style={[styles.title, { color: colors.navy, fontFamily: colors.fonts.serif }]}>
            Keep your AI coach
          </Text>
          <Text style={[styles.lead, { color: colors.bodyText }]}>{lead}</Text>

          <View
            testID="upgrade-sheet-price"
            style={[
              styles.priceBox,
              { backgroundColor: colors.accent, borderColor: colors.activeBorder, borderRadius: colors.radiusSm },
            ]}
          >
            <Text style={[styles.priceLabel, { color: colors.cobalt }]}>YOUR OFFICE CHARGES</Text>
            <Text style={[styles.price, { color: colors.navy }]}>
              {priceLine ?? 'Price available at checkout'}
            </Text>
            <Text style={[styles.priceHint, { color: colors.subtleText }]}>
              Billed by your office. Cancel any time from Account and settings.
            </Text>
          </View>

          <View style={styles.list} testID="upgrade-sheet-restores">
            <Text style={[styles.listLabel, { color: colors.labelText }]}>SUBSCRIBING BRINGS BACK</Text>
            {PREMIUM_FEATURES.map(feature => (
              <View key={feature} style={styles.listRow}>
                <Feather name="check" size={14} color={colors.activeGreen} style={styles.listIcon} />
                <Text style={[styles.listText, { color: colors.bodyText }]}>{feature}</Text>
              </View>
            ))}
          </View>

          <Pressable
            testID="upgrade-sheet-checkout"
            accessibilityRole="button"
            accessibilityLabel="Open the checkout page in your browser"
            accessibilityState={{ disabled: opening || !checkoutUrl }}
            disabled={opening || !checkoutUrl}
            onPress={onOpenCheckout}
            style={({ pressed }) => [
              styles.primaryBtn,
              {
                backgroundColor: opening || !checkoutUrl ? colors.cobaltMuted : colors.cobalt,
                borderRadius: colors.radiusSm,
              },
              pressed && !opening && checkoutUrl ? { opacity: 0.88 } : null,
            ]}
          >
            {opening || !checkoutUrl ? (
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            ) : (
              <Feather name="external-link" size={15} color={colors.primaryForeground} />
            )}
            <Text style={[styles.primaryBtnText, { color: colors.primaryForeground }]}>
              {opening ? 'Opening checkout…' : checkoutUrl ? 'Open checkout' : 'Loading checkout…'}
            </Text>
          </Pressable>
          <Pressable
            testID="upgrade-sheet-dismiss"
            accessibilityRole="button"
            accessibilityLabel="Not now"
            onPress={onClose}
            style={({ pressed }) => [
              styles.secondaryBtn,
              {
                borderColor: colors.border,
                backgroundColor: pressed ? colors.accent : colors.card,
                borderRadius: colors.radiusSm,
              },
            ]}
          >
            <Text style={[styles.secondaryBtnText, { color: colors.navyLight }]}>Not now</Text>
          </Pressable>
          <Text style={[styles.footnote, { color: colors.subtleText }]}>
            {Platform.OS === 'web'
              ? 'Checkout opens in a new tab. Come back here once you have paid.'
              : 'Checkout opens in your browser. Come back to the app once you have paid.'}
          </Text>
        </View>
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(23, 32, 46, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  sheet: {
    width: '100%',
    maxWidth: 420,
    borderWidth: 1,
    padding: 18,
    gap: 12,
  },
  label: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.4,
    fontFamily: 'Inter_700Bold',
  },
  title: {
    fontSize: 22,
    lineHeight: 28,
  },
  lead: {
    fontSize: 13,
    lineHeight: 19,
    fontFamily: 'Inter_400Regular',
  },
  priceBox: {
    borderWidth: 1,
    padding: 12,
    gap: 3,
  },
  priceLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
    fontFamily: 'Inter_700Bold',
  },
  price: {
    fontSize: 18,
    fontFamily: 'Inter_600SemiBold',
  },
  priceHint: {
    fontSize: 11,
    lineHeight: 15,
    fontFamily: 'Inter_400Regular',
  },
  list: {
    gap: 6,
  },
  listLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
    fontFamily: 'Inter_700Bold',
    marginBottom: 2,
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  listIcon: {
    marginTop: 2,
  },
  listText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    fontFamily: 'Inter_500Medium',
  },
  primaryBtn: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
  },
  primaryBtnText: {
    fontSize: 13.5,
    fontFamily: 'Inter_600SemiBold',
  },
  secondaryBtn: {
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  secondaryBtnText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
  footnote: {
    fontSize: 11,
    lineHeight: 15,
    textAlign: 'center',
    fontFamily: 'Inter_400Regular',
  },
});
