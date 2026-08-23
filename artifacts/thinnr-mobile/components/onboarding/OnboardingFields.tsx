/**
 * Reusable Heritage form widgets for the simulated onboarding flow.
 * Soft geometry (radius 9 cards / 7 controls), serif option titles,
 * uppercase micro-labels, no native wheel pickers — everything here is
 * RN-web friendly.
 */
import React, { useEffect } from 'react';
import {
  AccessibilityInfo,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';

const CARD_SHADOW_SOFT = '0 6px 15px rgba(40, 55, 74, 0.06)';
const CALLOUT_SHADOW = '0 6px 15px rgba(34, 58, 88, 0.08)';

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ─── Buttons ─────────────────────────────────────────────────────────────────

interface ButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

interface PrimaryButtonProps extends ButtonProps {
  /**
   * When provided, a disabled button still catches taps — it stays visually
   * and semantically disabled (accessibilityState) — so the caller can
   * explain what's missing instead of silently swallowing the press.
   */
  onDisabledPress?: () => void;
}

export function PrimaryButton({
  label,
  onPress,
  disabled = false,
  onDisabledPress,
  testID,
  style,
}: PrimaryButtonProps) {
  const colors = useColors();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled && !onDisabledPress}
      onPress={() => {
        if (disabled) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          onDisabledPress?.();
          return;
        }
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      style={({ pressed }) => [
        styles.btn,
        { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
        disabled && { opacity: 0.35 },
        pressed && !disabled && { opacity: 0.85 },
        style,
      ]}
    >
      <Text style={[styles.btnText, { color: colors.primaryForeground }]}>{label}</Text>
    </Pressable>
  );
}

export function GhostButton({ label, onPress, disabled = false, testID, style }: ButtonProps) {
  const colors = useColors();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      disabled={disabled}
      onPress={() => {
        Haptics.selectionAsync();
        onPress();
      }}
      style={({ pressed }) => [
        styles.btn,
        {
          backgroundColor: colors.card,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: colors.radiusSm,
        },
        disabled && { opacity: 0.35 },
        pressed && !disabled && { opacity: 0.7 },
        style,
      ]}
    >
      <Text style={[styles.btnText, { color: colors.navy }]}>{label}</Text>
    </Pressable>
  );
}

// ─── Text fields ─────────────────────────────────────────────────────────────

export function FieldLabel({ text }: { text: string }) {
  const colors = useColors();
  return <Text style={[styles.fieldLabel, { color: colors.labelText }]}>{text.toUpperCase()}</Text>;
}

export function LedgerInput(props: TextInputProps & { testID?: string }) {
  const colors = useColors();
  return (
    <TextInput
      placeholderTextColor={colors.subtleText}
      {...props}
      style={[
        styles.input,
        {
          borderColor: colors.border,
          backgroundColor: colors.card,
          color: colors.navy,
          borderRadius: colors.radiusSm,
        },
        props.style,
      ]}
    />
  );
}

interface BigNumberInputProps {
  value: string;
  onChangeText: (v: string) => void;
  unit: string;
  testID?: string;
  placeholder?: string;
}

export function BigNumberInput({ value, onChangeText, unit, testID, placeholder }: BigNumberInputProps) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.bigWrap,
        {
          borderColor: colors.border,
          backgroundColor: colors.card,
          borderRadius: colors.radius,
          boxShadow: CARD_SHADOW_SOFT,
        },
      ]}
    >
      <TextInput
        testID={testID}
        value={value}
        onChangeText={onChangeText}
        keyboardType="decimal-pad"
        placeholder={placeholder ?? '0'}
        placeholderTextColor={colors.subtleText}
        maxLength={5}
        style={[styles.bigInput, { color: colors.navy }]}
      />
      <Text style={[styles.bigUnit, { color: colors.labelText }]}>{unit.toUpperCase()}</Text>
    </View>
  );
}

// ─── Selection widgets ───────────────────────────────────────────────────────

interface ChoiceCardProps {
  icon?: React.ComponentProps<typeof Feather>['name'];
  title: string;
  body?: string;
  selected: boolean;
  onPress: () => void;
  testID?: string;
}

export function ChoiceCard({ icon, title, body, selected, onPress, testID }: ChoiceCardProps) {
  const colors = useColors();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      onPress={() => {
        Haptics.selectionAsync();
        onPress();
      }}
      style={({ pressed }) => [
        styles.choiceCard,
        {
          backgroundColor: colors.card,
          borderColor: selected ? colors.cobalt : colors.border,
          borderWidth: selected ? 2 : 1,
          borderRadius: colors.radius,
          boxShadow: CARD_SHADOW_SOFT,
        },
        pressed && { opacity: 0.88 },
      ]}
    >
      {icon ? (
        <View
          style={[
            styles.choiceIcon,
            { backgroundColor: selected ? colors.cobalt : colors.accent },
          ]}
        >
          <Feather name={icon} size={16} color={selected ? colors.primaryForeground : colors.cobalt} />
        </View>
      ) : null}
      <View style={styles.choiceBody}>
        <Text style={[styles.choiceTitle, { color: colors.navy }]}>{title}</Text>
        {body ? <Text style={[styles.choiceText, { color: colors.subtleText }]}>{body}</Text> : null}
      </View>
      <View
        style={[
          styles.checkSquare,
          {
            borderColor: selected ? colors.cobalt : colors.border,
            backgroundColor: selected ? colors.cobalt : 'transparent',
          },
        ]}
      >
        {selected ? <Feather name="check" size={12} color={colors.primaryForeground} /> : null}
      </View>
    </Pressable>
  );
}

interface CheckRowProps {
  label: string;
  sub?: string;
  checked: boolean;
  onPress: () => void;
  testID?: string;
}

export function CheckRow({ label, sub, checked, onPress, testID }: CheckRowProps) {
  const colors = useColors();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      onPress={() => {
        Haptics.selectionAsync();
        onPress();
      }}
      style={({ pressed }) => [
        styles.checkRow,
        {
          backgroundColor: colors.card,
          borderColor: checked ? colors.cobalt : colors.border,
          borderWidth: checked ? 2 : 1,
          borderRadius: colors.radius,
        },
        pressed && { opacity: 0.88 },
      ]}
    >
      <View
        style={[
          styles.checkSquare,
          {
            borderColor: checked ? colors.cobalt : colors.border,
            backgroundColor: checked ? colors.cobalt : 'transparent',
          },
        ]}
      >
        {checked ? <Feather name="check" size={12} color={colors.primaryForeground} /> : null}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.checkLabel, { color: colors.navy }]}>{label}</Text>
        {sub ? <Text style={[styles.checkSub, { color: colors.subtleText }]}>{sub}</Text> : null}
      </View>
    </Pressable>
  );
}

interface ChipGridProps {
  options: { label: string; value: string }[];
  value: string | null;
  onChange: (value: string) => void;
  testIDPrefix?: string;
  /** flexBasis percentage per chip, e.g. '31%' for 3 columns. */
  basis?: `${number}%`;
}

export function ChipGrid({ options, value, onChange, testIDPrefix = 'chip', basis = '31%' }: ChipGridProps) {
  const colors = useColors();
  return (
    <View style={styles.chipWrap}>
      {options.map(opt => {
        const active = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            testID={`${testIDPrefix}-${slug(opt.value)}`}
            accessibilityRole="radio"
            accessibilityState={{ checked: active }}
            accessibilityLabel={opt.label}
            onPress={() => {
              Haptics.selectionAsync();
              onChange(opt.value);
            }}
            style={({ pressed }) => [
              styles.chip,
              { flexBasis: basis },
              {
                backgroundColor: active ? colors.cobalt : colors.card,
                borderColor: active ? colors.cobalt : colors.border,
                borderRadius: colors.radiusSm,
              },
              pressed && { opacity: 0.8 },
            ]}
          >
            <Text
              style={[styles.chipText, { color: active ? colors.primaryForeground : colors.bodyText }]}
              numberOfLines={1}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

interface StepperRowProps {
  label: string;
  display: string;
  onDec: () => void;
  onInc: () => void;
  decDisabled?: boolean;
  incDisabled?: boolean;
  testID?: string;
}

export function StepperRow({ label, display, onDec, onInc, decDisabled, incDisabled, testID }: StepperRowProps) {
  const colors = useColors();
  const btn = (
    icon: 'minus' | 'plus',
    onPress: () => void,
    disabled: boolean | undefined,
    id: string,
  ) => (
    <Pressable
      testID={id}
      accessibilityRole="button"
      accessibilityLabel={`${icon === 'minus' ? 'Decrease' : 'Increase'} ${label.toLowerCase()}`}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      hitSlop={4}
      onPress={() => {
        Haptics.selectionAsync();
        onPress();
      }}
      style={({ pressed }) => [
        styles.stepBtn,
        { borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radiusSm },
        disabled && { opacity: 0.3 },
        pressed && !disabled && { backgroundColor: colors.accent },
      ]}
    >
      <Feather name={icon} size={16} color={colors.navy} />
    </Pressable>
  );
  return (
    <View
      style={[
        styles.stepperRow,
        { borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radius },
      ]}
    >
      <Text style={[styles.fieldLabel, { color: colors.labelText, marginBottom: 0 }]}>{label.toUpperCase()}</Text>
      <View style={styles.stepperControls}>
        {btn('minus', onDec, decDisabled, `${testID}-dec`)}
        <Text style={[styles.stepperValue, { color: colors.navy }]}>{display}</Text>
        {btn('plus', onInc, incDisabled, `${testID}-inc`)}
      </View>
    </View>
  );
}

// ─── Informational ───────────────────────────────────────────────────────────

export function InfoCard({ label, body }: { label: string; body: string }) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.infoCard,
        { backgroundColor: colors.accent, borderColor: colors.border, borderRadius: colors.radiusSm },
      ]}
    >
      <Text style={[styles.fieldLabel, { color: colors.labelText }]}>{label.toUpperCase()}</Text>
      <Text style={[styles.infoBody, { color: colors.bodyText }]}>{body}</Text>
    </View>
  );
}

export function CoachCallout({ text }: { text: string }) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.coachWrap,
        {
          backgroundColor: colors.sidebarBg,
          borderColor: colors.activeBorder,
          borderRadius: colors.radius,
          boxShadow: CALLOUT_SHADOW,
        },
      ]}
    >
      <View style={[styles.coachBar, { backgroundColor: colors.cobalt }]} />
      <View style={styles.coachBody}>
        <Text style={[styles.coachLabel, { color: colors.bodyText }]}>COACH SARAH · CARE TEAM</Text>
        <Text style={[styles.coachText, { color: colors.navy }]}>{text}</Text>
      </View>
    </View>
  );
}

export function RequirementRow({ met, label }: { met: boolean; label: string }) {
  const colors = useColors();
  return (
    <View style={styles.reqRow}>
      <Feather
        name={met ? 'check-square' : 'square'}
        size={14}
        color={met ? colors.activeGreen : colors.subtleText}
      />
      <Text style={[styles.reqText, { color: met ? colors.navy : colors.subtleText }]}>{label}</Text>
    </View>
  );
}

export function ErrorBox({ message, testID }: { message: string; testID?: string }) {
  const colors = useColors();

  // Live regions cover Android (accessibilityLiveRegion) and web
  // (role="alert" + aria-live), but iOS has no live-region concept —
  // announce there explicitly whenever the message appears or changes.
  useEffect(() => {
    if (Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibility(message);
    }
  }, [message]);

  return (
    <View
      testID={testID}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[
        styles.errorBox,
        { backgroundColor: colors.riskBg, borderColor: colors.riskBorder, borderRadius: colors.radiusSm },
      ]}
    >
      <Feather name="alert-triangle" size={14} color={colors.riskText} />
      <Text style={[styles.errorText, { color: colors.riskText }]}>{message}</Text>
    </View>
  );
}

export function NoteText({ text, center = false }: { text: string; center?: boolean }) {
  const colors = useColors();
  return (
    <Text style={[styles.note, { color: colors.subtleText }, center && { textAlign: 'center' }]}>
      {text}
    </Text>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  btn: {
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnText: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.3,
    fontFamily: 'Inter_700Bold',
  },
  fieldLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    fontFamily: 'Inter_700Bold',
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: 'Inter_500Medium',
  },
  bigWrap: {
    borderWidth: 1,
    alignItems: 'center',
    paddingVertical: 18,
  },
  bigInput: {
    fontSize: 40,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    textAlign: 'center',
    minWidth: 140,
    letterSpacing: -1,
    padding: 0,
  },
  bigUnit: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    fontFamily: 'Inter_700Bold',
    marginTop: 4,
  },
  choiceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    marginBottom: 10,
    gap: 12,
  },
  choiceIcon: {
    width: 34,
    height: 34,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  choiceBody: {
    flex: 1,
  },
  choiceTitle: {
    fontSize: 16,
    fontFamily: 'PlayfairDisplay_600SemiBold',
  },
  choiceText: {
    fontSize: 11,
    lineHeight: 16,
    fontFamily: 'Inter_400Regular',
    marginTop: 2,
  },
  checkSquare: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    marginBottom: 8,
    gap: 12,
  },
  checkLabel: {
    fontSize: 15,
    fontFamily: 'PlayfairDisplay_600SemiBold',
  },
  checkSub: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    marginTop: 1,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    flexGrow: 1,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 6,
    alignItems: 'center',
  },
  chipText: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    padding: 12,
    marginBottom: 10,
  },
  stepperControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  stepBtn: {
    width: 40,
    height: 40,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperValue: {
    fontSize: 17,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    minWidth: 72,
    textAlign: 'center',
    letterSpacing: -0.3,
  },
  infoCard: {
    borderWidth: 1,
    padding: 12,
  },
  infoBody: {
    fontSize: 12,
    lineHeight: 18,
    fontFamily: 'Inter_400Regular',
  },
  coachWrap: {
    flexDirection: 'row',
    borderWidth: 1,
    overflow: 'hidden',
    marginBottom: 18,
  },
  coachBar: {
    width: 3,
  },
  coachBody: {
    flex: 1,
    padding: 12,
  },
  coachLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
    fontFamily: 'Inter_700Bold',
    marginBottom: 4,
  },
  coachText: {
    fontSize: 15,
    lineHeight: 22,
    fontFamily: 'PlayfairDisplay_600SemiBold',
  },
  reqRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
  },
  reqText: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    padding: 10,
  },
  errorText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    fontFamily: 'Inter_500Medium',
  },
  note: {
    fontSize: 11,
    lineHeight: 16,
    fontFamily: 'Inter_400Regular',
  },
});
