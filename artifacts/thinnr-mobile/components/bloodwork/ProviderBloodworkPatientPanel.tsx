import React, { type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { PatientHeader } from '@/components/patient/PatientHeader';
import { ProviderBloodworkSection } from '@/components/bloodwork/ProviderBloodworkSection';
import { useOfficeRoster } from '@/components/office/LiveOfficeRoster';
import { useSupabaseSession } from '@/lib/supabase';
import { canOpenProviderBloodwork } from '@/lib/bloodwork-scope';

interface ProviderBloodworkPatientPanelProps {
  patientId: string;
  fallback?: ReactNode;
}

export function ProviderBloodworkPatientPanel({
  patientId,
  fallback,
}: ProviderBloodworkPatientPanelProps) {
  const { session, sessionLoading } = useSupabaseSession();
  const colors = useColors();
  if (sessionLoading) {
    return <ActivityIndicator color={colors.cobalt} style={styles.loading} />;
  }
  if (!session?.user.id) {
    if (fallback !== undefined) return <>{fallback}</>;
    return <UnavailableMessage />;
  }
  return (
    <AccountProviderBloodworkPanel
      key={session.user.id}
      patientId={patientId}
      sessionUserId={session.user.id}
      fallback={fallback}
    />
  );
}

function UnavailableMessage() {
  const colors = useColors();
  return (
    <View style={styles.message}>
      <Text style={[styles.messageTitle, { color: colors.navy }]}>Patient bloodwork unavailable</Text>
      <Text style={[styles.messageText, { color: colors.subtleText }]}>
        Sign in with the patient’s authorized office account to view private reports.
      </Text>
    </View>
  );
}

function AccountProviderBloodworkPanel({
  patientId,
  sessionUserId,
  fallback,
}: ProviderBloodworkPatientPanelProps & { sessionUserId: string }) {
  const colors = useColors();
  const office = useOfficeRoster(sessionUserId);
  const allowed = canOpenProviderBloodwork({
    sessionUserId,
    rosterStatus: office.status,
    rosterPatientIds: office.roster?.patients.map(patient => patient.id) ?? [],
    patientId,
  });

  if (office.status === 'loading') {
    return <ActivityIndicator color={colors.cobalt} style={styles.loading} />;
  }
  if (!allowed) {
    if (fallback !== undefined) return <>{fallback}</>;
    return <UnavailableMessage />;
  }

  return (
    <ProviderBloodworkSection
      patientId={patientId}
      onPressReport={reportId => router.push(`/patient/${patientId}/bloodwork/${reportId}`)}
    />
  );
}

export function ProviderBloodworkPatientShell(props: ProviderBloodworkPatientPanelProps) {
  const colors = useColors();
  return (
    <View style={[styles.shell, { backgroundColor: colors.background }]}>
      <PatientHeader
        title="Patient bloodwork"
        right={(
          <Pressable
            onPress={() => router.canGoBack() ? router.back() : router.replace('/patients')}
            accessibilityLabel="Back to patient list"
          >
            <Feather name="arrow-left" size={20} color={colors.navy} />
          </Pressable>
        )}
      />
      <View style={styles.content}>
        <ProviderBloodworkPatientPanel {...props} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: { flex: 1 },
  content: { flex: 1, padding: 16 },
  loading: { padding: 40 },
  message: { padding: 32, alignItems: 'center' },
  messageTitle: { fontSize: 17, fontFamily: 'Inter_600SemiBold', textAlign: 'center' },
  messageText: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center', marginTop: 8 },
});