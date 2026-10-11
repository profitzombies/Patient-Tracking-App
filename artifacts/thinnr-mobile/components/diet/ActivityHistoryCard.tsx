/**
 * Activity level over time, for the Progress tab: the ledger of answers the
 * patient gave (diet selection, weekly check-ins, settings, staff), newest
 * first, with a five-step bar so a change reads at a glance. Real accounts
 * read the server history. Errors
 * stay visible — an outage never looks like "never recorded".
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { Divider, LedgerCard, SectionHeader } from '@/components/ui/LedgerPrimitives';
import { ACTIVITY_SHORT_LABELS } from '@/components/diet/DietChoiceFields';
import { ACTIVITY_LEVELS } from '@/lib/diet-fit';
import { useDietHistory, type ActivityHistoryRow } from '@/hooks/useDietHistory';
import { formatDateKey } from '@/data/patient-data';

const SOURCE_LABELS: Record<string, string> = {
  diet_selection: 'When you chose your diet',
  check_in: 'Weekly check-in',
  settings: 'Food preferences',
  staff: 'Set by your care team',
};

const MAX_ROWS = 8;

export function activityTrendSummary(rows: ActivityHistoryRow[]): string | null {
  if (rows.length < 2) return null;
  const newest = ACTIVITY_LEVELS.indexOf(rows[0].level);
  const oldest = ACTIVITY_LEVELS.indexOf(rows[rows.length - 1].level);
  if (newest > oldest) return 'More active than when you started.';
  if (newest < oldest) return 'Less active than when you started.';
  return 'About the same as when you started.';
}

export function ActivityHistoryCard() {
  const colors = useColors();
  const { history, status, reload } = useDietHistory();
  const rows = history?.activity ?? [];
  const shown = rows.slice(0, MAX_ROWS);
  const summary = activityTrendSummary(rows);

  return (
    <View testID="progress-activity-section">
      <SectionHeader
        label="Activity Level"
        value={summary ?? (rows.length === 1 ? 'Recorded once' : 'Over time')}
        style={{ marginBottom: 8, marginTop: 4 }}
      />
      <LedgerCard style={{ marginBottom: 14 }}>
        {status === 'error' && rows.length === 0 ? (
          <View style={styles.stateRow}>
            <Text testID="progress-activity-error" style={[styles.stateText, { color: colors.riskText }]}>
              Couldn't load your activity history.
            </Text>
            <Pressable testID="progress-activity-retry" accessibilityRole="button" onPress={reload} hitSlop={8}>
              <Text style={[styles.retry, { color: colors.cobalt }]}>Retry</Text>
            </Pressable>
          </View>
        ) : status === 'loading' && rows.length === 0 ? (
          <View style={styles.stateRow}>
            <Text style={[styles.stateText, { color: colors.subtleText }]}>Loading…</Text>
          </View>
        ) : shown.length === 0 ? (
          <View style={styles.stateRow}>
            <Text testID="progress-activity-empty" style={[styles.stateText, { color: colors.subtleText }]}>
              No activity level yet. Your next check-in asks for it.
            </Text>
          </View>
        ) : (
          shown.map((row, index) => {
            const step = ACTIVITY_LEVELS.indexOf(row.level);
            return (
              <View key={`${row.recordedOn}-${row.source}-${index}`}>
                {index > 0 && <Divider />}
                <View style={styles.row} testID={`progress-activity-row-${index}`}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.level, { color: colors.navy }]}>{ACTIVITY_SHORT_LABELS[row.level]}</Text>
                    <Text style={[styles.meta, { color: colors.subtleText }]}>
                      {formatDateKey(row.recordedOn.slice(0, 10), true)} · {SOURCE_LABELS[row.source] ?? 'Recorded'}
                    </Text>
                  </View>
                  <View style={styles.bars} accessibilityLabel={`${step + 1} of ${ACTIVITY_LEVELS.length}`}>
                    {ACTIVITY_LEVELS.map((level, i) => (
                      <View
                        key={level}
                        style={[
                          styles.bar,
                          { height: 6 + i * 3, backgroundColor: i <= step ? colors.cobalt : colors.border },
                        ]}
                      />
                    ))}
                  </View>
                </View>
              </View>
            );
          })
        )}
      </LedgerCard>
    </View>
  );
}

const styles = StyleSheet.create({
  stateRow: { paddingHorizontal: 14, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  stateText: { fontSize: 12, fontFamily: fonts.sans, flex: 1 },
  retry: { fontSize: 12, fontFamily: fonts.sansSemiBold },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 11, gap: 12 },
  level: { fontSize: 13, fontFamily: fonts.sansSemiBold },
  meta: { fontSize: 10.5, fontFamily: fonts.sans, marginTop: 2 },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 3 },
  bar: { width: 6, borderRadius: 2 },
});
