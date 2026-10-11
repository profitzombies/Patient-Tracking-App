/**
 * Phase detail — the full card for one THINNR program phase, including the
 * meal-plan sections held back from the Instructions summary card. The
 * Current / Completed / Upcoming badge derives from the `day` param passed
 * by the Instructions screen (so it stays consistent with the summary
 * there), defaulting to the patient's real program day. A signed-in patient
 * without a loaded program calendar gets no badge — never an assumed day.
 */
import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { PageScrollView as ScrollView } from '@/components/ui/PageScrollView';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Redirect, router, useLocalSearchParams, usePathname } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { PhaseCard } from '@/components/patient/PhaseCard';
import { SyntheticDisclaimer } from '@/components/ui/ScreenHeader';
import { useAppMode } from '@/context/AppModeContext';
import { usePatient } from '@/context/PatientContext';
import { clampProgramDay, phaseById } from '@/data/program-instructions';

export default function PhaseDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const { mode, hydrated: modeHydrated } = useAppMode();
  const { id, day } = useLocalSearchParams<{ id: string; day?: string }>();
  const patient = usePatient();

  const phase = phaseById(id);
  const dayParam = Number(day);
  const fallbackDay = patient.entryFacts?.programDay ?? null;
  const effectiveDay =
    day !== undefined && Number.isFinite(dayParam)
      ? clampProgramDay(dayParam)
      : fallbackDay === null
        ? null
        : clampProgramDay(fallbackDay);

  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 24 : 12);
  const bottomPad = Platform.OS === 'web' ? 32 : insets.bottom + 24;

  // Patient-only route: deep links must not bypass the persona flow. The
  // redirect is gated on pathname so it can't hijack in-flight navigation.
  if (!modeHydrated) return null;
  if (mode !== 'patient') {
    if (!pathname.startsWith('/phase')) return null;
    return <Redirect href={mode === 'staff' ? '/' : '/persona'} />;
  }

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/instructions');
  };

  if (!phase) {
    return (
      <View
        style={[styles.container, styles.missing, { backgroundColor: colors.background, paddingTop: topPad }]}
      >
        <Text style={[styles.missingText, { color: colors.bodyText }]}>Phase not found.</Text>
        <Pressable onPress={goBack} style={({ pressed }) => [pressed && { opacity: 0.7 }]}>
          <Text style={[styles.missingLink, { color: colors.cobalt }]}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* ── Top bar ── */}
      <View
        style={[
          styles.topBar,
          { paddingTop: topPad, borderBottomColor: colors.border, backgroundColor: colors.paperCardAlt },
        ]}
      >
        <Pressable
          testID="phase-back"
          onPress={goBack}
          style={({ pressed }) => [
            styles.topBtn,
            {
              borderColor: colors.border,
              borderRadius: colors.radiusSm,
              backgroundColor: pressed ? colors.accent : colors.card,
            },
          ]}
        >
          <Feather name="chevron-left" size={17} color={colors.bodyText} />
        </Pressable>
        <Text style={[styles.topTitle, { color: colors.navy }]}>Phase {phase.index} of 4</Text>
        <View style={styles.topSpacer} />
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}>
        <PhaseCard phase={phase} day={effectiveDay} variant="full" />
        <SyntheticDisclaimer />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  missing: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  missingText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
  },
  missingLink: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: 1,
  },
  topBtn: {
    width: 34,
    height: 34,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topTitle: {
    fontSize: 15,
    fontFamily: 'PlayfairDisplay_700Bold',
    letterSpacing: 0.2,
  },
  topSpacer: {
    width: 34,
    height: 34,
  },
  content: {
    padding: 16,
  },
});
