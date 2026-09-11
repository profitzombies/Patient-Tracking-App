import React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useColors } from '@/hooks/useColors';

/**
 * Bloodwork loading placeholders intentionally stay static. A static skeleton
 * does not imply a processing percentage and remains quiet for reduced-motion
 * users. Each screen owns its skeleton so a refresh never replaces content
 * that has already loaded.
 */
export function BloodworkHistorySkeleton() {
  const colors = useColors();

  return (
    <View
      testID="bloodwork-history-skeleton"
      accessibilityRole="progressbar"
      accessibilityLabel="Loading bloodwork history"
      accessibilityLiveRegion={Platform.OS === 'ios' ? undefined : 'polite'}
      aria-busy={true}
      aria-live="polite"
      style={styles.history}
    >
      {Array.from({ length: 5 }, (_, index) => (
        <View
          key={index}
          testID="bloodwork-history-skeleton-row"
          accessible={false}
          style={[styles.historyRow, { borderColor: colors.border, backgroundColor: colors.card }]}
        >
          <View style={[styles.fileIcon, { backgroundColor: colors.accent }]} />
          <View style={styles.historyCopy}>
            <View style={[styles.titleLine, { backgroundColor: colors.border }]} />
            <View style={[styles.metaLine, { backgroundColor: colors.border }]} />
          </View>
          <View style={[styles.statusLine, { backgroundColor: colors.border }]} />
          <View style={[styles.chevronLine, { backgroundColor: colors.border }]} />
        </View>
      ))}
    </View>
  );
}

export function BloodworkDetailSkeleton() {
  const colors = useColors();

  return (
    <View
      testID="bloodwork-detail-skeleton"
      accessibilityRole="progressbar"
      accessibilityLabel="Loading bloodwork report"
      accessibilityLiveRegion={Platform.OS === 'ios' ? undefined : 'polite'}
      aria-busy={true}
      aria-live="polite"
      style={styles.detail}
    >
      <View style={[styles.detailTitle, { backgroundColor: colors.border }]} />
      <View style={[styles.detailMeta, { backgroundColor: colors.border }]} />
      <View style={[styles.detailMetaShort, { backgroundColor: colors.border }]} />
      <View style={styles.detailActions}>
        <View style={[styles.actionLine, { backgroundColor: colors.border }]} />
        <View style={[styles.actionLine, { backgroundColor: colors.border }]} />
      </View>
      <View style={[styles.resultsHeading, { backgroundColor: colors.border }]} />
      <View style={[styles.processingCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={[styles.processingIcon, { backgroundColor: colors.accent }]} />
        <View style={styles.processingCopy}>
          <View style={[styles.processingTitle, { backgroundColor: colors.border }]} />
          <View style={[styles.processingBody, { backgroundColor: colors.border }]} />
          <View style={[styles.processingBodyShort, { backgroundColor: colors.border }]} />
        </View>
      </View>
      <View style={[styles.resultRow, { backgroundColor: colors.card, borderColor: colors.border }]} />
      <View style={[styles.resultRow, { backgroundColor: colors.card, borderColor: colors.border }]} />
    </View>
  );
}

export function BloodworkSourcePageSkeleton() {
  const colors = useColors();

  return (
    <View testID="bloodwork-source-skeleton" accessible={false} style={styles.source}>
      <View
        testID="bloodwork-source-page-image-skeleton"
        style={[styles.sourcePage, { backgroundColor: colors.card, borderColor: colors.border }]}
      >
        <View style={[styles.sourcePageLine, { backgroundColor: colors.border }]} />
        <View style={[styles.sourcePageLineShort, { backgroundColor: colors.border }]} />
        <View style={[styles.sourcePageLine, { backgroundColor: colors.border }]} />
        <View style={[styles.sourcePageLineMedium, { backgroundColor: colors.border }]} />
        <View style={[styles.sourcePageLine, { backgroundColor: colors.border }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  history: { width: '100%', gap: 0 },
  historyRow: {
    minHeight: 62,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  fileIcon: { width: 36, height: 36, borderRadius: 8 },
  historyCopy: { flex: 1 },
  titleLine: { width: '72%', height: 14, borderRadius: 4, marginBottom: 9 },
  metaLine: { width: '42%', height: 11, borderRadius: 4 },
  statusLine: { width: 52, height: 10, borderRadius: 4, marginRight: 8 },
  chevronLine: { width: 8, height: 16, borderRadius: 4 },
  detail: { padding: 16 },
  detailTitle: { width: '78%', height: 28, borderRadius: 5, marginBottom: 14 },
  detailMeta: { width: '46%', height: 12, borderRadius: 4, marginBottom: 9 },
  detailMetaShort: { width: '58%', height: 12, borderRadius: 4 },
  detailActions: { flexDirection: 'row', gap: 12, marginTop: 18, marginBottom: 28 },
  actionLine: { flex: 1, height: 44, borderRadius: 8 },
  resultsHeading: { width: '62%', height: 15, borderRadius: 4, marginBottom: 12 },
  processingCard: {
    minHeight: 108,
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
    flexDirection: 'row',
    gap: 10,
    marginBottom: 16,
  },
  processingIcon: { width: 18, height: 18, borderRadius: 9 },
  processingCopy: { flex: 1 },
  processingTitle: { width: '62%', height: 15, borderRadius: 4, marginBottom: 10 },
  processingBody: { width: '92%', height: 12, borderRadius: 4, marginBottom: 8 },
  processingBodyShort: { width: '70%', height: 12, borderRadius: 4 },
  resultRow: { height: 68, borderWidth: 1, borderRadius: 8, marginBottom: 1 },
  source: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  sourcePage: {
    width: '86%',
    height: '78%',
    maxWidth: 420,
    borderWidth: 1,
    borderRadius: 4,
    padding: 28,
    justifyContent: 'center',
    gap: 16,
  },
  sourcePageLine: { width: '82%', height: 10, borderRadius: 3 },
  sourcePageLineShort: { width: '48%', height: 10, borderRadius: 3 },
  sourcePageLineMedium: { width: '64%', height: 10, borderRadius: 3 },
});