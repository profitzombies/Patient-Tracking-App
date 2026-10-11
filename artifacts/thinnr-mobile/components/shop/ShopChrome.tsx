/**
 * Shared chrome for the in-app shop screens (shop grid, product page, cart,
 * checkout, confirmation): the back/title/cart header, the states shown when
 * the storefront is missing, and the small purchase
 * controls (quantity stepper, one-time/subscribe toggle, cadence picker).
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router, type Href } from 'expo-router';
import { PrimaryButton } from '@/components/onboarding/OnboardingFields';
import { useColors } from '@/hooks/useColors';
import { useCartCount } from '@/context/CartContext';
import { cadenceLabel, CART_MAX_QUANTITY, formatCents } from '@/lib/cart-math';
import type { CartPurchase, PatientShop } from '@/lib/patient-billing-types';

export function goBackOr(fallback: Href): void {
  if (router.canGoBack()) router.back();
  else router.replace(fallback);
}

interface ShopHeaderProps {
  title: string;
  testIDPrefix: string;
  backFallback?: Href;
  /** Show the cart button (hidden on the cart and checkout themselves). */
  cartButton?: boolean;
}

export function ShopHeader({ title, testIDPrefix, backFallback = '/today', cartButton = true }: ShopHeaderProps) {
  const colors = useColors();
  const count = useCartCount();
  return (
    <View style={[styles.header, { borderBottomColor: colors.border }]}>
      <Pressable
        testID={`${testIDPrefix}-back`}
        accessibilityRole="button"
        accessibilityLabel="Go back"
        onPress={() => goBackOr(backFallback)}
        hitSlop={10}
        style={styles.headerBtn}
      >
        <Feather name="chevron-left" size={22} color={colors.navy} />
      </Pressable>
      <Text style={[styles.title, { color: colors.navy }]} numberOfLines={1}>{title}</Text>
      {cartButton ? (
        <Pressable
          testID={`${testIDPrefix}-cart`}
          accessibilityRole="button"
          accessibilityLabel={count ? `Cart, ${count} item${count === 1 ? '' : 's'}` : 'Cart, empty'}
          onPress={() => router.push('/cart' as Href)}
          hitSlop={10}
          style={styles.headerBtn}
        >
          <Feather name="shopping-bag" size={20} color={colors.navy} />
          {count ? (
            <View testID={`${testIDPrefix}-cart-count`} style={[styles.badge, { backgroundColor: colors.cobalt }]}>
              <Text style={[styles.badgeText, { color: colors.primaryForeground }]}>{count > 99 ? '99+' : count}</Text>
            </View>
          ) : null}
        </Pressable>
      ) : (
        <View style={styles.headerBtn} />
      )}
    </View>
  );
}

interface ShopStateProps {
  shop: PatientShop | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  onRetry: () => void;
  testIDPrefix: string;
}

/**
 * Renders the reason the storefront cannot be shown, or null when it can.
 * "Not connected" is a quiet, explanatory state (the office has not set up
 * payments) rather than an error.
 */
export function ShopUnavailable({ shop, status, error, onRetry, testIDPrefix }: ShopStateProps) {
  const colors = useColors();
  if (status === 'ready' && shop?.available) return null;
  if (status === 'loading' || status === 'idle') {
    return (
      <View testID={`${testIDPrefix}-loading`} style={styles.stateWrap}>
        <Text style={[styles.stateBody, { color: colors.bodyText }]}>Loading the shop…</Text>
      </View>
    );
  }
  if (status === 'error') {
    return (
      <View testID={`${testIDPrefix}-error`} accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.stateWrap}>
        <Feather name="alert-triangle" size={22} color={colors.riskText} />
        <Text style={[styles.stateTitle, { color: colors.navy }]}>Couldn’t load the shop</Text>
        <Text style={[styles.stateBody, { color: colors.bodyText }]}>{error ?? 'Please try again.'}</Text>
        <PrimaryButton testID={`${testIDPrefix}-retry`} label="Retry" onPress={onRetry} style={styles.stateBtn} />
      </View>
    );
  }
  const noProducts = shop?.unavailable_reason === 'no_products';
  return (
    <View testID={`${testIDPrefix}-unavailable`} style={styles.stateWrap}>
      <Feather name="shopping-bag" size={22} color={colors.subtleText} />
      <Text style={[styles.stateTitle, { color: colors.navy }]}>
        {noProducts ? 'Nothing for sale yet' : 'Shop not available yet'}
      </Text>
      <Text style={[styles.stateBody, { color: colors.bodyText }]}>
        {noProducts
          ? `${shop?.office?.office_name ?? 'Your office'} hasn’t listed any products yet. Check back soon.`
          : `${shop?.office?.office_name ?? 'Your office'} hasn’t set up in-app payments yet. Ask your care team about ordering.`}
      </Text>
    </View>
  );
}

interface QuantityStepperProps {
  value: number;
  onChange: (next: number) => void;
  /** Quantity 1 with `allowRemove` reads "Remove" for the minus button. */
  allowRemove?: boolean;
  testIDPrefix: string;
  label?: string;
  /** Freezes both buttons (a cart locked behind a pending payment). */
  disabled?: boolean;
}

export function QuantityStepper({ value, onChange, allowRemove = false, testIDPrefix, label = 'quantity', disabled: frozen = false }: QuantityStepperProps) {
  const colors = useColors();
  const decDisabled = frozen || (value <= 1 && !allowRemove);
  const incDisabled = frozen || value >= CART_MAX_QUANTITY;
  const button = (icon: 'minus' | 'plus' | 'trash-2', a11y: string, disabled: boolean, onPress: () => void, id: string) => (
    <Pressable
      testID={id}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ disabled }}
      aria-disabled={disabled}
      onPress={() => {
        if (disabled) return;
        Haptics.selectionAsync();
        onPress();
      }}
      style={({ pressed }) => [
        styles.stepBtn,
        { borderColor: colors.border, backgroundColor: pressed && !disabled ? colors.accent : colors.card, borderRadius: colors.radiusSm },
        disabled && { opacity: 0.35 },
      ]}
    >
      <Feather name={icon} size={14} color={colors.navy} />
    </Pressable>
  );
  const minusIsRemove = value <= 1 && allowRemove;
  return (
    <View style={styles.stepper} accessibilityRole="none">
      {button(
        minusIsRemove ? 'trash-2' : 'minus',
        minusIsRemove ? `Remove ${label}` : `Decrease ${label}`,
        decDisabled,
        () => onChange(value - 1),
        `${testIDPrefix}-dec`,
      )}
      <Text
        testID={`${testIDPrefix}-value`}
        accessibilityLabel={`Quantity ${value}`}
        style={[styles.stepValue, { color: colors.navy }]}
      >
        {value}
      </Text>
      {button('plus', `Increase ${label}`, incDisabled, () => onChange(value + 1), `${testIDPrefix}-inc`)}
    </View>
  );
}

interface PurchaseToggleProps {
  value: CartPurchase;
  onChange: (next: CartPurchase) => void;
  subscriptionAvailable: boolean;
  savePercent: number;
  testIDPrefix: string;
}

export function PurchaseToggle({ value, onChange, subscriptionAvailable, savePercent, testIDPrefix }: PurchaseToggleProps) {
  const colors = useColors();
  const options: { value: CartPurchase; label: string; hint: string | null }[] = [
    { value: 'one_time', label: 'One-time', hint: null },
    {
      value: 'subscription',
      label: 'Subscribe',
      hint: subscriptionAvailable ? (savePercent > 0 ? `Save ${savePercent}%` : 'Ships on schedule') : 'Not offered',
    },
  ];
  return (
    <View accessibilityRole="radiogroup" style={styles.toggleRow}>
      {options.map(option => {
        const active = option.value === value;
        const disabled = option.value === 'subscription' && !subscriptionAvailable;
        return (
          <Pressable
            key={option.value}
            testID={`${testIDPrefix}-${option.value === 'one_time' ? 'one-time' : 'subscribe'}`}
            accessibilityRole="radio"
            accessibilityLabel={option.hint ? `${option.label}, ${option.hint}` : option.label}
            accessibilityState={{ checked: active, disabled }}
            aria-disabled={disabled}
            onPress={() => {
              if (disabled || active) return;
              Haptics.selectionAsync();
              onChange(option.value);
            }}
            style={[
              styles.toggleItem,
              {
                borderColor: active ? colors.cobalt : colors.border,
                backgroundColor: active ? colors.activeBg : colors.card,
                borderRadius: colors.radiusSm,
              },
              disabled && { opacity: 0.45 },
            ]}
          >
            <Text style={[styles.toggleLabel, { color: active ? colors.cobalt : colors.navy }]}>{option.label}</Text>
            {option.hint ? (
              <Text style={[styles.toggleHint, { color: active ? colors.cobalt : colors.subtleText }]}>{option.hint}</Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

interface CadencePickerProps {
  cadences: number[];
  value: number;
  onChange: (weeks: number) => void;
  testIDPrefix: string;
}

export function CadencePicker({ cadences, value, onChange, testIDPrefix }: CadencePickerProps) {
  const colors = useColors();
  return (
    <View accessibilityRole="radiogroup" style={styles.cadenceRow}>
      {cadences.map(weeks => {
        const active = weeks === value;
        return (
          <Pressable
            key={weeks}
            testID={`${testIDPrefix}-cadence-${weeks}`}
            accessibilityRole="radio"
            accessibilityLabel={cadenceLabel(weeks)}
            accessibilityState={{ checked: active }}
            onPress={() => {
              if (active) return;
              Haptics.selectionAsync();
              onChange(weeks);
            }}
            style={[
              styles.cadenceChip,
              {
                borderColor: active ? colors.cobalt : colors.border,
                backgroundColor: active ? colors.cobalt : colors.card,
              },
            ]}
          >
            <Text style={[styles.cadenceText, { color: active ? colors.primaryForeground : colors.bodyText }]}>
              {weeks} wk
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

interface PriceRowProps {
  label: string;
  cents: number;
  strong?: boolean;
  discount?: boolean;
  testID?: string;
}

export function PriceRow({ label, cents, strong = false, discount = false, testID }: PriceRowProps) {
  const colors = useColors();
  return (
    <View style={styles.priceRow}>
      <Text style={[strong ? styles.priceLabelStrong : styles.priceLabel, { color: strong ? colors.navy : colors.bodyText }]}>{label}</Text>
      <Text
        testID={testID}
        style={[strong ? styles.priceValueStrong : styles.priceValue, { color: discount ? colors.activeGreen : colors.navy }]}
      >
        {discount && cents > 0 ? `−${formatCents(cents)}` : formatCents(cents)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    minHeight: 58,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    gap: 8,
  },
  headerBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, textAlign: 'center', fontSize: 18, fontFamily: 'PlayfairDisplay_700Bold' },
  badge: {
    position: 'absolute',
    top: 0,
    right: -2,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 9, fontFamily: 'Inter_700Bold' },
  stateWrap: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: 28, gap: 8 },
  stateTitle: { fontSize: 17, fontFamily: 'PlayfairDisplay_600SemiBold', marginTop: 6, textAlign: 'center' },
  stateBody: { fontSize: 13, lineHeight: 19, fontFamily: 'Inter_400Regular', textAlign: 'center' },
  stateBtn: { marginTop: 12, alignSelf: 'stretch' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepBtn: { width: 34, height: 34, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  stepValue: { minWidth: 22, textAlign: 'center', fontSize: 15, fontFamily: 'Inter_700Bold' },
  toggleRow: { flexDirection: 'row', gap: 8 },
  toggleItem: { flex: 1, borderWidth: 1, paddingVertical: 10, paddingHorizontal: 12, gap: 2 },
  toggleLabel: { fontSize: 13.5, fontFamily: 'Inter_700Bold' },
  toggleHint: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },
  cadenceRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  cadenceChip: { borderWidth: 1, borderRadius: 999, paddingVertical: 7, paddingHorizontal: 14 },
  cadenceText: { fontSize: 12.5, fontFamily: 'Inter_600SemiBold' },
  priceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 },
  priceLabel: { fontSize: 13, fontFamily: 'Inter_400Regular' },
  priceValue: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  priceLabelStrong: { fontSize: 14.5, fontFamily: 'Inter_700Bold' },
  priceValueStrong: { fontSize: 18, fontFamily: 'PlayfairDisplay_700Bold' },
});
