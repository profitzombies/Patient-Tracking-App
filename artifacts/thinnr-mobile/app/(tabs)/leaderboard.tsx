/**
 * Staff leaderboard tab.
 *
 * The office's real patients ranked by the API server (loss, goal completion,
 * and a documented adherence score are all computed server-side; the client
 * only picks which server rank to sort by). Loading / error / unauthorized /
 * empty states are explicit and a live failure never falls back to seeded
 * rows. While the session is still resolving the tab shows a spinner rather
 * than guessing; a signed-out visitor is redirected by the root layout.
 */
import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { PageFlatList as FlatList } from '@/components/ui/PageScrollView';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useQuery } from '@tanstack/react-query';
import { useColors } from '@/hooks/useColors';
import theme, { fonts } from '@/constants/colors';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { Divider, EmptyState, PillSelector } from '@/components/ui/LedgerPrimitives';
import { useSupabaseSession } from '@/lib/supabase';
import {
  fetchOfficeLeaderboard,
  OfficeRosterError,
  type LeaderboardMetric,
  type LeaderboardPeriod,
  type LeaderboardRow,
  type LeaderboardStage,
} from '@/lib/office-roster-api';

type Metric = LeaderboardMetric;
type Stage = LeaderboardStage;

const METRIC_OPTIONS: { label: string; value: Metric }[] = [
  { label: '% Lost', value: 'percent' },
  { label: 'Lbs Lost', value: 'pounds' },
  { label: 'Goal', value: 'goal' },
  { label: 'Adherence', value: 'adherence' },
];

const STAGE_OPTIONS: { label: string; value: Stage }[] = [
  { label: 'All Stages', value: 'all' },
  { label: 'Protocol', value: 'protocol' },
  { label: 'Maintenance', value: 'maintenance' },
];

const PERIOD_OPTIONS: { label: string; value: LeaderboardPeriod }[] = [
  { label: 'Program', value: 'program' },
  { label: '30 days', value: '30d' },
  { label: '90 days', value: '90d' },
];

const PERIOD_LABEL: Record<LeaderboardPeriod, string> = {
  program: 'Program to date',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
};

function useBottomPad(): number {
  const insets = useSafeAreaInsets();
  return Platform.OS === 'web' ? 84 + 16 : insets.bottom + 84 + 16;
}

function useRankTones() {
  const colors = useColors();
  // Podium tones come from the shared Heritage rank tokens.
  return [
    { bg: colors.rankGoldBg, text: colors.rankGoldText, border: colors.rankGoldBorder },
    { bg: colors.rankSilverBg, text: colors.rankSilverText, border: colors.rankSilverBorder },
    { bg: colors.rankBronzeBg, text: colors.rankBronzeText, border: colors.rankBronzeBorder },
  ];
}

function FilterChip({ label, active, onPress, testID }: { label: string; active: boolean; onPress: () => void; testID: string }) {
  const colors = useColors();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={() => { Haptics.selectionAsync(); onPress(); }}
      style={[
        styles.chip,
        { backgroundColor: active ? colors.cobalt : colors.card, borderColor: active ? colors.cobalt : colors.border },
      ]}
    >
      <Text style={[styles.chipText, { color: active ? colors.primaryForeground : colors.bodyText }]}>{label}</Text>
    </Pressable>
  );
}

function RankCell({ rank }: { rank: number }) {
  const colors = useColors();
  const tones = useRankTones();
  const tone = rank <= 3 ? tones[rank - 1] : null;
  return (
    <View style={styles.rankCell}>
      {tone ? (
        <View style={[styles.rankBadge, { backgroundColor: tone.bg, borderColor: tone.border }]}>
          <Text style={[styles.rankBadgeText, { color: tone.text }]}>#{rank}</Text>
        </View>
      ) : (
        <Text style={[styles.rankNum, { color: colors.subtleText }]}>#{rank}</Text>
      )}
    </View>
  );
}

function LoadingFrame({ testID }: { testID: string }) {
  const colors = useColors();
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Leaderboard" />
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }} testID={testID}>
        <ActivityIndicator color={colors.cobalt} />
      </View>
    </View>
  );
}

// ─── Live branch ─────────────────────────────────────────────────────────────

function formatLbs(value: number): string {
  return `${value.toFixed(1)} lbs`;
}

function liveMetric(row: LeaderboardRow, metric: Metric): { value: string; sub: string } {
  const pct = `${row.percentLost.toFixed(1)}%`;
  switch (metric) {
    case 'pounds':
      return { value: formatLbs(row.poundsLost), sub: `${pct} total` };
    case 'goal':
      return row.goalCompletion === null
        ? { value: '—', sub: 'no goal weight set' }
        : { value: `${row.goalCompletion.toFixed(0)}%`, sub: 'goal complete' };
    case 'adherence': {
      const a = row.adherence;
      return a.score === null
        ? { value: '—', sub: 'no days in period' }
        : { value: `${a.score}/100`, sub: `log ${a.loggedDays} · chk ${a.checkInDays} · h2o ${a.waterGoalDays} of ${a.eligibleDays}d` };
    }
    default:
      return { value: pct, sub: `${formatLbs(row.poundsLost)} lost` };
  }
}

function liveMilestone(row: LeaderboardRow): string {
  if (row.program.stage === 'maintenance') return 'Protocol graduate';
  if ((row.goalCompletion ?? 0) >= 75) return '75% goal reached';
  if (row.poundsLost >= 25) return '25 lb milestone';
  if ((row.adherence.score ?? 0) >= 95) return 'High adherence';
  if (row.program.week !== null) return `Week ${row.program.week}`;
  if (row.program.day !== null) return `Day ${row.program.day}`;
  return 'Ranked';
}

function LiveLeaderboard({ userId }: { userId: string }) {
  const colors = useColors();
  const bottomPad = useBottomPad();
  const [metric, setMetric] = useState<Metric>('percent');
  const [period, setPeriod] = useState<LeaderboardPeriod>('program');
  const [stageFilter, setStageFilter] = useState<Stage>('all');

  const query = useQuery({
    queryKey: ['mobile-office-leaderboard', userId, period, stageFilter],
    queryFn: ({ signal }) => fetchOfficeLeaderboard({ period, stage: stageFilter }, { userId, signal }),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: (count, error) => {
      // Access answers are final; transient failures get two more tries.
      if (error instanceof OfficeRosterError && error.status >= 400 && error.status < 500) return false;
      return count < 2;
    },
  });

  const data = query.data;
  const ranked = useMemo(() => {
    if (!data) return [];
    return [...data.rows].sort((a, b) => a.ranks[metric] - b.ranks[metric] || a.name.localeCompare(b.name));
  }, [data, metric]);

  const error = query.error;
  const errorStatus = error instanceof OfficeRosterError ? error.status : null;
  const unauthorized = errorStatus === 401 || errorStatus === 403;
  const errorMessage = unauthorized
    ? "You don't have access to this office's leaderboard. Sign in with an office staff account."
    : error instanceof Error
      ? error.message
      : 'The leaderboard could not be loaded.';

  const renderItem = ({ item: row }: { item: LeaderboardRow }) => {
    const rank = row.ranks[metric];
    const top3 = rank <= 3;
    const display = liveMetric(row, metric);
    const stageLabel = row.program.stage === 'maintenance' ? 'Maintenance' : row.program.stage === 'protocol' ? 'Protocol' : 'Program';
    const dayLabel = row.program.day !== null ? ` · Day ${row.program.day}` : '';
    return (
      <Pressable
        testID={`leaderboard-row-${row.id}`}
        accessibilityRole="link"
        accessibilityLabel={`${row.name}, rank ${rank}, ${display.value} ${display.sub}`}
        onPress={() => {
          Haptics.selectionAsync();
          router.push(`/office-patient/${encodeURIComponent(row.id)}` as never);
        }}
        style={({ pressed }) => [
          styles.row,
          { borderBottomColor: colors.divider },
          pressed && { backgroundColor: colors.accent },
        ]}
      >
        <RankCell rank={rank} />
        <View style={[styles.initials, { backgroundColor: top3 ? colors.navy : colors.activeBg }]}>
          <Text style={[styles.initialsText, { color: top3 ? colors.primaryForeground : colors.cobalt }]}>{row.initials}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.name, { color: colors.navy }]}>{row.name}</Text>
          <Text style={[styles.sub, { color: colors.subtleText }]}>
            {stageLabel}{dayLabel}{row.latestWeightDate ? ` · weighed ${row.latestWeightDate}` : ''}
          </Text>
          <View style={[styles.milestoneBadge, { backgroundColor: colors.activeBg, borderColor: colors.activeBorder, marginTop: 4 }]}>
            <Text style={[styles.milestoneText, { color: colors.cobalt }]}>{liveMilestone(row).toUpperCase()}</Text>
          </View>
        </View>
        <View style={styles.metricCell}>
          <Text style={[styles.metricValue, { color: colors.cobalt }]} testID={`leaderboard-metric-${row.id}`}>{display.value}</Text>
          <Text style={[styles.metricSub, { color: colors.subtleText }]}>{display.sub}</Text>
        </View>
        <Feather name="chevron-right" size={15} color={colors.subtleText} />
      </Pressable>
    );
  };

  const notRankable = data?.notRankable;
  const notRankableLine = notRankable && notRankable.total > 0
    ? `${notRankable.total} not yet rankable · ${notRankable.reasons.map((r) => `${r.label} ${r.count}`).join(' · ')}`
    : null;

  let body: React.ReactNode;
  if (query.isPending) {
    body = (
      <View style={styles.stateBox} testID="leaderboard-live-loading">
        <ActivityIndicator color={colors.cobalt} />
        <Text style={[styles.stateText, { color: colors.subtleText }]}>Ranking your patients…</Text>
      </View>
    );
  } else if (query.isError) {
    body = (
      <View style={styles.stateBox} accessibilityRole="alert" testID="leaderboard-live-error">
        <Feather name={unauthorized ? 'lock' : 'alert-triangle'} size={24} color={colors.destructive} />
        <Text style={[styles.stateTitle, { color: colors.navy }]}>{unauthorized ? 'Not available' : 'Leaderboard unavailable'}</Text>
        <Text style={[styles.stateText, { color: colors.subtleText }]}>{errorMessage}</Text>
        {!unauthorized ? (
          <Pressable
            testID="leaderboard-live-retry"
            accessibilityRole="button"
            onPress={() => void query.refetch()}
            style={[styles.retryBtn, { borderColor: colors.cobalt }]}
          >
            <Text style={[styles.retryText, { color: colors.cobalt }]}>Try again</Text>
          </Pressable>
        ) : null}
      </View>
    );
  } else {
    body = (
      <FlatList
        data={ranked}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        ItemSeparatorComponent={() => <Divider />}
        contentContainerStyle={{ paddingBottom: bottomPad }}
        scrollEnabled={ranked.length > 0}
        ListEmptyComponent={
          <View testID="leaderboard-live-empty">
            <EmptyState
              icon={<Feather name="award" size={28} color={colors.subtleText} />}
              title={notRankable && notRankable.total > 0 ? 'No rankable patients yet' : stageFilter !== 'all' ? 'No patients in this stage' : 'No patients to rank yet'}
              body={
                notRankable && notRankable.total > 0
                  ? 'Patients join the board once they are activated with a starting weight and a weigh-in.'
                  : stageFilter !== 'all'
                    ? 'Try another stage filter.'
                    : 'Invite and activate patients to start the board.'
              }
            />
          </View>
        }
        ListFooterComponent={
          data ? (
            <View style={[styles.footer, { borderTopColor: colors.divider }]}>
              <Text style={[styles.footerText, { color: colors.labelText }]} testID="leaderboard-live-counts">
                {ranked.length} ranked{notRankableLine ? `  ·  ${notRankableLine}` : ''}
              </Text>
              <Text style={[styles.definition, { color: colors.subtleText }]} testID="leaderboard-live-definitions">
                {data.definitions.adherence} {data.definitions.loss} {data.definitions.eligibility} {data.definitions.ties}
              </Text>
            </View>
          ) : null
        }
        testID="leaderboard-list"
      />
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Leaderboard" />

      <View style={[styles.toolbar, { borderBottomColor: colors.border, backgroundColor: colors.paperCardAlt }]}>
        <PillSelector options={METRIC_OPTIONS} selected={metric} onSelect={setMetric} />
        <View style={styles.filterRow}>
          <View style={styles.filterGroup}>
            <Text style={[styles.filterLabel, { color: colors.labelText }]}>PERIOD</Text>
            <View style={styles.filterChips}>
              {PERIOD_OPTIONS.map((opt) => (
                <FilterChip key={opt.value} testID={`period-filter-${opt.value}`} label={opt.label} active={period === opt.value} onPress={() => setPeriod(opt.value)} />
              ))}
            </View>
          </View>
          <View style={styles.filterGroup}>
            <Text style={[styles.filterLabel, { color: colors.labelText }]}>STAGE</Text>
            <View style={styles.filterChips}>
              {STAGE_OPTIONS.map((opt) => (
                <FilterChip key={opt.value} testID={`stage-filter-${opt.value}`} label={opt.label} active={stageFilter === opt.value} onPress={() => setStageFilter(opt.value)} />
              ))}
            </View>
          </View>
        </View>
      </View>

      <View style={[styles.tableHeader, { backgroundColor: colors.sidebarBg, borderBottomColor: colors.border }]}>
        <Text style={[styles.tableHeaderText, { color: colors.labelText }]} testID="leaderboard-live-scope">
          {(data?.office?.officeName ?? 'YOUR OFFICE').toUpperCase()} — {PERIOD_LABEL[period].toUpperCase()}
          {data ? ` — COMPUTED ${data.asOf} UTC` : ''}
        </Text>
      </View>

      {body}
    </View>
  );
}

// ─── Branch chooser ──────────────────────────────────────────────────────────

export default function LeaderboardScreen() {
  const { session, sessionLoading } = useSupabaseSession();
  if (sessionLoading) return <LoadingFrame testID="leaderboard-session-loading" />;
  if (session?.user) return <LiveLeaderboard key={session.user.id} userId={session.user.id} />;
  // Signed out: the provider gate in the root layout is already redirecting
  // to sign-in; hold the loading frame underneath it.
  return <LoadingFrame testID="leaderboard-signed-out" />;
}

const styles = StyleSheet.create({
  toolbar: { borderBottomWidth: 1, paddingHorizontal: 14, paddingVertical: 10, gap: 10 },
  filterRow: { gap: 8 },
  filterGroup: { gap: 6 },
  filterLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 1.2, fontFamily: 'Inter_700Bold' },
  filterChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderRadius: theme.radiusSm },
  chipText: { fontSize: 10, fontWeight: '600', fontFamily: 'Inter_600SemiBold' },
  tableHeader: { paddingHorizontal: 14, paddingVertical: 6, borderBottomWidth: 1 },
  tableHeaderText: { fontSize: 9, fontWeight: '700', letterSpacing: 1.2, fontFamily: 'Inter_700Bold' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 14, gap: 10, borderBottomWidth: 1 },
  rankCell: { width: 38, alignItems: 'center' },
  rankBadge: { borderWidth: 1, borderRadius: 5, paddingHorizontal: 5, paddingVertical: 3 },
  rankBadgeText: { fontSize: 11, fontWeight: '700', fontFamily: 'Inter_700Bold' },
  rankNum: { fontSize: 12, fontFamily: 'Inter_500Medium' },
  initials: { width: 38, height: 38, borderRadius: theme.radiusSm, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  initialsText: { fontSize: 11, fontWeight: '700', fontFamily: 'Inter_700Bold' },
  name: { fontSize: 14, fontFamily: fonts.serif },
  sub: { fontSize: 10, marginTop: 2, fontFamily: 'Inter_400Regular' },
  milestoneBadge: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 },
  milestoneText: { fontSize: 8, fontWeight: '700', letterSpacing: 0.8, fontFamily: 'Inter_700Bold' },
  metricCell: { alignItems: 'flex-end', minWidth: 70 },
  metricValue: { fontSize: 16, fontWeight: '600', fontFamily: 'Inter_600SemiBold', letterSpacing: -0.5 },
  metricSub: { fontSize: 9, fontFamily: 'Inter_400Regular', marginTop: 2 },
  stateBox: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, gap: 10 },
  stateTitle: { fontSize: 16, fontFamily: fonts.serif, textAlign: 'center' },
  stateText: { fontSize: 12, fontFamily: 'Inter_400Regular', textAlign: 'center', lineHeight: 18 },
  retryBtn: { marginTop: 4, borderWidth: 1, borderRadius: theme.radiusSm, paddingHorizontal: 14, paddingVertical: 8 },
  retryText: { fontSize: 12, fontWeight: '600', fontFamily: 'Inter_600SemiBold' },
  footer: { borderTopWidth: 1, paddingHorizontal: 14, paddingVertical: 12, gap: 6 },
  footerText: { fontSize: 9, fontWeight: '700', letterSpacing: 1.2, fontFamily: 'Inter_700Bold' },
  definition: { fontSize: 10, fontFamily: 'Inter_400Regular', lineHeight: 15 },
});
