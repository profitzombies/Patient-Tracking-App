/**
 * Phone-width activity feed (payments, refunds, disputes, payouts) — the
 * mobile counterpart of the web ActivityTable. Each row is a stacked card;
 * rows tied to an order are a single announced link to the transaction.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, type Href } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { formatDateTime, type PillTone } from '@/lib/office-billing-format';
import type { HqActivityRow } from '@/lib/office-billing-types';
import { Empty, MoneyText, StatusPill } from './primitives';

export function activityTone(kind: HqActivityRow['kind']): PillTone {
  switch (kind) {
    case 'sale':
    case 'dispute_won':
      return 'good';
    case 'refund':
    case 'dispute_opened':
    case 'fee_discrepancy':
      return 'warn';
    case 'dispute_lost':
      return 'bad';
    default:
      return 'neutral';
  }
}

export function activityHref(row: HqActivityRow): Href | null {
  return row.order_id ? (`/payments/transactions/${row.order_id}` as Href) : null;
}

export function ActivityList({ rows, empty, testID = 'activity-list' }: { rows: HqActivityRow[]; empty: string; testID?: string }) {
  const colors = useColors();
  if (rows.length === 0) return <Empty testID={`${testID}-empty`}>{empty}</Empty>;
  return (
    <View testID={testID} style={styles.list} accessibilityRole="list">
      {rows.map((row) => {
        const href = activityHref(row);
        const body = (
          <>
            <View style={styles.top}>
              <StatusPill tone={activityTone(row.kind)}>{row.label}</StatusPill>
              <MoneyText cents={row.amount_cents} signed />
            </View>
            <View style={styles.bottom}>
              <Text style={[styles.meta, { color: colors.mutedForeground }]}>{formatDateTime(row.occurred_at)}</Text>
              <Text style={[styles.meta, { color: colors.navy }]}>{row.order_number ?? '—'}</Text>
            </View>
          </>
        );
        const rowStyle = [styles.row, { borderBottomColor: colors.divider }];
        if (!href) {
          return (
            <View key={row.id} testID={`row-activity-${row.id}`} style={rowStyle}>
              {body}
            </View>
          );
        }
        return (
          <Pressable
            key={row.id}
            testID={`row-activity-${row.id}`}
            accessibilityRole="link"
            accessibilityLabel={`Open order ${row.order_number ?? ''} (${row.label.toLowerCase()})`}
            onPress={() => router.push(href)}
            style={({ pressed }) => [rowStyle, pressed && { opacity: 0.7 }]}
          >
            {body}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { marginHorizontal: -14 },
  row: { paddingHorizontal: 14, paddingVertical: 10, gap: 6, borderBottomWidth: 1 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  bottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  meta: { fontSize: 11, fontFamily: 'Inter_400Regular', fontVariant: ['tabular-nums'] },
});
