import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, type TextInput } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';
import { CodeInput, ErrorBox, FieldLabel, LedgerInput, NoteText, PrimaryButton } from '@/components/onboarding/OnboardingFields';
import { useColors } from '@/hooks/useColors';
import { useAppMode } from '@/context/AppModeContext';
import { completeRecovery, requestPatientPasswordLogin, signInWithTokenHash, startRecovery, verifyLoginCode, verifyRecovery } from '@/lib/auth-api';
import { normalizePhone, supabaseConfigured } from '@/lib/supabase';

type Channel = 'phone' | 'email';
type Phase = 'login' | 'mfa' | 'recovery-identify' | 'recovery-code' | 'recovery-password';
const validEmail = (value: string) => /^\S+@\S+\.\S+$/.test(value.trim());

export default function PatientLoginScreen() {
  const colors = useColors(); const insets = useSafeAreaInsets(); const { setMode, admitDemo, leaveDemo } = useAppMode();
  const [channel, setChannel] = useState<Channel>('phone');
  const [phase, setPhase] = useState<Phase>('login');
  // iOS never swaps an already-presented keyboard in place, so the identifier
  // input gets a fresh mount per channel (key={channel} below) and, after an
  // explicit switch, this refocuses the new mount so the matching keyboard
  // (email vs phone pad) presents immediately.
  const identifierRef = useRef<TextInput>(null);
  const switchedChannel = useRef(false);
  useEffect(() => { if (!switchedChannel.current) return; switchedChannel.current = false; identifierRef.current?.focus(); }, [channel]);
  const [phone, setPhone] = useState(''); const [email, setEmail] = useState('');
  const [password, setPassword] = useState(''); const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState(''); const [requestId, setRequestId] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const identifier = () => channel === 'phone' ? normalizePhone(phone) : validEmail(email) ? email.trim() : null;
  const clear = () => { setError(null); setNotice(null); };
  // Every user navigation bumps this generation so an in-flight request that
  // settles late can never yank the screen into a stale phase. Submits bump it
  // too, so a fresh attempt orphans any older one.
  const genRef = useRef(0);
  const invalidate = () => { genRef.current += 1; setBusy(false); };
  const done = async () => { leaveDemo(); await setMode('patient'); router.replace('/today'); };
  const backToSignIn = () => { invalidate(); clear(); setCode(''); setPassword(''); setConfirm(''); setPhase('login'); };
  const goBack = () => {
    Haptics.selectionAsync();
    invalidate();
    clear();
    if (phase === 'mfa') { setCode(''); setPhase('login'); return; }
    if (phase === 'recovery-code') { setCode(''); setPhase('recovery-identify'); return; }
    if (phase === 'recovery-identify' || phase === 'recovery-password') { backToSignIn(); return; }
    router.back();
  };
  const request = async (recovery = false) => {
    const value = identifier(); clear();
    if (!value) { setError(channel === 'phone' ? 'Enter your cell phone number.' : 'Enter the email on your account.'); return; }
    if (!recovery && !password) { setError('Enter your password.'); return; }
    const submittedPassword = password;
    if (!recovery) setPassword('');
    const gen = ++genRef.current;
    setBusy(true);
    try {
      const result = recovery ? await startRecovery(value) : await requestPatientPasswordLogin({ identifier: value, password: submittedPassword });
      if (genRef.current !== gen) return;
      if (!result.ok) { setError(result.error); return; }
      setRequestId(result.requestId); setDevCode(result.devCode); setNotice(result.message); setCode('');
      setPhase(recovery ? 'recovery-code' : 'mfa');
    } finally { if (genRef.current === gen) setBusy(false); }
  };
  const verify = async () => {
    if (!requestId || code.length !== 6) { setError('Enter the 6-digit verification code.'); return; }
    clear();
    const gen = ++genRef.current;
    setBusy(true);
    try {
      if (phase === 'mfa') {
        const result = await verifyLoginCode({ requestId, code });
        if (genRef.current !== gen) return;
        if (!result.ok) { setError(result.error); return; }
        const sessionError = await signInWithTokenHash(result.tokenHash);
        if (genRef.current !== gen) return;
        if (sessionError) setError(sessionError); else await done();
      } else {
        const result = await verifyRecovery({ requestId, code });
        if (genRef.current !== gen) return;
        if (!result.ok) setError(result.error); else { setResetToken(result.resetToken); setCode(''); setPhase('recovery-password'); }
      }
    } finally { if (genRef.current === gen) setBusy(false); }
  };
  const resetPassword = async () => {
    if (!resetToken || !password) { setError('Enter a new password.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    const submittedPassword = password;
    setPassword(''); setConfirm('');
    const gen = ++genRef.current;
    setBusy(true); clear();
    try {
      const result = await completeRecovery({ resetToken, password: submittedPassword });
      if (genRef.current !== gen) return;
      if (!result.ok) setError(result.error); else { setNotice('Password updated. You can sign in now.'); setPhase('login'); }
    } finally { if (genRef.current === gen) setBusy(false); }
  };
  const isCode = phase === 'mfa' || phase === 'recovery-code';
  const recovery = phase.startsWith('recovery');
  return <View style={[s.page, { backgroundColor: colors.background, paddingTop: Platform.OS === 'web' ? Math.max(insets.top, 44) : insets.top + 12 }]}>
    <View style={s.headerRow}>
      <Pressable testID="login-back" accessibilityRole="button" accessibilityLabel="Go back" onPress={goBack} style={({ pressed }) => [s.backBtn, { borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radiusSm }, pressed && { backgroundColor: colors.accent }]}>
        <Feather name="chevron-left" size={18} color={colors.navy} />
      </Pressable>
      <View style={[s.brandMark, { borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radiusSm }]}><Text style={[s.brandMarkText, { color: colors.navy }]}>TH</Text></View>
      <View style={s.backSpacer} />
    </View>
    <KeyboardAwareScrollViewCompat contentContainerStyle={s.content}>
      <Text style={[s.kicker, { color: colors.labelText }]}>{recovery ? 'PASSWORD RECOVERY' : 'PATIENT ACCESS'}</Text>
      <Text style={[s.title, { color: colors.navy }]}>{isCode ? 'Verify your sign-in' : phase === 'recovery-password' ? 'Create a new password' : recovery ? 'Reset your password' : 'Welcome back'}</Text>
      {!supabaseConfigured ? <ErrorBox testID="login-not-configured" message="Real sign-in isn’t configured in this environment." /> : null}
      <LedgerCard style={s.card}>
        {!isCode && phase !== 'recovery-password' ? <>
          {phase === 'recovery-identify' ? <Text style={[s.body, s.introBody, { color: colors.subtleText }]}>Enter the phone or email on your account and we’ll send a 6-digit reset code.</Text> : null}
          <FieldLabel text={channel === 'phone' ? 'Cell phone number' : 'Email address'} />
          <LedgerInput key={channel} ref={identifierRef} testID={channel === 'phone' ? 'login-phone' : 'login-email'} accessibilityLabel={channel === 'phone' ? 'Cell phone number' : 'Email address'} value={channel === 'phone' ? phone : email} onChangeText={channel === 'phone' ? setPhone : setEmail} keyboardType={channel === 'phone' ? 'phone-pad' : 'email-address'} autoComplete={channel === 'phone' ? 'tel' : 'email'} textContentType={channel === 'phone' ? 'telephoneNumber' : 'emailAddress'} autoCapitalize="none" placeholder={channel === 'phone' ? 'Your cell number' : 'you@example.com'} />
          <View style={s.linkRow}><Pressable testID="login-switch-channel" accessibilityRole="button" onPress={() => { invalidate(); switchedChannel.current = true; setChannel(channel === 'phone' ? 'email' : 'phone'); }} style={s.linkHit}><Text style={[s.inlineLink, { color: colors.cobalt }]}>{channel === 'phone' ? 'Use email instead' : 'Use phone instead'}</Text></Pressable></View>
          {!recovery ? <>
            <FieldLabel text="Password" />
            <LedgerInput testID="login-password" accessibilityLabel="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" textContentType="password" autoCapitalize="none" placeholder="Your password" />
            <View style={s.linkRow}><Pressable testID="login-forgot" accessibilityRole="button" onPress={() => { invalidate(); clear(); setPhase('recovery-identify'); }} style={s.linkHit}><Text style={[s.inlineLink, { color: colors.cobalt }]}>Forgot password?</Text></Pressable></View>
          </> : null}
          <PrimaryButton testID={recovery ? 'recovery-start' : 'login-submit'} label={busy ? 'Please wait…' : recovery ? 'Send recovery code' : 'Continue'} onPress={() => request(recovery)} disabled={busy || !supabaseConfigured} style={s.gap} />
        </> : isCode ? <>
          <Text style={[s.body, s.introBody, { color: colors.subtleText }]}>Enter the 6-digit code we sent. If the account details match, a code is on its way.</Text>
          <FieldLabel text="Verification code" />
          <CodeInput testID={phase === 'mfa' ? 'login-otp' : 'recovery-otp'} value={code} onChangeText={setCode} />
          <PrimaryButton testID={phase === 'mfa' ? 'login-verify' : 'recovery-verify'} label={busy ? 'Verifying…' : 'Verify'} onPress={verify} disabled={busy} style={s.gap} />
        </> : <>
          <FieldLabel text="New password" />
          <LedgerInput testID="recovery-password" accessibilityLabel="New password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" textContentType="newPassword" placeholder="At least 8 characters" />
          <View style={s.gap}><FieldLabel text="Confirm new password" /><LedgerInput testID="recovery-confirm" accessibilityLabel="Confirm new password" value={confirm} onChangeText={setConfirm} secureTextEntry autoComplete="new-password" textContentType="newPassword" placeholder="Same password again" /></View>
          <PrimaryButton testID="recovery-complete" label={busy ? 'Updating…' : 'Update password'} onPress={resetPassword} disabled={busy} style={s.gap} />
        </>}
        {devCode ? <Text testID="login-devcode" style={[s.body, { color: colors.subtleText }]}>Dev delivery mode — your code is {devCode}.</Text> : null}
        {notice ? <Text accessibilityLiveRegion="polite" style={[s.body, { color: colors.activeGreen }]}>{notice}</Text> : null}
        {error ? <View style={s.gap}><ErrorBox testID="login-error" message={error} /></View> : null}
      </LedgerCard>
      {phase === 'login' ? <>
        <Pressable testID="login-signup" accessibilityRole="button" onPress={() => { invalidate(); router.push('/patient-signup'); }} style={s.footerHit}><Text style={[s.footerCta, { color: colors.cobalt }]}>Create new account</Text></Pressable>
        <View style={s.quietRow}>
          <Pressable testID="login-demo" accessibilityRole="button" onPress={async () => { invalidate(); await admitDemo(); router.push('/patient-entry'); }} style={s.linkHit}><Text style={[s.quietLink, { color: colors.subtleText }]}>Explore demo</Text></Pressable>
          <Text style={[s.quietDot, { color: colors.labelText }]}>·</Text>
          <Pressable testID="login-provider" accessibilityRole="button" onPress={() => { invalidate(); router.push('/provider-login'); }} style={s.linkHit}><Text style={[s.quietLink, { color: colors.subtleText }]}>Provider login</Text></Pressable>
        </View>
        <NoteText center text="Your health journey, supported by your care team." />
      </> : <Pressable testID="login-back-to-signin" accessibilityRole="button" onPress={backToSignIn} style={s.footerHit}><Text style={[s.footerCta, { color: colors.cobalt }]}>Back to sign in</Text></Pressable>}
    </KeyboardAwareScrollViewCompat>
  </View>;
}
const s = StyleSheet.create({
  page: { flex: 1 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 10, paddingBottom: 12, maxWidth: 520, width: '100%', alignSelf: 'center' },
  backBtn: { width: 44, height: 44, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  backSpacer: { width: 44 },
  brandMark: { width: 34, height: 34, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  brandMarkText: { fontSize: 13, fontFamily: 'PlayfairDisplay_700Bold', letterSpacing: 1 },
  content: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 28, gap: 14, maxWidth: 520, width: '100%', alignSelf: 'center' },
  kicker: { fontSize: 10.5, fontFamily: 'Inter_700Bold', letterSpacing: 1.5 },
  title: { fontSize: 30, fontFamily: 'PlayfairDisplay_700Bold' },
  card: { padding: 18 },
  gap: { marginTop: 14 },
  linkRow: { alignItems: 'flex-end', marginTop: 6, marginBottom: 10 },
  linkHit: { paddingVertical: 4, paddingHorizontal: 4 },
  inlineLink: { fontSize: 12.5, fontFamily: 'Inter_600SemiBold' },
  footerHit: { alignSelf: 'center', paddingVertical: 6, paddingHorizontal: 8 },
  footerCta: { fontSize: 13.5, fontFamily: 'Inter_700Bold', textAlign: 'center' },
  quietRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  quietLink: { fontSize: 12.5, fontFamily: 'Inter_600SemiBold' },
  quietDot: { fontSize: 13, fontFamily: 'Inter_700Bold' },
  introBody: { marginTop: 0, marginBottom: 14 },
  body: { fontSize: 13.5, lineHeight: 20, fontFamily: 'Inter_400Regular', marginTop: 12 },
});
