import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import type { BloodworkReport } from '@/lib/bloodwork-types';

interface BloodworkHistoryListProps {
  reports: BloodworkReport[];
  onPressReport: (report: BloodworkReport) => void;
  emptyMessage?: string;
  nextCursor?: string | null;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}

export function BloodworkHistoryList({ reports, onPressReport, emptyMessage = 'No bloodwork reports', nextCursor, loadingMore, onLoadMore }: BloodworkHistoryListProps) {
  const colors = useColors();

  if (reports.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Feather name="file-text" size={24} color={colors.subtleText} style={{ opacity: 0.5 }} />
        <Text style={[styles.emptyText, { color: colors.subtleText }]}>{emptyMessage}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {reports.map((report, index) => (
        <React.Fragment key={report.id}>
          {index > 0 && <View style={[styles.divider, { backgroundColor: colors.border }]} />}
          <Pressable
            onPress={() => onPressReport(report)}
            style={({ pressed }) => [
              styles.row,
              pressed && { backgroundColor: colors.accent },
            ]}
          >
            <View style={[styles.iconChip, { backgroundColor: colors.accent, borderRadius: colors.radiusSm }]}>
              <Feather name={report.kind === 'pdf' ? 'file' : 'image'} size={15} color={colors.cobalt} />
            </View>
            <View style={styles.info}>
              <Text style={[styles.title, { color: colors.navy }]} numberOfLines={1}>
                {report.title}
              </Text>
              <Text style={[styles.meta, { color: colors.subtleText }]}>
                {report.reportDate ? new Date(report.reportDate).toLocaleDateString() : 'No date'}
                {' • '}
                {report.kind === 'pdf' ? `${report.pageCount} pages` : `${report.fileCount} images`}
              </Text>
            </View>
            <View style={styles.statusWrap}>
              <Text
                style={[
                  styles.status,
                  report.extractionStatus === 'failed' && { color: colors.destructive },
                  report.extractionStatus === 'completed' && { color: colors.activeGreen },
                  (report.extractionStatus === 'queued' || report.extractionStatus === 'processing') && { color: colors.cobalt },
                ]}
              >
                {report.extractionStatus.toUpperCase()}
              </Text>
              <Feather name="chevron-right" size={16} color={colors.subtleText} />
            </View>
          </Pressable>
        </React.Fragment>
      ))}
      {nextCursor && onLoadMore ? (
        <Pressable
          testID="bloodwork-load-more"
          disabled={loadingMore}
          onPress={onLoadMore}
          style={styles.loadMore}
        >
          <Text style={[styles.loadMoreText, { color: colors.cobalt }]}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  emptyContainer: {
    paddingVertical: 32,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  emptyText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
  },
  divider: {
    height: 1,
    width: '100%',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 12,
  },
  iconChip: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: {
    flex: 1,
    justifyContent: 'center',
  },
  title: {
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
  },
  meta: {
    fontSize: 12,
    marginTop: 2,
    fontFamily: 'Inter_400Regular',
  },
  statusWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  status: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
  loadMore: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  loadMoreText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
});
