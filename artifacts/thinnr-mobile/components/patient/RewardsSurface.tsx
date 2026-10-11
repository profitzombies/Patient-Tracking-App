import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Feather } from '@expo/vector-icons';
import { router, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { patientContentBottom } from '@/constants/layout';
import { fonts } from '@/constants/colors';
import { TODAY_KEY } from '@/data/patient-data';
import {
  buildLocalRewardState,
  type RewardAward,
} from '@/data/patient-rewards';
import type { PatientRewardsState } from '@/context/PatientAccountContext';
import { usePatient, usePatientSync, usePatientSyncNotice } from '@/context/PatientContext';
import { usePatientAccount } from '@/context/PatientAccountContext';
import { useColors } from '@/hooks/useColors';
import { PatientHeader } from '@/components/patient/PatientHeader';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';
import { PageScrollView as ScrollView } from '@/components/ui/PageScrollView';

export type RewardsView = 'overview' | 'earned' | 'next';

function BackButton() {
  const colors = useColors();
  return (
    <Pressable
      testID="rewards-back"
      accessibilityRole="button"
      accessibilityLabel="Go back"
      hitSlop={10}
      onPress={() => {
        if (router.canGoBack()) router.back();
        else router.replace('/rewards' as Href);
      }}
      style={({ pressed }) => [styles.backButton, { borderColor: colors.border }, pressed && { opacity: 0.65 }]}
    >
      <Feather name="arrow-left" size={15} color={colors.cobalt} />
      <Text style={[styles.backText, { color: colors.cobalt }]}>Back</Text>
    </Pressable>
  );
}

function RewardsStatus({ kind, onRetry }: { kind: 'loading' | 'empty' | 'offline' | 'error' | 'max'; onRetry?: () => void }) {
  const colors = useColors();
  if (kind === 'loading') {
    return (
      <View testID="rewards-loading" accessibilityLabel="Loading rewards" style={styles.statusStack}>
        <View style={[styles.skeletonLine, { backgroundColor: colors.track, width: '42%' }]} />
        <View style={[styles.skeletonLine, { backgroundColor: colors.track, width: '82%' }]} />
        <View style={[styles.skeletonCard, { backgroundColor: colors.card, borderColor: colors.border }]} />
        <View style={[styles.skeletonCard, { backgroundColor: colors.card, borderColor: colors.border }]} />
      </View>
    );
  }
  const copy = {
    empty: ['Your collection is waiting', 'The first award appears after your first meaningful step.'],
    offline: ['Rewards are offline', 'Your last saved progress will return when you are connected.'],
    error: ['Rewards could not load', 'Try again in a moment. Your diary is unchanged.'],
    max: ['You reached the highest level', 'There are no locked awards left. Keep caring for the progress you have made.'],
  }[kind];
  return (
    <View
      testID={`rewards-${kind}`}
      accessibilityRole="alert"
      style={[styles.statusCard, { backgroundColor: colors.card, borderColor: colors.border }]}
    >
      <View style={[styles.statusIcon, { backgroundColor: kind === 'error' ? colors.riskBg : colors.accent }]}>
        <Feather name={kind === 'offline' ? 'wifi-off' : kind === 'error' ? 'alert-circle' : kind === 'max' ? 'check-circle' : 'award'} size={20} color={kind === 'error' ? colors.riskText : colors.cobalt} />
      </View>
      <Text style={[styles.statusTitle, { color: colors.navy }]}>{copy[0]}</Text>
      <Text style={[styles.statusBody, { color: colors.bodyText }]}>{copy[1]}</Text>
      {onRetry ? (
        <Pressable
          testID="rewards-retry"
          accessibilityRole="button"
          accessibilityLabel="Retry loading rewards"
          onPress={onRetry}
          style={({ pressed }) => [styles.retryButton, { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm }, pressed && { opacity: 0.82 }]}
        >
          <Text style={[styles.retryText, { color: colors.primaryForeground }]}>Try again</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function AwardGlyph({ award, earned, size = 20 }: { award: RewardAward; earned: boolean; size?: number }) {
  const colors = useColors();
  return (
    <View style={[styles.awardGlyph, { backgroundColor: earned ? colors.orangeBg : colors.secondary, borderColor: earned ? colors.orangeBorder : colors.border }]}>
      <Feather name={award.icon} size={size} color={earned ? colors.orangeText : colors.subtleText} />
    </View>
  );
}

function AwardRow({ award, onPress }: { award: RewardAward; onPress: () => void }) {
  const colors = useColors();
  const ratio = award.threshold ? Math.min(1, award.progress / award.threshold) : 0;
  return (
    <Pressable
      testID={`reward-award-${award.id}`}
      accessibilityRole="button"
      accessibilityLabel={`${award.title}, ${award.earned ? 'earned' : `${award.progress} of ${award.threshold} ${award.unit}`}`}
      onPress={onPress}
      style={({ pressed }) => [styles.awardRow, { borderBottomColor: colors.divider }, pressed && { opacity: 0.78 }]}
    >
      <AwardGlyph award={award} earned={award.earned} />
      <View style={styles.awardCopy}>
        <View style={styles.awardTitleRow}>
          <Text style={[styles.awardTitle, { color: colors.navy }]}>{award.title}</Text>
          {award.earned ? <Text style={[styles.earnedLabel, { color: colors.orangeText }]}>EARNED</Text> : null}
        </View>
        <Text style={[styles.awardDescription, { color: colors.bodyText }]}>{award.earned ? award.description : award.requirement}</Text>
        {!award.earned ? (
          <View style={styles.progressLine}>
            <View style={[styles.progressTrack, { backgroundColor: colors.track }]}>
              <View style={[styles.progressFill, { backgroundColor: colors.cobalt, width: `${ratio * 100}%` }]} />
            </View>
            <Text style={[styles.progressText, { color: colors.subtleText }]}>
              {award.progress} / {award.threshold}
            </Text>
          </View>
        ) : null}
      </View>
      <Feather name="chevron-right" size={17} color={colors.subtleText} />
    </Pressable>
  );
}

function CelebrationModal({ award, onClose }: { award: RewardAward | null; onClose: () => void }) {
  const colors = useColors();
  return (
    <Modal transparent visible={!!award} animationType="none" onRequestClose={onClose}>
      <View style={[styles.modalBackdrop, { backgroundColor: 'rgba(32,59,100,0.32)' }]}>
        <View style={[styles.modalCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {award ? <AwardGlyph award={award} earned size={27} /> : null}
          <Text style={[styles.modalKicker, { color: colors.orangeText }]}>ADDED TO YOUR COLLECTION</Text>
          <Text style={[styles.modalTitle, { color: colors.navy }]}>{award?.title}</Text>
          <Text style={[styles.modalBody, { color: colors.bodyText }]}>{award?.description}</Text>
          <Pressable
            testID="rewards-celebration-close"
            accessibilityRole="button"
            accessibilityLabel="Close award detail"
            onPress={onClose}
            style={({ pressed }) => [styles.modalButton, { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm }, pressed && { opacity: 0.82 }]}
          >
            <Text style={[styles.modalButtonText, { color: colors.primaryForeground }]}>Keep going</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

export function useRewardsModel() {
  const patient = usePatient();
  const { account, retryResolve } = usePatientAccount();
  const sync = usePatientSync();
  const syncNotice = usePatientSyncNotice();
  const [retrying, setRetrying] = useState(false);
  const [remoteRewards, setRemoteRewards] = useState<PatientRewardsState | null>(null);
  const [rewardError, setRewardError] = useState(false);
  const profileStarting = patient.profile?.startingWeight ?? null;
  const profileCurrent = patient.weightSeries.at(-1)?.weight ?? patient.profile?.currentWeight ?? null;
  // Computed from the device's own entries until the server's ledger answers.
  const localState = useMemo(
    () =>
      buildLocalRewardState({
        entries: patient.allEntries,
        checkIns: patient.checkIns,
        waterFor: patient.waterFor,
        waterTarget: patient.targets.waterOz,
        startingWeight: profileStarting,
        currentWeight: profileCurrent,
        todayKey: patient.entryFacts?.todayKey ?? TODAY_KEY,
      }),
    [patient, profileStarting, profileCurrent],
  );
  const loadRemote = () => {
    if (account.kind !== 'real') return;
    setRetrying(true);
    setRewardError(false);
    void account.api.fetchRewards(patient.entryFacts?.todayKey).then(setRemoteRewards).catch(() => {
      setRewardError(true);
    }).finally(() => setRetrying(false));
  };
  useEffect(() => {
    setRemoteRewards(null);
    setRewardError(false);
    if (account.kind === 'real' && sync.online) loadRemote();
  // The account identity is the boundary; the API object and today's key are
  // stable for that account during a screen visit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.kind === 'real' ? account.patientId : account.kind, sync.online, patient.entryFacts?.todayKey]);
  const rewardState = remoteRewards ?? localState;
  const awards = rewardState.awards as RewardAward[];
  const retry = () => {
    if (account.kind === 'unresolved') retryResolve();
    else if (account.kind === 'real') loadRemote();
    else patient.rehydrate();
  };
  return {
    patient,
    account,
    sync,
    syncNotice,
    retry,
    retrying,
    rewardError,
    hasRemoteRewards: remoteRewards !== null,
    rewards: rewardState,
    awards,
    earned: awards.filter(award => award.earned),
    next: awards.filter(award => !award.earned),
    maxLevel: rewardState.level >= 50,
  };
}

export function RewardsScreen({ view }: { view: RewardsView }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const insetsBottom = patientContentBottom(insets.bottom);
  const model = useRewardsModel();
  const [selected, setSelected] = useState<RewardAward | null>(null);
  const { patient, account, sync, syncNotice, retry, retrying, rewardError, hasRemoteRewards, rewards, awards, earned, next, maxLevel } = model;
  const title = view === 'overview' ? 'Rewards' : view === 'earned' ? 'My awards' : 'Next awards';
  const offline = account.kind === 'unresolved' || (account.kind === 'real' && !sync.online);
  const loading = (account.kind === 'real' && !hasRemoteRewards && !rewardError && !offline) || model.retrying;
  const error = rewardError || (!!syncNotice && !offline);
  const status = offline ? 'offline' : error ? 'error' : loading ? 'loading' : view === 'earned' && earned.length === 0 ? 'empty' : null;
  const firstName = patient.entryFacts?.firstName ?? 'there';
  const earnedCount = earned.length;
  const levelProgress = rewards.nextLevelXp === null
    ? 1
    : Math.min(1, Math.max(0, (rewards.totalXp - rewards.levelXp) / Math.max(1, rewards.nextLevelXp - rewards.levelXp)));

  useEffect(() => {
    if (view !== 'overview' || account.kind !== 'real' || rewards.newlyUnlocked.length === 0) return;
    const key = `thinnr:rewards:seen:${account.patientId}`;
    let active = true;
    void AsyncStorage.getItem(key).then(raw => {
      const seen = new Set(raw ? JSON.parse(raw) as string[] : []);
      const nextId = rewards.newlyUnlocked.find(id => !seen.has(id));
      if (!active || !nextId) return;
      seen.add(nextId);
      setSelected(rewards.awards.find(award => award.id === nextId) as RewardAward | null);
      return AsyncStorage.setItem(key, JSON.stringify([...seen].slice(-100)));
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [account, rewards, view]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <PatientHeader
        title={title}
        subtitle={view === 'overview' ? 'MILESTONES THAT BELONG TO YOU' : view === 'earned' ? 'YOUR COLLECTION' : 'AHEAD, ONE STEP AT A TIME'}
        right={view !== 'overview' ? <BackButton /> : undefined}
      />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insetsBottom }]} showsVerticalScrollIndicator={false}>
        {status ? (
          <RewardsStatus kind={status} onRetry={status === 'error' || status === 'offline' ? retry : undefined} />
        ) : (
          <>
            {view === 'overview' ? (
              <>
                <View style={styles.intro}>
                  <Text style={[styles.eyebrow, { color: colors.orangeText }]}>YOUR PROGRESS, MADE TANGIBLE</Text>
                  <Text style={[styles.heading, { color: colors.navy }]}>A quiet record of the work, {firstName}.</Text>
                  <Text style={[styles.introBody, { color: colors.bodyText }]}>Awards are private markers for the steps you choose to take. There is no race here.</Text>
                </View>
                <LedgerCard accentTop testID="rewards-level-card" style={styles.levelCard}>
                  <View style={styles.levelTop}>
                    <View>
                      <Text style={[styles.cardLabel, { color: colors.labelText }]}>CURRENT LEVEL</Text>
                      <Text style={[styles.levelValue, { color: colors.navy }]}>Level {rewards.level}</Text>
                    </View>
                    <View style={[styles.levelMark, { backgroundColor: colors.accent }]}>
                      <Feather name={maxLevel ? 'check' : 'award'} size={22} color={colors.cobalt} />
                    </View>
                  </View>
                  <View style={[styles.levelTrack, { backgroundColor: colors.track }]}>
                    <View style={[styles.levelFill, { backgroundColor: colors.cobalt, width: `${levelProgress * 100}%` }]} />
                  </View>
                  <Text style={[styles.levelMeta, { color: colors.subtleText }]}>
                    {maxLevel ? 'You reached the highest level. XP still counts.' : `${rewards.totalXp.toLocaleString()} XP · ${rewards.xpToNextLevel.toLocaleString()} XP to level ${rewards.level + 1}`}
                  </Text>
                </LedgerCard>
                {maxLevel ? (
                  <View style={[styles.maxBanner, { backgroundColor: colors.orangeBg, borderColor: colors.orangeBorder }]}>
                    <Feather name="award" size={17} color={colors.orangeText} />
                    <Text style={[styles.maxText, { color: colors.orangeText }]}>Highest level reached. Let the work settle in.</Text>
                  </View>
                ) : null}
                <View style={styles.sectionHeading}>
                  <Text style={[styles.sectionTitle, { color: colors.navy }]}>Keep your eye on the next marker</Text>
                  <Pressable testID="rewards-view-next" accessibilityRole="button" accessibilityLabel="View next awards" onPress={() => router.push('/rewards/next-awards' as Href)} style={({ pressed }) => pressed && { opacity: 0.65 }}>
                    <Text style={[styles.linkText, { color: colors.cobalt }]}>See all</Text>
                  </Pressable>
                </View>
                <LedgerCard>
                  {(next.slice(0, 2).length ? next.slice(0, 2) : awards.slice(-2)).map(award => <AwardRow key={award.id} award={award} onPress={() => setSelected(award)} />)}
                </LedgerCard>
                <View style={styles.sectionHeading}>
                  <Text style={[styles.sectionTitle, { color: colors.navy }]}>Recent earning history</Text>
                </View>
                <LedgerCard testID="rewards-history">
                  {rewards.history.length === 0 ? (
                    <Text style={[styles.historyEmpty, { color: colors.subtleText }]}>Your first confirmed earning will appear here.</Text>
                  ) : rewards.history.slice(0, 3).map(entry => (
                    <View key={entry.id} style={[styles.historyRow, { borderBottomColor: colors.divider }]}>
                      <Text style={[styles.historyLabel, { color: colors.navy }]}>{entry.label}</Text>
                      <Text style={[styles.historyXp, { color: colors.orangeText }]}>+{entry.xp} XP</Text>
                    </View>
                  ))}
                </LedgerCard>
                <Pressable testID="rewards-today-entry" accessibilityRole="button" accessibilityLabel="Open today's reward progress" onPress={() => router.push('/today')} style={({ pressed }) => [styles.todayEntry, { backgroundColor: colors.sidebarBg, borderColor: colors.border }, pressed && { opacity: 0.78 }]}>
                  <View style={[styles.todayIcon, { backgroundColor: colors.card }]}>
                    <Feather name="sun" size={16} color={colors.orangeText} />
                  </View>
                  <View style={styles.awardCopy}>
                    <Text style={[styles.cardLabel, { color: colors.labelText }]}>TODAY</Text>
                    <Text style={[styles.todayTitle, { color: colors.navy }]}>Keep today's momentum visible</Text>
                  </View>
                  <Feather name="chevron-right" size={17} color={colors.cobalt} />
                </Pressable>
                <View style={styles.linkStack}>
                  <Pressable testID="rewards-view-earned" accessibilityRole="button" accessibilityLabel="View my awards" onPress={() => router.push('/rewards/my-awards' as Href)} style={({ pressed }) => [styles.outlineButton, { borderColor: colors.border }, pressed && { opacity: 0.72 }]}>
                    <Text style={[styles.outlineButtonText, { color: colors.cobalt }]}>View my awards</Text>
                    <Feather name="arrow-right" size={15} color={colors.cobalt} />
                  </Pressable>
                </View>
              </>
            ) : (
              <>
                <View style={styles.intro}>
                  <Text style={[styles.eyebrow, { color: colors.orangeText }]}>{view === 'earned' ? 'THE COLLECTION' : 'LOOKING AHEAD'}</Text>
                  <Text style={[styles.heading, { color: colors.navy }]}>{view === 'earned' ? 'The work you have kept.' : 'Your next meaningful steps.'}</Text>
                  <Text style={[styles.introBody, { color: colors.bodyText }]}>{view === 'earned' ? 'These markers stay with you. Open one to pause on what it represents.' : 'Nothing here asks for perfection. Each marker is simply a clear next step.'}</Text>
                </View>
                {view === 'next' && maxLevel ? (
                  <RewardsStatus kind="max" />
                ) : (
                  <LedgerCard testID={`rewards-${view}-list`}>
                    {(view === 'earned' ? earned : next).map(award => <AwardRow key={award.id} award={award} onPress={() => setSelected(award)} />)}
                  </LedgerCard>
                )}
              </>
            )}
          </>
        )}
        {retrying ? <Text style={[styles.syncHint, { color: colors.subtleText }]}>Refreshing your rewards…</Text> : null}
      </ScrollView>
      <CelebrationModal award={selected?.earned ? selected : null} onClose={() => setSelected(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 20 },
  intro: { marginBottom: 18 },
  eyebrow: { fontFamily: fonts.sansBold, fontSize: 10, letterSpacing: 1.15 },
  heading: { fontFamily: fonts.serifBold, fontSize: 27, lineHeight: 33, marginTop: 7 },
  introBody: { fontFamily: fonts.sans, fontSize: 13, lineHeight: 20, marginTop: 8, maxWidth: 350 },
  levelCard: { padding: 16 },
  levelTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardLabel: { fontFamily: fonts.sansBold, fontSize: 9, letterSpacing: 1.05 },
  levelValue: { fontFamily: fonts.serif, fontSize: 25, marginTop: 4 },
  levelMark: { width: 46, height: 46, alignItems: 'center', justifyContent: 'center', borderRadius: 23 },
  levelTrack: { height: 8, marginTop: 18, overflow: 'hidden' },
  levelFill: { height: '100%' },
  levelMeta: { fontFamily: fonts.sans, fontSize: 11, marginTop: 8 },
  maxBanner: { flexDirection: 'row', alignItems: 'center', gap: 9, borderWidth: 1, padding: 12, marginTop: 13 },
  maxText: { flex: 1, fontFamily: fonts.sansMedium, fontSize: 12, lineHeight: 17 },
  sectionHeading: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 25, marginBottom: 10 },
  sectionTitle: { flex: 1, fontFamily: fonts.serif, fontSize: 19, lineHeight: 24 },
  linkText: { fontFamily: fonts.sansBold, fontSize: 11 },
  awardRow: { flexDirection: 'row', alignItems: 'center', gap: 11, borderBottomWidth: 1, paddingHorizontal: 14, paddingVertical: 14 },
  awardGlyph: { width: 42, height: 42, borderWidth: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 21 },
  awardCopy: { flex: 1 },
  awardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  awardTitle: { fontFamily: fonts.sansSemiBold, fontSize: 14 },
  earnedLabel: { fontFamily: fonts.sansBold, fontSize: 8, letterSpacing: 0.75 },
  awardDescription: { fontFamily: fonts.sans, fontSize: 11, lineHeight: 16, marginTop: 3 },
  historyEmpty: { fontFamily: fonts.sans, fontSize: 12, lineHeight: 18, padding: 14 },
  historyRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 10, borderBottomWidth: 1, paddingHorizontal: 14, paddingVertical: 12 },
  historyLabel: { flex: 1, fontFamily: fonts.sans, fontSize: 12 },
  historyXp: { fontFamily: fonts.sansBold, fontSize: 11 },
  progressLine: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  progressTrack: { flex: 1, height: 5, overflow: 'hidden' },
  progressFill: { height: '100%' },
  progressText: { fontFamily: fonts.sansMedium, fontSize: 10 },
  todayEntry: { flexDirection: 'row', alignItems: 'center', gap: 11, borderWidth: 1, marginTop: 13, padding: 12 },
  todayIcon: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 17 },
  todayTitle: { fontFamily: fonts.sansSemiBold, fontSize: 13, marginTop: 3 },
  linkStack: { marginTop: 13 },
  outlineButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1, paddingVertical: 12 },
  outlineButtonText: { fontFamily: fonts.sansBold, fontSize: 12 },
  statusStack: { gap: 12 },
  skeletonLine: { height: 12, opacity: 0.75 },
  skeletonCard: { height: 108, borderWidth: 1, borderRadius: 9, opacity: 0.8 },
  statusCard: { alignItems: 'center', borderWidth: 1, padding: 24, marginTop: 8 },
  statusIcon: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 24 },
  statusTitle: { fontFamily: fonts.serif, fontSize: 20, marginTop: 14, textAlign: 'center' },
  statusBody: { fontFamily: fonts.sans, fontSize: 13, lineHeight: 19, marginTop: 6, textAlign: 'center' },
  retryButton: { paddingHorizontal: 18, paddingVertical: 10, marginTop: 17 },
  retryText: { fontFamily: fonts.sansBold, fontSize: 12 },
  syncHint: { textAlign: 'center', fontFamily: fonts.sans, fontSize: 11, marginTop: 15 },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 7 },
  backText: { fontFamily: fonts.sansSemiBold, fontSize: 11 },
  modalBackdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  modalCard: { alignItems: 'center', width: '100%', maxWidth: 340, borderWidth: 1, padding: 24 },
  modalKicker: { fontFamily: fonts.sansBold, fontSize: 9, letterSpacing: 1.1, marginTop: 16 },
  modalTitle: { fontFamily: fonts.serifBold, fontSize: 25, marginTop: 5, textAlign: 'center' },
  modalBody: { fontFamily: fonts.sans, fontSize: 13, lineHeight: 20, marginTop: 7, textAlign: 'center' },
  modalButton: { paddingHorizontal: 22, paddingVertical: 11, marginTop: 20 },
  modalButtonText: { fontFamily: fonts.sansBold, fontSize: 12 },
});
