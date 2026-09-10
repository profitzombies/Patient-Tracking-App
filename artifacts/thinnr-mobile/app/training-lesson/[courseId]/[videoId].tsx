/**
 * Lesson page — one published training video's full detail: chaptered
 * workbook-slide player, description, metadata-only resources, and
 * previous/next navigation.
 *
 * Availability is derived with the same lessonState rules as the course
 * outline, so a deep link to a locked lesson renders the locked explanation
 * (with the blocking lesson named) instead of the content. Everything is
 * Signed-in provider staff can mark their own available lesson complete;
 * signed-out demo browsing remains read-only.
 */
import React, { useState } from 'react';
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
import { SlideFrame } from '@/components/training/SlideFrame';
import { TrainingStatusView } from '@/components/training/TrainingStatusView';
import { useAppMode } from '@/context/AppModeContext';
import { useTrainingData } from '@/hooks/useTrainingData';
import {
  EMPTY_COMPLETION_MAP,
  completionsFor,
  formatClock,
  lessonState,
  type LessonState,
  type TrainingCourse,
} from '@/lib/training';

export default function TrainingLessonScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const { mode, hydrated: modeHydrated } = useAppMode();
  const { courseId, videoId } = useLocalSearchParams<{ courseId: string; videoId: string }>();
  const {
    status, errorMessage, refresh, findCourse, completionIndex,
    myViewer, isLiveStaff, markMyVideoComplete,
  } = useTrainingData();

  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 24 : 12);
  const bottomPad = Platform.OS === 'web' ? 32 : insets.bottom + 24;

  // Staff-only route: deep links must not bypass the persona flow. The
  // redirect is gated on pathname so it can't hijack in-flight navigation.
  if (!modeHydrated) return null;
  if (mode !== 'staff') {
    if (!pathname.startsWith('/training-lesson')) return null;
    return <Redirect href={mode === 'patient' ? '/today' : '/persona'} />;
  }

  const goToOutline = () => {
    if (router.canGoBack()) router.back();
    else router.replace(courseId ? `/training-course/${courseId}` : '/training');
  };

  const backRow = (
    <Pressable
      testID="lesson-back"
      accessibilityRole="button"
      accessibilityLabel="Back to course outline"
      onPress={goToOutline}
      style={({ pressed }) => [styles.backRow, pressed && { opacity: 0.7 }]}
    >
      <Feather name="chevron-left" size={16} color={colors.cobalt} />
      <Text style={[styles.backText, { color: colors.cobalt }]}>Course outline</Text>
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

  const course = findCourse(courseId);
  if (!course || course.status !== 'live') {
    return frame(
      <View style={styles.messageWrap} testID="lesson-course-unavailable">
        <LedgerCard style={styles.messageCard}>
          <View style={[styles.iconChip, { backgroundColor: colors.accent }]}>
            <Feather name="slash" size={18} color={colors.cobalt} />
          </View>
          <Text style={[styles.messageTitle, { color: colors.navy }]}>
            This course isn't available
          </Text>
          <Text style={[styles.messageBody, { color: colors.bodyText }]}>
            It may have been unpublished by THINNR HQ. Head back to Training to see what's live
            right now.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.replace('/training')}
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

  const myMap = myViewer ? completionsFor(completionIndex, myViewer.id) : EMPTY_COMPLETION_MAP;
  const state = lessonState(course, videoId ?? '', myMap);

  if (!state.item) {
    return frame(
      <View style={styles.messageWrap} testID="lesson-unavailable">
        <LedgerCard style={styles.messageCard}>
          <View style={[styles.iconChip, { backgroundColor: colors.accent }]}>
            <Feather name="slash" size={18} color={colors.cobalt} />
          </View>
          <Text style={[styles.messageTitle, { color: colors.navy }]}>
            This lesson isn't available
          </Text>
          <Text style={[styles.messageBody, { color: colors.bodyText }]}>
            It may have been unpublished or reordered by THINNR HQ. The course outline shows every
            lesson that's live right now.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={goToOutline}
            style={({ pressed }) => [
              styles.primaryBtn,
              { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
              pressed && { opacity: 0.85 },
            ]}
          >
            <Text style={[styles.primaryBtnText, { color: colors.primaryForeground }]}>
              Back to course outline
            </Text>
          </Pressable>
        </LedgerCard>
      </View>,
    );
  }

  if (state.availability === 'locked') {
    const blocker = state.blocker;
    return frame(
      <View style={styles.messageWrap} testID="lesson-locked">
        <LedgerCard style={styles.messageCard}>
          <View style={[styles.iconChip, { backgroundColor: colors.warnBg }]}>
            <Feather name="lock" size={18} color={colors.warnText} />
          </View>
          <Text style={[styles.messageTitle, { color: colors.navy }]}>
            This lesson is still locked
          </Text>
          <Text style={[styles.messageBody, { color: colors.bodyText }]}>
            Lessons in “{course.title}” unlock in order.
            {blocker
              ? ` Finish “${blocker.video.title}” (${blocker.numbering}) to open “${state.item.video.title}”.`
              : ''}
          </Text>
          {blocker ? (
            <Pressable
              testID="lesson-open-blocker"
              accessibilityRole="button"
              onPress={() => router.replace(`/training-lesson/${course.id}/${blocker.video.id}`)}
              style={({ pressed }) => [
                styles.primaryBtn,
                { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
                pressed && { opacity: 0.85 },
              ]}
            >
              <Text style={[styles.primaryBtnText, { color: colors.primaryForeground }]}>
                Open your next lesson
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            onPress={goToOutline}
            style={({ pressed }) => [pressed && { opacity: 0.7 }]}
          >
            <Text style={[styles.secondaryLink, { color: colors.cobalt }]}>
              Back to course outline
            </Text>
          </Pressable>
        </LedgerCard>
      </View>,
    );
  }

  return frame(
    <LessonBody
      key={state.item.video.id}
      course={course}
      state={state}
      bottomPad={bottomPad}
      canComplete={isLiveStaff && Boolean(myViewer)}
      onComplete={markMyVideoComplete}
    />,
  );
}

function LessonBody({
  course,
  state,
  bottomPad,
  canComplete,
  onComplete,
}: {
  course: TrainingCourse;
  state: LessonState;
  bottomPad: number;
  canComplete: boolean;
  onComplete: (videoId: string) => Promise<unknown>;
}) {
  const colors = useColors();
  const item = state.item!;
  const video = item.video;
  const [chapterIndex, setChapterIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const chapters = video.chapters;
  const currentChapter = chapters[Math.min(chapterIndex, Math.max(0, chapters.length - 1))];

  // Segment widths are proportional to each chapter's time span.
  const spanFor = (index: number) => {
    if (chapters.length === 0) return 1;
    const start = chapters[index]!.at;
    const end = index + 1 < chapters.length ? chapters[index + 1]!.at : video.duration;
    return Math.max(1, end - start);
  };

  const navCard = (direction: 'prev' | 'next') => {
    const target = direction === 'prev' ? state.prev : state.next;
    const availability = direction === 'prev' ? state.prevAvailability : state.nextAvailability;
    const label = direction === 'prev' ? 'PREVIOUS' : 'NEXT';
    if (!target) {
      return (
        <View style={[styles.navCard, { borderColor: colors.divider, backgroundColor: colors.paperCardAlt }]}>
          <Text style={[styles.navLabel, { color: colors.labelText }]}>{label}</Text>
          <Text style={[styles.navHint, { color: colors.subtleText }]}>
            {direction === 'prev' ? 'Start of course' : 'End of course'}
          </Text>
        </View>
      );
    }
    if (availability === 'locked') {
      return (
        <View
          testID="lesson-next-locked"
          style={[styles.navCard, { borderColor: colors.border, backgroundColor: colors.paperCardAlt }]}
        >
          <View style={styles.navLabelRow}>
            <Text style={[styles.navLabel, { color: colors.labelText }]}>{label}</Text>
            <Feather name="lock" size={11} color={colors.subtleText} />
          </View>
          <Text numberOfLines={2} style={[styles.navTitle, { color: colors.subtleText }]}>
            {target.numbering} {target.video.title}
          </Text>
          <Text style={[styles.navHint, { color: colors.subtleText }]}>
            Locked until the lessons before it are complete
          </Text>
        </View>
      );
    }
    return (
      <Pressable
        testID={`lesson-${direction}`}
        accessibilityRole="button"
        accessibilityLabel={`${direction === 'prev' ? 'Previous' : 'Next'} lesson: ${target.video.title}`}
        onPress={() => {
          Haptics.selectionAsync();
          router.replace(`/training-lesson/${course.id}/${target.video.id}`);
        }}
        style={({ pressed }) => [
          styles.navCard,
          { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card },
        ]}
      >
        <View style={styles.navLabelRow}>
          {direction === 'prev' ? <Feather name="arrow-left" size={11} color={colors.cobalt} /> : null}
          <Text style={[styles.navLabel, { color: colors.labelText }]}>{label}</Text>
          {direction === 'next' ? <Feather name="arrow-right" size={11} color={colors.cobalt} /> : null}
        </View>
        <Text numberOfLines={2} style={[styles.navTitle, { color: colors.navy }]}>
          {target.numbering} {target.video.title}
        </Text>
      </Pressable>
    );
  };

  return (
    <ScrollView
      contentContainerStyle={{ paddingBottom: bottomPad }}
      showsVerticalScrollIndicator={false}
      testID="lesson-scroll"
    >
      {/* Lesson header */}
      <View style={styles.headerWrap}>
        <Text style={[styles.kicker, { color: colors.labelText }]}>
          {course.title.toUpperCase()} — {item.module.title.toUpperCase()}
          {item.subgroup ? ` · ${item.subgroup.title.toUpperCase()}` : ''}
        </Text>
        <Text style={[styles.title, { color: colors.navy }]}>
          {item.numbering} {video.title}
        </Text>
        <View style={styles.chipRow}>
          <View style={[styles.chip, { borderColor: colors.border, backgroundColor: colors.paperCardAlt }]}>
            <Text style={[styles.chipText, { color: colors.bodyText }]}>{formatClock(video.duration)}</Text>
          </View>
          <View style={[styles.chip, { borderColor: colors.border, backgroundColor: colors.paperCardAlt }]}>
            <Text style={[styles.chipText, { color: colors.bodyText }]}>
              Lesson {state.index + 1} of {state.order.length}
            </Text>
          </View>
          {state.availability === 'done' ? (
            <View style={[styles.chip, { borderColor: colors.activeBorder, backgroundColor: colors.activeBg }]}>
              <Text style={[styles.chipText, { color: colors.activeGreen }]}>Completed</Text>
            </View>
          ) : null}
        </View>
      </View>

      {canComplete ? (
        <View style={styles.sectionWrap}>
          {state.availability !== 'done' ? (
            <Pressable
              testID="lesson-mark-complete"
              disabled={saving}
              onPress={async () => {
                setSaving(true);
                setSaveMessage(null);
                try {
                  await onComplete(video.id);
                  setSaveMessage('Lesson completed. Your next lesson is now unlocked.');
                } catch (error) {
                  setSaveMessage(error instanceof Error ? error.message : 'Could not save completion.');
                } finally {
                  setSaving(false);
                }
              }}
              style={[styles.completeButton, { backgroundColor: colors.cobalt }]}
            >
              <Text style={[styles.primaryBtnText, { color: colors.primaryForeground }]}>
                {saving ? 'Saving…' : 'Mark complete & continue'}
              </Text>
            </Pressable>
          ) : null}
          {saveMessage ? <Text testID="lesson-complete-message" style={[styles.saveMessage, { color: colors.bodyText }]}>{saveMessage}</Text> : null}
        </View>
      ) : null}

      {/* Simulated player */}
      <View style={styles.playerWrap}>
        <LedgerCard style={styles.playerCard}>
          <SlideFrame video={video} chapterIndex={chapterIndex} />
          {chapters.length > 0 ? (
            <>
              <View style={styles.segmentRow}>
                {chapters.map((chapter, index) => (
                  <Pressable
                    key={chapter.id}
                    testID={`chapter-segment-${index}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Chapter ${index + 1}: ${chapter.title}`}
                    onPress={() => setChapterIndex(index)}
                    hitSlop={{ top: 10, bottom: 10 }}
                    style={{ flex: spanFor(index) }}
                  >
                    <View
                      style={[
                        styles.segment,
                        { backgroundColor: index <= chapterIndex ? colors.cobalt : colors.track },
                      ]}
                    />
                  </Pressable>
                ))}
              </View>
              <View style={styles.timeRow}>
                <Text style={[styles.timeText, { color: colors.subtleText }]}>
                  CH {String(chapterIndex + 1).padStart(2, '0')} ·{' '}
                  {formatClock(currentChapter?.at ?? 0)}
                </Text>
                <Text style={[styles.timeText, { color: colors.subtleText }]}>
                  {formatClock(video.duration)}
                </Text>
              </View>
            </>
          ) : null}
          <Text style={[styles.playerNote, { color: colors.subtleText }]}>
            Simulated player — the mobile app doesn't stream lesson videos, so the chapters step
            through the lesson's workbook slides.
          </Text>
        </LedgerCard>
      </View>

      {/* About */}
      <View style={styles.sectionWrap}>
        <LedgerCard style={styles.sectionCard}>
          <Text style={[styles.sectionTitle, { color: colors.navy }]}>About this lesson</Text>
          {video.description.length > 0 ? (
            video.description.map((paragraph, index) => (
              <Text key={index} style={[styles.paragraph, { color: colors.bodyText }]}>
                {paragraph}
              </Text>
            ))
          ) : (
            <Text style={[styles.paragraph, { color: colors.subtleText }]}>
              No description has been written for this lesson yet.
            </Text>
          )}
        </LedgerCard>
      </View>

      {/* Prev / next */}
      <View style={styles.navRow}>
        {navCard('prev')}
        {navCard('next')}
      </View>

      {/* Chapters */}
      {chapters.length > 0 ? (
        <View style={styles.sectionWrap}>
          <LedgerCard style={styles.sectionCard}>
            <Text style={[styles.sectionTitle, { color: colors.navy }]}>Chapters</Text>
            <View style={styles.chapterList}>
              {chapters.map((chapter, index) => {
                const active = index === chapterIndex;
                return (
                  <Pressable
                    key={chapter.id}
                    testID={`chapter-row-${index}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Chapter ${index + 1}: ${chapter.title}, ${formatClock(chapter.at)}`}
                    onPress={() => setChapterIndex(index)}
                    style={({ pressed }) => [
                      styles.chapterRow,
                      {
                        backgroundColor: active ? colors.accent : pressed ? colors.paperCardAlt : 'transparent',
                        borderColor: active ? colors.cobalt : 'transparent',
                      },
                    ]}
                  >
                    <Text style={[styles.chapterClock, { color: active ? colors.cobalt : colors.subtleText }]}>
                      {formatClock(chapter.at)}
                    </Text>
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.chapterTitle,
                        { color: colors.navy, fontFamily: active ? 'Inter_600SemiBold' : 'Inter_400Regular' },
                      ]}
                    >
                      {chapter.title}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </LedgerCard>
        </View>
      ) : null}

      {/* Resources */}
      {video.attachments.length > 0 ? (
        <View style={styles.sectionWrap}>
          <LedgerCard style={styles.sectionCard}>
            <Text style={[styles.sectionTitle, { color: colors.navy }]}>Resources</Text>
            <Text style={[styles.resourceIntro, { color: colors.subtleText }]}>
              File hosting isn't connected in this demo — these are listed for reference only.
            </Text>
            <View style={styles.resourceList}>
              {video.attachments.map(attachment => (
                <View
                  key={attachment.id}
                  testID={`attachment-${attachment.id}`}
                  style={[styles.resourceRow, { borderColor: colors.divider }]}
                >
                  <Feather name="file-text" size={15} color={colors.cobalt} />
                  <View style={styles.resourceBody}>
                    <Text numberOfLines={1} style={[styles.resourceName, { color: colors.navy }]}>
                      {attachment.name}
                    </Text>
                    <Text style={[styles.resourceSize, { color: colors.subtleText }]}>
                      {attachment.sizeLabel}
                    </Text>
                  </View>
                  <View style={[styles.resourceChip, { borderColor: colors.warnBorder, backgroundColor: colors.warnBg }]}>
                    <Text style={[styles.resourceChipText, { color: colors.warnText }]}>NO FILE YET</Text>
                  </View>
                </View>
              ))}
            </View>
          </LedgerCard>
        </View>
      ) : null}

      <View style={styles.noteWrap}>
        <Text style={[styles.noteText, { color: colors.subtleText }]}>
           Signed-in office staff can save their own progress. Signed-out Care Team demo browsing
           remains read-only and uses the seeded roster.
        </Text>
      </View>

      <SyntheticDisclaimer />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  topBar: { paddingHorizontal: 14, paddingBottom: 6 },
  backRow: { flexDirection: 'row', alignItems: 'center', gap: 2, alignSelf: 'flex-start', paddingVertical: 6 },
  backText: { fontSize: 13, fontWeight: '600', fontFamily: 'Inter_600SemiBold' },
  headerWrap: { paddingHorizontal: 16, paddingTop: 6, gap: 8 },
  kicker: { fontSize: 9, fontWeight: '700', letterSpacing: 1.2, fontFamily: 'Inter_700Bold', lineHeight: 14 },
  title: { fontSize: 22, lineHeight: 28, fontFamily: fonts.serifBold },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, borderRadius: 5, paddingHorizontal: 8, paddingVertical: 4 },
  chipText: { fontSize: 10, fontWeight: '600', fontFamily: 'Inter_600SemiBold', letterSpacing: 0.3 },
  playerWrap: { paddingHorizontal: 14, paddingTop: 14 },
  playerCard: { padding: 12, gap: 10 },
  segmentRow: { flexDirection: 'row', gap: 3 },
  segment: { height: 5, borderRadius: 2 },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between' },
  timeText: { fontSize: 9, fontWeight: '600', fontFamily: 'Inter_600SemiBold', letterSpacing: 0.5 },
  playerNote: { fontSize: 10, lineHeight: 14, fontFamily: 'Inter_400Regular' },
  sectionWrap: { paddingHorizontal: 14, paddingTop: 10 },
  sectionCard: { padding: 16, gap: 8 },
  sectionTitle: { fontSize: 16, fontFamily: fonts.serif },
  paragraph: { fontSize: 12, lineHeight: 19, fontFamily: 'Inter_400Regular' },
  chapterList: { gap: 2 },
  chapterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderRadius: theme.radiusSm,
  },
  chapterClock: { fontSize: 10, fontWeight: '600', fontFamily: 'Inter_600SemiBold', width: 38 },
  chapterTitle: { fontSize: 12, flex: 1 },
  resourceIntro: { fontSize: 10, lineHeight: 15, fontFamily: 'Inter_400Regular' },
  resourceList: { gap: 8 },
  resourceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  resourceBody: { flex: 1, gap: 1 },
  resourceName: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  resourceSize: { fontSize: 9, fontFamily: 'Inter_400Regular' },
  resourceChip: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 3 },
  resourceChipText: { fontSize: 8, fontWeight: '700', letterSpacing: 0.8, fontFamily: 'Inter_700Bold' },
  navRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingTop: 12 },
  navCard: { flex: 1, borderWidth: 1, borderRadius: theme.radius, padding: 12, gap: 5, minHeight: 72 },
  navLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  navLabel: { fontSize: 8, fontWeight: '700', letterSpacing: 1.1, fontFamily: 'Inter_700Bold' },
  navTitle: { fontSize: 12, lineHeight: 16, fontFamily: 'Inter_600SemiBold' },
  navHint: { fontSize: 9, lineHeight: 13, fontFamily: 'Inter_400Regular' },
  messageWrap: { paddingHorizontal: 14, paddingTop: 12 },
  messageCard: { padding: 18, gap: 10 },
  iconChip: { width: 38, height: 38, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  messageTitle: { fontSize: 18, fontFamily: fonts.serif },
  messageBody: { fontSize: 12, lineHeight: 18, fontFamily: 'Inter_400Regular' },
  primaryBtn: { paddingVertical: 10, paddingHorizontal: 14, alignSelf: 'flex-start', marginTop: 2 },
  primaryBtnText: { fontSize: 12, fontWeight: '600', fontFamily: 'Inter_600SemiBold' },
  secondaryLink: { fontSize: 12, fontWeight: '600', fontFamily: 'Inter_600SemiBold', paddingVertical: 4 },
  noteWrap: { paddingHorizontal: 18, paddingTop: 12 },
  noteText: { fontSize: 10, lineHeight: 15, fontFamily: 'Inter_400Regular', textAlign: 'center' },
  completeButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: theme.radiusSm },
  saveMessage: { fontSize: 11, lineHeight: 16, fontFamily: 'Inter_400Regular', marginTop: 7 },
});
