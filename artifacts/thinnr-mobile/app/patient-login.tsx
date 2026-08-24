/**
 * Patient sign-in — the real front door. Email + password works today; phone
 * + password (with a texted 6-digit code at sign-up) lights up once Twilio
 * Verify is connected in the Supabase dashboard. The guided demo (Emma) stays
 * one tap away and never touches real auth.
 *
 * Any real session gets the patient companion experience — this app *is* the
 * patient surface; staff tooling lives on the web.
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
import {
  describeAuthError,
  normalizePhone,
  supabase,
  supabaseConfigured,
  useSupabaseSession,
} from '@/lib/supabase';

type AuthMethod = 'email' | 'phone';
type AuthMode = 'sign-in' | 'sign-up';
type Phase = 'credentials' | 'verify-phone' | 'check-email';

const CARD_SHADOW_SOFT = '0 6px 15px rgba(40, 55, 74, 0.06)';

/**
 * On web, RN renders inputs as bare <input> elements and browsers expect
 * password fields inside a <form> (quiets the "[DOM] Password field is not
 * contained in a form" warning and helps autofill). display:contents keeps
 * the wrapper out of layout; native renders children directly.
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

  const [method, setMethod] = useState<AuthMethod>('email');
  const [mode, setAuthMode] = useState<AuthMode>('sign-in');
  const [phase, setPhase] = useState<Phase>('credentials');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [pendingPhone, setPendingPhone] = useState('');
  const [pendingEmail, setPendingEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const topPad = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;

  const enterPatientExperience = async () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await setMode('patient');
    router.replace('/today');
  };

  const submitCredentials = async () => {
    if (busy || !supabase) return;
    setError(null);
    setNotice(null);

    let identifier: { email: string } | { phone: string };
    if (method === 'email') {
      const trimmed = email.trim();
      if (!trimmed) {
        setError('Enter your email.');
        return;
      }
      identifier = { email: trimmed };
    } else {
      const normalized = normalizePhone(phone);
      if (!normalized) {
        setError('Enter your mobile number, including the country code.');
        return;
      }
      identifier = { phone: normalized };
    }
    if (!password) {
      setError('Enter your password.');
      return;
    }
    if (mode === 'sign-up' && password.length < 6) {
      setError('Passwords need at least 6 characters.');
      return;
    }

    setBusy(true);
    try {
      if (mode === 'sign-in') {
        const { data, error: signInError } = await supabase.auth.signInWithPassword({
          ...identifier,
          password,
        });
        if (signInError) {
          setError(describeAuthError(signInError));
          return;
        }
        if (data.session) await enterPatientExperience();
        return;
      }

      // Sign-up
      const name = displayName.trim();
      const { data, error: signUpError } =
        'email' in identifier
          ? await supabase.auth.signUp({
              email: identifier.email,
              password,
              options: { data: { display_name: name } },
            })
          : await supabase.auth.signUp({
              phone: identifier.phone,
              password,
              options: { data: { display_name: name } },
            });
      if (signUpError) {
        setError(describeAuthError(signUpError));
        return;
      }
      // Supabase signals "already registered" with a user that has no identities.
      if (data.user && (data.user.identities?.length ?? 0) === 0) {
        setError('An account already exists with those details. Sign in instead.');
        return;
      }
      if (data.session) {
        await enterPatientExperience();
        return;
      }
      if ('phone' in identifier) {
        setPendingPhone(identifier.phone);
        setOtp('');
        setPhase('verify-phone');
      } else {
        setPendingEmail(identifier.email);
        setPhase('check-email');
      }
    } finally {
      setBusy(false);
    }
  };

  const submitOtp = async () => {
    if (busy || !supabase) return;
    setError(null);
    setNotice(null);
    if (otp.trim().length < 6) {
      setError('Enter the 6-digit code from the text message.');
      return;
    }
    setBusy(true);
    try {
      const { data, error: verifyError } = await supabase.auth.verifyOtp({
        phone: pendingPhone,
        token: otp.trim(),
        type: 'sms',
      });
      if (verifyError) {
        setError(describeAuthError(verifyError));
        return;
      }
      if (data.session) await enterPatientExperience();
    } finally {
      setBusy(false);
    }
  };

  const resendCode = async () => {
    if (busy || !supabase) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const { error: resendError } = await supabase.auth.resend({
        type: 'sms',
        phone: pendingPhone,
      });
      if (resendError) setError(describeAuthError(resendError));
      else setNotice('We sent a fresh code.');
    } finally {
      setBusy(false);
    }
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

  const methodTab = (value: AuthMethod, label: string, testID: string) => {
    const active = method === value;
    return (
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        onPress={() => {
          Haptics.selectionAsync();
          setMethod(value);
          setError(null);
          setNotice(null);
        }}
        style={[
          styles.methodTab,
          { borderRadius: 5 },
          active && { backgroundColor: colors.navy },
        ]}
      >
        <Text
          style={[
            styles.methodTabText,
            { color: active ? colors.brandMarkText : colors.labelText },
          ]}
        >
          {label}
        </Text>
      </Pressable>
    );
  };

  const identifierLabel = session?.user.email ?? (session?.user.phone ? `+${session.user.phone}` : 'your account');

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
          {phase === 'verify-phone'
            ? 'Check your texts'
            : phase === 'check-email'
              ? 'Check your inbox'
              : mode === 'sign-in'
                ? 'Sign in to THINNR'
                : 'Create your account'}
        </Text>

        {!supabaseConfigured && (
          <View style={styles.blockGap}>
            <ErrorBox
              testID="login-not-configured"
              message="Real sign-in isn’t configured in this environment — explore the demo below."
            />
          </View>
        )}

        {session && phase === 'credentials' ? (
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

        {!session && phase === 'credentials' && (
          <LedgerCard style={styles.cardPad}>
            <FormWrap>
              <View style={[styles.methodRow, { borderColor: colors.border, backgroundColor: colors.background }]}>
                {methodTab('email', 'Email', 'login-method-email')}
                {methodTab('phone', 'Phone', 'login-method-phone')}
              </View>

              {mode === 'sign-up' && (
                <View style={styles.fieldGap}>
                  <FieldLabel text="Name (optional)" />
                  <LedgerInput
                    testID="login-name"
                    value={displayName}
                    onChangeText={setDisplayName}
                    autoComplete="name"
                    textContentType="name"
                    editable={!busy && supabaseConfigured}
                  />
                </View>
              )}

              {method === 'email' ? (
                <View style={styles.fieldGap}>
                  <FieldLabel text="Email" />
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
                </View>
              ) : (
                <View style={styles.fieldGap}>
                  <FieldLabel text="Mobile number" />
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
                  <NoteText
                    text={
                      mode === 'sign-up'
                        ? 'Include the country code — ten digits are treated as US. We’ll text you a 6-digit code.'
                        : 'Include the country code — ten digits are treated as US.'
                    }
                  />
                </View>
              )}

              <View style={styles.fieldGap}>
                <FieldLabel text="Password" />
                <LedgerInput
                  testID="login-password"
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                  autoCapitalize="none"
                  autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
                  textContentType={mode === 'sign-in' ? 'password' : 'newPassword'}
                  editable={!busy && supabaseConfigured}
                />
                {mode === 'sign-up' && <NoteText text="At least 6 characters." />}
              </View>

              {error && (
                <View style={styles.blockGap}>
                  <ErrorBox testID="login-error" message={error} />
                </View>
              )}

              <PrimaryButton
                testID="login-submit"
                label={
                  busy
                    ? mode === 'sign-in'
                      ? 'Signing in…'
                      : 'Creating account…'
                    : mode === 'sign-in'
                      ? 'Sign in'
                      : 'Create account'
                }
                onPress={submitCredentials}
                disabled={busy || !supabaseConfigured}
                onDisabledPress={
                  supabaseConfigured
                    ? undefined
                    : () => setError('Real sign-in isn’t configured in this environment.')
                }
                style={styles.blockGap}
              />

              <Pressable
                testID="login-toggle-mode"
                accessibilityRole="button"
                onPress={() => {
                  Haptics.selectionAsync();
                  setAuthMode(current => (current === 'sign-in' ? 'sign-up' : 'sign-in'));
                  setError(null);
                  setNotice(null);
                }}
                style={styles.toggleModeBtn}
              >
                <Text style={[styles.toggleModeText, { color: colors.cobalt }]}>
                  {mode === 'sign-in' ? 'New here? Create an account' : 'Already have an account? Sign in'}
                </Text>
              </Pressable>
            </FormWrap>
          </LedgerCard>
        )}

        {phase === 'verify-phone' && (
          <LedgerCard style={styles.cardPad}>
            <Text style={[styles.sessionSub, { color: colors.subtleText }]}>
              A 6-digit code is on its way to {pendingPhone}.
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

            {error && (
              <View style={styles.blockGap}>
                <ErrorBox testID="login-error" message={error} />
              </View>
            )}
            {notice && (
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
                <Text style={[styles.toggleModeText, { color: colors.cobalt }]}>Resend code</Text>
              </Pressable>
              <Pressable
                testID="login-back"
                accessibilityRole="button"
                onPress={() => {
                  setPhase('credentials');
                  setOtp('');
                  setError(null);
                  setNotice(null);
                }}
              >
                <Text style={[styles.toggleModeText, { color: colors.subtleText }]}>Back</Text>
              </Pressable>
            </View>
          </LedgerCard>
        )}

        {phase === 'check-email' && (
          <LedgerCard style={styles.cardPad}>
            <View style={[styles.mailIcon, { backgroundColor: colors.accent }]}>
              <Feather name="mail" size={18} color={colors.cobalt} />
            </View>
            <Text style={[styles.sessionTitle, { color: colors.navy }]}>Confirm your email</Text>
            <Text style={[styles.sessionSub, { color: colors.subtleText }]}>
              We sent a confirmation link to {pendingEmail}. Open it, then come back and sign in.
              The demo mailer can take a few minutes.
            </Text>
            <GhostButton
              testID="login-back"
              label="Back to sign in"
              onPress={() => {
                setPhase('credentials');
                setAuthMode('sign-in');
                setError(null);
                setNotice(null);
              }}
              style={styles.blockGap}
            />
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
  methodRow: {
    flexDirection: 'row',
    borderWidth: 1,
    borderRadius: 7,
    padding: 3,
    gap: 3,
    marginBottom: 14,
  },
  methodTab: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
  },
  methodTabText: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.4,
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
  mailIcon: {
    width: 36,
    height: 36,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
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
  footerText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.6,
    fontFamily: 'Inter_700Bold',
    textAlign: 'center',
    marginTop: 24,
  },
});
