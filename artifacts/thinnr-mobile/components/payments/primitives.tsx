/**
 * Shared building blocks for the provider app's Payments area — the mobile
 * counterparts of the web area's primitives (StatusPill, SandboxBadge,
 * MoneyText, FeeBreakdown, DetailList, ErrorBox, DemoNotice, buttons, panels)
 * in the Heritage recipe: cream cards radius 9, hairline borders, Inter
 * labels, serif titles.
 *
 * Every interactive control here carries an accessibility role and a name
 * so the whole area reads correctly to screen readers and to the browser
 * tester on the Expo web build.
 */
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import theme, { fonts } from '@/constants/colors';
import { formatCents, type PillTone } from '@/lib/office-billing-format';
import type { FeeBreakdown as FeeBreakdownShape } from '@/lib/office-billing-types';

export const CARD_SHADOW_SOFT = '0 6px 15px rgba(40, 55, 74, 0.06)';

// ─── Status pill ─────────────────────────────────────────────────────────────

export function usePillTones(): Record<PillTone, { bg: string; border: string; text: string }> {
  const colors = useColors();
  return {
    neutral: { bg: colors.secondary, border: colors.border, text: colors.mutedForeground },
    good: { bg: colors.activeBg, border: colors.activeBorder, text: colors.activeGreen },
    warn: { bg: colors.warnBg, border: colors.warnBorder, text: colors.warnText },
    bad: { bg: colors.riskBg, border: colors.riskBorder, text: colors.riskText },
    info: { bg: '#eef3ff', border: '#b9c8e8', text: '#2b4a8f' },
  };
}

export function StatusPill({ tone, children, testID, style }: { tone: PillTone; children: string; testID?: string; style?: StyleProp<ViewStyle> }) {
  const tones = usePillTones()[tone];
  return (
    <View style={[styles.pill, { backgroundColor: tones.bg, borderColor: tones.border }, style]} testID={testID}>
      <Text style={[styles.pillText, { color: tones.text }]}>{children.toUpperCase()}</Text>
    </View>
  );
}

/** Loud environment marker: rendered whenever the API reports sandbox keys. */
export function SandboxBadge({ sandbox }: { sandbox: boolean | undefined }) {
  if (!sandbox) return null;
  return (
    <View style={styles.sandbox} testID="billing-sandbox-badge" accessibilityRole="text" accessibilityLabel="Sandbox, test payments only">
      <Feather name="alert-triangle" size={11} color="#b65c22" />
      <Text style={styles.sandboxText}>SANDBOX — TEST PAYMENTS ONLY</Text>
    </View>
  );
}

// ─── Money ───────────────────────────────────────────────────────────────────

export function MoneyText({ cents, signed, muted, style, testID }: { cents: number | null | undefined; signed?: boolean; muted?: boolean; style?: StyleProp<TextStyle>; testID?: string }) {
  const colors = useColors();
  const negative = typeof cents === 'number' && cents < 0;
  return (
    <Text
      testID={testID}
      style={[styles.money, { color: negative ? colors.riskText : muted ? colors.subtleText : colors.navy }, style]}
    >
      {formatCents(cents, { signed })}
    </Text>
  );
}

type FeeRow = { label: string; cents: number; hint?: string; emphasis?: boolean };

function FeeRows({ rows }: { rows: FeeRow[] }) {
  const colors = useColors();
  return (
    <View>
      {rows.map((row) => (
        <View key={row.label} style={styles.feeRow}>
          <Text style={[styles.feeLabel, { color: row.emphasis ? colors.navy : colors.bodyText }, row.emphasis && styles.feeEmphasis]}>
            {row.label}
            {row.hint ? <Text style={{ color: colors.subtleText }}> {row.hint}</Text> : null}
          </Text>
          <MoneyText cents={row.cents} signed={row.cents < 0} style={row.emphasis ? styles.feeEmphasis : undefined} />
        </View>
      ))}
    </View>
  );
}

/** The office's view of one order's money, identical rows to the web area. */
export function FeeBreakdown({ fees }: { fees: FeeBreakdownShape }) {
  const colors = useColors();
  const stripeActual = fees.stripe_fee_cents !== null;
  const rows: FeeRow[] = [
    { label: 'Subtotal', cents: fees.subtotal_cents },
    { label: 'Shipping', cents: fees.shipping_charge_cents },
    { label: 'Sales tax', cents: fees.tax_cents, hint: fees.tax_cents === 0 ? '(none collected)' : undefined },
    { label: 'Total charged', cents: fees.total_cents, emphasis: true },
    { label: 'THINNR share (60% of Retail MSRP)', cents: -fees.thinnr_share_cents },
    { label: 'THINNR shipping fee', cents: -fees.shipping_charge_cents },
    {
      label: 'Stripe processing',
      cents: -(stripeActual ? (fees.stripe_fee_cents as number) : fees.stripe_fee_estimate_cents),
      hint: stripeActual ? undefined : '(estimated)',
    },
    {
      label: 'Office net',
      cents: fees.office_net_cents ?? fees.office_net_estimate_cents,
      emphasis: true,
      hint: fees.office_net_cents === null ? '(estimated)' : undefined,
    },
  ];
  if (fees.application_fee_collected_cents !== null && fees.application_fee_collected_cents !== fees.application_fee_cents) {
    rows.splice(6, 0, { label: 'THINNR fee collected', cents: fees.application_fee_collected_cents, hint: '(differs from expected)' });
  }
  return (
    <View style={[styles.inset, { backgroundColor: colors.paperCardAlt, borderColor: colors.border }]} testID="billing-fee-breakdown">
      <FeeRows rows={rows} />
    </View>
  );
}

/** Key/value strip used for addresses, Stripe references, etc. */
export function DetailList({ items, testID }: { items: Array<{ label: string; value: string | React.ReactNode }>; testID?: string }) {
  const colors = useColors();
  return (
    <View style={styles.detailList} testID={testID}>
      {items.map((item) => (
        <View key={item.label} style={styles.detailItem}>
          <MicroLabel>{item.label}</MicroLabel>
          {typeof item.value === 'string' ? <Text style={[styles.detailValue, { color: colors.text }]}>{item.value}</Text> : item.value}
        </View>
      ))}
    </View>
  );
}

export function formatAddress(address: { name: string; line1: string; line2: string | null; city: string; state: string; postal_code: string; country: string; phone?: string | null }): string[] {
  return [
    address.name,
    address.line1,
    address.line2 ?? '',
    `${address.city}, ${address.state} ${address.postal_code}`,
    address.country !== 'US' ? address.country : '',
    address.phone ?? '',
  ].filter(Boolean);
}

// ─── Text ────────────────────────────────────────────────────────────────────

export function MicroLabel({ children, style }: { children: string; style?: StyleProp<TextStyle> }) {
  const colors = useColors();
  return <Text style={[styles.microLabel, { color: colors.labelText }, style]}>{children.toUpperCase()}</Text>;
}

export function Body({ children, style, testID, muted = true }: { children: React.ReactNode; style?: StyleProp<TextStyle>; testID?: string; muted?: boolean }) {
  const colors = useColors();
  return <Text testID={testID} style={[styles.body, { color: muted ? colors.mutedForeground : colors.text }, style]}>{children}</Text>;
}

// ─── Panels ──────────────────────────────────────────────────────────────────

export function Panel({ title, sub, action, children, style, testID }: { title?: string; sub?: string; action?: React.ReactNode; children: React.ReactNode; style?: StyleProp<ViewStyle>; testID?: string }) {
  const colors = useColors();
  return (
    <View testID={testID} style={[styles.panel, { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius, boxShadow: CARD_SHADOW_SOFT }, style]}>
      {title ? (
        <View style={[styles.panelHead, { borderBottomColor: colors.divider }]}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[styles.panelTitle, { color: colors.navy }]}>{title}</Text>
            {sub ? <Text style={[styles.panelSub, { color: colors.subtleText }]}>{sub}</Text> : null}
          </View>
          {action}
        </View>
      ) : null}
      <View style={styles.panelBody}>{children}</View>
    </View>
  );
}

export function MetricTile({ label, value, hint, tone = 'neutral', testID, style }: { label: string; value: string; hint?: string; tone?: 'neutral' | 'good' | 'warn' | 'bad'; testID?: string; style?: StyleProp<ViewStyle> }) {
  const colors = useColors();
  const valueColor = tone === 'good' ? '#2f7d4f' : tone === 'warn' ? colors.warnText : tone === 'bad' ? colors.riskText : colors.navy;
  return (
    <View testID={testID} style={[styles.tile, { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius, boxShadow: CARD_SHADOW_SOFT }, style]}>
      <MicroLabel>{label}</MicroLabel>
      <Text style={[styles.tileValue, { color: valueColor }]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
      {hint ? <Text style={[styles.tileHint, { color: colors.subtleText }]}>{hint}</Text> : null}
    </View>
  );
}

// ─── Buttons ─────────────────────────────────────────────────────────────────

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({ label, onPress, variant = 'secondary', disabled = false, busy = false, testID, accessibilityLabel, style, small = false, accessibilityHint }: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  small?: boolean;
}) {
  const colors = useColors();
  const blocked = disabled || busy;
  const palette =
    variant === 'primary'
      ? { bg: colors.cobalt, border: colors.cobalt, text: '#ffffff' }
      : variant === 'danger'
        ? { bg: colors.riskBg, border: colors.riskBorder, text: colors.riskText }
        : variant === 'ghost'
          ? { bg: 'transparent', border: 'transparent', text: colors.cobalt }
          : { bg: colors.card, border: colors.border, text: colors.navy };
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: blocked, busy }}
      aria-disabled={blocked}
      disabled={blocked}
      onPress={() => { if (!blocked) onPress(); }}
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        { backgroundColor: palette.bg, borderColor: palette.border, opacity: blocked ? 0.55 : pressed ? 0.8 : 1 },
        style,
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={palette.text} /> : null}
      <Text style={[styles.buttonText, small && styles.buttonTextSmall, { color: palette.text }]}>{label}</Text>
    </Pressable>
  );
}

/** Tab-style chips (filters, section pickers). Announced as a tab list. */
export function ChipRow<T extends string>({ options, value, onChange, label, testIDPrefix }: { options: readonly { label: string; value: T }[]; value: T; onChange: (value: T) => void; label: string; testIDPrefix: string }) {
  const colors = useColors();
  return (
    <View style={styles.chipRow} accessibilityRole="tablist" accessibilityLabel={label}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            testID={`${testIDPrefix}-${option.value}`}
            accessibilityRole="tab"
            accessibilityLabel={option.label}
            accessibilityState={{ selected: active }}
            aria-selected={active}
            onPress={() => onChange(option.value)}
            style={[styles.chip, { backgroundColor: active ? colors.navy : colors.card, borderColor: active ? colors.navy : colors.border }]}
          >
            <Text style={[styles.chipText, { color: active ? '#ffffff' : colors.bodyText }]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ─── States ──────────────────────────────────────────────────────────────────

export function ErrorBox({ error, retry, testID = 'billing-error' }: { error: unknown; retry?: () => void; testID?: string }) {
  const colors = useColors();
  return (
    <View
      testID={testID}
      accessibilityRole="alert"
      aria-live="assertive"
      style={[styles.panel, styles.errorBox, { backgroundColor: colors.card, borderColor: colors.riskBorder, borderRadius: colors.radius }]}
    >
      <Text style={[styles.body, { color: colors.riskText }]}>{error instanceof Error ? error.message : 'Payments could not be loaded.'}</Text>
      {retry ? <Button label="Try again" onPress={retry} small testID={`${testID}-retry`} style={{ alignSelf: 'flex-start', marginTop: 10 }} /> : null}
    </View>
  );
}

export function LoadingBox({ label = 'Loading payments…', testID = 'billing-loading' }: { label?: string; testID?: string }) {
  const colors = useColors();
  return (
    <View testID={testID} style={styles.loading} accessibilityRole="progressbar" accessibilityLabel={label}>
      <ActivityIndicator color={colors.cobalt} />
      <Text style={[styles.body, { color: colors.subtleText }]}>{label}</Text>
    </View>
  );
}

export function DemoNotice() {
  const colors = useColors();
  return (
    <View testID="billing-demo-notice" accessibilityRole="text" style={[styles.notice, { backgroundColor: colors.accent, borderColor: colors.activeBorder }]}>
      <Text style={[styles.body, { color: colors.text }]}>Live payments appear here once your office is signed in.</Text>
    </View>
  );
}

export function InlineNotice({ children, tone = 'info', testID }: { children: string; tone?: 'info' | 'good' | 'bad' | 'warn'; testID?: string }) {
  const tones = usePillTones()[tone === 'info' ? 'info' : tone];
  return (
    <View testID={testID} accessibilityRole={tone === 'bad' ? 'alert' : 'text'} aria-live="polite" style={[styles.notice, { backgroundColor: tones.bg, borderColor: tones.border }]}>
      <Text style={[styles.body, { color: tones.text }]}>{children}</Text>
    </View>
  );
}

export function Empty({ children, testID }: { children: string; testID?: string }) {
  const colors = useColors();
  return <Text testID={testID} style={[styles.body, styles.empty, { color: colors.subtleText }]}>{children}</Text>;
}

/** Simple "Page N of M" pager for the paged lists (Transactions, Activity, …). */
export function Pager({ page, pageSize, total, onPage, testIDPrefix = 'pager' }: { page: number; pageSize: number; total: number; onPage: (page: number) => void; testIDPrefix?: string }) {
  const colors = useColors();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <View style={styles.pager} accessibilityRole="toolbar" accessibilityLabel="Pages">
      <Button small label="Previous" testID={`${testIDPrefix}-prev`} disabled={page <= 1} onPress={() => onPage(page - 1)} />
      <Text style={[styles.body, { color: colors.subtleText }]} testID={`${testIDPrefix}-label`}>Page {page} of {pages}</Text>
      <Button small label="Next" testID={`${testIDPrefix}-next`} disabled={page >= pages} onPress={() => onPage(page + 1)} />
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 4, paddingHorizontal: 7, paddingVertical: 2 },
  pillText: { fontSize: 9, fontFamily: 'Inter_700Bold', letterSpacing: 0.6 },
  sandbox: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', borderWidth: 1, borderColor: '#e8b47c', backgroundColor: '#fff4e6', borderRadius: 4, paddingHorizontal: 8, paddingVertical: 4 },
  sandboxText: { fontSize: 9, fontFamily: 'Inter_700Bold', letterSpacing: 1.2, color: '#b65c22' },
  money: { fontSize: 13, fontFamily: 'Inter_600SemiBold', fontVariant: ['tabular-nums'] },
  feeRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingVertical: 5 },
  feeLabel: { fontSize: 12, fontFamily: 'Inter_400Regular', flex: 1 },
  feeEmphasis: { fontFamily: 'Inter_700Bold' },
  inset: { borderWidth: 1, borderRadius: theme.radiusSm, paddingHorizontal: 12, paddingVertical: 4 },
  detailList: { gap: 10 },
  detailItem: { gap: 2 },
  detailValue: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  microLabel: { fontSize: 9, fontFamily: 'Inter_700Bold', letterSpacing: 1.2 },
  body: { fontSize: 12, lineHeight: 18, fontFamily: 'Inter_400Regular' },
  panel: { borderWidth: 1, overflow: 'hidden' },
  panelHead: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1 },
  panelTitle: { fontSize: 15, fontFamily: fonts.serif },
  panelSub: { fontSize: 11, marginTop: 2, fontFamily: 'Inter_400Regular' },
  panelBody: { padding: 14, gap: 10 },
  tile: { borderWidth: 1, padding: 12, gap: 4, flexGrow: 1, flexBasis: '46%' },
  tileValue: { fontSize: 20, fontFamily: fonts.serif, fontVariant: ['tabular-nums'] },
  tileHint: { fontSize: 10, fontFamily: 'Inter_400Regular' },
  button: { minHeight: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1, borderRadius: theme.radiusSm, paddingHorizontal: 14, paddingVertical: 8 },
  buttonSmall: { minHeight: 32, paddingHorizontal: 10, paddingVertical: 5 },
  buttonText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  buttonTextSmall: { fontSize: 12 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { minHeight: 32, justifyContent: 'center', paddingHorizontal: 11, paddingVertical: 6, borderWidth: 1, borderRadius: theme.radiusSm },
  chipText: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },
  errorBox: { padding: 14 },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 16 },
  notice: { borderWidth: 1, borderRadius: theme.radiusSm, paddingHorizontal: 12, paddingVertical: 10 },
  empty: { paddingVertical: 12 },
  pager: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingTop: 6 },
});
