/**
 * Provider login — the staff door inside the patient app.
 *
 * Staff accounts (provider offices and HQ) are keyed on work email, never
 * phone — so a provider's personal cell stays free for their own patient
 * account. Same passwordless shape as the operations web app: email in, a
 * 6-digit code back, and a real session that flips the app into staff mode.
 */
import React, { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';
import {
  ErrorBox,
  FieldLabel,
  LedgerInput,
  NoteText,
  PrimaryButton,
} from '@/components/onboarding/OnboardingFields';
import { useColors } from '@/hooks/useColors';
import { useAppMode } from '@/context/AppModeContext';
import { requestLoginCode, signInWithTokenHash, verifyLoginCode } from '@/lib/auth-api';
import { supabaseConfigured } from '@/lib/supabase';

type Phase = 'email' | 'code';

function FormWrap({ children }: { children: React.ReactNode }) {
  if (Platform.OS !== 'web') return <>{children}</>;
  return (
    <form style={{ display: 'contents' }} onSubmit={event => event.preventDefault()}>
      {children}
    </form>
  );
}

export default function ProviderLoginScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { setMode } = useAppMode();

  const [phase, setPhase] = useState<Phase>('email');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [pendingEmail, setPendingEmail] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const topPad = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;

  const sendCode = async (address: string) => {
    const result = await requestLoginCode('staff', address);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    setRequestId(result.requestId);
    setPendingEmail(address);
    setDevCode(result.devCode);
    setNotice(result.message ?? 'If that address has an account, a sign-in code is on its way.');
    return true;
  };

  const submitEmail = async () => {
    if (busy || !supabaseConfigured) return;
    setError(null);
    setNotice(null);
    const trimmed = email.trim();
    if (!trimmed || !trimmed.includes('@')) {
      setError('Enter your work email address.');
      return;
    }
    setBusy(true);
    try {
      if (await sendCode(trimmed)) {
        setOtp('');
        setPhase('code');
      }
    } finally {
      setBusy(false);
    }
  };

  const submitOtp = async () => {
    if (busy || !requestId) return;
    setError(null);
    if (otp.trim().length < 6) {
      setError('Enter the 6-digit code from the email.');
      return;
    }
    setBusy(true);
    try {
      const result = await verifyLoginCode({ requestId, code: otp.trim() });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const sessionError = await signInWithTokenHash(result.tokenHash);
      if (sessionError) {
        setError(sessionError);
        return;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await setMode('staff');
      router.replace('/');
    } finally {
      setBusy(false);
    }
  };

  const resendCode = async () => {
    if (busy || !pendingEmail) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      setOtp('');
      await sendCode(pendingEmail);
    } finally {
      setBusy(false);
    }
  };

  const backToEmail = () => {
    setPhase('email');
    setOtp('');
    setRequestId(null);
    setDevCode(null);
    setError(null);
    setNotice(null);
  };

  const goBack = () => {
    Haptics.selectionAsync();
    if (router.canGoBack()) router.back();
    else router.replace('/patient-login');
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: topPad }]}>
      <View style={styles.headerRow}>
        <Pressable
          testID="provider-back-login"
          accessibilityRole="button"
          accessibilityLabel="Back to patient sign-in"
          onPress={goBack}
          style={({ pressed }) => [
            styles.backBtn,
            { borderColor: colors.border, backgroundColor: colors.card },
            pressed && { backgroundColor: colors.accent },
          ]}
        >
          <Feather name="chevron-left" size={18} color={colors.navy} />
        </Pressable>
        <View style={[styles.brandMark, { backgroundColor: colors.navy }]}>
          <Text style={[styles.brandMarkText, { color: colors.brandMarkText }]}>TH</Text>
        </View>
        <View style={styles.backBtnSpacer} />
      </View>

      <KeyboardAwareScrollViewCompat
        contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, 16) + 16 }]}
        showsVerticalScrollIndicator={false}
        bottomOffset={96}
      >
        <Text style={[styles.kicker, { color: colors.labelText }]}>PROVIDER ACCESS</Text>
        <Text style={[styles.title, { color: colors.navy }]}>
          {phase === 'code' ? 'Check your inbox' : 'Provider sign-in'}
        </Text>

        {!supabaseConfigured && (
          <View style={styles.blockGap}>
            <ErrorBox
              testID="provider-not-configured"
              message="Real sign-in isn’t configured in this environment."
            />
          </View>
        )}

        {phase === 'email' && (
          <LedgerCard style={styles.cardPad}>
            <FormWrap>
              <FieldLabel text="Work email" />
              <LedgerInput
                testID="provider-email"
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                autoComplete="email"
                textContentType="emailAddress"
                placeholder="you@yourclinic.com"
                editable={!busy && supabaseConfigured}
              />
              <NoteText text="For office staff and HQ. We’ll email a 6-digit sign-in code — no password. Patients sign in with their phone on the previous screen." />

              {error && (
                <View style={styles.blockGap}>
                  <ErrorBox testID="provider-error" message={error} />
                </View>
              )}

              <PrimaryButton
                testID="provider-send"
                label={busy ? 'Sending code…' : 'Email me a code'}
                onPress={submitEmail}
                disabled={busy || !supabaseConfigured}
                onDisabledPress={
                  supabaseConfigured
                    ? undefined
                    : () => setError('Real sign-in isn’t configured in this environment.')
                }
                style={styles.blockGap}
              />
            </FormWrap>
          </LedgerCard>
        )}

        {phase === 'code' && (
          <LedgerCard style={styles.cardPad}>
            <FormWrap>
              <Text style={[styles.sessionSub, { color: colors.subtleText }]}>
                If {pendingEmail} has an account, a 6-digit code is on its way. It expires in 10
                minutes.
              </Text>
              <View style={styles.fieldGap}>
                <FieldLabel text="Verification code" />
                <LedgerInput
                  testID="provider-otp"
                  value={otp}
                  onChangeText={value => setOtp(value.replace(/\D/g, ''))}
                  keyboardType="number-pad"
                  autoComplete="sms-otp"
                  textContentType="oneTimeCode"
                  maxLength={6}
                  editable={!busy}
                  style={styles.otpInput}
                />
              </View>

              {devCode && (
                <Text testID="provider-devcode" style={[styles.noticeText, { color: colors.subtleText }]}>
                  Dev delivery mode — your code is {devCode}.
                </Text>
              )}
              {error && (
                <View style={styles.blockGap}>
                  <ErrorBox testID="provider-error" message={error} />
                </View>
              )}
              {notice && !error && (
                <Text testID="provider-notice" style={[styles.noticeText, { color: colors.activeGreen }]}>
                  {notice}
                </Text>
              )}

              <PrimaryButton
                testID="provider-verify"
                label={busy ? 'Verifying…' : 'Verify and sign in'}
                onPress={submitOtp}
                disabled={busy}
                style={styles.blockGap}
              />
              <View style={styles.linkRow}>
                <Pressable testID="provider-resend" accessibilityRole="button" onPress={resendCode} disabled={busy}>
                  <Text style={[styles.toggleModeText, { color: colors.cobalt }]}>Send a fresh code</Text>
                </Pressable>
                <Pressable testID="provider-back" accessibilityRole="button" onPress={backToEmail}>
                  <Text style={[styles.toggleModeText, { color: colors.subtleText }]}>
                    Use a different email
                  </Text>
                </Pressable>
              </View>
            </FormWrap>
          </LedgerCard>
        )}

        <Text style={[styles.footerText, { color: colors.labelText }]}>
          SYNTHETIC DEMO DATA  •  NOT MEDICAL ADVICE
        </Text>
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    maxWidth: 520,
    width: '100%',
    alignSelf: 'center',
  },
  backBtn: {
    width: 44,
    height: 44,
    borderRadius: 7,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backBtnSpacer: {
    width: 44,
  },
  brandMark: {
    width: 34,
    height: 34,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandMarkText: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.5,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 16,
    maxWidth: 520,
    width: '100%',
    alignSelf: 'center',
  },
  kicker: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.4,
    fontFamily: 'Inter_700Bold',
    marginBottom: 6,
  },
  title: {
    fontSize: 27,
    lineHeight: 34,
    fontFamily: 'PlayfairDisplay_700Bold',
    marginBottom: 16,
  },
  cardPad: {
    padding: 16,
  },
  fieldGap: {
    marginTop: 12,
  },
  blockGap: {
    marginTop: 16,
  },
  toggleModeText: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.2,
  },
  linkRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 24,
    marginTop: 12,
    paddingVertical: 4,
  },
  otpInput: {
    textAlign: 'center',
    fontSize: 20,
    letterSpacing: 8,
    fontFamily: 'Inter_700Bold',
  },
  noticeText: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    marginTop: 12,
    textAlign: 'center',
  },
  sessionSub: {
    fontSize: 12,
    lineHeight: 18,
    fontFamily: 'Inter_400Regular',
    marginTop: 4,
  },
  footerText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.6,
    fontFamily: 'Inter_700Bold',
    textAlign: 'center',
    marginTop: 24,
  },
});
