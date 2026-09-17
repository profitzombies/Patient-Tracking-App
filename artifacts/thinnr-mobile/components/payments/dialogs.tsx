/**
 * Shared dialog + input building blocks for the Payments area's write flows
 * (refund, cancel/pause/change subscription, price edits, payment links,
 * sell to patient). One sheet implementation so every dialog announces the
 * same way: a modal with a titled header, a named Close control, and a
 * footer of Buttons. Content scrolls inside the sheet on short phones.
 */
import React, { type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { AppModal } from '@/components/ui/AppModal';
import { OrdinaryTextInput } from '@/components/ui/OrdinaryTextInput';
import { useColors } from '@/hooks/useColors';
import theme, { fonts } from '@/constants/colors';
import { parseDollarsToCents } from '@/lib/office-billing-format';
import { MicroLabel } from './primitives';

export function Sheet({ open, onClose, title, sub, children, footer, testID = 'payments-sheet', closeLabel = 'Close' }: {
  open: boolean;
  onClose: () => void;
  title: string;
  sub?: string;
  children: ReactNode;
  footer?: ReactNode;
  testID?: string;
  closeLabel?: string;
}) {
  const colors = useColors();
  if (!open) return null;
  return (
    <AppModal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable accessibilityRole="button" accessibilityLabel={closeLabel} testID={`${testID}-backdrop`} onPress={onClose} style={StyleSheet.absoluteFill} />
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.sheetWrap} pointerEvents="box-none">
          <View
            testID={testID}
            accessibilityViewIsModal
            aria-modal
            accessibilityRole="none"
            style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius }]}
          >
            <View style={[styles.sheetHead, { borderBottomColor: colors.divider }]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text accessibilityRole="header" testID={`${testID}-title`} style={[styles.sheetTitle, { color: colors.navy }]}>{title}</Text>
                {sub ? <Text style={[styles.sheetSub, { color: colors.subtleText }]}>{sub}</Text> : null}
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel={closeLabel} testID={`${testID}-close`} onPress={onClose} hitSlop={8} style={styles.closeButton}>
                <Feather name="x" size={18} color={colors.mutedForeground} />
              </Pressable>
            </View>
            <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetBody} keyboardShouldPersistTaps="handled">
              {children}
            </ScrollView>
            {footer ? <View style={[styles.sheetFooter, { borderTopColor: colors.divider }]}>{footer}</View> : null}
          </View>
        </KeyboardAvoidingView>
      </View>
    </AppModal>
  );
}

/** Labelled text field in the Heritage recipe; the label doubles as the accessible name. */
export function Field({ label, value, onChangeText, placeholder, keyboardType = 'default', invalid, hint, testID, editable = true, multiline = false, autoCapitalize = 'sentences', style }: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'decimal-pad' | 'number-pad' | 'email-address' | 'phone-pad';
  invalid?: boolean;
  hint?: string;
  testID?: string;
  editable?: boolean;
  multiline?: boolean;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  style?: StyleProp<ViewStyle>;
}) {
  const colors = useColors();
  return (
    <View style={[styles.field, style]}>
      <MicroLabel>{label}</MicroLabel>
      <OrdinaryTextInput
        testID={testID}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.subtleText}
        keyboardType={keyboardType}
        editable={editable}
        multiline={multiline}
        autoCapitalize={autoCapitalize}
        accessibilityLabel={label}
        aria-invalid={invalid || undefined}
        style={[
          styles.input,
          multiline && styles.inputMultiline,
          { color: colors.text, borderColor: invalid ? colors.riskBorder : colors.border, backgroundColor: editable ? colors.card : colors.paperCardAlt },
        ]}
      />
      {hint ? <Text style={[styles.hint, { color: invalid ? colors.riskText : colors.subtleText }]}>{hint}</Text> : null}
    </View>
  );
}

/** `$` prefixed dollars field; the value is plain dollars text the caller owns (wire contract stays integer cents). */
export function MoneyField({ label, value, onChangeText, invalid, hint, testID, editable = true, onBlurNormalize = true }: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  invalid?: boolean;
  hint?: string;
  testID?: string;
  editable?: boolean;
  onBlurNormalize?: boolean;
}) {
  const colors = useColors();
  return (
    <View style={styles.field}>
      <MicroLabel>{label}</MicroLabel>
      <View style={[styles.moneyWrap, { borderColor: invalid ? colors.riskBorder : colors.border, backgroundColor: editable ? colors.card : colors.paperCardAlt }]}>
        <Text style={[styles.moneyPrefix, { color: invalid ? colors.riskText : colors.mutedForeground }]}>$</Text>
        <OrdinaryTextInput
          testID={testID}
          value={value}
          onChangeText={onChangeText}
          onBlur={() => { if (onBlurNormalize) onChangeText(normalizeDollarsInput(value)); }}
          placeholder="0.00"
          placeholderTextColor={colors.subtleText}
          keyboardType="decimal-pad"
          inputMode="decimal"
          editable={editable}
          accessibilityLabel={`${label}, dollars`}
          aria-invalid={invalid || undefined}
          style={[styles.moneyInput, { color: colors.text }]}
        />
      </View>
      {hint ? <Text style={[styles.hint, { color: invalid ? colors.riskText : colors.subtleText }]}>{hint}</Text> : null}
    </View>
  );
}

/** Blur formatter: "9" → "9.00", "$1,250.5" → "1250.50"; unparseable text is returned untouched. */
export function normalizeDollarsInput(value: string): string {
  const parsed = parseDollarsToCents(value);
  return parsed.ok ? (parsed.cents / 100).toFixed(2) : value;
}

/** Labelled on/off switch rendered as an announced checkbox (works identically on web and native). */
export function Toggle({ label, value, onChange, disabled, testID, hint }: { label: string; value: boolean; onChange: (next: boolean) => void; disabled?: boolean; testID?: string; hint?: string }) {
  const colors = useColors();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      aria-checked={value}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={() => { if (!disabled) onChange(!value); }}
      style={[styles.toggleRow, disabled && { opacity: 0.55 }]}
    >
      <View style={[styles.checkbox, { borderColor: value ? colors.cobalt : colors.border, backgroundColor: value ? colors.cobalt : colors.card }]}>
        {value ? <Feather name="check" size={12} color="#ffffff" /> : null}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.toggleLabel, { color: colors.text }]}>{label}</Text>
        {hint ? <Text style={[styles.hint, { color: colors.subtleText }]}>{hint}</Text> : null}
      </View>
    </Pressable>
  );
}

/** Radio group rendered as announced radio buttons. */
export function RadioGroup<T extends string>({ label, options, value, onChange, disabled, testIDPrefix }: {
  label: string;
  options: readonly { value: T; label: string; hint?: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  testIDPrefix: string;
}) {
  const colors = useColors();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.field}>
      <MicroLabel>{label}</MicroLabel>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <Pressable
            key={option.value}
            testID={`${testIDPrefix}-${option.value}`}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ checked: on, disabled }}
            aria-checked={on}
            aria-disabled={disabled}
            disabled={disabled}
            onPress={() => { if (!disabled) onChange(option.value); }}
            style={[styles.toggleRow, disabled && { opacity: 0.55 }]}
          >
            <View style={[styles.radio, { borderColor: on ? colors.cobalt : colors.border }]}>
              {on ? <View style={[styles.radioDot, { backgroundColor: colors.cobalt }]} /> : null}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.toggleLabel, { color: colors.text }]}>{option.label}</Text>
              {option.hint ? <Text style={[styles.hint, { color: colors.subtleText }]}>{option.hint}</Text> : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(24, 32, 48, 0.45)', justifyContent: 'flex-end' },
  sheetWrap: { justifyContent: 'flex-end', maxHeight: '92%' },
  sheet: { borderWidth: 1, borderBottomWidth: 0, borderBottomLeftRadius: 0, borderBottomRightRadius: 0, maxHeight: '100%' },
  sheetHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10, borderBottomWidth: 1 },
  sheetTitle: { fontSize: 18, fontFamily: fonts.serifBold, lineHeight: 24 },
  sheetSub: { fontSize: 11, marginTop: 2, fontFamily: 'Inter_400Regular', lineHeight: 16 },
  closeButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  sheetScroll: { flexGrow: 0 },
  sheetBody: { padding: 16, gap: 12 },
  sheetFooter: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, padding: 12, borderTopWidth: 1, paddingBottom: Platform.OS === 'web' ? 12 : 24 },
  field: { gap: 5 },
  input: { minHeight: 40, borderWidth: 1, borderRadius: theme.radiusSm, paddingHorizontal: 12, paddingVertical: 9, fontSize: 13, fontFamily: 'Inter_400Regular' },
  inputMultiline: { minHeight: 72, textAlignVertical: 'top' },
  hint: { fontSize: 11, lineHeight: 15, fontFamily: 'Inter_400Regular' },
  moneyWrap: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: theme.radiusSm, paddingLeft: 12 },
  moneyPrefix: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  moneyInput: { flex: 1, minHeight: 40, paddingHorizontal: 8, paddingVertical: 9, fontSize: 13, fontFamily: 'Inter_400Regular', fontVariant: ['tabular-nums'] },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 36, paddingVertical: 4 },
  checkbox: { width: 20, height: 20, borderRadius: 5, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  toggleLabel: { fontSize: 13, fontFamily: 'Inter_500Medium' },
});
