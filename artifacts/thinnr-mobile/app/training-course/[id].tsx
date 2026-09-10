/**
 * Course outline — every published lesson of one live course, in program
 * order, with the same sequential-unlock presentation as the web portal.
 *
 * The demo Care Team persona browses with an empty personal completion map
 * (no staff sign-in exists on mobile), so the unlock frontier sits at the
 * first lesson: exactly what the web's demo persona shows. Team-finished
 * counts come from the live demo roster. Locked rows open the lesson page's
 * locked explanation rather than the lesson itself — a deep link cannot
 * bypass the same rules.
 */
import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { PageScrollView as ScrollView } from '@/components/ui/PageScrollView';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Redirect, router, useLocalSearchParams, usePathname } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import theme, { fonts } from '@/constants/colors';
import { SyntheticDisclaimer } from '@/components/ui/ScreenHeader';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';
import { TrainingStatusView } from '@/components/training/TrainingStatusView';
import { useAppMode } from '@/context/AppModeContext';
import { useTrainingData } from '@/hooks/useTrainingData';
import {
  countVideos,
  completionsFor,
  courseDuration,
  EMPTY_COMPLETION_MAP,
  formatClock,
  formatHours,
  frontierIndex,
  getOrderedVideos,
  officeCourseStats,
  officeRoster,
  videoAvailability,
  videoTeamDone,
  type VideoAvailability,
} from '@/lib/training';

export default function TrainingCourseScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const { mode, hydrated: modeHydrated } = useAppMode();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { status, errorMessage, refresh, findCourse, viewers, completionIndex, accountId, myViewer } = useTrainingData();

  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 24 : 12);
  const bottomPad = Platform.OS === 'web' ? 32 : insets.bottom + 24;

  // Staff-only route: deep links must not bypass the persona flow. The
  // redirect is gated on pathname so it can't hijack in-flight navigation.
  if (!modeHydrated) return null;
  if (mode !== 'staff') {
    if (!pathname.startsWith('/training-course')) return null;
    return <Redirect href={mode === 'patient' ? '/today' : '/persona'} />;
  }

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/training');
  };

  const backRow = (
    <Pressable
      testID="course-back"
      accessibilityRole="button"
      accessibilityLabel="Back to Training"
      onPress={goBack}
      style={({ pressed }) => [styles.backRow, pressed && { opacity: 0.7 }]}
    >
      <Feather name="chevron-left" size={16} color={colors.cobalt} />
      <Text style={[styles.backText, { color: colors.cobalt }]}>All training</Text>
    </Pressable>
  );

  const frame = (children: React.ReactNode) => (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: topPad }}>
      <View style={styles.topBar}>{backRow}</View>
      {children}
    </View>
  );

  if (status !== 'ready') {
    return frame(<TrainingStatusView status={status} errorMessage={errorMessage} onRetry={refresh} />);
  }

  const course = findCourse(id);
  if (!course || course.status !== 'live') {
    return frame(
      <View style={styles.unavailableWrap} testID="course-unavailable">
        <LedgerCard style={styles.unavailableCard}>
          <View style={[styles.lockChip, { backgroundColor: colors.accent }]}>
            <Feather name="slash" size={18} color={colors.cobalt} />
          </View>
          <Text style={[styles.unavailableTitle, { color: colors.navy }]}>
            This course isn't available
          </Text>
          <Text style={[styles.unavailableBody, { color: colors.bodyText }]}>
            It may have been unpublished by THINNR HQ. Head back to Training to see what's live
            right now.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={goBack}
            style={({ pressed }) => [
              styles.primaryBtn,
              { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
              pressed && { opacity: 0.85 },
            ]}
          >
            <Text style={[styles.primaryBtnText, { color: colors.primaryForeground }]}>
              Back to Training
            </Text>
          </Pressable>
        </LedgerCard>
      </View>,
    );
  }

  const order = getOrderedVideos(course, true);
  const myMap = myViewer ? completionsFor(completionIndex, myViewer.id) : EMPTY_COMPLETION_MAP;
  const frontier = frontierIndex(myMap, order);
  const roster = officeRoster(viewers, accountId, order, completionIndex, myViewer?.id ?? null);
  const stats = officeCourseStats(roster);
  const videos = countVideos(course, true);

  const iconFor = (availability: VideoAvailability) =>
    availability === 'done' ? (
      <Feather name="check-circle" size={16} color={colors.activeGreen} />
    ) : availability === 'available' ? (
      <Feather name="play-circle" size={16} color={colors.cobalt} />
    ) : (
      <Feather name="lock" size={15} color={colors.subtleText} />
    );

  return frame(
    <ScrollView
      contentContainerStyle={{ paddingBottom: bottomPad }}
      showsVerticalScrollIndicator={false}
      testID="course-outline-scroll"
    >
      {/* Course header */}
      <View style={styles.headerWrap}>
        <Text style={[styles.kicker, { color: colors.labelText }]}>ENABLEMENT — COURSE</Text>
        <Text style={[styles.title, { color: colors.navy }]}>{course.title}</Text>
        {course.description ? (
          <Text style={[styles.description, { color: colors.bodyText }]}>{course.description}</Text>
        ) : null}
        <View style={styles.chipRow}>
          <View style={[styles.chip, { borderColor: colors.border, backgroundColor: colors.paperCardAlt }]}>
            <Text style={[styles.chipText, { color: colors.bodyText }]}>
              {videos} {videos === 1 ? 'video' : 'videos'}
            </Text>
          </View>
          <View style={[styles.chip, { borderColor: colors.border, backgroundColor: colors.paperCardAlt }]}>
            <Text style={[styles.chipText, { color: colors.bodyText }]}>
              {formatHours(courseDuration(course, true))}
            </Text>
          </View>
          <View style={[styles.chip, { borderColor: colors.border, backgroundColor: colors.paperCardAlt }]}>
            <Text style={[styles.chipText, { color: colors.bodyText }]}>Team avg {stats.avgPct}%</Text>
          </View>
        </View>
      </View>

      {/* Outline */}
      <View style={styles.outlineWrap}>
        <LedgerCard>
          {order.length === 0 ? (
            <Text style={[styles.emptyOutline, { color: colors.subtleText }]}>
              No published lessons yet — THINNR HQ is still assembling this course.
            </Text>
          ) : (
            order.map((item, index) => {
              const availability = videoAvailability(course, item, index, myMap, frontier);
              const teamDone = videoTeamDone(item.video.id, roster, completionIndex);
              const showModuleHeader = index === 0 || order[index - 1]!.module.id !== item.module.id;
              const locked = availability === 'locked';
              return (
                <View key={item.video.id}>
                  {showModuleHeader ? (
                    <View
                      style={[
                        styles.moduleHeader,
                        { borderBottomColor: colors.divider, backgroundColor: colors.paperCardAlt },
                        index > 0 && { borderTopWidth: 1, borderTopColor: colors.divider },
                      ]}
                    >
                      <Text style={[styles.moduleHeaderText, { color: colors.labelText }]}>
                        {item.module.title.toUpperCase()}
                      </Text>
                    </View>
                  ) : null}
                  <Pressable
                    testID={`course-row-${item.video.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Lesson ${item.numbering} ${item.video.title}${
                      locked ? ', locked' : availability === 'done' ? ', completed' : ''
                    }`}
                    accessibilityHint={locked ? 'Opens an explanation of why this lesson is locked' : undefined}
                    onPress={() => {
                      Haptics.selectionAsync();
                      router.push(`/training-lesson/${course.id}/${item.video.id}`);
                    }}
                    style={({ pressed }) => [
                      styles.lessonRow,
                      index < order.length - 1 && { borderBottomWidth: 1, borderBottomColor: colors.divider },
                      pressed && { backgroundColor: colors.accent },
                    ]}
                  >
                    <View style={[styles.lessonContent, locked && styles.lockedContent]}>
                      {iconFor(availability)}
                      <View style={styles.lessonBody}>
                        <Text style={[styles.lessonTitle, { color: colors.navy }]}>
                          <Text style={[styles.lessonNumbering, { color: colors.cobalt }]}>
                            {item.numbering}
                          </Text>{' '}
                          {item.video.title}
                        </Text>
                        <Text style={[styles.lessonMeta, { color: colors.subtleText }]}>
                          {item.subgroup ? `${item.subgroup.title} · ` : ''}
                          {formatClock(item.video.duration)} · {teamDone}/{roster.length} on your team
                          finished
                        </Text>
                      </View>
                      <Feather name="chevron-right" size={16} color={colors.subtleText} />
                    </View>
                  </Pressable>
                </View>
              );
            })
          )}
        </LedgerCard>
      </View>

      {/* Footnotes */}
      <View style={styles.noteWrap}>
        <Text style={[styles.noteText, { color: colors.subtleText }]}>
           Video files aren't streamed here — each lesson's chapters step through its workbook slides.
           Signed-in staff progress persists to their own linked learner.
        </Text>
      </View>

      <SyntheticDisclaimer />
    </ScrollView>,
  );
}

const styles = StyleSheet.create({
  topBar: { paddingHorizontal: 14, paddingBottom: 6 },
  backRow: { flexDirection: 'row', alignItems: 'center', gap: 2, alignSelf: 'flex-start', paddingVertical: 6 },
  backText: { fontSize: 13, fontWeight: '600', fontFamily: 'Inter_600SemiBold' },
  headerWrap: { paddingHorizontal: 16, paddingTop: 6, gap: 8 },
  kicker: { fontSize: 9, fontWeight: '700', letterSpacing: 1.4, fontFamily: 'Inter_700Bold' },
  title: { fontSize: 24, lineHeight: 30, fontFamily: fonts.serifBold },
  description: { fontSize: 12, lineHeight: 18, fontFamily: 'Inter_400Regular' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 },
  chip: { borderWidth: 1, borderRadius: 5, paddingHorizontal: 8, paddingVertical: 4 },
  chipText: { fontSize: 10, fontWeight: '600', fontFamily: 'Inter_600SemiBold', letterSpacing: 0.3 },
  outlineWrap: { paddingHorizontal: 14, paddingTop: 14 },
  emptyOutline: { fontSize: 12, fontFamily: 'Inter_400Regular', padding: 16, lineHeight: 18 },
  moduleHeader: { paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: 1 },
  moduleHeaderText: { fontSize: 9, fontWeight: '700', letterSpacing: 1.2, fontFamily: 'Inter_700Bold' },
  lessonRow: { paddingHorizontal: 14, paddingVertical: 12 },
  lessonContent: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  lockedContent: { opacity: 0.55 },
  lessonBody: { flex: 1, gap: 2 },
  lessonTitle: { fontSize: 13, lineHeight: 18, fontFamily: 'Inter_600SemiBold' },
  lessonNumbering: { fontFamily: 'Inter_700Bold', fontSize: 12 },
  lessonMeta: { fontSize: 10, fontFamily: 'Inter_400Regular' },
  unavailableWrap: { paddingHorizontal: 14, paddingTop: 12 },
  unavailableCard: { padding: 18, gap: 10 },
  lockChip: { width: 38, height: 38, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  unavailableTitle: { fontSize: 18, fontFamily: fonts.serif },
  unavailableBody: { fontSize: 12, lineHeight: 18, fontFamily: 'Inter_400Regular' },
  primaryBtn: { paddingVertical: 10, paddingHorizontal: 14, alignSelf: 'flex-start', marginTop: 2 },
  primaryBtnText: { fontSize: 12, fontWeight: '600', fontFamily: 'Inter_600SemiBold' },
  noteWrap: { paddingHorizontal: 18, paddingTop: 12 },
  noteText: { fontSize: 10, lineHeight: 15, fontFamily: 'Inter_400Regular', textAlign: 'center' },
});
