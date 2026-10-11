import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { PageFlatList as FlatList } from '@/components/ui/PageScrollView';
import { OrdinaryTextInput as TextInput } from '@/components/ui/OrdinaryTextInput';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import theme from '@/constants/colors';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { useSupabaseSession } from '@/lib/supabase';
import {
  InvitePatientModal,
  LiveRosterSection,
  useOfficeRoster,
} from '@/components/office/LiveOfficeRoster';
import { fetchOfficeAlerts } from '@/lib/office-alerts-api';

function LoadingPatientsScreen() {
  const colors = useColors();
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Patients" />
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }} testID="patients-session-loading">
        <ActivityIndicator color={colors.cobalt} />
      </View>
    </View>
  );
}

function LivePatientsScreen({ userId }: { userId: string }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const officeRoster = useOfficeRoster(userId);
  const [attention, setAttention] = useState<
    { status: 'loading' | 'ready' | 'error'; count: number | null }
  >({ status: 'loading', count: null });
  const bottomPad = Platform.OS === 'web' ? 84 + 16 : insets.bottom + 84 + 16;

  const refreshAttention = useCallback(async (signal?: AbortSignal) => {
    setAttention({ status: 'loading', count: null });
    try {
      const alerts = await fetchOfficeAlerts({ userId, signal });
      if (!signal?.aborted) setAttention({ status: 'ready', count: alerts.count });
    } catch {
      if (!signal?.aborted) setAttention({ status: 'error', count: null });
    }
  }, [userId]);

  useEffect(() => {
    const controller = new AbortController();
    void refreshAttention(controller.signal);
    return () => controller.abort();
  }, [refreshAttention]);

  const attentionSubtitle = attention.status === 'ready'
    ? `${attention.count} need attention`
    : attention.status === 'loading'
      ? 'Loading attention…'
      : 'Attention unavailable';

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((current) => (current === text ? null : current)), 5000);
  }, []);

  const onRefresh = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setRefreshing(true);
    void Promise.all([officeRoster.refresh(), refreshAttention()]).finally(() => setRefreshing(false));
  }, [officeRoster.refresh, refreshAttention]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        title="Patients"
        subtitle={attentionSubtitle}
        onSearch={setSearch}
        action={
          officeRoster.status === 'ready'
            ? {
                icon: 'user-plus',
                label: 'Invite patient',
                onPress: () => setInviteOpen(true),
                testID: 'header-invite-patient-btn',
              }
            : undefined
        }
      />
      <View style={[styles.toolbar, { borderBottomColor: colors.border, backgroundColor: colors.paperCardAlt }]}>
        <View style={[styles.searchBox, { borderColor: colors.border, backgroundColor: colors.card }]}>
          <Feather name="search" size={14} color={colors.subtleText} />
          <TextInput
            testID="patients-search-input"
            placeholder="Search live patients..."
            placeholderTextColor={colors.subtleText}
            value={search}
            onChangeText={setSearch}
            style={[styles.searchInput, { color: colors.foreground }]}
          />
          {search.length > 0 ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setSearch('')}>
              <Feather name="x" size={13} color={colors.subtleText} />
            </Pressable>
          ) : null}
        </View>
      </View>
      {notice ? (
        <View
          style={[styles.noticeBar, { backgroundColor: colors.activeBg, borderBottomColor: colors.border }]}
          accessibilityLiveRegion="polite"
          testID="patients-notice"
        >
          <Text style={[styles.noticeText, { color: colors.navy }]}>{notice}</Text>
        </View>
      ) : null}
      <FlatList
        scrollBoundary="refresh"
        data={[]}
        renderItem={() => null}
        ListHeaderComponent={<LiveRosterSection state={officeRoster} search={search} onNotice={showNotice} />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.cobalt} />}
        contentContainerStyle={{ paddingBottom: bottomPad }}
        testID="patients-live-list"
      />
      <InvitePatientModal
        visible={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onInvited={(patient, outcome) => {
          void officeRoster.refresh();
          showNotice(
            outcome === 'sent'
              ? `Invitation sent to ${patient.name}. They sign in with the invited phone number.`
              : `${patient.name} was added, but the email didn’t go out. Use Resend on the live roster.`,
          );
        }}
      />
    </View>
  );
}

export default function PatientsScreen() {
  const { session, sessionLoading } = useSupabaseSession();
  if (sessionLoading) return <LoadingPatientsScreen />;
  if (session?.user) return <LivePatientsScreen key={session.user.id} userId={session.user.id} />;
  // Signed out: the provider gate in the root layout is already redirecting
  // to sign-in; hold the loading frame underneath it.
  return <LoadingPatientsScreen />;
}

const styles = StyleSheet.create({
  toolbar: { borderBottomWidth: 1, paddingHorizontal: 14, paddingVertical: 10, gap: 8 },
  searchBox: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: theme.radiusSm, paddingHorizontal: 10, paddingVertical: 7, gap: 8 },
  searchInput: { flex: 1, fontSize: 13, fontFamily: 'Inter_400Regular' },
  noticeBar: { paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: 1 },
  noticeText: { fontSize: 11, fontFamily: 'Inter_500Medium' },
});
