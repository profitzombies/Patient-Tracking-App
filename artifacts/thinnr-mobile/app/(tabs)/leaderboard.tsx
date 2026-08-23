import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import theme, { fonts } from '@/constants/colors';
import { ScreenHeader, SyntheticDisclaimer } from '@/components/ui/ScreenHeader';
import { Divider, EmptyState, PillSelector } from '@/components/ui/LedgerPrimitives';
import { MOCK_PROVIDERS, type Patient } from '@/data/mock-data';
import { useOperations } from '@/context/OperationsContext';

type Metric = 'percent' | 'pounds' | 'goal' | 'adherence';
type Stage = 'all' | 'protocol' | 'maintenance';

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

function getMilestone(patient: Patient): string {
  const weightLoss = patient.startingWeight - patient.currentWeight;
  const goalProgress = Math.max(0, Math.min(100, ((weightLoss / (patient.startingWeight - patient.goalWeight)) * 100)));
  if (patient.stage === 'maintenance') return 'Protocol graduate';
  if (goalProgress >= 75) return '75% goal reached';
  if (weightLoss >= 25) return '25 lb milestone';
  if (patient.adherence >= 95) return 'High adherence';
  return `Week ${patient.protocolWeek}`;
}

export default function LeaderboardScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { hydrated, mergedPatients } = useOperations();
  const [metric, setMetric] = useState<Metric>('percent');
  const [providerFilter, setProviderFilter] = useState('all');
  const [stageFilter, setStageFilter] = useState<Stage>('all');
  const bottomPad = Platform.OS === 'web' ? 84 + 16 : insets.bottom + 84 + 16;

  const ranked = useMemo(() => {
    return [...mergedPatients]
      .filter(
        p =>
          (providerFilter === 'all' || p.providerId === providerFilter) &&
          (stageFilter === 'all' || p.stage === stageFilter),
      )
      .sort((a, b) => {
        const aLoss = a.startingWeight - a.currentWeight;
        const bLoss = b.startingWeight - b.currentWeight;
        if (metric === 'pounds') return bLoss - aLoss;
        if (metric === 'goal') {
          const aG = aLoss / (a.startingWeight - a.goalWeight);
          const bG = bLoss / (b.startingWeight - b.goalWeight);
          return bG - aG;
        }
        if (metric === 'adherence') return b.adherence - a.adherence;
        return (bLoss / b.startingWeight) - (aLoss / a.startingWeight);
      });
  }, [mergedPatients, metric, providerFilter, stageFilter]);

  const providerOptions = [
    { label: 'All Providers', value: 'all' },
    ...MOCK_PROVIDERS.map(p => ({ label: p.name.split(',')[0], value: p.id })),
  ];

  const renderItem = ({ item: patient, index: idx }: { item: Patient; index: number }) => {
    const provider = MOCK_PROVIDERS.find(p => p.id === patient.providerId);
    const loss = patient.startingWeight - patient.currentWeight;
    const pct = ((loss / patient.startingWeight) * 100).toFixed(1);
    const goalProgress = Math.max(0, Math.min(100, (loss / (patient.startingWeight - patient.goalWeight)) * 100));
    const milestone = getMilestone(patient);
    const isTop3 = idx < 3;
    // Podium tones come from the shared Heritage rank tokens.
    const rankTones = [
      { bg: colors.rankGoldBg, text: colors.rankGoldText, border: colors.rankGoldBorder },
      { bg: colors.rankSilverBg, text: colors.rankSilverText, border: colors.rankSilverBorder },
      { bg: colors.rankBronzeBg, text: colors.rankBronzeText, border: colors.rankBronzeBorder },
    ];
    const rankStyle = isTop3 ? rankTones[idx] : null;

    const metricDisplay =
      metric === 'pounds' ? `${loss.toFixed(1)} lbs` :
      metric === 'goal' ? `${goalProgress.toFixed(0)}%` :
      metric === 'adherence' ? `${patient.adherence}/100` :
      `${pct}%`;

    const metricSub =
      metric === 'pounds' ? `${pct}% total` :
      metric === 'goal' ? 'goal complete' :
      metric === 'adherence' ? 'adherence' :
      `${loss.toFixed(1)} lbs lost`;

    return (
      <Pressable
        testID={`leaderboard-row-${patient.id}`}
        onPress={() => { Haptics.selectionAsync(); router.push(`/patient/${patient.id}`); }}
        style={({ pressed }) => [
          styles.row,
          { borderBottomColor: colors.divider },
          pressed && { backgroundColor: colors.accent },
        ]}
      >
        <View style={styles.rankCell}>
          {rankStyle ? (
            <View style={[styles.rankBadge, { backgroundColor: rankStyle.bg, borderColor: rankStyle.border }]}>
              <Text style={[styles.rankBadgeText, { color: rankStyle.text }]}>#{idx + 1}</Text>
            </View>
          ) : (
            <Text style={[styles.rankNum, { color: colors.subtleText }]}>#{idx + 1}</Text>
          )}
        </View>

        <View style={[styles.initials, { backgroundColor: isTop3 ? colors.navy : colors.activeBg }]}>
          <Text style={[styles.initialsText, { color: isTop3 ? colors.primaryForeground : colors.cobalt }]}>{patient.initials}</Text>
        </View>

        <View style={{ flex: 1 }}>
          <Text style={[styles.name, { color: colors.navy }]}>{patient.name}</Text>
          <Text style={[styles.sub, { color: colors.subtleText }]}>
            {provider?.name.split(',')[0]} · Wk {patient.protocolWeek}
          </Text>
          <View style={[styles.milestoneBadge, { backgroundColor: colors.activeBg, borderColor: colors.activeBorder, marginTop: 4 }]}>
            <Text style={[styles.milestoneText, { color: colors.cobalt }]}>{milestone.toUpperCase()}</Text>
          </View>
        </View>

        <View style={styles.metricCell}>
          <Text style={[styles.metricValue, { color: colors.cobalt }]}>{metricDisplay}</Text>
          <Text style={[styles.metricSub, { color: colors.subtleText }]}>{metricSub}</Text>
        </View>

        <Feather name="chevron-right" size={15} color={colors.subtleText} />
      </Pressable>
    );
  };

  if (!hydrated) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <ScreenHeader title="Leaderboard" />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.cobalt} />
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Leaderboard" />

      {/* Filters */}
      <View style={[styles.toolbar, { borderBottomColor: colors.border, backgroundColor: colors.paperCardAlt }]}>
        <PillSelector options={METRIC_OPTIONS} selected={metric} onSelect={setMetric} />

        <View style={styles.filterRow}>
          <View style={styles.filterGroup}>
            <Text style={[styles.filterLabel, { color: colors.labelText }]}>PROVIDER</Text>
            <View style={styles.filterChips}>
              {providerOptions.map(opt => {
                const active = providerFilter === opt.value;
                const shortLabel = opt.value === 'all' ? 'All' : opt.label.split(' ').pop() ?? opt.label;
                return (
                  <Pressable
                    key={opt.value}
                    testID={`provider-filter-${opt.value}`}
                    onPress={() => { Haptics.selectionAsync(); setProviderFilter(opt.value); }}
                    style={[
                      styles.chip,
                      { backgroundColor: active ? colors.cobalt : colors.card, borderColor: active ? colors.cobalt : colors.border },
                    ]}
                  >
                    <Text style={[styles.chipText, { color: active ? colors.primaryForeground : colors.bodyText }]}>
                      {shortLabel}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <View style={styles.filterGroup}>
            <Text style={[styles.filterLabel, { color: colors.labelText }]}>STAGE</Text>
            <View style={styles.filterChips}>
              {STAGE_OPTIONS.map(opt => {
                const active = stageFilter === opt.value;
                return (
                  <Pressable
                    key={opt.value}
                    testID={`stage-filter-${opt.value}`}
                    onPress={() => { Haptics.selectionAsync(); setStageFilter(opt.value); }}
                    style={[
                      styles.chip,
                      { backgroundColor: active ? colors.cobalt : colors.card, borderColor: active ? colors.cobalt : colors.border },
                    ]}
                  >
                    <Text style={[styles.chipText, { color: active ? colors.primaryForeground : colors.bodyText }]}>
                      {opt.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </View>
      </View>

      <View style={[styles.tableHeader, { backgroundColor: colors.sidebarBg, borderBottomColor: colors.border }]}>
        <Text style={[styles.tableHeaderText, { color: colors.labelText }]}>
          TOP PERFORMERS — {ranked.length} PATIENTS
        </Text>
      </View>

      <FlatList
        data={ranked}
        keyExtractor={item => item.id}
        renderItem={renderItem}
        ItemSeparatorComponent={() => <Divider />}
        contentContainerStyle={{ paddingBottom: bottomPad }}
        scrollEnabled={ranked.length > 0}
        ListEmptyComponent={
          <EmptyState
            icon={<Feather name="award" size={28} color={colors.subtleText} />}
            title="No patients match filters"
            body="Try adjusting the provider or stage filter."
          />
        }
        ListFooterComponent={ranked.length > 0 ? <SyntheticDisclaimer /> : null}
        testID="leaderboard-list"
      />
    </View>
  );
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
});
