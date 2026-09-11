import React, { useMemo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import {
  formatBloodworkElapsedSeconds,
  getBloodworkProcessingLabel,
  getBloodworkProcessingSnapshot,
  type BloodworkReportLike,
} from '@/lib/bloodwork-types';

interface BloodworkProcessingStatusProps {
  report: BloodworkReportLike;
  pollingError?: boolean;
  onRefresh?: () => void;
  onRetryExtraction?: () => void;
  retryPending?: boolean;
}

export function BloodworkProcessingStatus({
  report,
  pollingError = false,
  onRefresh,
  onRetryExtraction,
  retryPending = false,
}: BloodworkProcessingStatusProps) {
  const colors = useColors();
  const snapshot = getBloodworkProcessingSnapshot(report);
  const elapsed = useMemo(
    () => formatBloodworkElapsedSeconds(snapshot.elapsedSeconds),
    [snapshot.elapsedSeconds],
  );
  const total = snapshot.totalPages;
  const completed = snapshot.completedPages;
  const hasCounts = total !== null && completed !== null;
  const progressNow = report.extractionStatus === 'completed' && total !== null
    ? total
    : completed;
  const processingLabel = getBloodworkProcessingLabel(report);
  const delayed = snapshot.activity === 'delayed';
  const unknown = snapshot.activity === 'unknown' || processingLabel === 'checking';
  const refreshNeeded = pollingError || delayed || unknown;
  const showActiveIndicator = snapshot.activity === 'active'
    && processingLabel !== 'queued'
    && !pollingError
    && !delayed
    && !unknown;
  const pendingCopy = 'Your source is saved. You can safely leave this screen; processing continues.';

  if (report.extractionStatus === 'completed') {
    return (
      <View
        testID="bloodwork-processing-completed"
        accessibilityRole="text"
        accessibilityLiveRegion="polite"
        style={[styles.card, { backgroundColor: colors.accent, borderColor: colors.border }]}
      >
        <Feather name="check-circle" size={18} color={colors.activeGreen} />
        <Text style={[styles.title, { color: colors.navy }]}>Completed · Results ready · Unreviewed</Text>
        <Text style={[styles.body, { color: colors.bodyText }]}>
          Results are available as an unreviewed transcription. Review them against the printed report.
        </Text>
        {elapsed ? (
          <Text style={[styles.caption, { color: colors.subtleText }]}>Elapsed {elapsed} · completed</Text>
        ) : null}
        {hasCounts && total !== null ? (
          <>
            <Text style={[styles.caption, { color: colors.subtleText }]}>
              {total} of {total} pages read · results saved
            </Text>
            <View
              testID="bloodwork-processing-progress"
              accessibilityRole="progressbar"
              accessibilityLabel={`Bloodwork processing: ${total} of ${total} pages read; results saved`}
              accessibilityValue={{ min: 0, max: total, now: total }}
              style={[styles.progressTrack, { backgroundColor: colors.border }]}
            >
              <View style={[styles.progressFill, { backgroundColor: colors.activeGreen, width: '100%' }]} />
            </View>
          </>
        ) : null}
      </View>
    );
  }

  if (report.extractionStatus === 'failed') {
    return (
      <View
        testID="bloodwork-processing-failed"
        accessibilityRole="alert"
        style={[styles.card, { backgroundColor: colors.warnBg, borderColor: colors.warnBorder }]}
      >
        <Feather name="alert-triangle" size={18} color={colors.destructive} />
        <Text style={[styles.title, { color: colors.destructive }]}>Reading failed</Text>
        <Text style={[styles.body, { color: colors.bodyText }]}>
          {report.extractionError || 'The saved source is still available. You can try extraction again.'}
        </Text>
        {elapsed ? (
          <Text style={[styles.caption, { color: colors.subtleText }]}>Elapsed {elapsed} · last server update</Text>
        ) : null}
        {hasCounts && total !== null && progressNow !== null ? (
          <>
            <Text style={[styles.caption, { color: colors.subtleText }]}>
              {completed} of {total} pages read · results not saved
            </Text>
            <View
              testID="bloodwork-processing-progress"
              accessibilityRole="progressbar"
              accessibilityLabel={`Bloodwork processing: ${completed} of ${total} pages read; results not saved`}
              accessibilityValue={{ min: 0, max: total, now: progressNow }}
              style={[styles.progressTrack, { backgroundColor: colors.border }]}
            >
              <View
                style={[
                  styles.progressFill,
                   { backgroundColor: colors.destructive, width: `${Math.max(0, Math.min(100, (progressNow / total) * 100))}%` },
                ]}
              />
            </View>
          </>
        ) : null}
        {onRetryExtraction ? (
          <Pressable
            testID="bloodwork-retry-extraction"
            accessibilityRole="button"
            disabled={retryPending}
            onPress={onRetryExtraction}
            style={[styles.action, { borderColor: colors.cobalt }]}
          >
            <Text style={[styles.actionText, { color: colors.cobalt }]}>
              {retryPending ? 'Retrying extraction…' : 'Retry extraction'}
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  const label = unknown
    ? 'Checking processing status'
    : delayed
      ? processingLabel === 'organizing'
        ? 'Organizing results is taking longer than expected'
        : 'Reading pages is taking longer than expected'
      : processingLabel === 'organizing'
        ? 'Organizing results'
        : processingLabel === 'queued'
          ? 'Queued'
          : processingLabel === 'reading'
            ? 'Reading'
            : 'Checking processing status';
  const countText = hasCounts
    ? `${completed} of ${total} pages read${processingLabel === 'organizing' ? ' · Preparing results' : processingLabel === 'queued' ? ' · Waiting to read pages' : ''}`
    : 'Page progress is not available yet';

  return (
    <View
      testID="bloodwork-processing"
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
      style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
    >
      <View style={styles.heading}>
        {showActiveIndicator ? (
          <ActivityIndicator color={colors.cobalt} />
        ) : (
          <Feather
            name={processingLabel === 'queued' ? 'clock' : 'alert-triangle'}
            size={18}
            color={pollingError || delayed || unknown ? colors.warnBorder : colors.cobalt}
          />
        )}
        <View style={styles.headingCopy}>
          <Text style={[styles.title, { color: colors.navy }]}>{label}</Text>
          <Text style={[styles.body, { color: colors.bodyText }]}>{countText}</Text>
          {elapsed ? (
            <Text style={[styles.caption, { color: colors.subtleText }]}>
              Elapsed {elapsed}{pollingError ? ' · last server update' : ''}
            </Text>
          ) : null}
          <Text style={[styles.caption, { color: colors.subtleText }]}>{pendingCopy}</Text>
        </View>
      </View>
       {hasCounts && total !== null && progressNow !== null ? (
        <View
          testID="bloodwork-processing-progress"
          accessibilityRole="progressbar"
           accessibilityLabel={`Bloodwork processing: ${countText}`}
           accessibilityValue={{ min: 0, max: total, now: progressNow }}
          style={[styles.progressTrack, { backgroundColor: colors.border }]}
        >
          <View
            style={[
              styles.progressFill,
              {
                backgroundColor: colors.cobalt,
                 width: `${Math.max(0, Math.min(100, (progressNow / total) * 100))}%`,
              },
            ]}
          />
        </View>
      ) : null}
      {refreshNeeded ? (
        <View style={[styles.warning, { borderTopColor: colors.warnBorder }]}>
          <Text style={[styles.body, { color: colors.bodyText }]}>
            {pollingError
              ? 'Status could not be refreshed. This report is still saved; processing may continue while you are away.'
              : delayed
                ? 'The last server update is delayed. Processing may still be active; no completion estimate is available.'
                : 'The server has not reported a reliable processing state yet. The saved source is still available.'}
          </Text>
          {onRefresh ? (
            <Pressable
              testID="bloodwork-refresh-status"
              accessibilityRole="button"
              onPress={onRefresh}
              style={styles.refresh}
            >
              <Text style={[styles.actionText, { color: colors.cobalt }]}>Refresh status</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 8, padding: 14, marginBottom: 16 },
  heading: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  headingCopy: { flex: 1 },
  title: { fontSize: 15, fontFamily: 'Inter_700Bold' },
  body: { fontSize: 13, lineHeight: 19, fontFamily: 'Inter_400Regular', marginTop: 5 },
  caption: { fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 4 },
  progressTrack: { height: 7, borderRadius: 4, overflow: 'hidden', marginTop: 14 },
  progressFill: { height: '100%', borderRadius: 4 },
  warning: { borderTopWidth: 1, marginTop: 14, paddingTop: 12 },
  action: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: 7, paddingHorizontal: 13, paddingVertical: 9, marginTop: 12 },
  actionText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  refresh: { alignSelf: 'flex-start', paddingVertical: 9, paddingHorizontal: 2 },
});