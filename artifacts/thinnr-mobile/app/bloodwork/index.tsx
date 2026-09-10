import React, { useState, useCallback } from 'react';
import { View, StyleSheet, RefreshControl, Text, Pressable } from 'react-native';
import { PageScrollView as ScrollView } from '@/components/ui/PageScrollView';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import { PatientHeader } from '@/components/patient/PatientHeader';
import { useColors } from '@/hooks/useColors';
import { BloodworkHistoryList } from '@/components/bloodwork/BloodworkHistoryList';
import { Feather } from '@expo/vector-icons';
import { usePatientAccount } from '@/context/PatientAccountContext';
import { usePatient } from '@/context/PatientContext';
import { supabase, useSupabaseSession } from '@/lib/supabase';
import { useBloodworkHistory } from '@/lib/use-bloodwork-history';
import {
  bloodworkEntryRecovery,
  classifyBloodworkError,
  setBloodworkRecoveryRoute,
} from '@/lib/bloodwork-recovery';

export default function BloodworkIndex() {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const accountCtx = usePatientAccount();
  const patient = usePatient();
  const { session } = useSupabaseSession();
  const isReal = accountCtx.account.kind === 'real';
  const patientId = accountCtx.account.kind === 'real' ? accountCtx.account.patientId : '';
  const userId = session?.user.id ?? '';
  const accountKey = isReal && userId ? `${userId}:${patientId}` : 'unavailable';
  const entryRecovery = bloodworkEntryRecovery({
    accountKind: accountCtx.account.kind,
    accountResolving: accountCtx.resolving,
    patientHydrated: patient.hydrated,
    onboardingComplete: patient.hydratedFlags?.onboardingComplete ?? null,
    consentSatisfied: patient.hydratedPrivacy?.consent.satisfied ?? null,
  });
  const { data, isLoading, isError, error, refetch, isFetching, loadMore } = useBloodworkHistory({
    patientId,
    userId,
    token: session?.access_token ?? '',
    enabled: isReal && !!userId,
  });
  const historyRecovery = isError ? classifyBloodworkError(error) : null;

  const [refreshing, setRefreshing] = useState(false);

  // Poll for status updates if any report is processing or queued
  const hasProcessing = data?.reports.some(r => r.extractionStatus === 'queued' || r.extractionStatus === 'processing');
  
  useFocusEffect(
    useCallback(() => {
      if (isReal && userId) void refetch();
      let interval: ReturnType<typeof setInterval> | undefined;
      if (isReal && hasProcessing) {
        interval = setInterval(() => refetch(), 5000);
      }
      return () => {
        if (interval) clearInterval(interval);
      };
    }, [isReal, userId, hasProcessing, refetch])
  );

  const onRefresh = useCallback(async () => {
    if (!isReal) return;
    setRefreshing(true);
    try {
      await refetch();
    } finally {
      setRefreshing(false);
    }
  }, [refetch, isReal]);

  const openNewReport = () => {
    if (accountCtx.account.kind === 'unresolved') {
      accountCtx.retryResolve();
      return;
    }
    if (entryRecovery?.action === 'setup') {
      patient.rehydrate();
      setBloodworkRecoveryRoute('/onboarding/welcome', accountKey);
      router.push('/onboarding/welcome');
      return;
    }
    if (entryRecovery?.action === 'consent') {
      patient.rehydrate();
      setBloodworkRecoveryRoute('/consent', accountKey);
      router.push('/consent');
      return;
    }
    if (entryRecovery?.action === 'account' || entryRecovery?.action === 'retry') {
      patient.rehydrate();
      accountCtx.retryResolve();
      return;
    }
    // Demo mode still opens the existing form so its explicit demo denial is
    // visible at save time; it never gets a live report request.
    router.push('/bloodwork/new');
  };

  const recoverHistory = async () => {
    switch (historyRecovery?.action) {
      case 'setup':
        patient.rehydrate();
        setBloodworkRecoveryRoute('/onboarding/welcome', accountKey);
        router.push('/onboarding/welcome');
        return;
      case 'consent':
        patient.rehydrate();
        setBloodworkRecoveryRoute('/consent', accountKey);
        router.push('/consent');
        return;
      case 'account':
      case 'retry':
        patient.rehydrate();
        accountCtx.retryResolve();
        await refetch();
        return;
      case 'sign_in': {
        const result = await supabase?.auth.refreshSession();
        if (result?.error || !result?.data.session) router.push('/patient-login');
        else {
          patient.rehydrate();
          await refetch();
        }
        return;
      }
      default:
        await refetch();
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <PatientHeader
        title="Bloodwork"
        subtitle="Manage reports & results"
        right={(
          <Pressable onPress={() => router.back()} accessibilityLabel="Back to Plan">
            <Feather name="arrow-left" size={20} color={colors.navy} />
          </Pressable>
        )}
      />
      <ScrollView
        scrollBoundary="refresh"
        contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, 24) }]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.cobalt} />
        }
      >
        <Pressable
          testID="add-bloodwork-report"
          onPress={openNewReport}
          style={[styles.addButton, { backgroundColor: colors.cobalt }]}
        >
          <Feather name="plus" size={18} color={colors.primaryForeground} />
          <Text style={[styles.addText, { color: colors.primaryForeground }]}>Add report</Text>
        </Pressable>
        {entryRecovery && accountCtx.account.kind !== 'demo' ? (
          <View
            testID="bloodwork-entry-recovery"
            accessibilityRole="alert"
            style={[styles.recoveryBox, { backgroundColor: colors.warnBg, borderColor: colors.warnBorder }]}
          >
            <Text style={[styles.recoveryTitle, { color: colors.navy }]}>{entryRecovery.title}</Text>
            <Text style={[styles.recoveryMessage, { color: colors.bodyText }]}>{entryRecovery.message}</Text>
            {entryRecovery.actionLabel ? (
              <Pressable onPress={openNewReport} style={[styles.retry, { borderColor: colors.cobalt }]}>
                <Text style={[styles.addText, { color: colors.cobalt }]}>{entryRecovery.actionLabel}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {isLoading && !refreshing ? (
          <View style={styles.center}>
             <Text style={[styles.msg, { color: colors.subtleText }]}>Loading history...</Text>
          </View>
        ) : isError ? (
          <View style={styles.center}>
              <Text style={[styles.msg, { color: colors.destructive }]}>{historyRecovery?.title ?? 'Could not load bloodwork.'}</Text>
              <Text style={[styles.recoveryMessage, { color: colors.subtleText, textAlign: 'center' }]}>
                {historyRecovery?.message ?? 'Try again in a moment.'}
              </Text>
              <Pressable onPress={() => void recoverHistory()} style={styles.retry}>
                <Text style={[styles.addText, { color: colors.cobalt }]}>{historyRecovery?.actionLabel ?? 'Retry'}</Text>
             </Pressable>
          </View>
        ) : (
          <BloodworkHistoryList 
            reports={data?.reports || []} 
            onPressReport={(r) => router.push(`/bloodwork/${r.id}`)}
            emptyMessage="You have no saved bloodwork reports."
             nextCursor={data?.nextCursor}
             loadingMore={isFetching && !isLoading}
             onLoadMore={loadMore}
          />
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  center: {
    padding: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  msg: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
  },
  addButton: {
    minHeight: 46,
    borderRadius: 8,
    paddingHorizontal: 16,
    marginBottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  addText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  retry: { padding: 12 },
  recoveryBox: { borderWidth: 1, borderRadius: 8, padding: 14, marginBottom: 16 },
  recoveryTitle: { fontSize: 15, fontFamily: 'Inter_700Bold' },
  recoveryMessage: { fontSize: 13, lineHeight: 19, fontFamily: 'Inter_400Regular', marginTop: 6 },
});
