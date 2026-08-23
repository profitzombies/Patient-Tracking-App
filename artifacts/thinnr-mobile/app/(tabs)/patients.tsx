import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import theme, { fonts } from '@/constants/colors';
import { ScreenHeader, SyntheticDisclaimer } from '@/components/ui/ScreenHeader';
import { Divider, EmptyState, StatusBadge } from '@/components/ui/LedgerPrimitives';
import { MOCK_PROVIDERS, type Status, type Patient } from '@/data/mock-data';
import { useOperations } from '@/context/OperationsContext';

type SortKey = 'name' | 'startDate' | 'weightLoss' | 'status';

const STATUS_OPTIONS: { label: string; value: Status | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Active', value: 'active' },
  { label: 'Paused', value: 'paused' },
  { label: 'Overdue', value: 'overdue' },
  { label: 'Graduated', value: 'graduated' },
];

const SORT_OPTIONS: { label: string; value: SortKey }[] = [
  { label: 'Newest', value: 'startDate' },
  { label: 'Name', value: 'name' },
  { label: 'Progress', value: 'weightLoss' },
  { label: 'Status', value: 'status' },
];

export default function PatientsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { hydrated, mergedPatients } = useOperations();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<Status | 'all'>('all');
  const [sortKey, setSortKey] = useState<SortKey>('startDate');
  const [refreshing, setRefreshing] = useState(false);

  const bottomPad = Platform.OS === 'web' ? 84 + 16 : insets.bottom + 84 + 16;

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    let result = mergedPatients.filter(p => {
      const matchSearch = !q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q);
      const matchStatus = statusFilter === 'all' || p.status === statusFilter;
      return matchSearch && matchStatus;
    });
    result = [...result].sort((a, b) => {
      if (sortKey === 'name') return a.name.localeCompare(b.name);
      if (sortKey === 'startDate') return new Date(b.startDate).getTime() - new Date(a.startDate).getTime();
      if (sortKey === 'weightLoss') return (b.startingWeight - b.currentWeight) - (a.startingWeight - a.currentWeight);
      return a.status.localeCompare(b.status);
    });
    return result;
  }, [mergedPatients, search, statusFilter, sortKey]);

  const onRefresh = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 800);
  }, []);

  const renderItem = useCallback(({ item: patient }: { item: Patient }) => {
    const provider = MOCK_PROVIDERS.find(p => p.id === patient.providerId);
    const loss = patient.startingWeight - patient.currentWeight;
    const pct = ((loss / patient.startingWeight) * 100).toFixed(1);
    const started = new Date(patient.startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    return (
      <Pressable
        testID={`patient-row-${patient.id}`}
        onPress={() => { Haptics.selectionAsync(); router.push(`/patient/${patient.id}`); }}
        style={({ pressed }) => [
          styles.row,
          { borderBottomColor: colors.divider },
          pressed && { backgroundColor: colors.accent },
        ]}
      >
        <View style={[styles.rowInitials, { backgroundColor: colors.activeBg }]}>
          <Text style={[styles.rowInitialsText, { color: colors.cobalt }]}>{patient.initials}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <View style={styles.rowTop}>
            <Text style={[styles.rowName, { color: colors.navy }]}>{patient.name}</Text>
            <StatusBadge status={patient.status} />
          </View>
          <Text style={[styles.rowSub, { color: colors.subtleText }]} numberOfLines={1}>
            {provider?.name.split(',')[0]} · {patient.stage === 'protocol' ? `Wk ${patient.protocolWeek}` : 'Maintenance'} · Started {started}
          </Text>
          <View style={styles.rowBottom}>
            <Text style={[styles.rowProgress, { color: colors.navyLight }]}>{loss.toFixed(1)} lbs</Text>
            <Text style={[styles.rowPct, { color: colors.subtleText }]}>{pct}%</Text>
          </View>
        </View>
        <Feather name="chevron-right" size={16} color={colors.subtleText} />
      </Pressable>
    );
  }, [colors]);

  if (!hydrated) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <ScreenHeader title="Patients" />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.cobalt} />
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Patients" onSearch={setSearch} />

      {/* Toolbar */}
      <View style={[styles.toolbar, { borderBottomColor: colors.border, backgroundColor: colors.paperCardAlt }]}>
        <View style={[styles.searchBox, { borderColor: colors.border, backgroundColor: colors.card }]}>
          <Feather name="search" size={14} color={colors.subtleText} />
          <TextInput
            testID="patients-search-input"
            placeholder="Search patients..."
            placeholderTextColor={colors.subtleText}
            value={search}
            onChangeText={setSearch}
            style={[styles.searchInput, { color: colors.foreground }]}
          />
          {search.length > 0 && (
            <Pressable onPress={() => setSearch('')}>
              <Feather name="x" size={13} color={colors.subtleText} />
            </Pressable>
          )}
        </View>

        <View style={styles.chipRow}>
          {STATUS_OPTIONS.map(opt => {
            const active = statusFilter === opt.value;
            return (
              <Pressable
                key={opt.value}
                testID={`status-filter-${opt.value}`}
                onPress={() => { Haptics.selectionAsync(); setStatusFilter(opt.value); }}
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

        <View style={styles.sortRow}>
          <Text style={[styles.sortLabel, { color: colors.labelText }]}>SORT:</Text>
          {SORT_OPTIONS.map(opt => {
            const active = sortKey === opt.value;
            return (
              <Pressable
                key={opt.value}
                testID={`sort-${opt.value}`}
                onPress={() => { Haptics.selectionAsync(); setSortKey(opt.value); }}
              >
                <Text style={[styles.sortOption, { color: active ? colors.cobalt : colors.bodyText }, active && { fontFamily: 'Inter_700Bold' }]}>
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={[styles.countBar, { backgroundColor: colors.sidebarBg, borderBottomColor: colors.border }]}>
        <Text style={[styles.countText, { color: colors.labelText }]}>{filtered.length} RECORDS</Text>
      </View>

      <FlatList
        data={filtered}
        keyExtractor={item => item.id}
        renderItem={renderItem}
        ItemSeparatorComponent={() => <Divider />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.cobalt} />}
        scrollEnabled={filtered.length > 0}
        contentContainerStyle={{ paddingBottom: bottomPad }}
        ListEmptyComponent={
          <EmptyState
            icon={<Feather name="users" size={28} color={colors.subtleText} />}
            title="No patients found"
            body="Try adjusting your search or filter."
          />
        }
        ListFooterComponent={filtered.length > 0 ? <SyntheticDisclaimer /> : null}
        testID="patients-list"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  toolbar: { borderBottomWidth: 1, paddingHorizontal: 14, paddingVertical: 10, gap: 8 },
  searchBox: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: theme.radiusSm, paddingHorizontal: 10, paddingVertical: 7, gap: 8 },
  searchInput: { flex: 1, fontSize: 13, fontFamily: 'Inter_400Regular' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderRadius: theme.radiusSm },
  chipText: { fontSize: 10, fontWeight: '700', fontFamily: 'Inter_700Bold', letterSpacing: 0.4 },
  sortRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  sortLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 1.2, fontFamily: 'Inter_700Bold' },
  sortOption: { fontSize: 11, fontFamily: 'Inter_500Medium' },
  countBar: { paddingHorizontal: 14, paddingVertical: 6, borderBottomWidth: 1 },
  countText: { fontSize: 9, fontWeight: '700', letterSpacing: 1.2, fontFamily: 'Inter_700Bold' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 14, gap: 12, borderBottomWidth: 1 },
  rowInitials: { width: 38, height: 38, borderRadius: theme.radiusSm, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  rowInitialsText: { fontSize: 11, fontWeight: '700', fontFamily: 'Inter_700Bold' },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  rowName: { fontSize: 15, fontFamily: fonts.serif, flex: 1 },
  rowSub: { fontSize: 10, marginTop: 3, fontFamily: 'Inter_400Regular' },
  rowBottom: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  rowProgress: { fontSize: 12, fontWeight: '600', fontFamily: 'Inter_600SemiBold' },
  rowPct: { fontSize: 10, fontFamily: 'Inter_400Regular' },
});
