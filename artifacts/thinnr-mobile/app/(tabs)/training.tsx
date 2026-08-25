/**
 * Training tab — the Care Team persona's window into the LIVE course
 * catalog. Unlike every other provider tab (seeded demo data), this screen
 * reads the same Supabase training tables as the web operations portal and
 * derives identical numbers: video counts, total duration, and team-average
 * progress for the unscoped demo office.
 *
 * Read-only: browsing and progress review only — publishing lives with
 * THINNR HQ on the web, and nothing here writes.
 */
import React from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import theme, { fonts } from '@/constants/colors';
import { ScreenHeader, SyntheticDisclaimer } from '@/components/ui/ScreenHeader';
import { EmptyState, LedgerCard, SectionHeader } from '@/components/ui/LedgerPrimitives';
import { TrainingStatusView } from '@/components/training/TrainingStatusView';
import { useTrainingData } from '@/hooks/useTrainingData';
import {
  countVideos,
  courseDuration,
  formatHours,
  getOrderedVideos,
  officeCourseStats,
  officeRoster,
  type TrainingCourse,
} from '@/lib/training';

export default function TrainingScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const bottomPad = Platform.OS === 'web' ? 84 + 16 : insets.bottom + 84 + 16;

  const { status, errorMessage, refresh, liveCourses, viewers, completionIndex } = useTrainingData();

  // The demo Care Team browses the unscoped demo office: every learner that
  // belongs to a provider office, exactly like the web demo persona.
  const teamSize = viewers.filter(viewer => viewer.accountId !== null).length;

  const statsFor = (course: TrainingCourse) => {
    const order = getOrderedVideos(course, true);
    return officeCourseStats(officeRoster(viewers, null, order, completionIndex, null));
  };

  // Headline team average follows the flagship (oldest live) course, the
  // same course the web roster summarizes.
  const flagship = liveCourses[0];
  const flagshipStats = flagship ? statsFor(flagship) : null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Training" />
      {status !== 'ready' ? (
        <TrainingStatusView status={status} errorMessage={errorMessage} onRetry={refresh} />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: bottomPad }}
          showsVerticalScrollIndicator={false}
          testID="training-home-scroll"
        >
          {/* Headline stats */}
          <View style={styles.summaryGrid}>
            <LedgerCard style={styles.summaryCard} testID="training-stat-live">
              <View style={[styles.summaryIcon, { backgroundColor: colors.accent }]}>
                <MaterialCommunityIcons name="school-outline" size={20} color={colors.cobalt} />
              </View>
              <Text style={[styles.summaryLabel, { color: colors.labelText }]}>LIVE COURSES</Text>
              <Text style={[styles.summaryValue, { color: colors.navy }]}>{liveCourses.length}</Text>
            </LedgerCard>
            <LedgerCard style={styles.summaryCard} testID="training-stat-team">
              <View style={[styles.summaryIcon, { backgroundColor: colors.activeBg }]}>
                <Feather name="users" size={18} color={colors.activeGreen} />
              </View>
              <Text style={[styles.summaryLabel, { color: colors.labelText }]}>TEAM LEARNERS</Text>
              <Text style={[styles.summaryValue, { color: colors.navy }]}>{teamSize}</Text>
            </LedgerCard>
            <LedgerCard style={styles.summaryCard} testID="training-stat-avg">
              <View style={[styles.summaryIcon, { backgroundColor: colors.orangeBg }]}>
                <Feather name="trending-up" size={18} color={colors.orange} />
              </View>
              <Text style={[styles.summaryLabel, { color: colors.labelText }]}>TEAM AVG</Text>
              <Text style={[styles.summaryValue, { color: colors.navy }]}>
                {flagshipStats ? `${flagshipStats.avgPct}%` : '—'}
              </Text>
            </LedgerCard>
          </View>

          {/* Live courses */}
          <View style={styles.coursesSection}>
            <SectionHeader
              label="Enablement"
              value="THINNR program training"
              style={{ marginBottom: 10 }}
            />
            {liveCourses.length === 0 ? (
              <LedgerCard>
                <EmptyState
                  icon={<MaterialCommunityIcons name="school-outline" size={28} color={colors.subtleText} />}
                  title="No live courses yet"
                  body="Courses appear here as soon as THINNR HQ publishes training."
                />
              </LedgerCard>
            ) : (
              liveCourses.map(course => {
                const stats = statsFor(course);
                const videos = countVideos(course, true);
                const duration = formatHours(courseDuration(course, true));
                return (
                  <LedgerCard
                    key={course.id}
                    testID={`training-course-card-${course.id}`}
                    style={styles.courseCard}
                    onPress={() => {
                      Haptics.selectionAsync();
                      router.push(`/training-course/${course.id}`);
                    }}
                  >
                    <View style={styles.courseRow}>
                      <View style={[styles.courseIcon, { backgroundColor: colors.accent }]}>
                        <MaterialCommunityIcons name="school-outline" size={22} color={colors.cobalt} />
                      </View>
                      <View style={styles.courseBody}>
                        <Text style={[styles.courseTitle, { color: colors.navy }]}>{course.title}</Text>
                        {course.description ? (
                          <Text
                            numberOfLines={2}
                            style={[styles.courseDesc, { color: colors.bodyText }]}
                          >
                            {course.description}
                          </Text>
                        ) : null}
                        <Text style={[styles.courseMeta, { color: colors.subtleText }]}>
                          {videos} {videos === 1 ? 'video' : 'videos'} · {duration} · Team avg{' '}
                          {stats.avgPct}%
                        </Text>
                      </View>
                      <Feather name="chevron-right" size={18} color={colors.subtleText} />
                    </View>
                  </LedgerCard>
                );
              })
            )}
          </View>

          {/* Scope + read-only note */}
          <View style={styles.noteWrap}>
            <Text style={[styles.noteText, { color: colors.subtleText }]}>
              Live catalog · THINNR program training across every office in the demo. Browsing is
              read-only — progress numbers come from the live demo team.
            </Text>
          </View>

          <SyntheticDisclaimer />
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  summaryGrid: { flexDirection: 'row', paddingHorizontal: 14, paddingTop: 14, paddingBottom: 10, gap: 8 },
  summaryCard: { flex: 1, padding: 12, gap: 6 },
  summaryIcon: { width: 36, height: 36, borderRadius: theme.radiusSm, alignItems: 'center', justifyContent: 'center' },
  summaryLabel: { fontSize: 8, fontWeight: '700', letterSpacing: 1, fontFamily: 'Inter_700Bold' },
  summaryValue: { fontSize: 22, fontWeight: '600', fontFamily: 'Inter_600SemiBold', letterSpacing: -0.5 },
  coursesSection: { paddingHorizontal: 14, paddingTop: 6 },
  courseCard: { marginBottom: 10 },
  courseRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  courseIcon: { width: 42, height: 42, borderRadius: theme.radiusSm, alignItems: 'center', justifyContent: 'center' },
  courseBody: { flex: 1, gap: 3 },
  courseTitle: { fontSize: 16, fontFamily: fonts.serif },
  courseDesc: { fontSize: 11, lineHeight: 16, fontFamily: 'Inter_400Regular' },
  courseMeta: { fontSize: 10, fontFamily: 'Inter_600SemiBold', letterSpacing: 0.2, marginTop: 2 },
  noteWrap: { paddingHorizontal: 18, paddingTop: 4 },
  noteText: { fontSize: 10, lineHeight: 15, fontFamily: 'Inter_400Regular', textAlign: 'center' },
});
