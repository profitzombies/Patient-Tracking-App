import React, { useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ErrorBox, PrimaryButton } from '@/components/onboarding/OnboardingFields';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';
import { useColors } from '@/hooks/useColors';
import { reportSignInByToken } from '@/lib/security-api';

/**
 * "This wasn't me" landing for the link in a new-sign-in or password-changed
 * email. Nothing happens on open: link scanners and accidental taps must not
 * sign a patient out of every device, so the report fires only on the
 * explicit button press.
 */
export default function SecurityReportScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { token } = useLocalSearchParams<{ token?: string | string[] }>();
  const value = Array.isArray(token) ? token[0] : token;
  const [state, setState] = useState<'ready' | 'busy' | 'success' | 'error'>(value ? 'ready' : 'error');
  const [error, setError] = useState<string | null>(value ? null : 'This security link is missing its token.');
  const [forcedReset, setForcedReset] = useState(false);

  const confirm = async () => {
    if (!value || state === 'busy') return;
    setState('busy');
    setError(null);
    try {
      const result = await reportSignInByToken(value);
      setForcedReset(result.forcedReset);
      setState('success');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This security link could not be used.');
      setState('error');
    }
  };

  const top = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  return (
    <View style={[styles.page, { backgroundColor: colors.background, paddingTop: top, paddingBottom: insets.bottom }]}>
      <LedgerCard style={styles.card}>
        <Text style={[styles.kicker, { color: colors.labelText }]}>ACCOUNT SECURITY</Text>
        <Text style={[styles.title, { color: colors.navy }]}>Was that you?</Text>
        {state === 'ready' || state === 'busy' ? (
          <>
            <Text testID="security-report-intro" style={[styles.body, { color: colors.bodyText }]}>
              If you don't recognize the sign-in from the email, confirm below. Every device will be signed out and you'll choose a new password the next time you sign in.
            </Text>
            <PrimaryButton
              testID="security-report-confirm"
              label={state === 'busy' ? 'Securing your account…' : "This wasn't me, sign out everywhere"}
              onPress={confirm}
              disabled={state === 'busy'}
              style={styles.gap}
            />
          </>
        ) : null}
        {state === 'success' ? (
          <Text testID="security-report-success" style={[styles.body, { color: colors.bodyText }]}>
            {forcedReset
              ? 'All sessions were signed out. Choose a new password the next time you sign in.'
              : 'All sessions were signed out. Sign in again with a fresh code when you are ready.'}
          </Text>
        ) : null}
        {state === 'error' && error ? <ErrorBox testID="security-report-error" message={error} /> : null}
        {state === 'success' || state === 'error' ? (
          <PrimaryButton testID="security-report-login" label="Go to patient sign-in" onPress={() => router.replace('/patient-login')} style={styles.gap} />
        ) : null}
      </LedgerCard>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, justifyContent: 'center', paddingHorizontal: 20 },
  card: { width: '100%', maxWidth: 480, alignSelf: 'center', padding: 22 },
  kicker: { fontSize: 10, letterSpacing: 1.5, fontFamily: 'Inter_700Bold', marginBottom: 7 },
  title: { fontSize: 28, fontFamily: 'PlayfairDisplay_700Bold', marginBottom: 14 },
  body: { fontSize: 14, lineHeight: 21, fontFamily: 'Inter_400Regular' },
  gap: { marginTop: 18 },
});
