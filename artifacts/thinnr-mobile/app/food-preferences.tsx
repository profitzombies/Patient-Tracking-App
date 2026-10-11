import React, { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { PageScrollView } from '@/components/ui/PageScrollView';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { usePatient } from '@/context/PatientContext';
import { usePatientAccount } from '@/context/PatientAccountContext';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';
import { GhostButton, PrimaryButton } from '@/components/onboarding/OnboardingFields';
import { FoodPreferencesSections } from '@/components/diet/FoodPreferencesSections';
import { DietSummaryCard } from '@/components/diet/DietSummaryCard';
import { DietNoticeList } from '@/components/diet/DietNoticeList';
import { DIET_DISCLAIMER } from '@/lib/diet-fit';

/**
 * The single Food preferences page: the diet at the top (phase, settings,
 * activity, change-diet door), then one section per list, then the safety
 * answers the patient gave. List edits are instant and ride the offline
 * queue; the diet itself changes through the picker with one confirmation.
 */
export default function FoodPreferencesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const patient = usePatient();
  const { account } = usePatientAccount();
  const topPad = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  const [refreshing, setRefreshing] = useState(false);
  const { diet, dietStatus } = patient;

  const back = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(patient)/plan' as never);
  };

  let body: React.ReactNode;
  if (account.kind === 'unresolved') {
    body = (
      <Text testID="food-preferences-unavailable" style={[styles.body, { color: colors.bodyText }]}>
        Food preferences become available once your account has finished loading.
      </Text>
    );
  } else if (dietStatus === 'loading' || dietStatus === 'idle') {
    body = <Text testID="food-preferences-loading" style={[styles.body, { color: colors.subtleText }]}>Loading your plan…</Text>;
  } else if (dietStatus === 'error' || !diet) {
    body = (
      <LedgerCard style={styles.card} testID="food-preferences-error">
        <Text style={[styles.body, { color: colors.riskText }]}>Couldn’t load your food preferences right now.</Text>
        <GhostButton
          label={refreshing ? 'Retrying…' : 'Try again'}
          disabled={refreshing}
          testID="food-preferences-retry"
          onPress={() => {
            setRefreshing(true);
            void patient.refreshDiet().finally(() => setRefreshing(false));
          }}
          style={styles.gap}
        />
      </LedgerCard>
    );
  } else {
    body = (
      <>
        <DietNoticeList />
        <DietSummaryCard diet={diet} onChangeDiet={() => router.push('/diet-picker' as never)} />
        <FoodPreferencesSections diet={diet} />
        <Text style={[styles.disclaimer, { color: colors.subtleText }]}>{DIET_DISCLAIMER}</Text>
      </>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: topPad }]}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable testID="food-preferences-back" accessibilityRole="button" accessibilityLabel="Back" onPress={back} hitSlop={10}>
          <Feather name="chevron-left" size={22} color={colors.navy} />
        </Pressable>
        <Text style={[styles.title, { color: colors.navy }]}>Food preferences</Text>
        <View style={styles.spacer} />
      </View>
      <PageScrollView testID="food-preferences-screen" contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 28 }]}>
        {body}
        {account.kind === 'unresolved' ? <PrimaryButton label="Go back" onPress={back} style={styles.gap} /> : null}
      </PageScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    minHeight: 58,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
  },
  title: { fontSize: 18, fontFamily: 'PlayfairDisplay_700Bold' },
  spacer: { width: 22 },
  content: { padding: 18, maxWidth: 520, width: '100%', alignSelf: 'center', gap: 16 },
  card: { padding: 14 },
  gap: { marginTop: 12 },
  body: { fontFamily: fonts.sansMedium, fontSize: 13, lineHeight: 18 },
  disclaimer: { fontFamily: fonts.sans, fontSize: 11, lineHeight: 15 },
});
