/**
 * Progress — weight trend, progress photos, and check-in history.
 * Heritage language: paper cards with a cobalt accent strip on the featured
 * trend card, ruled stat columns, serif row titles, restrained orange only
 * inside the chart's goal reference.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { PageScrollView as ScrollView } from '@/components/ui/PageScrollView';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { patientContentBottom } from '@/constants/layout';
import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { PatientHeader } from '@/components/patient/PatientHeader';
import { PatientWeightChart } from '@/components/patient/PatientWeightChart';
import { PendingDot } from '@/components/patient/PendingDot';
import { Divider, LedgerCard, SectionHeader } from '@/components/ui/LedgerPrimitives';
import { SyntheticDisclaimer } from '@/components/ui/ScreenHeader';
import { Snackbar } from '@/components/ui/Snackbar';
import { PROGRESS_UNDO_WINDOW_MS, usePatient } from '@/context/PatientContext';
import { usePatientAccount } from '@/context/PatientAccountContext';
import { createGuidedPhotoRequest } from '@/lib/guided-photos';
import { preparePhotoForUpload } from '@/lib/photo-prep';
import { progressPhotoDisplayUrl } from '@/lib/progress-photo-upload';
import { photoDisplayLabels, type RemovedProgressPhoto } from '@/data/progress-photo-state';
import {
  ENROLLMENT_DAYS,
  formatDateKey,
  MOOD_LABELS,
  PATIENT_PROFILE,
  weightAtDateKey,
} from '@/data/patient-data';
import { PROGRESS_IMAGES } from '@/data/recipe-images';

export default function ProgressScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const patient = usePatient();
  const { account } = usePatientAccount();
  const { commitPhotoRemoval } = patient; // stable callback, safe as an effect dep
  // Live program day for real accounts; the demo persona has no entry facts
  // and keeps the seeded enrollment figure, byte-identical.
  const programDay = patient.entryFacts?.programDay ?? ENROLLMENT_DAYS;
  const [photoError, setPhotoError] = useState('');
  // One snackbar slot for the last removed photo, mirroring the diary's undo
  // notice. A fresh object per removal restarts the auto-dismiss timer; once
  // the window lapses the removal is committed for good (for a real account
  // that's when the server record and stored bytes go away) and the snapshot
  // — the only remaining reference to the image data — is dropped.
  const [removedNotice, setRemovedNotice] = useState<{ removed: RemovedProgressPhoto; label: string } | null>(null);

  useEffect(() => {
    if (!removedNotice) return;
    const removed = removedNotice.removed;
    const timer = setTimeout(() => {
      setRemovedNotice(null);
      void commitPhotoRemoval(removed);
    }, UNDO_WINDOW_MS);
    // An unmount mid-window drops this timer, but not the removal itself:
    // the provider backstop armed by removePhoto commits it right after the
    // window, so a real account's server delete still happens.
    return () => clearTimeout(timer);
  }, [removedNotice, commitPhotoRemoval]);

  // Saved-confirmation snackbar for the guided session; same auto-dismiss
  // window as the undo notice so transient notices feel consistent.
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!savedNotice) return;
    const timer = setTimeout(() => setSavedNotice(null), UNDO_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [savedNotice]);

  const bottomPad = patientContentBottom(insets.bottom);

  const currentWeight = patient.weightSeries.at(-1)?.weight ?? PATIENT_PROFILE.currentWeight;
  const lost = PATIENT_PROFILE.startingWeight - currentWeight;
  const recentCheckIns = useMemo(() => patient.checkIns.slice(0, 10), [patient.checkIns]);

  const stats = [
    { key: 'start', label: 'START', value: PATIENT_PROFILE.startingWeight.toFixed(1), color: colors.navyLight },
    { key: 'current', label: 'CURRENT', value: currentWeight.toFixed(1), color: colors.navy },
    { key: 'lost', label: 'LOST', value: `−${lost.toFixed(1)}`, color: colors.cobalt },
    { key: 'goal', label: 'GOAL', value: PATIENT_PROFILE.goalWeight.toFixed(0), color: colors.navyLight },
  ];

  // Hands-free guided session (module-promise handoff, like the food
  // camera): the outcome resolves when the session settles, so the saved
  // count lands back here for the snackbar + announcement.
  const openGuidedSession = () => {
    const outcome = createGuidedPhotoRequest();
    router.push('/guided-photos');
    void outcome.then(result => {
      if (result && result.savedCount > 0) {
        const message =
          result.savedCount === 1
            ? '1 photo saved to your grid.'
            : `${result.savedCount} photos saved to your grid.`;
        setSavedNotice(message);
        AccessibilityInfo.announceForAccessibility(message);
      }
    });
  };

  const pickPhoto = async () => {
    setPhotoError('');
    try {
      if (Platform.OS !== 'web') {
        const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted) {
          setPhotoError('Photo library permission was declined.');
          return;
        }
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.4,
        base64: Platform.OS === 'web',
      });
      if (result.canceled || result.assets.length === 0) return;
      const asset = result.assets[0];
      const label = `Week ${Math.ceil(programDay / 7)}`;
      if (account.kind === 'real') {
        // Signed-in patient: compress here, then hand the prepared bytes to
        // the offline queue. The queued write shows the photo in the grid
        // at once (pending marker), uploads to the account's media rail and
        // records the grid row when connectivity allows — reinstall-safe
        // once synced, and never lost to a dead connection in the meantime.
        const prepared = await preparePhotoForUpload(asset);
        const saved = await patient.addPhoto({ dateKey: patient.todayKey, uri: prepared.uri, label });
        if (!saved) {
          setPhotoError('The photo could not be added to your grid. Please try again.');
        }
        return;
      }
      let uri = asset.uri;
      if (Platform.OS === 'web' && asset.base64 && !uri.startsWith('data:')) {
        uri = `data:${asset.mimeType ?? 'image/jpeg'};base64,${asset.base64}`;
      }
      await patient.addPhoto({ dateKey: patient.todayKey, uri, label });
    } catch (error) {
      if (account.kind === 'real') {
        setPhotoError(
          error instanceof Error && error.message
            ? error.message
            : 'Photo could not be uploaded. Please try again.',
        );
        return;
      }
      setPhotoError('Photo could not be saved — it may be too large for browser storage.');
    }
  };

  // Arm the Undo only after the removal has committed, so a fast Undo tap
  // always acts on a recorded removal (restorePhoto no-ops otherwise). The
  // snackbar carries the de-duplicated display label the card showed. A
  // second removal inside the first one's undo window seals the earlier
  // removal's fate first — its undo chance is gone the moment its snackbar
  // is replaced.
  const handleRemovePhoto = async (id: string, label: string) => {
    const pending = removedNotice;
    if (pending) {
      setRemovedNotice(null);
      void commitPhotoRemoval(pending.removed);
    }
    const removed = await patient.removePhoto(id);
    if (removed) setRemovedNotice({ removed, label });
  };

  const handleUndoRemove = () => {
    if (!removedNotice) return;
    setRemovedNotice(null);
    void patient.restorePhoto(removedNotice.removed);
  };

  // De-duplicated captions ("Week 12", "Week 12 (2)") derived from the
  // displayed list, so removing a duplicate heals the numbering.
  const displayLabels = useMemo(() => photoDisplayLabels(patient.photos), [patient.photos]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <PatientHeader title="Progress" subtitle={`DAY ${programDay} OF YOUR PROGRAM`} />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}>
        {/* ── Weight trend ── */}
        <SectionHeader label="Weight Trend" value={`${currentWeight.toFixed(1)} lbs`} style={{ marginBottom: 8 }} />
        <LedgerCard accentTop style={{ marginBottom: 14 }}>
          <View style={styles.cardBody}>
            <PatientWeightChart points={patient.weightSeries} goalWeight={PATIENT_PROFILE.goalWeight} />
            <Divider style={{ marginVertical: 12 }} />
            <View style={styles.statsRow}>
              {stats.map((stat, index) => (
                <React.Fragment key={stat.key}>
                  {index > 0 && <View style={[styles.statDivider, { backgroundColor: colors.divider }]} />}
                  <View style={styles.statCol}>
                    <Text style={[styles.statValue, { color: stat.color }]}>{stat.value}</Text>
                    <Text style={[styles.statLabel, { color: colors.labelText }]}>{stat.label}</Text>
                  </View>
                </React.Fragment>
              ))}
            </View>
            <Pressable
              testID="progress-log-weight"
              onPress={() => router.push('/check-in')}
              style={({ pressed }) => [
                styles.primaryBtn,
                { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
                pressed && { opacity: 0.88 },
              ]}
            >
              <Text style={[styles.primaryBtnText, { color: colors.primaryForeground }]}>Log Today's Weight</Text>
            </Pressable>
          </View>
        </LedgerCard>

        {/* ── Progress photos ── */}
        <SectionHeader
          label="Progress Photos"
          action={{ label: '+ Add Photo', onPress: pickPhoto }}
          style={{ marginBottom: 8 }}
        />
        <Pressable
          testID="progress-guided-session"
          accessibilityRole="button"
          accessibilityLabel="Start a guided photo session"
          onPress={openGuidedSession}
          style={({ pressed }) => [
            styles.guidedBtn,
            { borderColor: colors.cobalt, backgroundColor: colors.paperCard, borderRadius: colors.radiusSm },
            pressed && { opacity: 0.85 },
          ]}
        >
          <View style={[styles.guidedBtnIcon, { backgroundColor: colors.sidebarBg, borderColor: colors.border }]}>
            <Feather name="camera" size={15} color={colors.cobalt} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.guidedBtnTitle, { color: colors.navy }]}>Guided photo session</Text>
            <Text style={[styles.guidedBtnSub, { color: colors.subtleText }]}>
              Hands-free Front, Side, and Back with a countdown
            </Text>
          </View>
          <Feather name="chevron-right" size={17} color={colors.subtleText} />
        </Pressable>
        {photoError ? (
          <Text style={[styles.photoError, { color: colors.riskText }]}>{photoError}</Text>
        ) : null}
        <View style={styles.photoGrid}>
          {patient.photos.map(photo => {
            const source =
              photo.source === 'seed'
                ? PROGRESS_IMAGES[photo.id]
                : photo.objectPath
                  ? { uri: progressPhotoDisplayUrl(photo.objectPath) }
                  : { uri: photo.uri };
            const seedWeight = photo.source === 'seed' ? weightAtDateKey(photo.dateKey) : null;
            const label = displayLabels.get(photo.id) ?? photo.label;
            return (
              <LedgerCard key={photo.id} style={styles.photoCard}>
                <Image source={source} style={styles.photoImage} contentFit="cover" transition={120} />
                {/* Only photos the patient added can be removed — seed milestones stay. */}
                {photo.source === 'user' && (
                  <Pressable
                    testID={`photo-remove-${photo.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${label} photo`}
                    hitSlop={8}
                    onPress={() => handleRemovePhoto(photo.id, label)}
                    style={({ pressed }) => [
                      styles.photoRemoveBtn,
                      {
                        backgroundColor: colors.paperCard,
                        borderColor: colors.border,
                        borderRadius: colors.radiusSm,
                      },
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <Feather name="x" size={13} color={colors.navy} />
                  </Pressable>
                )}
                <View style={styles.photoCaption}>
                  <View style={styles.photoLabelRow}>
                    <Text style={[styles.photoLabel, { color: colors.navyLight }]}>{label}</Text>
                    <PendingDot entityKey={`photo:${photo.id}`} size={10} />
                  </View>
                  <Text style={[styles.photoMeta, { color: colors.subtleText }]}>
                    {formatDateKey(photo.dateKey)}
                    {seedWeight !== null ? ` · ${seedWeight.toFixed(1)} lbs` : ''}
                  </Text>
                </View>
              </LedgerCard>
            );
          })}
        </View>

        {/* ── Check-in history ── */}
        <SectionHeader label="Check-In History" value="Last 10 entries" style={{ marginBottom: 8, marginTop: 4 }} />
        <LedgerCard style={{ marginBottom: 14 }}>
          {recentCheckIns.map((checkIn, index) => (
            <View key={checkIn.id}>
              {index > 0 && <Divider />}
              <View style={styles.checkinRow}>
                <View style={{ flex: 1 }}>
                  <View style={styles.checkinDateRow}>
                    <Text style={[styles.checkinDate, { color: colors.navyLight }]}>
                      {checkIn.dateKey === patient.todayKey ? 'Today' : formatDateKey(checkIn.dateKey)}
                    </Text>
                    <PendingDot entityKey={`checkIn:${checkIn.dateKey}`} size={10} />
                  </View>
                  <Text style={[styles.checkinMeta, { color: colors.subtleText }]}>
                    Mood: {MOOD_LABELS[checkIn.mood]}
                    {checkIn.sideEffects.length > 0 ? ` · ${checkIn.sideEffects.join(', ')}` : ' · No side effects'}
                  </Text>
                  {checkIn.notes ? (
                    <Text style={[styles.checkinNotes, { color: colors.bodyText }]} numberOfLines={2}>
                      "{checkIn.notes}"
                    </Text>
                  ) : null}
                </View>
                {typeof checkIn.weight === 'number' ? (
                  <Text style={[styles.checkinWeight, { color: colors.navy }]}>{checkIn.weight.toFixed(1)}</Text>
                ) : null}
              </View>
            </View>
          ))}
        </LedgerCard>

        <SyntheticDisclaimer />
      </ScrollView>

      {/* ── Transient undo notice (floats above the tab bar) ── */}
      {removedNotice && (
        <Snackbar
          testID="photo-undo-snackbar"
          message={`Removed “${removedNotice.label}” photo`}
          actionLabel="UNDO"
          actionTestID="photo-undo"
          onAction={handleUndoRemove}
        />
      )}
      {savedNotice && !removedNotice && (
        <Snackbar
          testID="guided-saved-snackbar"
          message={savedNotice}
          actionLabel="OK"
          actionTestID="guided-saved-ok"
          onAction={() => setSavedNotice(null)}
        />
      )}
    </View>
  );
}

// Matches the diary snackbar's undo window, so delete/undo feels the same
// everywhere.
// One clock shared with PatientContext, whose provider-owned backstop
// commits a pending removal just after this window closes.
const UNDO_WINDOW_MS = PROGRESS_UNDO_WINDOW_MS;

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: 16,
  },
  guidedBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1.5,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
  },
  guidedBtnIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  guidedBtnTitle: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
  },
  guidedBtnSub: {
    fontSize: 11.5,
    fontFamily: 'Inter_400Regular',
    marginTop: 2,
  },
  cardBody: {
    padding: 16,
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  statCol: {
    flex: 1,
    alignItems: 'center',
  },
  statDivider: {
    width: 1,
    alignSelf: 'stretch',
  },
  statValue: {
    fontSize: 17,
    letterSpacing: -0.4,
    fontFamily: 'Inter_600SemiBold',
  },
  statLabel: {
    fontSize: 8,
    letterSpacing: 1,
    fontFamily: 'Inter_700Bold',
    marginTop: 3,
  },
  primaryBtn: {
    marginTop: 14,
    paddingVertical: 12,
    alignItems: 'center',
  },
  primaryBtnText: {
    fontSize: 13,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.3,
  },
  photoError: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    marginBottom: 8,
  },
  photoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  photoCard: {
    width: '48.4%',
    marginBottom: 12,
  },
  photoImage: {
    width: '100%',
    height: 150,
  },
  photoRemoveBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 26,
    height: 26,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 2px 6px rgba(32, 59, 100, 0.18)',
  },
  photoCaption: {
    padding: 10,
  },
  photoLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  photoLabel: {
    fontSize: 15,
    fontFamily: 'PlayfairDisplay_600SemiBold',
  },
  photoMeta: {
    fontSize: 10,
    marginTop: 3,
    fontFamily: 'Inter_400Regular',
  },
  checkinRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  checkinDateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  checkinDate: {
    fontSize: 15,
    fontFamily: 'PlayfairDisplay_600SemiBold',
  },
  checkinMeta: {
    fontSize: 10.5,
    marginTop: 3,
    fontFamily: 'Inter_400Regular',
  },
  checkinNotes: {
    fontSize: 11,
    marginTop: 4,
    fontFamily: 'Inter_400Regular',
    lineHeight: 15,
  },
  checkinWeight: {
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
  },
});
