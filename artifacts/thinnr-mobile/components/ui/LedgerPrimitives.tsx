/**
 * Shared Heritage primitive components.
 * All colors come from useColors(). Heritage geometry: cards radius 9 with
 * hairline borders and soft shadows; controls radius 7; progress bars stay
 * square. Serif (Playfair) carries titles; Inter carries labels and body.
 */
import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type PressableProps,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';

const CARD_SHADOW = '0 8px 20px rgba(40, 55, 74, 0.07)';
const CARD_SHADOW_SOFT = '0 6px 15px rgba(40, 55, 74, 0.06)';

// ─── LedgerCard ──────────────────────────────────────────────────────────────

interface LedgerCardProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  /** Renders the thin cobalt top accent strip used on featured cards. */
  accentTop?: boolean;
  testID?: string;
}

export function LedgerCard({ children, style, onPress, accentTop = false, testID }: LedgerCardProps) {
  const colors = useColors();
  const base: ViewStyle = {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: colors.radius,
    overflow: 'hidden',
    boxShadow: CARD_SHADOW,
  };
  const strip = accentTop ? (
    <View style={{ height: 3, backgroundColor: colors.cobalt }} />
  ) : null;
  if (onPress) {
    return (
      <Pressable
        testID={testID}
        onPress={onPress}
        style={({ pressed }) => [base, pressed && { opacity: 0.88 }, style]}
      >
        {strip}
        {children}
      </Pressable>
    );
  }
  return (
    <View testID={testID} style={[base, style]}>
      {strip}
      {children}
    </View>
  );
}

// ─── SectionHeader ────────────────────────────────────────────────────────────

interface SectionHeaderProps {
  label: string;
  value?: string;
  action?: { label: string; onPress: () => void };
  style?: StyleProp<ViewStyle>;
}

export function SectionHeader({ label, value, action, style }: SectionHeaderProps) {
  const colors = useColors();
  return (
    <View style={[styles.sectionHeaderRow, style]}>
      <View>
        <Text style={[styles.sectionLabel, { color: colors.labelText }]}>{label.toUpperCase()}</Text>
        {value ? <Text style={[styles.sectionValue, { color: colors.navyLight }]}>{value}</Text> : null}
      </View>
      {action ? (
        <Pressable onPress={action.onPress} style={({ pressed }) => [pressed && { opacity: 0.7 }]}>
          <Text style={[styles.sectionAction, { color: colors.cobalt }]}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// ─── MetricCard ───────────────────────────────────────────────────────────────

interface MetricCardProps {
  label: string;
  value: string;
  change: string;
  detail: string;
  warning?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function MetricCard({ label, value, change, detail, warning = false, style }: MetricCardProps) {
  const colors = useColors();
  return (
    <View
      style={[
        {
          backgroundColor: colors.card,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: colors.radius,
          boxShadow: CARD_SHADOW_SOFT,
          padding: 16,
        },
        style,
      ]}
    >
      <View style={styles.metricTopRow}>
        <Text style={[styles.metricLabel, { color: colors.labelText }]}>{label.toUpperCase()}</Text>
        <View
          style={[
            styles.metricBadge,
            {
              backgroundColor: warning ? colors.warnBg : colors.activeBg,
              borderColor: warning ? colors.warnBorder : colors.activeBorder,
            },
          ]}
        >
          <Text style={[styles.metricBadgeText, { color: warning ? colors.warnText : colors.activeGreen }]}>
            {change}
          </Text>
        </View>
      </View>
      <Text style={[styles.metricValue, { color: colors.navy }]}>{value}</Text>
      <Text style={[styles.metricDetail, { color: colors.subtleText }]}>{detail}</Text>
    </View>
  );
}

// ─── StatusBadge ──────────────────────────────────────────────────────────────

interface StatusBadgeProps {
  status: string;
  style?: StyleProp<ViewStyle>;
}

export function StatusBadge({ status, style }: StatusBadgeProps) {
  const colors = useColors();
  const isHealthy = status === 'active' || status === 'graduated';
  const isWatch = status === 'paused';

  const bg = isHealthy ? colors.activeBg : isWatch ? colors.warnBg : colors.riskBg;
  const border = isHealthy ? colors.activeBorder : isWatch ? colors.warnBorder : colors.riskBorder;
  const textColor = isHealthy ? colors.activeGreen : isWatch ? colors.warnText : colors.riskText;

  return (
    <View style={[styles.badge, { backgroundColor: bg, borderColor: border, borderWidth: 1 }, style]}>
      <View style={[styles.badgeDot, { backgroundColor: textColor }]} />
      <Text style={[styles.badgeText, { color: textColor }]}>{status.toUpperCase()}</Text>
    </View>
  );
}

// ─── ProgressBar ──────────────────────────────────────────────────────────────

interface ProgressBarProps {
  value: number; // 0-100
  color?: string;
  style?: StyleProp<ViewStyle>;
}

export function ProgressBar({ value, color, style }: ProgressBarProps) {
  const colors = useColors();
  const clipped = Math.min(100, Math.max(0, value));
  // Deliberately square: Heritage keeps progress bars as crisp hairline rules.
  return (
    <View style={[{ height: 8, backgroundColor: colors.track, overflow: 'hidden' }, style]}>
      <View
        style={{
          height: '100%',
          width: `${clipped}%`,
          backgroundColor: color ?? colors.cobalt,
        }}
      />
    </View>
  );
}

// ─── PillSelector ─────────────────────────────────────────────────────────────

interface PillSelectorProps<T extends string> {
  options: { label: string; value: T }[];
  selected: T;
  onSelect: (value: T) => void;
  style?: StyleProp<ViewStyle>;
}

export function PillSelector<T extends string>({
  options,
  selected,
  onSelect,
  style,
}: PillSelectorProps<T>) {
  const colors = useColors();
  return (
    <View
      style={[styles.pillRow, { borderColor: colors.border, borderRadius: colors.radiusSm }, style]}
    >
      {options.map(opt => {
        const isActive = opt.value === selected;
        return (
          <Pressable
            key={opt.value}
            testID={`pill-${opt.value}`}
            onPress={() => {
              Haptics.selectionAsync();
              onSelect(opt.value);
            }}
            style={({ pressed }) => [
              styles.pillItem,
              {
                backgroundColor: isActive ? colors.cobalt : colors.card,
                borderColor: colors.border,
              },
              pressed && { opacity: 0.8 },
            ]}
          >
            <Text
              style={[
                styles.pillText,
                { color: isActive ? colors.primaryForeground : colors.bodyText },
              ]}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ─── EmptyState ───────────────────────────────────────────────────────────────

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  body?: string;
}

export function EmptyState({ icon, title, body }: EmptyStateProps) {
  const colors = useColors();
  return (
    <View style={styles.emptyContainer}>
      {icon}
      <Text style={[styles.emptyTitle, { color: colors.navyLight }]}>{title}</Text>
      {body ? <Text style={[styles.emptyBody, { color: colors.subtleText }]}>{body}</Text> : null}
    </View>
  );
}

// ─── IconButton ───────────────────────────────────────────────────────────────

interface IconButtonProps extends PressableProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function IconButton({ children, style, testID, ...rest }: IconButtonProps) {
  const colors = useColors();
  return (
    <Pressable
      testID={testID}
      {...rest}
      style={({ pressed }) => [
        styles.iconBtn,
        {
          backgroundColor: pressed ? colors.accent : colors.card,
          borderColor: colors.border,
          borderRadius: colors.radiusSm,
        },
        style,
      ]}
    >
      {children}
    </Pressable>
  );
}

// ─── Divider ──────────────────────────────────────────────────────────────────

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  const colors = useColors();
  return <View style={[{ height: 1, backgroundColor: colors.divider }, style]} />;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.4,
    fontFamily: 'Inter_700Bold',
  },
  sectionValue: {
    fontSize: 18,
    marginTop: 2,
    fontFamily: 'PlayfairDisplay_600SemiBold',
  },
  sectionAction: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  metricTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  metricLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
    fontFamily: 'Inter_700Bold',
  },
  metricBadge: {
    borderWidth: 1,
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  metricBadgeText: {
    fontSize: 9,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
  metricValue: {
    fontSize: 26,
    fontWeight: '600',
    marginTop: 10,
    letterSpacing: -1,
    fontFamily: 'Inter_600SemiBold',
  },
  metricDetail: {
    fontSize: 11,
    marginTop: 3,
    fontFamily: 'Inter_400Regular',
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 5,
    paddingHorizontal: 7,
    paddingVertical: 4,
    gap: 5,
  },
  badgeDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
  },
  badgeText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.6,
    fontFamily: 'Inter_700Bold',
  },
  pillRow: {
    flexDirection: 'row',
    borderWidth: 1,
    overflow: 'hidden',
  },
  pillItem: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderWidth: 0,
  },
  pillText: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  emptyContainer: {
    padding: 40,
    alignItems: 'center',
    gap: 10,
  },
  emptyTitle: {
    fontSize: 17,
    textAlign: 'center',
    fontFamily: 'PlayfairDisplay_600SemiBold',
  },
  emptyBody: {
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 18,
    fontFamily: 'Inter_400Regular',
  },
  iconBtn: {
    width: 36,
    height: 36,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
