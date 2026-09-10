import React, { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { PageScrollView as ScrollView } from '@/components/ui/PageScrollView';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Redirect, router } from 'expo-router';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';
import { PrimaryButton } from '@/components/onboarding/OnboardingFields';
import { fonts } from '@/constants/colors';
import { useAppMode } from '@/context/AppModeContext';
import { useCoachChat } from '@/context/CoachChatContext';
import { usePatient } from '@/context/PatientContext';
import { useColors } from '@/hooks/useColors';
import { claimTestRequest, type ClaimTestState, type PreparedClaimTest } from '@/lib/claim-test-api';
import {
  saveClaimTestHandoff,
  type ClaimTestScenario,
} from '@/lib/claim-test-handoff';
import { supabase, useSupabaseSession } from '@/lib/supabase';

const SCENARIOS: Array<{
  id: ClaimTestScenario;
  title: string;
  detail: string;
}> = [
  { id: 'claim_phone', title: 'Claim with phone', detail: 'Remove the login and prepare the phone path as a first-time claim.' },
  { id: 'recover_phone', title: 'Recover with phone', detail: 'Keep the phone linked and prepare the password-reset path.' },
  { id: 'claim_email', title: 'Claim with email', detail: 'Remove the login and prepare the email path as a first-time claim.' },
  { id: 'recover_email', title: 'Recover with email', detail: 'Keep the email linked and prepare the password-reset path.' },
];

function confirmationCopy(scenario: ClaimTestScenario, state: ClaimTestState): string[] {
  const channel = scenario.endsWith('phone') ? 'phone' : 'email';
  const recovery = scenario.startsWith('recover');
  return [
    recovery
      ? `The existing login stays attached so the ${channel} path opens password recovery.`
      : `The existing login linkage will be removed so the ${channel} can be claimed again.`,
    channel === 'phone'
      ? `The approved test phone will be restored. The email on file is ${state.state.hasEmail ? 'kept unchanged' : 'not present'}.`
      : `The phone will be removed from claim matching. The email on file is ${state.state.hasEmail ? 'kept unchanged' : 'not present'}.`,
    'Patient companion data and coach chat on this device will be cleared. Operations data will not be changed.',
    'You will be signed out and sent directly to Claim your account.',
  ];
}

export default function ClaimTestScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { mode, hydrated, setMode } = useAppMode();
  const patient = usePatient();
  const coach = useCoachChat();
  const { session, sessionLoading } = useSupabaseSession();
  const [remote, setRemote] = useState<ClaimTestState | null>(null);
  const [hidden, setHidden] = useState(false);
  const [selected, setSelected] = useState<ClaimTestScenario | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (sessionLoading || !session) return;
    let live = true;
    claimTestRequest(session.access_token)
      .then(result => {
        if (!live) return;
        if (result.status === 403 || result.status === 404) setHidden(true);
        else if (result.status === 200) setRemote(result.data as ClaimTestState);
        else setError('Couldn’t load the private claim test. Try again.');
      })
      .catch(() => live && setError('Couldn’t reach THINNR. Check your connection and try again.'));
    return () => { live = false; };
  }, [session, sessionLoading]);

  if (!hydrated || sessionLoading) return null;
  if (mode !== 'patient' || !session || hidden) return <Redirect href="/today" />;

  const prepare = async () => {
    if (!selected || busy || !supabase) return;
    setBusy(true);
    setError(null);
    try {
      const result = await claimTestRequest(session.access_token, selected);
      const prepared = result.data as PreparedClaimTest | null;
      if (
        result.status !== 200 ||
        prepared?.prepared !== true ||
        prepared.scenario !== selected ||
        typeof prepared.identifier !== 'string' ||
        (prepared.mode !== 'create' && prepared.mode !== 'reset')
      ) {
        setError('The test state could not be prepared. Try again.');
        return;
      }
      let cleanupWarning = !(await saveClaimTestHandoff({
        scenario: prepared.scenario,
        identifier: prepared.identifier,
        mode: prepared.mode,
      }));
      // From this point the server reset is committed. Cleanup cannot be
      // allowed to keep this authenticated screen on top of that new state.
      try {
        try {
          await patient.clearLocalState();
        } catch {
          cleanupWarning = true;
        }
        try {
          coach.clearLocalState();
        } catch {
          cleanupWarning = true;
        }
        try {
          await setMode('patient');
        } catch {
          cleanupWarning = true;
        }
        let globalFailed = false;
        try {
          const global = await supabase.auth.signOut({ scope: 'global' });
          globalFailed = Boolean(global.error);
        } catch {
          globalFailed = true;
        }
        if (globalFailed) {
          cleanupWarning = true;
          try {
            const local = await supabase.auth.signOut({ scope: 'local' });
            if (local.error) cleanupWarning = true;
          } catch {
            cleanupWarning = true;
          }
        }
        if (cleanupWarning) {
          // This also refreshes the synchronous memory value if persistence
          // itself is unavailable.
          await saveClaimTestHandoff({
            scenario: prepared.scenario,
            identifier: prepared.identifier,
            mode: prepared.mode,
            cleanupWarning: true,
          });
        }
      } finally {
        router.replace('/claim-account');
      }
    } catch {
      setError('Couldn’t prepare the claim test. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 24 : 12);
  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad, borderBottomColor: colors.border, backgroundColor: colors.paperCardAlt }]}>
        <Pressable testID="claim-test-back" accessibilityRole="button" accessibilityLabel="Back to Today" onPress={() => router.back()} style={[styles.back, { borderColor: colors.border, backgroundColor: colors.card }]}>
          <Feather name="chevron-left" size={18} color={colors.navy} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.navy }]}>Private claim test</Text>
        <View style={styles.back} />
      </View>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 28 }]}>
        {remote && (
          <>
            <LedgerCard style={styles.card}>
              <Text style={[styles.kicker, { color: colors.labelText }]}>CURRENT ACCOUNT STATE</Text>
              <Text style={[styles.name, { color: colors.navy }]}>{remote.patient.name}</Text>
              <Text style={[styles.body, { color: colors.bodyText }]}>
                {remote.state.claimed ? 'Claimed' : 'Not claimed'} · Phone {remote.state.hasPhone ? remote.patient.phoneMasked : 'not linked'} · Email {remote.state.hasEmail ? remote.patient.emailMasked : 'not linked'}
              </Text>
            </LedgerCard>
            <Text style={[styles.sectionTitle, { color: colors.navy }]}>Choose an exact path</Text>
            {SCENARIOS.map(item => (
              <Pressable
                key={item.id}
                testID={`claim-test-${item.id}`}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected === item.id }}
                onPress={() => setSelected(item.id)}
                style={[styles.choice, { borderColor: selected === item.id ? colors.cobalt : colors.border, backgroundColor: selected === item.id ? colors.activeBg : colors.card }]}
              >
                <Feather name={selected === item.id ? 'check-circle' : 'circle'} size={19} color={selected === item.id ? colors.cobalt : colors.subtleText} />
                <View style={styles.choiceText}>
                  <Text style={[styles.choiceTitle, { color: colors.navy }]}>{item.title}</Text>
                  <Text style={[styles.body, { color: colors.subtleText }]}>{item.detail}</Text>
                </View>
              </Pressable>
            ))}
            {selected && (
              <LedgerCard testID="claim-test-confirmation" style={styles.card}>
                <Text style={[styles.kicker, { color: colors.labelText }]}>CONFIRM CHANGES</Text>
                {confirmationCopy(selected, remote).map(line => (
                  <View key={line} style={styles.bulletRow}>
                    <Text style={{ color: colors.orange }}>•</Text>
                    <Text style={[styles.body, styles.bulletText, { color: colors.bodyText }]}>{line}</Text>
                  </View>
                ))}
                {error && <Text testID="claim-test-error" accessibilityRole="alert" style={[styles.error, { color: colors.riskText }]}>{error}</Text>}
                <PrimaryButton testID="claim-test-prepare" label={busy ? 'Preparing…' : 'Prepare and sign me out'} onPress={prepare} disabled={busy} style={styles.button} />
              </LedgerCard>
            )}
          </>
        )}
        {!remote && error && <Text accessibilityRole="alert" style={[styles.error, { color: colors.riskText }]}>{error}</Text>}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { minHeight: 58, paddingHorizontal: 16, paddingBottom: 10, borderBottomWidth: 1, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  back: { width: 38, height: 38, borderWidth: 1, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontFamily: fonts.sansSemiBold, fontSize: 16, marginBottom: 9 },
  content: { padding: 16, gap: 10 },
  card: { padding: 18 },
  kicker: { fontFamily: fonts.sansBold, fontSize: 10, letterSpacing: 1.4, marginBottom: 8 },
  name: { fontFamily: fonts.serif, fontSize: 22, marginBottom: 5 },
  sectionTitle: { fontFamily: fonts.serif, fontSize: 20, marginTop: 8, marginBottom: 2 },
  body: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
  choice: { borderWidth: 1, borderRadius: 9, padding: 15, flexDirection: 'row', gap: 12, alignItems: 'flex-start', minHeight: 76 },
  choiceText: { flex: 1, gap: 3 },
  choiceTitle: { fontFamily: fonts.sansSemiBold, fontSize: 15 },
  bulletRow: { flexDirection: 'row', gap: 8, marginTop: 7 },
  bulletText: { flex: 1 },
  button: { marginTop: 16 },
  error: { fontFamily: fonts.sansMedium, fontSize: 13, lineHeight: 19, marginTop: 12 },
});