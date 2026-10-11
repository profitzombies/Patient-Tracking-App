/**
 * Layout primitives shared by the auth entry screens. Every gap here comes
 * from the 8-point scale so the four screens share one rhythm:
 *
 *   FormCard        card interior padding md, fields stacked md apart
 *   Field           label (sm below) + input, optional right-aligned link
 *   ActionGroup     primary action with xl above, secondary md below
 *   FeedbackSlot    dev code / notice / error, md below the action
 *   OptionCard      roomy tappable choice (signup "how are you joining?")
 *   FooterLink      centered text CTA in the page footer
 *   QuietLinkRow    quiet "A · B" text-link pair
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle, type TextStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';
import { ErrorBox, FieldLabel } from '@/components/onboarding/OnboardingFields';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { space } from '@/constants/spacing';

export function FormCard({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <LedgerCard style={[styles.formCard, style]}>{children}</LedgerCard>;
}

/** Vertical stack whose children sit `md` apart. */
export function FieldStack({ children }: { children: React.ReactNode }) {
  return <View style={styles.fieldStack}>{children}</View>;
}

type InlineAction = { label: string; onPress: () => void; testID?: string };

export function Field({
  label,
  children,
  hint,
  link,
  labelAction,
}: {
  label: string;
  children: React.ReactNode;
  /** Quiet helper line under the input. */
  hint?: React.ReactNode;
  /** Right-aligned inline text action under the input (switch channel, forgot). */
  link?: InlineAction;
  /**
   * Right-aligned text action on the label row itself (e.g. "Forgot
   * password?"). Keeps the stack label → input → label → input with nothing
   * hanging between fields.
   */
  labelAction?: InlineAction;
}) {
  const colors = useColors();
  return (
    <View>
      {labelAction ? (
        <View style={styles.labelRow}>
          <FieldLabel text={label} />
          <Pressable
            testID={labelAction.testID}
            accessibilityRole="button"
            onPress={labelAction.onPress}
            style={styles.labelActionHit}
            hitSlop={space.sm}
          >
            <Text style={[styles.inlineLink, { color: colors.cobalt }]}>{labelAction.label}</Text>
          </Pressable>
        </View>
      ) : (
        <FieldLabel text={label} />
      )}
      {children}
      {hint ? <View style={styles.hint}>{hint}</View> : null}
      {link ? (
        <View style={styles.linkRow}>
          <Pressable testID={link.testID} accessibilityRole="button" onPress={link.onPress} style={styles.linkHit} hitSlop={space.xs}>
            <Text style={[styles.inlineLink, { color: colors.cobalt }]}>{link.label}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

/** Holds the primary action (and an optional secondary) below a field stack. */
export function ActionGroup({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.actions, style]}>{children}</View>;
}

export function SecondaryButton({
  label,
  onPress,
  testID,
  accessibilityLabel,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  testID?: string;
  accessibilityLabel?: string;
  disabled?: boolean;
}) {
  const colors = useColors();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => {
        Haptics.selectionAsync();
        onPress();
      }}
      style={({ pressed }) => [
        styles.secondary,
        { borderColor: colors.cobalt, backgroundColor: colors.card, borderRadius: colors.radiusSm },
        disabled && { opacity: 0.35 },
        pressed && !disabled && { opacity: 0.7 },
      ]}
    >
      <Text style={[styles.secondaryText, { color: colors.cobalt }]}>{label}</Text>
    </Pressable>
  );
}

/**
 * Dev code, live notice, and error sit in one slot under the action so
 * feedback never shoves the fields around. Renders nothing when empty.
 */
export function FeedbackSlot({
  devCode,
  devCodeTestID,
  notice,
  noticeTestID,
  error,
  errorTestID,
}: {
  devCode?: string | null;
  devCodeTestID?: string;
  notice?: string | null;
  noticeTestID?: string;
  error?: string | null;
  errorTestID?: string;
}) {
  const colors = useColors();
  if (!devCode && !notice && !error) return null;
  return (
    <View style={styles.feedback}>
      {devCode ? (
        <Text testID={devCodeTestID} style={[styles.feedbackText, { color: colors.subtleText }]}>
          Dev delivery mode — your code is {devCode}.
        </Text>
      ) : null}
      {notice ? (
        <Text testID={noticeTestID} accessibilityLiveRegion="polite" style={[styles.feedbackText, { color: colors.activeGreen }]}>
          {notice}
        </Text>
      ) : null}
      {error ? <ErrorBox testID={errorTestID} message={error} /> : null}
    </View>
  );
}

/**
 * Two-way segmented choice (e.g. Phone | Email) that sits above a field
 * stack. One decision, made once, instead of a "use X instead" link hanging
 * under the input. The inactive segment carries `switchTestID` so pressing
 * it is always "switch to the other channel".
 *
 * Semantics: a named group of toggle buttons (aria-pressed), not a tablist.
 * Buttons get Enter AND Space activation from RN-web's press responder for
 * free; tabs would owe roving focus + arrow keys that nothing here provides.
 */
export function SegmentedToggle<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
  testIDPrefix,
  switchTestID,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  accessibilityLabel: string;
  testIDPrefix: string;
  switchTestID?: string;
}) {
  const colors = useColors();
  return (
    <View
      role="group"
      accessibilityLabel={accessibilityLabel}
      style={[styles.segmented, { backgroundColor: colors.accent, borderRadius: colors.radius }]}
    >
      {options.map(option => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            testID={selected ? `${testIDPrefix}-${option.value}` : switchTestID ?? `${testIDPrefix}-${option.value}`}
            accessibilityRole="button"
            accessibilityLabel={option.label}
            accessibilityState={{ selected }}
            aria-pressed={selected}
            onPress={() => {
              if (selected) return;
              Haptics.selectionAsync();
              onChange(option.value);
            }}
            style={({ pressed }) => [
              styles.segment,
              { borderRadius: colors.radiusSm },
              selected && { backgroundColor: colors.card, boxShadow: '0 1px 2px rgba(32, 59, 100, 0.10)' },
              pressed && !selected && { opacity: 0.7 },
            ]}
          >
            <Text style={[styles.segmentText, { color: selected ? colors.navy : colors.bodyText }]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function OptionCard({
  icon,
  title,
  body,
  onPress,
  testID,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  title: string;
  body: string;
  onPress: () => void;
  testID?: string;
}) {
  const colors = useColors();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={body}
      onPress={() => {
        Haptics.selectionAsync();
        onPress();
      }}
      style={({ pressed }) => [
        styles.option,
        { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius },
        pressed && { borderColor: colors.cobalt, backgroundColor: colors.paperCardAlt },
      ]}
    >
      <View style={[styles.optionIcon, { backgroundColor: colors.accent, borderRadius: colors.radiusSm }]}>
        <Feather name={icon} size={18} color={colors.cobalt} />
      </View>
      <View style={styles.optionBody}>
        <Text style={[styles.optionTitle, { color: colors.navy }]}>{title}</Text>
        <Text style={[styles.optionText, { color: colors.bodyText }]}>{body}</Text>
      </View>
      <Feather name="chevron-right" size={18} color={colors.labelText} />
    </Pressable>
  );
}

export function FooterLink({
  label,
  onPress,
  testID,
  quiet = false,
  disabled = false,
  style,
  textStyle,
}: {
  label: string;
  onPress: () => void;
  testID?: string;
  quiet?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}) {
  const colors = useColors();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.footerHit, style, disabled && { opacity: 0.5 }]}
      hitSlop={space.xs}
    >
      <Text style={[quiet ? styles.quietLink : styles.footerCta, { color: quiet ? colors.subtleText : colors.cobalt }, textStyle]}>{label}</Text>
    </Pressable>
  );
}

export function QuietLinkRow({ children }: { children: React.ReactNode }) {
  const colors = useColors();
  const items = React.Children.toArray(children);
  return (
    <View style={styles.quietRow}>
      {items.map((child, index) => (
        <React.Fragment key={index}>
          {index > 0 ? <Text style={[styles.quietDot, { color: colors.labelText }]}>·</Text> : null}
          {child}
        </React.Fragment>
      ))}
    </View>
  );
}

/**
 * Live password rules checklist — each rule ticks as it is met. Rules come
 * from lib/password-rules (the mirror of the server's password check).
 */
export function PasswordChecklist({
  checks,
  testIDPrefix,
}: {
  checks: ReadonlyArray<{ key: string; label: string; met: boolean }>;
  testIDPrefix: string;
}) {
  const colors = useColors();
  return (
    <View style={styles.checklist} accessibilityRole="list">
      {checks.map(rule => (
        <View
          key={rule.key}
          testID={`${testIDPrefix}-${rule.key}`}
          style={styles.checkRow}
          accessible
          accessibilityLabel={`${rule.label}: ${rule.met ? 'done' : 'not yet'}`}
          accessibilityState={{ checked: rule.met }}
        >
          <Feather
            name={rule.met ? 'check-circle' : 'circle'}
            size={14}
            color={rule.met ? colors.activeGreen : colors.labelText}
          />
          <Text style={[styles.checkText, { color: rule.met ? colors.navy : colors.subtleText }]}>{rule.label}</Text>
        </View>
      ))}
    </View>
  );
}

export function Footnote({ text }: { text: string }) {
  const colors = useColors();
  return <Text style={[styles.footnote, { color: colors.subtleText }]}>{text}</Text>;
}

const styles = StyleSheet.create({
  formCard: { padding: space.md },
  fieldStack: { gap: space.md },
  hint: { marginTop: space.sm },
  linkRow: { alignItems: 'flex-end', marginTop: space.sm },
  linkHit: { paddingVertical: space.xs, paddingHorizontal: space.xs },
  // The label carries its own sm bottom margin; the action pads to the same
  // baseline so both sit on one line above the input.
  labelRow: { flexDirection: 'row', flexWrap: 'wrap', columnGap: space.sm, justifyContent: 'space-between', alignItems: 'flex-end' },
  labelActionHit: { paddingTop: space.xs, paddingBottom: space.sm, paddingHorizontal: space.xs, marginRight: -space.xs },
  inlineLink: { fontSize: 13, fontFamily: fonts.sansSemiBold },
  segmented: { flexDirection: 'row', padding: space.xs, gap: space.xs },
  segment: { flex: 1, minHeight: 40, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.sm },
  segmentText: { fontSize: 14, fontFamily: fonts.sansSemiBold },
  actions: { marginTop: space.lg, gap: space.md },
  secondary: { borderWidth: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingVertical: 14 },
  secondaryText: { fontSize: 14, fontFamily: fonts.sansBold, letterSpacing: 0.3 },
  feedback: { marginTop: space.md, gap: space.sm },
  checklist: { marginTop: space.sm, gap: 6 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  checkText: { fontSize: 12, fontFamily: fonts.sansMedium },
  feedbackText: { fontSize: 13.5, lineHeight: 20, fontFamily: fonts.sans },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderWidth: 1,
    padding: space.md,
    minHeight: 88,
  },
  optionIcon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  optionBody: { flex: 1, gap: space.xs },
  optionTitle: { fontSize: 16, lineHeight: 21, fontFamily: fonts.sansBold },
  optionText: { fontSize: 13.5, lineHeight: 19, fontFamily: fonts.sans },
  footerHit: { paddingVertical: space.sm, paddingHorizontal: space.sm },
  footerCta: { fontSize: 14, fontFamily: fonts.sansBold, textAlign: 'center' },
  quietLink: { fontSize: 13, fontFamily: fonts.sansSemiBold },
  quietRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs },
  quietDot: { fontSize: 13, fontFamily: fonts.sansBold },
  footnote: { fontSize: 12.5, lineHeight: 18, fontFamily: fonts.sans, textAlign: 'center', marginTop: space.sm },
});
