import React, { useMemo } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { PageScrollView as ScrollView } from '@/components/ui/PageScrollView';
import { Feather } from '@expo/vector-icons';
import { Redirect, router, useLocalSearchParams, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppMode } from '@/context/AppModeContext';
import { useColors } from '@/hooks/useColors';
import { useTrainingData } from '@/hooks/useTrainingData';
import { courseDuration, formatClock, formatHours, teammateStats } from '@/lib/training';
import { TrainingStatusView } from '@/components/training/TrainingStatusView';
import { LedgerCard, SectionHeader } from '@/components/ui/LedgerPrimitives';
import { SyntheticDisclaimer } from '@/components/ui/ScreenHeader';
import theme, { fonts } from '@/constants/colors';

export default function TrainingTeammateScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const { mode, hydrated } = useAppMode();
  const { viewerId } = useLocalSearchParams<{ viewerId: string }>();
  const data = useTrainingData();
  const stats = useMemo(
    () => teammateStats(
      data.viewers, data.accountId, viewerId ?? '', data.courses,
      data.completionIndex, data.myViewer?.id ?? null,
    ),
    [data.viewers, data.accountId, viewerId, data.courses, data.completionIndex, data.myViewer],
  );

  if (!hydrated) return null;
  if (mode !== 'staff') {
    if (!pathname.startsWith('/training-teammate')) return null;
    return <Redirect href={mode === 'patient' ? '/today' : '/persona'} />;
  }
  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 24 : 12);
  const goBack = () => router.canGoBack() ? router.back() : router.replace('/training');
  const frame = (child: React.ReactNode) => (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: topPad }}>
      <Pressable testID="teammate-back" onPress={goBack} style={styles.back}>
        <Feather name="chevron-left" size={16} color={colors.cobalt} />
        <Text style={[styles.backText, { color: colors.cobalt }]}>All training</Text>
      </Pressable>
      {child}
    </View>
  );
  if (data.status !== 'ready') {
    return frame(<TrainingStatusView status={data.status} errorMessage={data.errorMessage} onRetry={data.refresh} />);
  }
  if (!stats) {
    return frame(
      <View style={styles.pad}>
        <LedgerCard style={styles.card}>
          <Text testID="teammate-unavailable" style={[styles.title, { color: colors.navy }]}>This teammate isn't available</Text>
          <Text style={[styles.body, { color: colors.bodyText }]}>They aren't on your office's roster.</Text>
        </LedgerCard>
      </View>,
    );
  }
  return frame(
    <ScrollView contentContainerStyle={{ paddingBottom: Platform.OS === 'web' ? 34 : insets.bottom + 20 }}>
      <View style={styles.header}>
        <Text style={[styles.kicker, { color: colors.labelText }]}>ENABLEMENT — TEAMMATE</Text>
        <Text testID="teammate-name" style={[styles.title, { color: colors.navy }]}>
          {stats.viewer.name}{stats.isSelf ? ' · You' : ''}
        </Text>
        <Text style={[styles.body, { color: colors.subtleText }]}>{stats.viewer.email}</Text>
      </View>
      <View style={styles.metrics}>
        {[
          ['PROGRESS', `${stats.pct}%`],
          ['WATCH TIME', formatHours(stats.watchSeconds)],
          ['COMPLETED', `${stats.done}/${stats.total}`],
        ].map(([label, value]) => (
          <LedgerCard key={label} style={styles.metric}>
            <Text style={[styles.kicker, { color: colors.labelText }]}>{label}</Text>
            <Text style={[styles.metricValue, { color: colors.navy }]}>{value}</Text>
          </LedgerCard>
        ))}
      </View>
      <View style={styles.pad}>
        <SectionHeader label="Assigned live courses" value={`${stats.coursesFinished} finished`} style={styles.section} />
        {stats.courses.map(row => (
          <LedgerCard key={row.course.id} style={styles.rowCard} onPress={() => router.push(`/training-course/${row.course.id}`)}>
            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.rowTitle, { color: colors.navy }]}>{row.course.title}</Text>
                <Text style={[styles.meta, { color: colors.subtleText }]}>
                  {row.done}/{row.total} lessons · watched {formatHours(row.watchSeconds)} · {formatHours(courseDuration(row.course, true))}
                </Text>
              </View>
              <Text style={[styles.pct, { color: colors.cobalt }]}>{row.pct}%</Text>
              <Feather name="chevron-right" size={16} color={colors.subtleText} />
            </View>
          </LedgerCard>
        ))}
      </View>
      <View style={styles.pad}>
        <SectionHeader label="Recent activity" value={`${stats.completedLessons.length} completed`} style={styles.section} />
        <LedgerCard>
          {stats.completedLessons.length === 0 ? (
            <Text style={[styles.empty, { color: colors.subtleText }]}>No completed lessons yet.</Text>
          ) : stats.completedLessons.map((lesson, index) => (
            <View key={`${lesson.courseId}-${lesson.item.video.id}`} style={[styles.activity, index > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }]}>
              <Feather name="check-circle" size={15} color={colors.activeGreen} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.rowTitle, { color: colors.navy }]}>{lesson.item.numbering} {lesson.item.video.title}</Text>
                <Text style={[styles.meta, { color: colors.subtleText }]}>{lesson.courseTitle} · {formatClock(lesson.item.video.duration)}</Text>
              </View>
              <Text style={[styles.date, { color: colors.subtleText }]}>{new Date(lesson.completedAt).toLocaleDateString()}</Text>
            </View>
          ))}
        </LedgerCard>
      </View>
      <SyntheticDisclaimer />
    </ScrollView>,
  );
}

const styles = StyleSheet.create({
  back: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 8 },
  backText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  header: { paddingHorizontal: 16, paddingTop: 8, gap: 4 },
  kicker: { fontSize: 8, letterSpacing: 1.1, fontFamily: 'Inter_700Bold' },
  title: { fontSize: 24, fontFamily: fonts.serifBold },
  body: { fontSize: 12, lineHeight: 18, fontFamily: 'Inter_400Regular' },
  metrics: { flexDirection: 'row', gap: 8, padding: 14 },
  metric: { flex: 1, padding: 11, gap: 5 },
  metricValue: { fontSize: 17, fontFamily: 'Inter_700Bold' },
  pad: { paddingHorizontal: 14, paddingBottom: 14 },
  card: { padding: 18, gap: 8 },
  section: { marginBottom: 9 },
  rowCard: { marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 13 },
  rowTitle: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  meta: { fontSize: 9, lineHeight: 14, fontFamily: 'Inter_400Regular', marginTop: 2 },
  pct: { fontSize: 12, fontFamily: 'Inter_700Bold' },
  activity: { flexDirection: 'row', alignItems: 'center', gap: 9, padding: 12 },
  date: { fontSize: 9, fontFamily: 'Inter_400Regular' },
  empty: { padding: 16, fontSize: 12, fontFamily: 'Inter_400Regular' },
});