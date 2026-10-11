/**
 * Claim your account — the bridge from the migrated THINNR rolls to a real
 * login. Patients, providers, and staff enter the email or mobile number the
 * clinic has on file; a one-time code proves it's really them; shared-phone
 * families disambiguate with a date of birth; then they set a password and
 * are signed straight in. Running it again for an already-claimed account
 * simply resets the password, so this screen doubles as "forgot password".
 *
 * The screen never says whether an identifier exists — every identify answer
 * looks identical. Until SMS/email delivery goes live the server runs in dev
 * mode and returns the code in the response; the screen shows it inline.
 */
import React, { useMemo, useState } from 'react';
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
import { apiBase } from '@/lib/coach-api';
import { describeAuthError, normalizePhone, supabase, supabaseConfigured } from '@/lib/supabase';
import { PASSWORD_RULES } from '@/lib/password-rules';

type Phase =
  | 'identify'
  | 'code'
  | 'birthday'
  | 'password'
  | 'add-phone'
  | 'add-phone-code'
  | 'done';

type AccountKind = 'hq_admin' | 'provider' | 'team_member' | 'patient' | null;

interface ClaimResponse {
  status: number;
  json: Record<string, unknown> | null;
}

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTransientAuthError(error: { message?: string } | null): boolean {
  const message = (error?.message ?? '').toLowerCase();
  return (
    message.includes('network') ||
    message.includes('fetch') ||
    message.includes('connection') ||
    message.includes('timeout')
  );
}

async function claimApi(
  path: string,
  body?: unknown,
  token?: string,
  retryNetworkOnce = false,
): Promise<ClaimResponse> {
  const requestBody = body === undefined ? undefined : JSON.stringify(body);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${apiBase()}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: requestBody,
      });
      let json: Record<string, unknown> | null = null;
      try {
        json = (await response.json()) as Record<string, unknown>;
      } catch {
        json = null;
      }
      return { status: response.status, json };
    } catch (error) {
      if (!retryNetworkOnce || attempt > 0) throw error;
      await pause(350);
    }
  }
}

function errorFrom(result: ClaimResponse, fallback: string): string {
  const message = typeof result.json?.error === 'string' ? (result.json.error as string) : '';
  if (message) return message;
  if (result.status === 429) return 'Too many attempts — give it a minute, then try again.';
  if (result.status >= 500) return 'Something went wrong on our side. Try again in a moment.';
  return fallback;
}

/** MM/DD/YYYY as-you-type mask. */
function formatBirthdayInput(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

function birthdayToIso(value: string): string | null {
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [, mm, dd, yyyy] = match;
  const iso = `${yyyy}-${mm}-${dd}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getUTCMonth() + 1 !== Number(mm) || date.getUTCDate() !== Number(dd)) return null;
  return iso;
}

/** US phone mask for display; normalizePhone adds +1 only at the API boundary. */
function formatUsPhoneInput(value: string): string {
  let digits = value.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  digits = digits.slice(0, 10);
  if (!digits) return '';
  if (digits.length <= 3) return `(${digits}`;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function formatClaimIdentifierInput(value: string): string {
  if (/[A-Za-z@]/.test(value)) return value;
  const digits = value.replace(/\D/g, '');
  if (value.trim().startsWith('+') && digits.length > 0 && !digits.startsWith('1')) return value;
  return formatUsPhoneInput(value);
}

function displayClaimIdentifier(value: string): string {
  return value.includes('@') ? value : formatClaimIdentifierInput(value);
}

function FormWrap({ children }: { children: React.ReactNode }) {
  if (Platform.OS !== 'web') return <>{children}</>;
  return (
    <form style={{ display: 'contents' }} onSubmit={event => event.preventDefault()}>
      {children}
    </form>
  );
}

export default function ClaimAccountScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { setMode } = useAppMode();

  const [phase, setPhase] = useState<Phase>('identify');
  const [identifier, setIdentifier] = useState('');
  const [sentIdentifier, setSentIdentifier] = useState('');
  const [requestId, setRequestId] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [claimToken, setClaimToken] = useState('');
  const [accountType, setAccountType] = useState<AccountKind>(null);
  const [masked, setMasked] = useState<string | null>(null);
  const [claimMode, setClaimMode] = useState<'create' | 'reset' | null>(null);
  const [birthday, setBirthday] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [signedInKind, setSignedInKind] = useState<AccountKind | 'unlinked' | null>(null);
  const [signedInName, setSignedInName] = useState<string | null>(null);
  const [offerPhone, setOfferPhone] = useState(false);
  const [newPhone, setNewPhone] = useState('');
  const [phoneRequestId, setPhoneRequestId] = useState('');
  const [phoneDevCode, setPhoneDevCode] = useState<string | null>(null);
  const [phoneCode, setPhoneCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dead, setDead] = useState(false); // clinic dead-end — only a restart helps

  const topPad = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;

  const passwordChecks = useMemo(
    () => PASSWORD_RULES.map(rule => ({ ...rule, met: rule.test(password) })),
    [password],
  );
  const passwordReady = passwordChecks.every(rule => rule.met) && password.length <= 72;
  const confirmMatches = passwordConfirm.length > 0 && passwordConfirm === password;

  const resetFlow = () => {
    setPhase('identify');
    setRequestId('');
    setDevCode(null);
    setCode('');
    setClaimToken('');
    setAccountType(null);
    setMasked(null);
    setClaimMode(null);
    setBirthday('');
    setPassword('');
    setPasswordConfirm('');
    setError(null);
    setNotice(null);
    setDead(false);
  };

  const startIdentify = async (silentResend = false) => {
    if (busy) return;
    setError(null);
    setNotice(null);
    const raw = (silentResend ? sentIdentifier : identifier).trim();
    let payload = raw;
    if (!raw) {
      setError('Enter the email or mobile number your clinic has on file.');
      return;
    }
    if (!raw.includes('@')) {
      const normalized = normalizePhone(raw);
      if (!normalized) {
        setError('That doesn’t look like an email or a mobile number. Check it and try again.');
        return;
      }
      payload = normalized;
    }
    setBusy(true);
    try {
      const result = await claimApi('/claim/identify', { identifier: payload }, undefined, true);
      if (result.status !== 200 || typeof result.json?.requestId !== 'string') {
        setError(errorFrom(result, 'We couldn’t start verification. Try again.'));
        return;
      }
      setSentIdentifier(payload);
      setRequestId(result.json.requestId as string);
      setDevCode(typeof result.json.devCode === 'string' ? (result.json.devCode as string) : null);
      setCode('');
      if (silentResend) {
        setNotice('We sent a fresh code.');
      } else {
        Haptics.selectionAsync();
        setPhase('code');
      }
    } catch {
      setError('Couldn’t reach THINNR. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async () => {
    if (busy) return;
    setError(null);
    setNotice(null);
    if (code.trim().length !== 6) {
      setError('Enter the 6-digit code.');
      return;
    }
    setBusy(true);
    try {
      const result = await claimApi('/claim/verify', { requestId, code: code.trim() });
      if (result.status === 409) {
        setDead(true);
        setError(errorFrom(result, 'We couldn’t verify your account automatically.'));
        return;
      }
      if (result.status !== 200 || typeof result.json?.claimToken !== 'string') {
        setError(errorFrom(result, 'That code didn’t match. Check it and try again.'));
        return;
      }
      setClaimToken(result.json.claimToken as string);
      setAccountType((result.json.accountType as AccountKind) ?? null);
      setMasked(typeof result.json.masked === 'string' ? (result.json.masked as string) : null);
      if (result.json.next === 'birthday') {
        Haptics.selectionAsync();
        setPhase('birthday');
      } else {
        setClaimMode(result.json.mode === 'reset' ? 'reset' : 'create');
        Haptics.selectionAsync();
        setPhase('password');
      }
    } catch {
      setError('Couldn’t reach THINNR. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const submitBirthday = async () => {
    if (busy) return;
    setError(null);
    const iso = birthdayToIso(birthday);
    if (!iso) {
      setError('Enter your date of birth as MM/DD/YYYY.');
      return;
    }
    setBusy(true);
    try {
      const result = await claimApi('/claim/birthday', { claimToken, birthday: iso });
      if (result.status === 409) {
        setDead(true);
        setError(errorFrom(result, 'We couldn’t verify your account automatically.'));
        return;
      }
      if (result.status !== 200) {
        setError(errorFrom(result, 'That didn’t work. Start over and try again.'));
        return;
      }
      setClaimMode(result.json?.mode === 'reset' ? 'reset' : 'create');
      Haptics.selectionAsync();
      setPhase('password');
    } catch {
      setError('Couldn’t reach THINNR. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = async () => {
    if (busy || !supabase) return;
    setError(null);
    if (!passwordReady) {
      setError('Your password needs everything on the checklist.');
      return;
    }
    if (!confirmMatches) {
      setError('Both password boxes need to match.');
      return;
    }
    setBusy(true);
    try {
      let result: ClaimResponse;
      try {
        result = await claimApi('/claim/complete', { claimToken, password, passwordConfirm });
      } catch {
        // The API may have committed even if Expo lost the response. Try the
        // credential we just established before inviting a duplicate submit.
        await pause(400);
        const recoveryCredentials = sentIdentifier.includes('@')
          ? { email: sentIdentifier, password }
          : { phone: sentIdentifier, password };
        let recovered = await supabase.auth.signInWithPassword(recoveryCredentials);
        if (recovered.error && isTransientAuthError(recovered.error)) {
          await pause(350);
          recovered = await supabase.auth.signInWithPassword(recoveryCredentials);
        }
        if (recovered.data.session) {
          let who: ClaimResponse | null = null;
          try {
            who = await claimApi(
              '/claim/whoami',
              undefined,
              recovered.data.session.access_token,
              true,
            );
          } catch {
            // Non-fatal: the account and session are already established.
          }
          const rawKind = who?.json?.kind;
          const recoveredKind =
            rawKind === 'demo_staff' || rawKind === 'demo_patient'
              ? 'unlinked'
              : typeof rawKind === 'string' && rawKind !== 'none'
                ? (rawKind as AccountKind)
                : 'patient';
          setSignedInKind(recoveredKind);
          setSignedInName(
            typeof who?.json?.name === 'string' ? (who.json.name as string) : null,
          );
          setOfferPhone(
            recoveredKind === 'patient' &&
              !(typeof who?.json?.hasPhone === 'boolean'
                ? who.json.hasPhone
                : !sentIdentifier.includes('@')),
          );
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          setPhase('done');
          return;
        }
        throw new Error(recovered.error?.message ?? 'claim completion response lost');
      }
      if (result.status !== 200) {
        setError(errorFrom(result, 'We couldn’t finish setting up. Try again.'));
        return;
      }
      const signIn = result.json?.signIn as { method?: string; identifier?: string } | undefined;
      if (!signIn?.method || !signIn.identifier) {
        setError('Your password is set — sign in from the login screen.');
        return;
      }
      const credentials =
        signIn.method === 'phone'
          ? { phone: signIn.identifier, password }
          : { email: signIn.identifier, password };
      let { data, error: signInError } = await supabase.auth.signInWithPassword(credentials);
      if (signInError && isTransientAuthError(signInError)) {
        await pause(350);
        ({ data, error: signInError } = await supabase.auth.signInWithPassword(credentials));
      }
      if (signInError || !data.session) {
        setError(
          signInError
            ? describeAuthError(signInError)
            : 'Your password is set — sign in from the login screen.',
        );
        return;
      }
      // Who did we just become? Route patients into the companion; point
      // staff at the web tools; offer phone-less patients a phone add.
      // A login with only a legacy profile row (no patient or staff record)
      // is 'unlinked': neither routed into the companion nor offered a phone.
      let kind: AccountKind | 'unlinked' = 'patient';
      let name: string | null = null;
      let hasPhone = signIn.method === 'phone';
      try {
        const who = await claimApi('/claim/whoami', undefined, data.session.access_token);
        if (who.status === 200 && who.json) {
          const rawKind = who.json.kind;
          if (rawKind === 'demo_staff' || rawKind === 'demo_patient') kind = 'unlinked';
          else if (typeof rawKind === 'string' && rawKind !== 'none') kind = rawKind as AccountKind;
          if (typeof who.json.name === 'string') name = who.json.name as string;
          if (typeof who.json.hasPhone === 'boolean') hasPhone = who.json.hasPhone as boolean;
        }
      } catch {
        // Non-fatal: the session is live; default routing below still works.
      }
      setSignedInKind(kind);
      setSignedInName(name);
      setOfferPhone(kind === 'patient' && !hasPhone);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setPhase('done');
    } catch {
      setError('Couldn’t reach THINNR. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const startAddPhone = async () => {
    if (busy || !supabase) return;
    setError(null);
    setNotice(null);
    const normalized = normalizePhone(newPhone);
    if (!normalized) {
      setError('Enter your mobile number, including the country code.');
      return;
    }
    setBusy(true);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) {
        setError('Your session ended — sign in from the login screen and try again.');
        return;
      }
      const result = await claimApi('/claim/add-phone', { phone: normalized }, token);
      if (result.status !== 200 || typeof result.json?.requestId !== 'string') {
        setError(errorFrom(result, 'We couldn’t start phone verification. Try again.'));
        return;
      }
      setPhoneRequestId(result.json.requestId as string);
      setPhoneDevCode(
        typeof result.json.devCode === 'string' ? (result.json.devCode as string) : null,
      );
      setPhoneCode('');
      Haptics.selectionAsync();
      setPhase('add-phone-code');
    } catch {
      setError('Couldn’t reach THINNR. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const submitPhoneCode = async () => {
    if (busy || !supabase) return;
    setError(null);
    if (phoneCode.trim().length !== 6) {
      setError('Enter the 6-digit code.');
      return;
    }
    setBusy(true);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) {
        setError('Your session ended — sign in from the login screen and try again.');
        return;
      }
      const result = await claimApi(
        '/claim/add-phone/verify',
        { requestId: phoneRequestId, code: phoneCode.trim() },
        token,
      );
      if (result.status !== 200) {
        setError(errorFrom(result, 'That code didn’t match. Check it and try again.'));
        return;
      }
      setOfferPhone(false);
      setNotice('Phone added — you can sign in with it from now on.');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setPhase('done');
    } catch {
      setError('Couldn’t reach THINNR. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const enterPatientExperience = async () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await setMode('patient');
    router.replace('/today');
  };

  const goBack = () => {
    Haptics.selectionAsync();
    if (router.canGoBack()) router.back();
    else router.replace('/patient-login');
  };

  const title =
    phase === 'identify'
      ? 'Claim your account'
      : phase === 'code'
        ? 'Enter your code'
        : phase === 'birthday'
          ? 'One more check'
          : phase === 'password'
            ? claimMode === 'reset'
              ? 'Set a new password'
              : 'Create your password'
            : phase === 'add-phone' || phase === 'add-phone-code'
              ? 'Add your mobile number'
              : 'You’re all set';

  const staffAccount =
    signedInKind === 'provider' || signedInKind === 'team_member' || signedInKind === 'hq_admin';

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: topPad }]}>
      <View style={styles.headerRow}>
        <Pressable
          testID="claim-back"
          accessibilityRole="button"
          accessibilityLabel="Back to sign in"
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
        contentContainerStyle={[
          styles.content,
          { paddingBottom: Math.max(insets.bottom, 16) + 16 },
        ]}
        showsVerticalScrollIndicator={false}
        bottomOffset={96}
      >
        <Text style={[styles.kicker, { color: colors.labelText }]}>THINNR MEMBERS</Text>
        <Text style={[styles.title, { color: colors.navy }]}>{title}</Text>

        {!supabaseConfigured && (
          <View style={styles.blockGap}>
            <ErrorBox
              testID="claim-not-configured"
              message="Real sign-in isn’t configured in this environment."
            />
          </View>
        )}

        {phase === 'identify' && (
          <LedgerCard style={styles.cardPad}>
            <FormWrap>
              <Text style={[styles.introText, { color: colors.subtleText }]}>
                Already on the THINNR program? Enter the email or mobile number your clinic has
                on file and we’ll text or email you a verification code. This is also how you
                reset a forgotten password.
              </Text>
              <View style={styles.fieldGap}>
                <FieldLabel text="Email or mobile number" />
                <LedgerInput
                  testID="claim-identifier"
                  value={identifier}
                  onChangeText={value => setIdentifier(formatClaimIdentifierInput(value))}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  autoComplete="username"
                  textContentType="username"
                  placeholder="you@example.com or (555) 123-4567"
                  editable={!busy && supabaseConfigured}
                />
              </View>
              {error && (
                <View style={styles.blockGap}>
                  <ErrorBox testID="claim-error" message={error} />
                </View>
              )}
              <PrimaryButton
                testID="claim-identify-submit"
                label={busy ? 'Sending…' : 'Send my code'}
                onPress={() => startIdentify(false)}
                disabled={busy || !supabaseConfigured}
                style={styles.blockGap}
              />
              <View style={styles.blockGap}>
                <NoteText text="For your privacy we never confirm whether an email or number is on file." />
              </View>
            </FormWrap>
          </LedgerCard>
        )}

        {phase === 'code' && (
          <LedgerCard style={styles.cardPad}>
            <Text style={[styles.introText, { color: colors.subtleText }]}>
              If those details match an account, a 6-digit code is on its way to{' '}
              {sentIdentifier}. Codes can take a minute to arrive and expire after ten.
            </Text>
            {devCode && (
              <View
                testID="claim-dev-code"
                style={[styles.devCodeBox, { backgroundColor: colors.accent, borderColor: colors.border }]}
              >
                <Feather name="tool" size={13} color={colors.cobalt} />
                <Text style={[styles.devCodeText, { color: colors.navy }]}>
                  Test mode — delivery isn’t switched on yet, so your code is {devCode}.
                </Text>
              </View>
            )}
            <View style={styles.fieldGap}>
              <FieldLabel text="Verification code" />
              <LedgerInput
                testID="claim-code"
                value={code}
                onChangeText={value => setCode(value.replace(/\D/g, ''))}
                keyboardType="number-pad"
                autoComplete="sms-otp"
                textContentType="oneTimeCode"
                maxLength={6}
                editable={!busy && !dead}
                style={styles.otpInput}
              />
            </View>
            {error && (
              <View style={styles.blockGap}>
                <ErrorBox testID="claim-error" message={error} />
              </View>
            )}
            {notice && (
              <Text testID="claim-notice" style={[styles.noticeText, { color: colors.activeGreen }]}>
                {notice}
              </Text>
            )}
            {dead ? (
              <GhostButton
                testID="claim-start-over"
                label="Start over"
                onPress={resetFlow}
                style={styles.blockGap}
              />
            ) : (
              <>
                <PrimaryButton
                  testID="claim-code-submit"
                  label={busy ? 'Checking…' : 'Verify code'}
                  onPress={submitCode}
                  disabled={busy}
                  style={styles.blockGap}
                />
                <View style={styles.linkRow}>
                  <Pressable
                    testID="claim-resend"
                    accessibilityRole="button"
                    onPress={() => startIdentify(true)}
                    disabled={busy}
                  >
                    <Text style={[styles.linkText, { color: colors.cobalt }]}>Resend code</Text>
                  </Pressable>
                  <Pressable testID="claim-code-back" accessibilityRole="button" onPress={resetFlow}>
                    <Text style={[styles.linkText, { color: colors.subtleText }]}>
                      Different email or number
                    </Text>
                  </Pressable>
                </View>
              </>
            )}
          </LedgerCard>
        )}

        {phase === 'birthday' && (
          <LedgerCard style={styles.cardPad}>
            <Text style={[styles.introText, { color: colors.subtleText }]}>
              That number is shared by more than one THINNR account, so we need your date of
              birth to find yours. You get one try — if it doesn’t match, your clinic can set
              you up instead.
            </Text>
            <View style={styles.fieldGap}>
              <FieldLabel text="Date of birth (MM/DD/YYYY)" />
              <LedgerInput
                testID="claim-birthday"
                value={birthday}
                onChangeText={value => setBirthday(formatBirthdayInput(value))}
                keyboardType="number-pad"
                placeholder="04/23/1975"
                maxLength={10}
                editable={!busy && !dead}
              />
            </View>
            {error && (
              <View style={styles.blockGap}>
                <ErrorBox testID="claim-error" message={error} />
              </View>
            )}
            {dead ? (
              <GhostButton
                testID="claim-start-over"
                label="Back to sign in"
                onPress={goBack}
                style={styles.blockGap}
              />
            ) : (
              <PrimaryButton
                testID="claim-birthday-submit"
                label={busy ? 'Checking…' : 'Continue'}
                onPress={submitBirthday}
                disabled={busy}
                style={styles.blockGap}
              />
            )}
          </LedgerCard>
        )}

        {phase === 'password' && (
          <LedgerCard style={styles.cardPad}>
            <FormWrap>
              <Text style={[styles.introText, { color: colors.subtleText }]}>
                {claimMode === 'reset'
                  ? `Pick a new password for ${masked ?? 'your account'}.`
                  : `Almost done — pick a password for ${masked ?? 'your account'}.`}
              </Text>
              <View style={styles.fieldGap}>
                <FieldLabel text={claimMode === 'reset' ? 'New password' : 'Password'} />
                <LedgerInput
                  testID="claim-password"
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                  autoCapitalize="none"
                  autoComplete="new-password"
                  textContentType="newPassword"
                  editable={!busy}
                />
              </View>
              <View style={styles.fieldGap}>
                <FieldLabel text={claimMode === 'reset' ? 'Confirm new password' : 'Confirm password'} />
                <LedgerInput
                  testID="claim-password-confirm"
                  value={passwordConfirm}
                  onChangeText={setPasswordConfirm}
                  secureTextEntry
                  autoCapitalize="none"
                  autoComplete="new-password"
                  textContentType="newPassword"
                  editable={!busy}
                />
                {passwordConfirm.length > 0 && !confirmMatches && (
                  <NoteText text="These don’t match yet." />
                )}
              </View>
              <View style={styles.checklist}>
                {passwordChecks.map(rule => (
                  <View key={rule.key} style={styles.checkRow}>
                    <Feather
                      name={rule.met ? 'check-circle' : 'circle'}
                      size={14}
                      color={rule.met ? colors.activeGreen : colors.labelText}
                    />
                    <Text
                      testID={`claim-rule-${rule.key}`}
                      style={[
                        styles.checkText,
                        { color: rule.met ? colors.navy : colors.subtleText },
                      ]}
                    >
                      {rule.label}
                    </Text>
                  </View>
                ))}
              </View>
              {error && (
                <View style={styles.blockGap}>
                  <ErrorBox testID="claim-error" message={error} />
                </View>
              )}
              <PrimaryButton
                testID="claim-password-submit"
                label={busy ? 'Setting up…' : claimMode === 'reset' ? 'Save and sign in' : 'Finish and sign in'}
                onPress={submitPassword}
                disabled={busy || !passwordReady || !confirmMatches}
                onDisabledPress={
                  busy
                    ? undefined
                    : () =>
                        setError(
                          passwordReady
                            ? 'Both password boxes need to match.'
                            : 'Your password needs everything on the checklist.',
                        )
                }
                style={styles.blockGap}
              />
            </FormWrap>
          </LedgerCard>
        )}

        {phase === 'add-phone' && (
          <LedgerCard style={styles.cardPad}>
            <Text style={[styles.introText, { color: colors.subtleText }]}>
              Add your mobile number so you can sign in with it and get codes by text. We’ll
              send a 6-digit code to confirm it’s yours.
            </Text>
            <View style={styles.fieldGap}>
              <FieldLabel text="Mobile number" />
              <LedgerInput
                testID="claim-new-phone"
                value={newPhone}
                  onChangeText={value => setNewPhone(formatUsPhoneInput(value))}
                keyboardType="phone-pad"
                autoComplete="tel"
                textContentType="telephoneNumber"
                  placeholder="(555) 123-4567"
                editable={!busy}
              />
              <NoteText text="Enter all 10 digits. The US country code (+1) is added automatically." />
            </View>
            {error && (
              <View style={styles.blockGap}>
                <ErrorBox testID="claim-error" message={error} />
              </View>
            )}
            <PrimaryButton
              testID="claim-add-phone-submit"
              label={busy ? 'Sending…' : 'Text me a code'}
              onPress={startAddPhone}
              disabled={busy}
              style={styles.blockGap}
            />
            <GhostButton
              testID="claim-add-phone-skip"
              label="Skip for now"
              onPress={() => {
                setOfferPhone(false);
                setError(null);
                setPhase('done');
              }}
              style={styles.smallGap}
            />
          </LedgerCard>
        )}

        {phase === 'add-phone-code' && (
          <LedgerCard style={styles.cardPad}>
            <Text style={[styles.introText, { color: colors.subtleText }]}>
              We sent a 6-digit code to {normalizePhone(newPhone) || newPhone}.
            </Text>
            {phoneDevCode && (
              <View
                testID="claim-phone-dev-code"
                style={[styles.devCodeBox, { backgroundColor: colors.accent, borderColor: colors.border }]}
              >
                <Feather name="tool" size={13} color={colors.cobalt} />
                <Text style={[styles.devCodeText, { color: colors.navy }]}>
                  Test mode — delivery isn’t switched on yet, so your code is {phoneDevCode}.
                </Text>
              </View>
            )}
            <View style={styles.fieldGap}>
              <FieldLabel text="Verification code" />
              <LedgerInput
                testID="claim-phone-code"
                value={phoneCode}
                onChangeText={value => setPhoneCode(value.replace(/\D/g, ''))}
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
                <ErrorBox testID="claim-error" message={error} />
              </View>
            )}
            <PrimaryButton
              testID="claim-phone-code-submit"
              label={busy ? 'Checking…' : 'Confirm number'}
              onPress={submitPhoneCode}
              disabled={busy}
              style={styles.blockGap}
            />
            <GhostButton
              testID="claim-phone-code-skip"
              label="Skip for now"
              onPress={() => {
                setOfferPhone(false);
                setError(null);
                setPhase('done');
              }}
              style={styles.smallGap}
            />
          </LedgerCard>
        )}

        {phase === 'done' && (
          <LedgerCard style={styles.cardPad}>
            <View style={[styles.doneIcon, { backgroundColor: colors.accent }]}>
              <Feather name="check" size={18} color={colors.activeGreen} />
            </View>
            <Text style={[styles.doneTitle, { color: colors.navy }]}>
              {signedInName ? `Welcome back, ${signedInName.split(' ')[0]}` : 'Welcome back'}
            </Text>
            {notice && (
              <Text testID="claim-notice" style={[styles.noticeText, { color: colors.activeGreen }]}>
                {notice}
              </Text>
            )}
            {staffAccount ? (
              <>
                <Text style={[styles.introText, { color: colors.subtleText }]}>
                  Your login is ready. Staff and provider tools live on the THINNR operations
                  site on the web — sign in there with the same details. This app is the
                  patient companion.
                </Text>
                <GhostButton
                  testID="claim-done-back"
                  label="Back to sign in"
                  onPress={() => router.replace('/patient-login')}
                  style={styles.blockGap}
                />
              </>
            ) : (
              <>
                <Text style={[styles.introText, { color: colors.subtleText }]}>
                  Your account is claimed and you’re signed in on this phone.
                </Text>
                {offerPhone && (
                  <Pressable
                    testID="claim-offer-phone"
                    accessibilityRole="button"
                    onPress={() => {
                      setError(null);
                      setNotice(null);
                      setPhase('add-phone');
                    }}
                    style={[styles.offerRow, { borderColor: colors.border }]}
                  >
                    <Feather name="smartphone" size={15} color={colors.cobalt} />
                    <Text style={[styles.offerText, { color: colors.navy }]}>
                      Add a mobile number for texted codes
                    </Text>
                    <Feather name="arrow-right" size={14} color={colors.cobalt} />
                  </Pressable>
                )}
                <PrimaryButton
                  testID="claim-done-continue"
                  label="Continue to your companion"
                  onPress={enterPatientExperience}
                  style={styles.blockGap}
                />
              </>
            )}
          </LedgerCard>
        )}

        <Text style={[styles.footerText, { color: colors.labelText }]}>
          NEED HELP? CONTACT YOUR CLINIC
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
  introText: {
    fontSize: 12,
    lineHeight: 18,
    fontFamily: 'Inter_400Regular',
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
  otpInput: {
    textAlign: 'center',
    fontSize: 20,
    letterSpacing: 8,
    fontFamily: 'Inter_700Bold',
  },
  devCodeBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 7,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginTop: 12,
  },
  devCodeText: {
    flex: 1,
    fontSize: 11,
    lineHeight: 16,
    fontFamily: 'Inter_600SemiBold',
  },
  checklist: {
    marginTop: 12,
    gap: 6,
  },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  checkText: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
  },
  linkRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 24,
    marginTop: 12,
    paddingVertical: 4,
  },
  linkText: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.2,
  },
  noticeText: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    marginTop: 12,
    textAlign: 'center',
  },
  doneIcon: {
    width: 36,
    height: 36,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  doneTitle: {
    fontSize: 18,
    fontFamily: 'PlayfairDisplay_700Bold',
  },
  offerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 7,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 16,
  },
  offerText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  footerText: {
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 1.6,
    fontFamily: 'Inter_700Bold',
    textAlign: 'center',
    marginTop: 24,
  },
});
