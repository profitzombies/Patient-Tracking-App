/**
 * Staff Overview tab: a signed-in office only ever sees its own live
 * numbers (LiveOfficeOverview). While the session is still resolving the tab
 * shows a spinner rather than guessing; a signed-out visitor is redirected to
 * provider sign-in by the root layout, so the loading frame is all that ever
 * renders underneath that redirect.
 */
import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { useSupabaseSession } from '@/lib/supabase';
import { LiveOfficeOverview } from '@/components/office/LiveOfficeOverview';

function LoadingOverviewScreen() {
  const colors = useColors();
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Overview" />
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }} testID="overview-session-loading">
        <ActivityIndicator color={colors.cobalt} />
      </View>
    </View>
  );
}

export default function OverviewScreen() {
  const { session, sessionLoading } = useSupabaseSession();
  if (sessionLoading) return <LoadingOverviewScreen />;
  if (session?.user) return <LiveOfficeOverview key={session.user.id} userId={session.user.id} />;
  return <LoadingOverviewScreen />;
}
