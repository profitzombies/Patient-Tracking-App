/**
 * Training tab — the Care Team's window into the LIVE course catalog. It
 * reads the same Supabase training tables as the web operations portal and
 * derives identical numbers: video counts, total duration, and team-average
 * progress for the signed-in office.
 *
 * Publishing stays with THINNR HQ on the web. Signed-in provider staff can
 * manage their own roster enrollment and lesson progress through RPCs.
 */
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { PageScrollView as ScrollView } from '@/components/ui/PageScrollView';
import { OrdinaryTextInput as TextInput } from '@/components/ui/OrdinaryTextInput';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import theme, { fonts } from '@/constants/colors';
import { ScreenHeader, SyntheticDisclaimer } from '@/components/ui/ScreenHeader';
import { EmptyState, LedgerCard, SectionHeader } from '@/components/ui/LedgerPrimitives';
import { TrainingStatusView } from '@/components/training/TrainingStatusView';
import { AppModal } from '@/components/ui/AppModal';
import { useTrainingData } from '@/hooks/useTrainingData';
import {
  countVideos,
  courseDuration,
  formatHours,
  completionsFor,
  getOrderedVideos,
  officeCourseStats,
  officeRoster,
  selfCourseState,
  type TrainingCourse,
} from '@/lib/training';

export default function TrainingScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const bottomPad = Platform.OS === 'web' ? 84 + 16 : insets.bottom + 84 + 16;

  const {
    status, errorMessage, refresh, liveCourses, viewers, completionIndex,
    accountId, myViewer, isLiveStaff, addStaffMember,
  } = useTrainingData();
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [formMessage, setFormMessage] = useState<string | null>(null);

  const flagship = liveCourses[0];
  const flagshipOrder = useMemo(() => flagship ? getOrderedVideos(flagship, true) : [], [flagship]);
  const roster = useMemo(
    () => officeRoster(viewers, accountId, flagshipOrder, completionIndex, myViewer?.id ?? null),
    [viewers, accountId, flagshipOrder, completionIndex, myViewer],
  );
  const teamSize = roster.length;

  const statsFor = (course: TrainingCourse) => {
    const order = getOrderedVideos(course, true);
    return officeCourseStats(officeRoster(viewers, accountId, order, completionIndex, myViewer?.id ?? null));
  };

  // Headline team average follows the flagship (oldest live) course, the
  // same course the web roster summarizes.
  const flagshipStats = flagship ? statsFor(flagship) : null;
  const self = flagship && myViewer
    ? selfCourseState(flagship, completionsFor(completionIndex, myViewer.id))
    : null;

  const submitStaff = async () => {
    if (saving) return;
    if (!name.trim() || !email.trim() || !email.includes('@')) {
      setFormMessage('Enter a teammate name and valid work email.');
      return;
    }
    setSaving(true);
    setFormMessage(null);
    try {
      const viewer = await addStaffMember({ name, email });
      setFormMessage(`${viewer.name} is pre-approved. No invite email was sent.`);
      setName('');
      setEmail('');
    } catch (error) {
      setFormMessage(error instanceof Error ? error.message : 'Could not add this teammate.');
    } finally {
      setSaving(false);
    }
  };

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
          {self && flagship ? (
            <View style={styles.coursesSection}>
              <SectionHeader label="My training" value={flagship.title} style={{ marginBottom: 10 }} />
              <LedgerCard style={styles.myCard}>
                <View style={styles.myRow}>
                  <Text style={[styles.courseTitle, { color: colors.navy }]}>{self.pct}% complete</Text>
                  <Text style={[styles.courseMeta, { color: colors.subtleText }]}>{self.done}/{self.total} lessons</Text>
                </View>
                <View style={[styles.progressTrack, { backgroundColor: colors.track }]}>
                  <View style={[styles.progressFill, { backgroundColor: colors.cobalt, width: `${self.pct}%` }]} />
                </View>
                {self.next ? (
                  <Pressable
                    testID="training-my-next"
                    onPress={() => router.push(`/training-lesson/${flagship.id}/${self.next!.video.id}`)}
                  >
                    <Text style={[styles.nextLink, { color: colors.cobalt }]}>
                      Next: {self.next.numbering} {self.next.video.title}
                    </Text>
                  </Pressable>
                ) : <Text style={[styles.nextLink, { color: colors.activeGreen }]}>All caught up</Text>}
              </LedgerCard>
            </View>
          ) : null}

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

          <View style={styles.coursesSection}>
            <View style={styles.sectionTitleRow}>
              <SectionHeader label="Team roster" value={`${teamSize} learner${teamSize === 1 ? '' : 's'}`} />
              <Pressable
                testID="training-add-teammate"
                onPress={() => {
                  setFormMessage(isLiveStaff ? null : 'Sign in with an office account to add teammates.');
                  setAddOpen(true);
                }}
                style={[styles.addButton, { backgroundColor: colors.cobalt }]}
              >
                <Feather name="plus" size={14} color={colors.primaryForeground} />
                <Text style={[styles.addButtonText, { color: colors.primaryForeground }]}>Add teammate</Text>
              </Pressable>
            </View>
            <LedgerCard>
              {roster.map((entry, index) => (
                <Pressable
                  key={entry.viewer.id}
                  testID={`training-teammate-${entry.viewer.id}`}
                  onPress={() => router.push(`/training-teammate/${entry.viewer.id}` as never)}
                  style={[styles.rosterRow, index > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }]}
                >
                  <View style={styles.courseBody}>
                    <Text style={[styles.rosterName, { color: colors.navy }]}>
                      {entry.viewer.name}{entry.isSelf ? ' · You' : ''}
                    </Text>
                    <Text style={[styles.courseMeta, { color: colors.subtleText }]}>
                      {entry.done}/{entry.total} complete · {formatHours(entry.watchSeconds)} watched
                    </Text>
                  </View>
                  <Text style={[styles.rosterPct, { color: colors.cobalt }]}>{entry.pct}%</Text>
                  <Feather name="chevron-right" size={16} color={colors.subtleText} />
                </Pressable>
              ))}
            </LedgerCard>
          </View>

          {/* Scope + read-only note */}
          <View style={styles.noteWrap}>
            <Text style={[styles.noteText, { color: colors.subtleText }]}>
              Live catalog · Your office roster and your progress are secured by your staff sign-in.
            </Text>
          </View>

          <SyntheticDisclaimer />
        </ScrollView>
      )}
      <AppModal visible={addOpen} transparent animationType="fade" onRequestClose={() => setAddOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.sectionTitleRow}>
              <Text style={[styles.modalTitle, { color: colors.navy }]}>Add teammate</Text>
              <Pressable accessibilityLabel="Close" onPress={() => setAddOpen(false)}>
                <Feather name="x" size={20} color={colors.navy} />
              </Pressable>
            </View>
            <Text style={[styles.modalBody, { color: colors.bodyText }]}>
              This pre-approves their work email for staff sign-up and adds them to your roster. No invite email is sent.
            </Text>
            {isLiveStaff ? <>
              <TextInput testID="training-add-name" value={name} onChangeText={setName} placeholder="Full name"
                placeholderTextColor={colors.subtleText} style={[styles.input, { color: colors.navy, borderColor: colors.border }]} />
              <TextInput testID="training-add-email" value={email} onChangeText={setEmail} placeholder="Work email"
                autoCapitalize="none" keyboardType="email-address" placeholderTextColor={colors.subtleText}
                style={[styles.input, { color: colors.navy, borderColor: colors.border }]} />
              <Pressable testID="training-add-submit" disabled={saving} onPress={() => void submitStaff()}
                style={[styles.submitButton, { backgroundColor: colors.cobalt }]}>
                {saving ? <ActivityIndicator color={colors.primaryForeground} /> :
                  <Text style={[styles.addButtonText, { color: colors.primaryForeground }]}>Pre-approve teammate</Text>}
              </Pressable>
            </> : null}
            {formMessage ? <Text testID="training-add-message" style={[styles.modalBody, { color: colors.bodyText }]}>{formMessage}</Text> : null}
          </View>
        </View>
      </AppModal>
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
  myCard: { padding: 14, gap: 10, marginBottom: 8 },
  myRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  progressTrack: { height: 6, borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: 6, borderRadius: 3 },
  nextLink: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },
  sectionTitleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 10 },
  addButton: { flexDirection: 'row', gap: 5, alignItems: 'center', paddingHorizontal: 10, paddingVertical: 8, borderRadius: theme.radiusSm },
  addButtonText: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },
  rosterRow: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 13 },
  rosterName: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  rosterPct: { fontSize: 12, fontFamily: 'Inter_700Bold' },
  modalBackdrop: { flex: 1, justifyContent: 'center', padding: 20, backgroundColor: 'rgba(0,0,0,0.45)' },
  modalCard: { borderWidth: 1, borderRadius: theme.radius, padding: 18, gap: 12 },
  modalTitle: { fontSize: 20, fontFamily: fonts.serifBold },
  modalBody: { fontSize: 12, lineHeight: 18, fontFamily: 'Inter_400Regular' },
  input: { borderWidth: 1, borderRadius: theme.radiusSm, paddingHorizontal: 12, paddingVertical: 11, fontSize: 14 },
  submitButton: { minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: theme.radiusSm },
});
