import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { PageScrollView as ScrollView } from '@/components/ui/PageScrollView';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import theme, { fonts } from '@/constants/colors';
import { ScreenHeader, SyntheticDisclaimer } from '@/components/ui/ScreenHeader';
import {
  Divider,
  LedgerCard,
  MetricCard,
  PillSelector,
  ProgressBar,
  SectionHeader,
  StatusBadge,
} from '@/components/ui/LedgerPrimitives';
import { MOCK_ANALYTICS, MOCK_PROVIDERS } from '@/data/mock-data';
import { useOperations } from '@/context/OperationsContext';
import { useSupabaseSession } from '@/lib/supabase';
import { LiveOfficeOverview } from '@/components/office/LiveOfficeOverview';

type Range = '12 months' | '6 months' | '30 days';

const TREND_DATA: Record<Range, { values: number[]; labels: string[] }> = {
  '12 months': {
    values: [48, 52, 55, 53, 61, 66, 70, 68, 76, 82, 88, 94],
    labels: ['May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr'],
  },
  '6 months': {
    values: [70, 68, 76, 82, 88, 94],
    labels: ['Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr'],
  },
  '30 days': {
    values: [66, 70, 68, 76, 82, 88, 94],
    labels: ['Apr 01', 'Apr 06', 'Apr 11', 'Apr 16', 'Apr 21', 'Apr 26', 'Apr 30'],
  },
};

function BarChart({ range }: { range: Range }) {
  const colors = useColors();
  const { values, labels } = TREND_DATA[range];
  const max = Math.max(...values);

  return (
    <View>
      <View style={{ height: 140 }}>
        {[100, 75, 50, 25, 0].map((n, idx) => (
          <View
            key={n}
            style={{
              position: 'absolute',
              top: `${idx * 25}%` as any,
              left: 0,
              right: 0,
              flexDirection: 'row',
              alignItems: 'center',
            }}
          >
            <Text style={[styles.chartAxisLabel, { color: colors.subtleText }]}>
              {n === 0 ? '$0' : `$${n * 3}k`}
            </Text>
            <View style={{ flex: 1, height: 1, backgroundColor: colors.divider }} />
          </View>
        ))}
        <View style={[styles.chartBars, { left: 34 }]}>
          {values.map((v, i) => {
            const heightPct = ((v / max) * 88 + 8);
            return (
              <View key={`${labels[i]}-${i}`} style={styles.barWrapper}>
                <View style={{ width: '80%', height: `${heightPct}%`, backgroundColor: colors.cobalt }} />
              </View>
            );
          })}
        </View>
      </View>
      <View style={[styles.chartXRow, { marginLeft: 34 }]}>
        {labels.map(l => (
          <Text key={l} style={[styles.chartXLabel, { color: colors.subtleText }]} numberOfLines={1}>{l}</Text>
        ))}
      </View>
    </View>
  );
}

const PRIORITY_ITEMS = [
  { title: 'Failed Subscription Payments', body: '2 recurring payments failed this week', level: 'High', tone: 'risk' },
  { title: 'Missed Check-ins', body: '4 patients missed their scheduled protocol check-in', level: 'Watch', tone: 'watch' },
  { title: 'High Adherence Cohort', body: '24 patients reached goal weight this week', level: 'Positive', tone: 'healthy' },
];

const ACTIVITY_ITEMS = [
  { initials: 'ER', name: 'Elena Rostova', action: 'completed week 4 check-in for Emma S.', time: '12 min ago' },
  { initials: 'MC', name: 'Michael Chen', action: 'flagged overdue check-in for Liam J.', time: '46 min ago' },
  { initials: 'SJ', name: 'Sarah Jenkins', action: 'approved Maintenance Stack for Olivia W.', time: '2 hr ago' },
];

// The seeded practice — only ever shown to signed-out visitors of the demo.
function DemoOverviewScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { hydrated, mergedPatients, mergedSubscriptions } = useOperations();
  const [range, setRange] = useState<Range>('12 months');
  const [showNotice, setShowNotice] = useState(true);
  const [providerFilter, setProviderFilter] = useState('all');

  const bottomPad = Platform.OS === 'web' ? 84 + 16 : insets.bottom + 84 + 16;

  const filteredPatients = useMemo(
    () => mergedPatients.filter(p => providerFilter === 'all' || p.providerId === providerFilter),
    [mergedPatients, providerFilter],
  );

  const overduePatients = filteredPatients.filter(p => p.status === 'overdue');
  const selectedProvider = MOCK_PROVIDERS.find(p => p.id === providerFilter);
  const avgPoundsLost = filteredPatients.length
    ? filteredPatients.reduce((t, p) => t + p.startingWeight - p.currentWeight, 0) / filteredPatients.length
    : 0;
  const filteredMrr = mergedSubscriptions
    .filter(s => filteredPatients.some(p => p.id === s.patientId))
    .reduce((t, s) => t + s.monthlyValue, 0);

  const todayStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const rangeOptions: { label: string; value: Range }[] = [
    { label: '12 mo', value: '12 months' },
    { label: '6 mo', value: '6 months' },
    { label: '30 d', value: '30 days' },
  ];

  if (!hydrated) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <ScreenHeader title="Overview" />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.cobalt} />
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Overview" />
      <ScrollView
        contentContainerStyle={{ paddingBottom: bottomPad }}
        showsVerticalScrollIndicator={false}
        testID="overview-scroll"
      >
        {/* Greeting */}
        <View style={styles.greetingBlock}>
          <View style={[styles.pulseLabelRow, { marginBottom: 6 }]}>
            <Feather name="activity" size={12} color={colors.orange} />
            <Text style={[styles.pulseLabel, { color: colors.cobalt }]}>PRACTICE PULSE</Text>
            <View style={[styles.dot, { backgroundColor: colors.cobaltMuted }]} />
            <Text style={[styles.pulseLabel, { color: colors.cobalt }]}>{todayStr}</Text>
          </View>
          <Text style={[styles.greeting, { color: colors.navy }]}>Good morning, Dr. Jenkins.</Text>
          <Text style={[styles.greetingSubtitle, { color: colors.bodyText }]}>Here's what changed since your last login.</Text>

          {/* Range + Provider filter row */}
          <View style={styles.filterRow}>
            <PillSelector options={rangeOptions} selected={range} onSelect={setRange} style={{ flex: 1 }} />
            <Pressable
              testID="provider-filter-btn"
              onPress={() => {
                Haptics.selectionAsync();
                const allIds = ['all', ...MOCK_PROVIDERS.map(p => p.id)];
                const idx = allIds.indexOf(providerFilter);
                setProviderFilter(allIds[(idx + 1) % allIds.length]);
              }}
              style={({ pressed }) => [
                styles.filterPill,
                { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card },
              ]}
            >
              <Feather name="filter" size={13} color={colors.bodyText} />
              <Text style={[styles.filterPillText, { color: colors.bodyText }]}>
                {selectedProvider ? selectedProvider.name.split(',')[0].split(' ').pop() : 'All'}
              </Text>
            </Pressable>
          </View>
        </View>

        {/* Metrics */}
        <View style={styles.sectionPad}>
          <View style={styles.metricsGrid}>
            <MetricCard
              label="MRR"
              value={providerFilter === 'all' ? `$${(MOCK_ANALYTICS.recurringRevenue / 1000).toFixed(1)}k` : `$${filteredMrr}`}
              change="+12.4%"
              detail="vs. last month"
              style={{ flex: 1 }}
            />
            <MetricCard
              label="Active Patients"
              value={(selectedProvider?.activePatientCount ?? MOCK_ANALYTICS.activePatients).toString()}
              change="+8.7%"
              detail={`${MOCK_ANALYTICS.newEnrollments} new`}
              style={{ flex: 1 }}
            />
          </View>
          <View style={[styles.metricsGrid, { marginTop: 8 }]}>
            <MetricCard
              label="Avg lbs Lost"
              value={`${providerFilter === 'all' ? MOCK_ANALYTICS.averagePoundsLost : avgPoundsLost.toFixed(1)} lbs`}
              change="+3.2%"
              detail="All active cohorts"
              style={{ flex: 1 }}
            />
            <MetricCard
              label="Overdue"
              value={overduePatients.length.toString()}
              change="Needs review"
              detail="Patients at risk"
              warning
              style={{ flex: 1 }}
            />
          </View>
        </View>

        {/* Overdue notice */}
        {showNotice && overduePatients.length > 0 && (
          <View style={[styles.noticeBanner, { borderColor: colors.warnBorder, backgroundColor: colors.warnBg }]}>
            <Feather name="alert-triangle" size={16} color={colors.warnText} />
            <Text style={[styles.noticeText, { color: colors.warnText, flex: 1 }]}>
              <Text style={{ fontFamily: 'Inter_700Bold' }}>{overduePatients.length} patients need attention.</Text>{' '}
              Check-ins or renewals are past due.
            </Text>
            <Pressable
              testID="dismiss-notice-btn"
              onPress={() => { Haptics.selectionAsync(); setShowNotice(false); }}
            >
              <Feather name="x" size={15} color={colors.warnText} />
            </Pressable>
          </View>
        )}

        {/* Revenue trend chart */}
        <View style={[styles.sectionPad, { paddingTop: 0 }]}>
          <LedgerCard style={{ padding: 16 }}>
            <SectionHeader label="Revenue Trend" value={`$${(MOCK_ANALYTICS.monthlyRevenue / 1000).toFixed(1)}k`} />
            <View style={{ marginTop: 14 }}>
              <BarChart range={range} />
            </View>
          </LedgerCard>
        </View>

        {/* Protocol stages */}
        <View style={[styles.sectionPad, { paddingTop: 0 }]}>
          <LedgerCard style={{ padding: 16 }}>
            <SectionHeader
              label="Protocol Stages"
              value={`${MOCK_ANALYTICS.activePatients} Active`}
              action={{ label: 'Details', onPress: () => router.push('/outcomes' as any) }}
            />
            <View style={{ marginTop: 16, gap: 12 }}>
              {[
                { name: 'Maintenance', pct: 65, count: MOCK_ANALYTICS.stageCounts.maintenance, color: colors.cobalt },
                { name: 'Protocol Wks 1-3', pct: 20, count: MOCK_ANALYTICS.stageCounts.week1 + MOCK_ANALYTICS.stageCounts.week2 + MOCK_ANALYTICS.stageCounts.week3, color: colors.cobaltLight },
                { name: 'Protocol Wks 4-6', pct: 15, count: MOCK_ANALYTICS.stageCounts.week4 + MOCK_ANALYTICS.stageCounts.week5 + MOCK_ANALYTICS.stageCounts.week6, color: colors.cobaltMuted },
              ].map(s => (
                <View key={s.name}>
                  <View style={styles.stageRow}>
                    <Text style={[styles.stageName, { color: colors.bodyText }]}>{s.name}</Text>
                    <Text style={[styles.stageCount, { color: colors.subtleText }]}>
                      {s.count} <Text style={{ color: colors.navyLight, fontFamily: 'Inter_700Bold' }}>{s.pct}%</Text>
                    </Text>
                  </View>
                  <ProgressBar value={s.pct} color={s.color} style={{ marginTop: 4 }} />
                </View>
              ))}
            </View>
          </LedgerCard>
        </View>

        {/* Priority items */}
        <View style={[styles.sectionPad, { paddingTop: 0 }]}>
          <LedgerCard style={{ padding: 16 }}>
            <SectionHeader label="Priority Items" value="Worth a closer look" />
            <View style={{ marginTop: 12 }}>
              {PRIORITY_ITEMS.map((item, idx) => (
                <View key={item.title}>
                  {idx > 0 && <Divider />}
                  <Pressable
                    testID={`priority-item-${idx}`}
                    onPress={() => Haptics.selectionAsync()}
                    style={({ pressed }) => [styles.priorityRow, pressed && { backgroundColor: colors.accent }]}
                  >
                    <View
                      style={[
                        styles.priorityDot,
                        { backgroundColor: item.tone === 'risk' ? colors.riskText : item.tone === 'watch' ? colors.warnText : colors.cobalt },
                      ]}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.priorityTitle, { color: colors.navyLight }]}>{item.title}</Text>
                      <Text style={[styles.priorityBody, { color: colors.subtleText }]}>{item.body}</Text>
                    </View>
                    <Text
                      style={[
                        styles.priorityLevel,
                        { color: item.tone === 'risk' ? colors.riskText : item.tone === 'watch' ? colors.warnText : colors.cobalt },
                      ]}
                    >
                      {item.level}
                    </Text>
                  </Pressable>
                </View>
              ))}
            </View>
          </LedgerCard>
        </View>

        {/* Patient watchlist — uses merged patients */}
        <View style={[styles.sectionPad, { paddingTop: 0 }]}>
          <LedgerCard>
            <View style={[styles.watchlistHeader, { borderBottomWidth: 1, borderBottomColor: colors.border }]}>
              <SectionHeader
                label="Patient Watchlist"
                value="Recent & Overdue"
                action={{ label: 'View all', onPress: () => router.push('/(tabs)/patients') }}
              />
            </View>
            {filteredPatients.slice(0, 5).map((patient, idx) => {
              const provider = MOCK_PROVIDERS.find(p => p.id === patient.providerId);
              const lbsLost = patient.startingWeight - patient.currentWeight;
              return (
                <View key={patient.id}>
                  {idx > 0 && <Divider />}
                  <Pressable
                    testID={`watchlist-patient-${patient.id}`}
                    onPress={() => { Haptics.selectionAsync(); router.push(`/patient/${patient.id}`); }}
                    style={({ pressed }) => [styles.watchlistRow, pressed && { backgroundColor: colors.accent }]}
                  >
                    <View style={[styles.initials, { backgroundColor: colors.activeBg }]}>
                      <Text style={[styles.initialsText, { color: colors.cobalt }]}>{patient.initials}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.watchlistName, { color: colors.navy }]}>{patient.name}</Text>
                      <Text style={[styles.watchlistSub, { color: colors.subtleText }]}>
                        {provider?.name.split(',')[0]} · {patient.stage === 'protocol' ? `Wk ${patient.protocolWeek}` : 'Maintenance'}
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end', gap: 4 }}>
                      <StatusBadge status={patient.status} />
                      <Text style={[styles.watchlistWeight, { color: colors.bodyText }]}>{lbsLost.toFixed(1)} lbs</Text>
                    </View>
                  </Pressable>
                </View>
              );
            })}
          </LedgerCard>
        </View>

        {/* Recent activity */}
        <View style={[styles.sectionPad, { paddingTop: 0 }]}>
          <LedgerCard style={{ padding: 16 }}>
            <SectionHeader label="Recent Activity" value="Team movement" />
            <View style={{ marginTop: 12, gap: 8 }}>
              {ACTIVITY_ITEMS.map(item => (
                <Pressable
                  key={item.name}
                  testID={`activity-${item.name}`}
                  onPress={() => Haptics.selectionAsync()}
                  style={({ pressed }) => [
                    styles.activityRow,
                    { borderColor: colors.divider },
                    pressed && { backgroundColor: colors.accent },
                  ]}
                >
                  <View style={[styles.activityAvatar, { backgroundColor: colors.sidebarBg }]}>
                    <Text style={[styles.activityAvatarText, { color: colors.cobalt }]}>{item.initials}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.activityText, { color: colors.navyLight }]} numberOfLines={2}>
                      <Text style={{ fontFamily: 'Inter_700Bold' }}>{item.name}</Text>{' '}
                      <Text style={{ color: colors.subtleText }}>{item.action}</Text>
                    </Text>
                    <Text style={[styles.activityTime, { color: colors.subtleText }]}>{item.time}</Text>
                  </View>
                </Pressable>
              ))}
            </View>
          </LedgerCard>
        </View>

        <SyntheticDisclaimer />
      </ScrollView>
    </View>
  );
}

function LoadingOverviewScreen() {
  const colors = useColors();
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Overview" />
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }} testID="overview-session-loading">
        <ActivityIndicator color={colors.cobalt} />
      </View>
    </View>
  );
}

export default function OverviewScreen() {
  const { session, sessionLoading } = useSupabaseSession();
  if (sessionLoading) return <LoadingOverviewScreen />;
  // A signed-in office only ever sees its own live numbers.
  if (session?.user) return <LiveOfficeOverview key={session.user.id} userId={session.user.id} />;
  return <DemoOverviewScreen />;
}

const styles = StyleSheet.create({
  greetingBlock: { padding: 16, paddingBottom: 12 },
  pulseLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pulseLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 1.4, fontFamily: 'Inter_700Bold' },
  dot: { width: 4, height: 4, borderRadius: 2 },
  greeting: { fontSize: 26, letterSpacing: -0.2, fontFamily: fonts.serifBold, lineHeight: 34 },
  greetingSubtitle: { fontSize: 13, marginTop: 4, fontFamily: 'Inter_400Regular' },
  filterRow: { flexDirection: 'row', gap: 8, marginTop: 12, alignItems: 'center' },
  filterPill: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1, borderRadius: theme.radiusSm, gap: 5 },
  filterPillText: { fontSize: 11, fontWeight: '600', fontFamily: 'Inter_600SemiBold' },
  sectionPad: { paddingHorizontal: 16, paddingTop: 0, paddingBottom: 12 },
  metricsGrid: { flexDirection: 'row', gap: 8 },
  noticeBanner: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, marginBottom: 12, padding: 12, borderWidth: 1, borderRadius: theme.radius, gap: 10 },
  noticeText: { fontSize: 12, fontFamily: 'Inter_400Regular', lineHeight: 17 },
  chartAxisLabel: { fontSize: 9, width: 32, fontFamily: 'Inter_400Regular', textAlign: 'right' },
  chartBars: { position: 'absolute', top: 0, right: 0, bottom: 0, flexDirection: 'row', alignItems: 'flex-end', gap: 3 },
  barWrapper: { flex: 1, height: '100%', alignItems: 'center', justifyContent: 'flex-end' },
  chartXRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  chartXLabel: { fontSize: 8, fontFamily: 'Inter_400Regular', flex: 1, textAlign: 'center' },
  stageRow: { flexDirection: 'row', justifyContent: 'space-between' },
  stageName: { fontSize: 12, fontFamily: 'Inter_500Medium' },
  stageCount: { fontSize: 11, fontFamily: 'Inter_400Regular' },
  priorityRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 12, gap: 10 },
  priorityDot: { width: 8, height: 8, borderRadius: 4, marginTop: 4 },
  priorityTitle: { fontSize: 13, fontFamily: fonts.serif },
  priorityBody: { fontSize: 11, marginTop: 2, lineHeight: 15, fontFamily: 'Inter_400Regular' },
  priorityLevel: { fontSize: 10, fontWeight: '700', fontFamily: 'Inter_700Bold' },
  watchlistHeader: { padding: 16, paddingBottom: 12 },
  watchlistRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  initials: { width: 36, height: 36, borderRadius: theme.radiusSm, alignItems: 'center', justifyContent: 'center' },
  initialsText: { fontSize: 10, fontWeight: '700', fontFamily: 'Inter_700Bold' },
  watchlistName: { fontSize: 14, fontFamily: fonts.serif },
  watchlistSub: { fontSize: 10, marginTop: 2, fontFamily: 'Inter_400Regular' },
  watchlistWeight: { fontSize: 10, fontFamily: 'Inter_500Medium' },
  activityRow: { flexDirection: 'row', alignItems: 'flex-start', borderWidth: 1, borderRadius: theme.radiusSm, padding: 10, gap: 10 },
  activityAvatar: { width: 30, height: 30, borderRadius: theme.radiusSm, alignItems: 'center', justifyContent: 'center' },
  activityAvatarText: { fontSize: 9, fontWeight: '700', fontFamily: 'Inter_700Bold' },
  activityText: { fontSize: 11, lineHeight: 16, fontFamily: 'Inter_400Regular' },
  activityTime: { fontSize: 10, marginTop: 2, fontFamily: 'Inter_400Regular' },
});
