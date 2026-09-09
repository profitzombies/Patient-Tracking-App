import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Pressable } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { BloodworkHistoryList } from '@/components/bloodwork/BloodworkHistoryList';
import { useFocusEffect } from 'expo-router';
import { useBloodworkHistory } from '@/lib/use-bloodwork-history';
import { useOfficeRoster } from '@/components/office/LiveOfficeRoster';
import { useSupabaseSession } from '@/lib/supabase';

interface ProviderBloodworkSectionProps {
  patientId: string;
  onPressReport: (reportId: string) => void;
}

export function ProviderBloodworkSection({ patientId, onPressReport }: ProviderBloodworkSectionProps) {
  const colors = useColors();
  const officeRoster = useOfficeRoster();
  const { session } = useSupabaseSession();
  const userId = session?.user.id ?? null;
  const userRef = useRef(userId);
  userRef.current = userId;
  const [readyUser, setReadyUser] = useState<string | null>(null);
  useEffect(() => {
    setReadyUser(null);
    if (!userId) return;
    const captured = userId;
    void officeRoster.refresh().then(() => {
      if (userRef.current === captured) setReadyUser(captured);
    });
  }, [userId]);
  const officeId = officeRoster.roster?.office.providerId;
  const { data, isLoading, isError, refetch, isRefetching, isFetching, loadMore } = useBloodworkHistory({
    patientId,
    officeId,
    userId: userId ?? '',
    token: session?.access_token ?? '',
    enabled: officeRoster.status === 'ready' && readyUser === userId && !!patientId && !!userId,
  });
  useFocusEffect(
    React.useCallback(() => {
      if (officeRoster.status === 'ready' && readyUser === userId && userId) void refetch();
    }, [officeRoster.status, readyUser, refetch, userId]),
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.navyLight }]}>Bloodwork</Text>
      </View>
      
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        {officeRoster.status === 'loading' || (!!userId && readyUser !== userId) || (isLoading && !isRefetching) ? (
           <View style={styles.center}>
             <ActivityIndicator color={colors.cobalt} />
           </View>
        ) : isError ? (
           <View style={styles.center}>
              <Text style={[styles.error, { color: colors.destructive }]}>Could not load bloodwork history.</Text>
             <Pressable onPress={() => refetch()} style={[styles.retryBtn, { borderColor: colors.border }]}>
               <Text style={[styles.retryText, { color: colors.navy }]}>Retry</Text>
             </Pressable>
           </View>
        ) : (
           <BloodworkHistoryList 
             reports={data?.reports || []} 
             onPressReport={(r) => onPressReport(r.id)} 
             emptyMessage="No bloodwork reports on file."
              nextCursor={data?.nextCursor}
              loadingMore={isFetching && !isLoading}
              onLoadMore={loadMore}
           />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: 24,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    marginLeft: 2,
  },
  title: {
    fontSize: 19,
    fontFamily: 'PlayfairDisplay_600SemiBold',
    letterSpacing: -0.2,
  },
  card: {
    borderWidth: 1,
    borderRadius: 12,
    overflow: 'hidden',
    padding: 8,
  },
  center: {
    padding: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  error: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
  },
  retryBtn: {
    marginTop: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderWidth: 1,
    borderRadius: 6,
  },
  retryText: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
  },
});
