/**
 * Signed-in Overview for the staff app.
 *
 * Every number here is read live for the signed-in office: roster counts
 * come from the same roster request the Patients screen uses, and the
 * attention count from the office alerts endpoint. Nothing falls back to the
 * seeded practice — a failed or denied read says so plainly. Revenue lives
 * on the Payments screen, which owns its own live reads and permissions.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { PageScrollView as ScrollView } from '@/components/ui/PageScrollView';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { router, type Href } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import theme, { fonts } from '@/constants/colors';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { Divider, LedgerCard, MetricCard, SectionHeader } from '@/components/ui/LedgerPrimitives';
import { useOfficeRoster } from '@/components/office/LiveOfficeRoster';
import { fetchOfficeAlerts } from '@/lib/office-alerts-api';

type FeatherName = React.ComponentProps<typeof Feather>['name'];

/** Greeting for the device's local hour (live screens never use the demo anchor). */
export function greetingForHour(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

const SHORTCUTS: { key: string; label: string; detail: string; icon: FeatherName; href: Href }[] = [
  { key: 'patients', label: 'Patients', detail: 'Roster, invitations and records', icon: 'users', href: '/patients' },
  { key: 'payments', label: 'Payments', detail: 'Sales, orders and payouts', icon: 'credit-card', href: '/payments' },
  { key: 'leaderboard', label: 'Leaderboard', detail: 'Patient progress rankings', icon: 'award', href: '/leaderboard' },
  { key: 'training', label: 'Training', detail: 'Courses for your team', icon: 'book-open', href: '/training' },
];

export function LiveOfficeOverview({ userId }: { userId: string }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const officeRoster = useOfficeRoster(userId);
  const [attention, setAttention] = useState<{ status: 'loading' | 'ready' | 'error'; count: number | null }>(
    { status: 'loading', count: null },
  );
  const bottomPad = Platform.OS === 'web' ? 84 + 16 : insets.bottom + 84 + 16;

  const refreshAttention = useCallback(async (signal?: AbortSignal) => {
    setAttention({ status: 'loading', count: null });
    try {
      const alerts = await fetchOfficeAlerts({ userId, signal });
      if (!signal?.aborted) setAttention({ status: 'ready', count: alerts.count });
    } catch {
      if (!signal?.aborted) setAttention({ status: 'error', count: null });
    }
  }, [userId]);

  useEffect(() => {
    const controller = new AbortController();
    void refreshAttention(controller.signal);
    return () => controller.abort();
  }, [refreshAttention]);

  const retry = () => {
    Haptics.selectionAsync();
    void officeRoster.refresh();
    void refreshAttention();
  };

  const roster = officeRoster.roster;
  const officeName = roster?.office.officeName?.trim() || null;
  const patients = roster?.patients ?? [];
  const joined = patients.filter(p => p.verified).length;
  const invited = patients.filter(p => p.invitation?.state === 'pending').length;
  const now = new Date();
  const todayStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  const attentionValue = attention.status === 'ready' && attention.count !== null ? String(attention.count) : '—';
  const attentionBadge = attention.status === 'ready'
    ? (attention.count ?? 0) > 0 ? 'Needs review' : 'All clear'
    : attention.status === 'loading' ? 'Loading' : 'Unavailable';

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Overview" subtitle={officeName ?? undefined} />
      <ScrollView
        contentContainerStyle={{ paddingBottom: bottomPad }}
        showsVerticalScrollIndicator={false}
        testID="overview-live-scroll"
      >
        <View style={styles.greetingBlock}>
          <View style={[styles.pulseLabelRow, { marginBottom: 6 }]}>
            <Feather name="activity" size={12} color={colors.orange} />
            <Text style={[styles.pulseLabel, { color: colors.cobalt }]}>PRACTICE PULSE</Text>
            <View style={[styles.dot, { backgroundColor: colors.cobaltMuted }]} />
            <Text style={[styles.pulseLabel, { color: colors.cobalt }]}>{todayStr}</Text>
          </View>
          <Text testID="overview-live-greeting" style={[styles.greeting, { color: colors.navy }]}>
            {greetingForHour(now.getHours())}.
          </Text>
          <Text style={[styles.greetingSubtitle, { color: colors.bodyText }]}>
            {officeName ? `Live numbers for ${officeName}.` : 'Live numbers for your office.'}
          </Text>
        </View>

        <View style={styles.sectionPad}>
          {officeRoster.status === 'loading' ? (
            <LedgerCard style={styles.stateCard}>
              <ActivityIndicator color={colors.cobalt} testID="overview-live-loading" />
            </LedgerCard>
          ) : officeRoster.status === 'ready' ? (
            <View testID="overview-live-metrics">
              <View style={styles.metricsGrid}>
                <MetricCard label="Patients" value={String(patients.length)} change="Live" detail="On your roster" style={{ flex: 1 }} />
                <MetricCard label="Joined" value={String(joined)} change="Live" detail="Signed in to the app" style={{ flex: 1 }} />
              </View>
              <View style={[styles.metricsGrid, { marginTop: 8 }]}>
                <MetricCard label="Invited" value={String(invited)} change="Live" detail="Not joined yet" style={{ flex: 1 }} />
                <MetricCard
                  label="Attention"
                  value={attentionValue}
                  change={attentionBadge}
                  detail="Patients to review"
                  warning={attention.status !== 'ready' || (attention.count ?? 0) > 0}
                  style={{ flex: 1 }}
                />
              </View>
            </View>
          ) : (
            <LedgerCard style={styles.stateCard}>
              <View testID="overview-live-unavailable" style={{ alignItems: 'center', gap: 8 }}>
                <Feather name="cloud-off" size={20} color={colors.subtleText} />
                <Text style={[styles.stateTitle, { color: colors.navyLight }]}>Office numbers unavailable</Text>
                <Text style={[styles.stateBody, { color: colors.subtleText }]}>
                  {officeRoster.error ?? 'The live roster could not be loaded.'}
                </Text>
                {officeRoster.status === 'error' ? (
                  <Pressable
                    testID="overview-live-retry"
                    accessibilityRole="button"
                    onPress={retry}
                    style={({ pressed }) => [
                      styles.retryBtn,
                      { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card },
                    ]}
                  >
                    <Text style={[styles.retryText, { color: colors.cobalt }]}>Try again</Text>
                  </Pressable>
                ) : null}
              </View>
            </LedgerCard>
          )}
        </View>

        <View style={styles.sectionPad}>
          <LedgerCard style={{ padding: 16 }}>
            <SectionHeader label="Go to" value="Live office tools" />
            <View style={{ marginTop: 8 }}>
              {SHORTCUTS.map((item, idx) => (
                <View key={item.key}>
                  {idx > 0 && <Divider />}
                  <Pressable
                    testID={`overview-live-${item.key}`}
                    accessibilityRole="button"
                    onPress={() => { Haptics.selectionAsync(); router.push(item.href); }}
                    style={({ pressed }) => [styles.shortcutRow, pressed && { backgroundColor: colors.accent }]}
                  >
                    <View style={[styles.shortcutIcon, { backgroundColor: colors.accent }]}>
                      <Feather name={item.icon} size={15} color={colors.cobalt} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.shortcutLabel, { color: colors.navyLight }]}>{item.label}</Text>
                      <Text style={[styles.shortcutDetail, { color: colors.subtleText }]}>{item.detail}</Text>
                    </View>
                    <Feather name="chevron-right" size={16} color={colors.subtleText} />
                  </Pressable>
                </View>
              ))}
            </View>
          </LedgerCard>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  greetingBlock: { padding: 16, paddingBottom: 12 },
  pulseLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pulseLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 1.4, fontFamily: 'Inter_700Bold' },
  dot: { width: 4, height: 4, borderRadius: 2 },
  greeting: { fontSize: 26, letterSpacing: -0.2, fontFamily: fonts.serifBold, lineHeight: 34 },
  greetingSubtitle: { fontSize: 13, marginTop: 4, fontFamily: 'Inter_400Regular' },
  sectionPad: { paddingHorizontal: 16, paddingTop: 0, paddingBottom: 12 },
  metricsGrid: { flexDirection: 'row', gap: 8 },
  stateCard: { padding: 20, alignItems: 'center', justifyContent: 'center', minHeight: 96 },
  stateTitle: { fontSize: 14, fontFamily: fonts.serif, textAlign: 'center' },
  stateBody: { fontSize: 12, lineHeight: 17, fontFamily: 'Inter_400Regular', textAlign: 'center' },
  retryBtn: { marginTop: 4, paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1, borderRadius: theme.radiusSm },
  retryText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  shortcutRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 12 },
  shortcutIcon: { width: 32, height: 32, borderRadius: theme.radiusSm, alignItems: 'center', justifyContent: 'center' },
  shortcutLabel: { fontSize: 14, fontFamily: fonts.serif },
  shortcutDetail: { fontSize: 11, marginTop: 2, fontFamily: 'Inter_400Regular' },
});
