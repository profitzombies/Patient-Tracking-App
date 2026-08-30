/**
 * Patient sign-in — the real front door, passwordless and patient-first.
 *
 * Patients are keyed on their cell phone: type the number, get a 6-digit
 * text code, and the code becomes a real session that sticks until sign-out.
 * An email fallback covers the day the phone is unreachable, and brand-new
 * patients hop to the signup flow with their office's provider code. Staff
 * use the small "Provider login" door at the bottom — their accounts are
 * keyed on work email, so the same human can hold both kinds of account.
 *
 * The guided demo (Emma) stays one tap away and never touches real auth.
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
  GhostButton,
  LedgerInput,
  NoteText,
  PrimaryButton,
} from '@/components/onboarding/OnboardingFields';
import { useColors } from '@/hooks/useColors';
import { useAppMode } from '@/context/AppModeContext';
import { requestLoginCode, signInWithTokenHash, verifyLoginCode } from '@/lib/auth-api';
import { normalizePhone, supabase, supabaseConfigured, useSupabaseSession } from '@/lib/supabase';

type Channel = 'phone' | 'email';
type Phase = 'identify' | 'code';

const CARD_SHADOW_SOFT = '0 6px 15px rgba(40, 55, 74, 0.06)';

/**
 * On web, RN renders inputs as bare <input> elements; a real <form> wrapper
 * helps browsers wire up autofill and one-time-code suggestions.
 * display:contents keeps the wrapper out of layout; native renders children
 * directly.
 */
function FormWrap({ children }: { children: React.ReactNode }) {
  if (Platform.OS !== 'web') return <>{children}</>;
  return (
    <form style={{ display: 'contents' }} onSubmit={event => event.preventDefault()}>
      {children}
    </form>
  );
}

export default function PatientLoginScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { setMode } = useAppMode();
  const { session } = useSupabaseSession();

  const [channel, setChannel] = useState<Channel>('phone');
  const [phase, setPhase] = useState<Phase>('identify');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [pendingLabel, setPendingLabel] = useState('');
  const [pendingIdentifier, setPendingIdentifier] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const topPad = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;

  const enterPatientExperience = async () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await setMode('patient');
    router.replace('/today');
  };

  const sendCode = async (identifier: string, label: string) => {
    const result = await requestLoginCode('patient', identifier);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    setRequestId(result.requestId);
    setPendingIdentifier(identifier);
    setPendingLabel(label);
    setDevCode(result.devCode);
    setNotice(result.message ?? 'If that matches an account, a code is on its way.');
    return true;
  };

  const submitIdentifier = async () => {
    if (busy || !supabaseConfigured) return;
    setError(null);
    setNotice(null);

    let identifier: string;
    let label: string;
    if (channel === 'phone') {
      const normalized = normalizePhone(phone);
      if (!normalized) {
        setError('Enter your cell phone number — ten digits are treated as US.');
        return;
      }
      identifier = normalized;
      label = normalized;
    } else {
      const trimmed = email.trim();
      if (!trimmed || !trimmed.includes('@')) {
        setError('Enter the email on your account.');
        return;
      }
      identifier = trimmed;
      label = trimmed;
    }

    setBusy(true);
    try {
      if (await sendCode(identifier, label)) {
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
      setError(
        channel === 'phone'
          ? 'Enter the 6-digit code from the text message.'
          : 'Enter the 6-digit code from the email.',
      );
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
      await enterPatientExperience();
    } finally {
      setBusy(false);
    }
  };

  const resendCode = async () => {
    if (busy || !pendingIdentifier) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      setOtp('');
      await sendCode(pendingIdentifier, pendingLabel);
    } finally {
      setBusy(false);
    }
  };

  const backToIdentify = () => {
    setPhase('identify');
    setOtp('');
    setRequestId(null);
    setDevCode(null);
    setError(null);
    setNotice(null);
  };

  const switchChannel = (next: Channel) => {
    Haptics.selectionAsync();
    setChannel(next);
    setError(null);
    setNotice(null);
  };

  const signOutReal = async () => {
    if (!supabase) return;
    Haptics.selectionAsync();
    await supabase.auth.signOut();
  };

  const goBack = () => {
    Haptics.selectionAsync();
    if (router.canGoBack()) router.back();
    else router.replace('/persona');
  };

  const identifierLabel =
    session?.user.phone ? `+${session.user.phone}` : session?.user.email ?? 'your account';

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: topPad }]}>
      <View style={styles.headerRow}>
        <Pressable
          testID="login-back-persona"
          accessibilityRole="button"
          accessibilityLabel="Back to persona picker"
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
        <Text style={[styles.kicker, { color: colors.labelText }]}>PATIENT ACCESS</Text>
        <Text style={[styles.title, { color: colors.navy }]}>
          {phase === 'code'
            ? channel === 'phone'
              ? 'Check your texts'
              : 'Check your inbox'
            : 'Sign in to THINNR'}
        </Text>

        {!supabaseConfigured && (
          <View style={styles.blockGap}>
            <ErrorBox
              testID="login-not-configured"
              message="Real sign-in isn’t configured in this environment — explore the demo below."
            />
          </View>
        )}

        {session && phase === 'identify' ? (
          <LedgerCard style={styles.cardPad}>
            <Text style={[styles.sessionTitle, { color: colors.navy }]}>You’re signed in</Text>
            <Text style={[styles.sessionSub, { color: colors.subtleText }]} numberOfLines={1}>
              {identifierLabel}
            </Text>
            <PrimaryButton
              testID="login-continue"
              label="Continue to your companion"
              onPress={enterPatientExperience}
              style={styles.blockGap}
            />
            <GhostButton
              testID="login-signout"
              label="Sign out"
              onPress={signOutReal}
              style={styles.smallGap}
            />
          </LedgerCard>
        ) : null}

        {!session && phase === 'identify' && (
          <LedgerCard style={styles.cardPad}>
            <FormWrap>
              {channel === 'phone' ? (
                <View>
                  <FieldLabel text="Cell phone number" />
                  <LedgerInput
                    testID="login-phone"
                    value={phone}
                    onChangeText={setPhone}
                    keyboardType="phone-pad"
                    autoComplete="tel"
                    textContentType="telephoneNumber"
                    placeholder="+1 555 123 4567"
                    editable={!busy && supabaseConfigured}
                  />
                  <NoteText text="We’ll text you a 6-digit sign-in code. No password to remember." />
                </View>
              ) : (
                <View>
                  <FieldLabel text="Email on your account" />
                  <LedgerInput
                    testID="login-email"
                    value={email}
                    onChangeText={setEmail}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="email-address"
                    autoComplete="email"
                    textContentType="emailAddress"
                    placeholder="you@example.com"
                    editable={!busy && supabaseConfigured}
                  />
                  <NoteText text="We’ll email you a 6-digit sign-in code — handy when your phone’s unavailable." />
                </View>
              )}

              {error && (
                <View style={styles.blockGap}>
                  <ErrorBox testID="login-error" message={error} />
                </View>
              )}

              <PrimaryButton
                testID="login-submit"
                label={busy ? 'Sending code…' : channel === 'phone' ? 'Text me a code' : 'Email me a code'}
                onPress={submitIdentifier}
                disabled={busy || !supabaseConfigured}
                onDisabledPress={
                  supabaseConfigured
                    ? undefined
                    : () => setError('Real sign-in isn’t configured in this environment.')
                }
                style={styles.blockGap}
              />

              <Pressable
                testID="login-switch-channel"
                accessibilityRole="button"
                onPress={() => switchChannel(channel === 'phone' ? 'email' : 'phone')}
                style={styles.toggleModeBtn}
              >
                <Text style={[styles.toggleModeText, { color: colors.cobalt }]}>
                  {channel === 'phone'
                    ? 'Can’t get texts right now? Use your email'
                    : 'Use your phone number instead'}
                </Text>
              </Pressable>

              <View style={[styles.claimDivider, { backgroundColor: colors.divider }]} />
              <Pressable
                testID="login-signup"
                accessibilityRole="button"
                onPress={() => {
                  Haptics.selectionAsync();
                  router.push('/patient-signup');
                }}
                style={styles.claimLinkBtn}
              >
                <Text style={[styles.toggleModeText, { color: colors.cobalt }]}>
                  New patient? Create your account
                </Text>
              </Pressable>
            </FormWrap>
          </LedgerCard>
        )}

        {phase === 'code' && (
          <LedgerCard style={styles.cardPad}>
            <Text style={[styles.sessionSub, { color: colors.subtleText }]}>
              {channel === 'phone'
                ? `If ${pendingLabel} matches an account, a 6-digit code is on its way by text. It expires in 10 minutes.`
                : `If ${pendingLabel} matches an account, a 6-digit code is on its way by email. It expires in 10 minutes.`}
            </Text>
            <View style={styles.fieldGap}>
              <FieldLabel text="Verification code" />
              <LedgerInput
                testID="login-otp"
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
              <Text testID="login-devcode" style={[styles.noticeText, { color: colors.subtleText }]}>
                Dev delivery mode — your code is {devCode}.
              </Text>
            )}
            {error && (
              <View style={styles.blockGap}>
                <ErrorBox testID="login-error" message={error} />
              </View>
            )}
            {notice && !error && (
              <Text testID="login-notice" style={[styles.noticeText, { color: colors.activeGreen }]}>
                {notice}
              </Text>
            )}

            <PrimaryButton
              testID="login-verify"
              label={busy ? 'Verifying…' : 'Verify and sign in'}
              onPress={submitOtp}
              disabled={busy}
              style={styles.blockGap}
            />
            <View style={styles.linkRow}>
              <Pressable testID="login-resend" accessibilityRole="button" onPress={resendCode} disabled={busy}>
                <Text style={[styles.toggleModeText, { color: colors.cobalt }]}>Send a fresh code</Text>
              </Pressable>
              <Pressable testID="login-back" accessibilityRole="button" onPress={backToIdentify}>
                <Text style={[styles.toggleModeText, { color: colors.subtleText }]}>Back</Text>
              </Pressable>
            </View>
          </LedgerCard>
        )}

        <View style={styles.dividerRow}>
          <View style={[styles.dividerLine, { backgroundColor: colors.divider }]} />
          <Text style={[styles.dividerText, { color: colors.labelText }]}>EXPLORING THE DEMO?</Text>
          <View style={[styles.dividerLine, { backgroundColor: colors.divider }]} />
        </View>

        <Pressable
          testID="login-demo"
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            router.push('/patient-entry');
          }}
          style={({ pressed }) => [
            styles.demoCard,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
              borderRadius: colors.radius,
              boxShadow: CARD_SHADOW_SOFT,
            },
            pressed && { opacity: 0.88 },
          ]}
        >
          <View style={[styles.demoIcon, { backgroundColor: colors.accent }]}>
            <Feather name="compass" size={16} color={colors.cobalt} />
          </View>
          <View style={styles.demoBody}>
            <Text style={[styles.demoTitle, { color: colors.navy }]}>Browse without an account</Text>
            <Text style={[styles.demoText, { color: colors.subtleText }]}>
              One-tap sign-in as Emma Smith, or simulate the new-patient onboarding. Nothing is saved.
            </Text>
          </View>
          <Feather name="arrow-right" size={16} color={colors.cobalt} />
        </Pressable>

        <Pressable
          testID="login-provider"
          accessibilityRole="button"
          onPress={() => {
            Haptics.selectionAsync();
            router.push('/provider-login');
          }}
          style={styles.providerLinkBtn}
        >
          <Text style={[styles.providerLinkText, { color: colors.subtleText }]}>Provider login</Text>
        </Pressable>

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
  smallGap: {
    marginTop: 8,
  },
  toggleModeBtn: {
    marginTop: 12,
    alignItems: 'center',
    paddingVertical: 4,
  },
  claimDivider: {
    height: 1,
    marginTop: 14,
    marginBottom: 6,
  },
  claimLinkBtn: {
    marginTop: 8,
    alignItems: 'center',
    paddingVertical: 4,
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
  sessionTitle: {
    fontSize: 18,
    fontFamily: 'PlayfairDisplay_700Bold',
  },
  sessionSub: {
    fontSize: 12,
    lineHeight: 18,
    fontFamily: 'Inter_400Regular',
    marginTop: 4,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginVertical: 20,
  },
  dividerLine: {
    flex: 1,
    height: 1,
  },
  dividerText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.4,
    fontFamily: 'Inter_700Bold',
  },
  demoCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    padding: 16,
    gap: 12,
  },
  demoIcon: {
    width: 34,
    height: 34,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  demoBody: {
    flex: 1,
  },
  demoTitle: {
    fontSize: 15,
    fontFamily: 'PlayfairDisplay_600SemiBold',
  },
  demoText: {
    fontSize: 11,
    lineHeight: 16,
    fontFamily: 'Inter_400Regular',
    marginTop: 3,
  },
  providerLinkBtn: {
    alignSelf: 'center',
    marginTop: 20,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  providerLinkText: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.3,
    textDecorationLine: 'underline',
  },
  footerText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.6,
    fontFamily: 'Inter_700Bold',
    textAlign: 'center',
    marginTop: 16,
  },
});
