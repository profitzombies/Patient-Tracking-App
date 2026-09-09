import React, { useState, useCallback } from 'react';
import { View, StyleSheet, ScrollView, RefreshControl, Text, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import { PatientHeader } from '@/components/patient/PatientHeader';
import { useColors } from '@/hooks/useColors';
import { BloodworkHistoryList } from '@/components/bloodwork/BloodworkHistoryList';
import { Feather } from '@expo/vector-icons';
import { usePatientAccount } from '@/context/PatientAccountContext';
import { useSupabaseSession } from '@/lib/supabase';
import { useBloodworkHistory } from '@/lib/use-bloodwork-history';

export default function BloodworkIndex() {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const accountCtx = usePatientAccount();
  const { session } = useSupabaseSession();
  const isReal = accountCtx.account.kind === 'real';
  const patientId = accountCtx.account.kind === 'real' ? accountCtx.account.patientId : '';
  const userId = session?.user.id ?? '';
  const { data, isLoading, isError, refetch, isFetching, loadMore } = useBloodworkHistory({
    patientId,
    userId,
    token: session?.access_token ?? '',
    enabled: isReal && !!userId,
  });

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
        contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, 24) }]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.cobalt} />
        }
      >
        <Pressable
          testID="add-bloodwork-report"
          onPress={() => router.push('/bloodwork/new')}
          style={[styles.addButton, { backgroundColor: colors.cobalt }]}
        >
          <Feather name="plus" size={18} color={colors.primaryForeground} />
          <Text style={[styles.addText, { color: colors.primaryForeground }]}>Add report</Text>
        </Pressable>
        {isLoading && !refreshing ? (
          <View style={styles.center}>
             <Text style={[styles.msg, { color: colors.subtleText }]}>Loading history...</Text>
          </View>
        ) : isError ? (
          <View style={styles.center}>
             <Text style={[styles.msg, { color: colors.destructive }]}>Failed to load history.</Text>
             <Pressable onPress={() => void refetch()} style={styles.retry}>
               <Text style={[styles.addText, { color: colors.cobalt }]}>Retry</Text>
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
});
