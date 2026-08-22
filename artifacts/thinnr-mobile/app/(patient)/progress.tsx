/**
 * Progress — weight trend, progress photos, and check-in history.
 */
import React, { useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { PatientHeader } from '@/components/patient/PatientHeader';
import { PatientWeightChart } from '@/components/patient/PatientWeightChart';
import { Divider, LedgerCard, SectionHeader } from '@/components/ui/LedgerPrimitives';
import { SyntheticDisclaimer } from '@/components/ui/ScreenHeader';
import { usePatient } from '@/context/PatientContext';
import {
  ENROLLMENT_DAYS,
  formatDateKey,
  MOOD_LABELS,
  PATIENT_PROFILE,
  TODAY_KEY,
  weightAtDateKey,
} from '@/data/patient-data';
import { PROGRESS_IMAGES } from '@/data/recipe-images';

export default function ProgressScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const patient = usePatient();
  const [photoError, setPhotoError] = useState('');

  const bottomPad = Platform.OS === 'web' ? 84 + 20 : insets.bottom + 84 + 20;

  const currentWeight = patient.weightSeries.at(-1)?.weight ?? PATIENT_PROFILE.currentWeight;
  const lost = PATIENT_PROFILE.startingWeight - currentWeight;
  const recentCheckIns = useMemo(() => patient.checkIns.slice(0, 10), [patient.checkIns]);

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
      let uri = asset.uri;
      if (Platform.OS === 'web' && asset.base64 && !uri.startsWith('data:')) {
        uri = `data:${asset.mimeType ?? 'image/jpeg'};base64,${asset.base64}`;
      }
      await patient.addPhoto({
        dateKey: TODAY_KEY,
        uri,
        label: `Week ${Math.ceil(ENROLLMENT_DAYS / 7)}`,
      });
    } catch {
      setPhotoError('Photo could not be saved — it may be too large for browser storage.');
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <PatientHeader title="Progress" subtitle={`DAY ${ENROLLMENT_DAYS} OF YOUR PROGRAM`} />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}>
        {/* ── Weight trend ── */}
        <SectionHeader label="Weight Trend" value={`${currentWeight.toFixed(1)} lbs`} style={{ marginBottom: 8 }} />
        <LedgerCard style={{ padding: 16, marginBottom: 14 }}>
          <PatientWeightChart points={patient.weightSeries} goalWeight={PATIENT_PROFILE.goalWeight} />
          <Divider style={{ marginVertical: 12 }} />
          <View style={styles.statsRow}>
            <View style={styles.statCol}>
              <Text style={[styles.statValue, { color: colors.navyLight }]}>{PATIENT_PROFILE.startingWeight.toFixed(1)}</Text>
              <Text style={[styles.statLabel, { color: colors.labelText }]}>START</Text>
            </View>
            <View style={styles.statCol}>
              <Text style={[styles.statValue, { color: colors.navy }]}>{currentWeight.toFixed(1)}</Text>
              <Text style={[styles.statLabel, { color: colors.labelText }]}>CURRENT</Text>
            </View>
            <View style={styles.statCol}>
              <Text style={[styles.statValue, { color: colors.cobalt }]}>−{lost.toFixed(1)}</Text>
              <Text style={[styles.statLabel, { color: colors.labelText }]}>LOST</Text>
            </View>
            <View style={styles.statCol}>
              <Text style={[styles.statValue, { color: colors.navyLight }]}>{PATIENT_PROFILE.goalWeight.toFixed(0)}</Text>
              <Text style={[styles.statLabel, { color: colors.labelText }]}>GOAL</Text>
            </View>
          </View>
          <Pressable
            testID="progress-log-weight"
            onPress={() => router.push('/check-in')}
            style={({ pressed }) => [
              styles.primaryBtn,
              { backgroundColor: colors.cobalt },
              pressed && { opacity: 0.88 },
            ]}
          >
            <Text style={[styles.primaryBtnText, { color: colors.primaryForeground }]}>Log Today's Weight</Text>
          </Pressable>
        </LedgerCard>

        {/* ── Progress photos ── */}
        <SectionHeader
          label="Progress Photos"
          action={{ label: '+ Add Photo', onPress: pickPhoto }}
          style={{ marginBottom: 8 }}
        />
        {photoError ? (
          <Text style={[styles.photoError, { color: colors.riskText }]}>{photoError}</Text>
        ) : null}
        <View style={styles.photoGrid}>
          {patient.photos.map(photo => {
            const source = photo.source === 'seed' ? PROGRESS_IMAGES[photo.id] : { uri: photo.uri };
            const seedWeight = photo.source === 'seed' ? weightAtDateKey(photo.dateKey) : null;
            return (
              <LedgerCard key={photo.id} style={styles.photoCard}>
                <Image source={source} style={styles.photoImage} contentFit="cover" transition={120} />
                <View style={styles.photoCaption}>
                  <Text style={[styles.photoLabel, { color: colors.navyLight }]}>{photo.label}</Text>
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
                  <Text style={[styles.checkinDate, { color: colors.navyLight }]}>
                    {checkIn.dateKey === TODAY_KEY ? 'Today' : formatDateKey(checkIn.dateKey)}
                  </Text>
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: 16,
  },
  statsRow: {
    flexDirection: 'row',
  },
  statCol: {
    flex: 1,
  },
  statValue: {
    fontSize: 18,
    fontWeight: '600',
    letterSpacing: -0.5,
    fontFamily: 'Inter_600SemiBold',
  },
  statLabel: {
    fontSize: 8,
    fontWeight: '700',
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
    fontWeight: '700',
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
  photoCaption: {
    padding: 10,
  },
  photoLabel: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
  photoMeta: {
    fontSize: 10,
    marginTop: 2,
    fontFamily: 'Inter_400Regular',
  },
  checkinRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  checkinDate: {
    fontSize: 12.5,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  checkinMeta: {
    fontSize: 10.5,
    marginTop: 2,
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
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
});
