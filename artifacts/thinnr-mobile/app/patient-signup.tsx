/**
 * Patient signup — a real account from a provider code and a proven phone.
 *
 * Four short steps: the office's provider code (either generation — the
 * 6-digit onboarding code or the older 5-digit account code), the patient's
 * cell number, the 6-digit text code that proves it, then name + email.
 * The server creates the patient row under that office, so the new patient
 * appears in the office roster on the operations app immediately.
 *
 * If the phone already belongs to a patient, the text code simply signs
 * them in — no duplicate accounts, no fuss. Email is collected for account
 * recovery: it must be unique among patients so an emailed code maps to
 * exactly one account.
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
import {
  completeSignup,
  lookupSignupOffice,
  signInWithTokenHash,
  startSignup,
  verifySignupCode,
} from '@/lib/auth-api';
import { normalizePhone, supabaseConfigured } from '@/lib/supabase';

type Phase = 'office' | 'phone' | 'verify' | 'details';

function FormWrap({ children }: { children: React.ReactNode }) {
  if (Platform.OS !== 'web') return <>{children}</>;
  return (
    <form style={{ display: 'contents' }} onSubmit={event => event.preventDefault()}>
      {children}
    </form>
  );
}

export default function PatientSignupScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { setMode } = useAppMode();

  const [phase, setPhase] = useState<Phase>('office');
  const [officeCode, setOfficeCode] = useState('');
  const [officeName, setOfficeName] = useState('');
  const [phone, setPhone] = useState('');
  const [pendingPhone, setPendingPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [signupToken, setSignupToken] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
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

  const submitOfficeCode = async () => {
    if (busy || !supabaseConfigured) return;
    setError(null);
    setNotice(null);
    const trimmed = officeCode.trim();
    if (!/^[0-9]{5,6}$/.test(trimmed)) {
      setError('Enter the 5 or 6 digit provider code from your office.');
      return;
    }
    setBusy(true);
    try {
      const result = await lookupSignupOffice(trimmed);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOfficeName(result.officeName);
      setPhase('phone');
    } finally {
      setBusy(false);
    }
  };

  const sendPhoneCode = async (normalized: string) => {
    const result = await startSignup({ code: officeCode.trim(), phone: normalized });
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    setRequestId(result.requestId);
    setPendingPhone(normalized);
    setDevCode(result.devCode);
    setNotice(result.message ?? 'A verification code is on its way by text.');
    return true;
  };

  const submitPhone = async () => {
    if (busy) return;
    setError(null);
    setNotice(null);
    const normalized = normalizePhone(phone);
    if (!normalized) {
      setError('Enter your cell phone number — ten digits are treated as US.');
      return;
    }
    setBusy(true);
    try {
      if (await sendPhoneCode(normalized)) {
        setOtp('');
        setPhase('verify');
      }
    } finally {
      setBusy(false);
    }
  };

  const submitOtp = async () => {
    if (busy || !requestId) return;
    setError(null);
    if (otp.trim().length < 6) {
      setError('Enter the 6-digit code from the text message.');
      return;
    }
    setBusy(true);
    try {
      const result = await verifySignupCode({ requestId, code: otp.trim() });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.mode === 'existing') {
        // The phone already has an account — the proven code signs them in.
        const sessionError = await signInWithTokenHash(result.tokenHash);
        if (sessionError) {
          setError(sessionError);
          return;
        }
        await enterPatientExperience();
        return;
      }
      setSignupToken(result.signupToken);
      setNotice(null);
      setPhase('details');
    } finally {
      setBusy(false);
    }
  };

  const resendCode = async () => {
    if (busy || !pendingPhone) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      setOtp('');
      await sendPhoneCode(pendingPhone);
    } finally {
      setBusy(false);
    }
  };

  const submitDetails = async () => {
    if (busy || !signupToken) return;
    setError(null);
    const cleanName = name.trim();
    if (!cleanName) {
      setError('Enter your name.');
      return;
    }
    const cleanEmail = email.trim();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      setError('Enter a valid email address.');
      return;
    }
    setBusy(true);
    try {
      const result = await completeSignup({ signupToken, name: cleanName, email: cleanEmail });
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

  const goBack = () => {
    Haptics.selectionAsync();
    if (phase === 'phone') {
      setPhase('office');
      setError(null);
      setNotice(null);
      return;
    }
    if (phase === 'verify') {
      setPhase('phone');
      setOtp(''); 
      setRequestId(null);
      setDevCode(null);
      setError(null);
      setNotice(null);
      return;
    }
    if (router.canGoBack()) router.back();
    else router.replace('/patient-login');
  };

  const stepLabel =
    phase === 'office' ? 'STEP 1 OF 4' : phase === 'phone' ? 'STEP 2 OF 4' : phase === 'verify' ? 'STEP 3 OF 4' : 'STEP 4 OF 4';

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: topPad }]}>
      <View style={styles.headerRow}>
        <Pressable
          testID="signup-back"
          accessibilityRole="button"
          accessibilityLabel="Back"
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
        <Text style={[styles.kicker, { color: colors.labelText }]}>{stepLabel}</Text>
        <Text style={[styles.title, { color: colors.navy }]}>
          {phase === 'office'
            ? 'Create your account'
            : phase === 'phone'
              ? `Joining ${officeName}`
              : phase === 'verify'
                ? 'Check your texts'
                : 'Almost done'}
        </Text>

        {!supabaseConfigured && (
          <View style={styles.blockGap}>
            <ErrorBox
              testID="signup-not-configured"
              message="Real sign-in isn’t configured in this environment — explore the demo from the sign-in screen instead."
            />
          </View>
        )}

        {phase === 'office' && (
          <LedgerCard style={styles.cardPad}>
            <FormWrap>
              <FieldLabel text="Provider code" />
              <LedgerInput
                testID="signup-code"
                value={officeCode}
                onChangeText={value => setOfficeCode(value.replace(/\D/g, ''))}
                keyboardType="number-pad"
                maxLength={6}
                placeholder="6-digit code"
                editable={!busy && supabaseConfigured}
                style={styles.otpInput}
              />
              <NoteText text="Your med spa gave you this code — it links your account to their office. Older 5-digit codes work too." />

              {error && (
                <View style={styles.blockGap}>
                  <ErrorBox testID="signup-error" message={error} />
                </View>
              )}

              <PrimaryButton
                testID="signup-lookup"
                label={busy ? 'Checking…' : 'Continue'}
                onPress={submitOfficeCode}
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

        {phase === 'phone' && (
          <LedgerCard style={styles.cardPad}>
            <FormWrap>
              <Text testID="signup-office-name" style={[styles.sessionSub, { color: colors.subtleText }]}>
                Your account will be linked to{' '}
                <Text style={{ fontFamily: 'Inter_700Bold', color: colors.navy }}>{officeName}</Text>.
              </Text>
              <View style={styles.fieldGap}>
                <FieldLabel text="Cell phone number" />
                <LedgerInput
                  testID="signup-phone"
                  value={phone}
                  onChangeText={setPhone}
                  keyboardType="phone-pad"
                  autoComplete="tel"
                  textContentType="telephoneNumber"
                  placeholder="+1 555 123 4567"
                  editable={!busy}
                />
                <NoteText text="This is how you’ll sign in. We’ll text a 6-digit code to verify it’s yours — ten digits are treated as US." />
              </View>

              {error && (
                <View style={styles.blockGap}>
                  <ErrorBox testID="signup-error" message={error} />
                </View>
              )}

              <PrimaryButton
                testID="signup-send"
                label={busy ? 'Sending code…' : 'Text me a code'}
                onPress={submitPhone}
                disabled={busy}
                style={styles.blockGap}
              />
            </FormWrap>
          </LedgerCard>
        )}

        {phase === 'verify' && (
          <LedgerCard style={styles.cardPad}>
            <FormWrap>
              <Text style={[styles.sessionSub, { color: colors.subtleText }]}>
                A 6-digit code is on its way to {pendingPhone}. It expires in 10 minutes.
              </Text>
              <View style={styles.fieldGap}>
                <FieldLabel text="Verification code" />
                <LedgerInput
                  testID="signup-otp"
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
                <Text testID="signup-devcode" style={[styles.noticeText, { color: colors.subtleText }]}>
                  Dev delivery mode — your code is {devCode}.
                </Text>
              )}
              {error && (
                <View style={styles.blockGap}>
                  <ErrorBox testID="signup-error" message={error} />
                </View>
              )}
              {notice && !error && (
                <Text testID="signup-notice" style={[styles.noticeText, { color: colors.activeGreen }]}>
                  {notice}
                </Text>
              )}

              <PrimaryButton
                testID="signup-verify"
                label={busy ? 'Verifying…' : 'Verify my number'}
                onPress={submitOtp}
                disabled={busy}
                style={styles.blockGap}
              />
              <View style={styles.linkRow}>
                <Pressable testID="signup-resend" accessibilityRole="button" onPress={resendCode} disabled={busy}>
                  <Text style={[styles.toggleModeText, { color: colors.cobalt }]}>Send a fresh code</Text>
                </Pressable>
              </View>
            </FormWrap>
          </LedgerCard>
        )}

        {phase === 'details' && (
          <LedgerCard style={styles.cardPad}>
            <FormWrap>
              <Text style={[styles.sessionSub, { color: colors.subtleText }]}>
                Your number is verified. Two last details and you’re in.
              </Text>
              <View style={styles.fieldGap}>
                <FieldLabel text="Your name" />
                <LedgerInput
                  testID="signup-name"
                  value={name}
                  onChangeText={setName}
                  autoComplete="name"
                  textContentType="name"
                  placeholder="First and last name"
                  editable={!busy}
                />
              </View>
              <View style={styles.fieldGap}>
                <FieldLabel text="Email" />
                <LedgerInput
                  testID="signup-email"
                  value={email}
                  onChangeText={setEmail}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  autoComplete="email"
                  textContentType="emailAddress"
                  placeholder="you@example.com"
                  editable={!busy}
                />
                <NoteText text="For account recovery — if your phone’s ever unavailable, we can email your sign-in code here instead." />
              </View>

              {error && (
                <View style={styles.blockGap}>
                  <ErrorBox testID="signup-error" message={error} />
                </View>
              )}

              <PrimaryButton
                testID="signup-complete"
                label={busy ? 'Creating account…' : 'Create my account'}
                onPress={submitDetails}
                disabled={busy}
                style={styles.blockGap}
              />
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
