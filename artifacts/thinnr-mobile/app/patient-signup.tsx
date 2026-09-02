import React, { useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';
import { CodeInput, ErrorBox, FieldLabel, LedgerInput, NoteText, PrimaryButton } from '@/components/onboarding/OnboardingFields';
import { useColors } from '@/hooks/useColors';
import { useAppMode } from '@/context/AppModeContext';
import { completeSignup, signInWithTokenHash, startSignup, verifySignupCode } from '@/lib/auth-api';
import { normalizePhone, supabaseConfigured } from '@/lib/supabase';
type Flow = 'invited' | 'new'; type Phase = 'choose' | 'contact' | 'code' | 'details';
const emailOK = (x: string) => /^\S+@\S+\.\S+$/.test(x.trim());
export default function PatientSignupScreen() {
  const colors = useColors(), insets = useSafeAreaInsets(), { setMode, leaveDemo } = useAppMode();
  const [flow, setFlow] = useState<Flow>('invited'), [phase, setPhase] = useState<Phase>('choose'), [phone, setPhone] = useState(''), [email, setEmail] = useState(''), [providerCode, setProviderCode] = useState(''), [otp, setOtp] = useState(''), [password, setPassword] = useState(''), [name, setName] = useState(''), [requestId, setRequestId] = useState<string | null>(null), [signupToken, setSignupToken] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [devCode, setDevCode] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const identifier = () => emailOK(email) ? email.trim() : normalizePhone(phone);
  const clear = () => { setError(null); setNotice(null); };
  // Every user navigation bumps this generation so an in-flight request that
  // settles late can never yank the screen into a stale phase. Submits bump it
  // too, so a fresh attempt orphans any older one.
  const genRef = useRef(0);
  const invalidate = () => { genRef.current += 1; setBusy(false); };
  const goBack = () => {
    Haptics.selectionAsync();
    invalidate();
    clear();
    if (phase === 'contact') { setPhase('choose'); return; }
    if (phase === 'code') { setOtp(''); setPhase('contact'); return; }
    if (phase === 'details') { setPassword(''); setPhase('contact'); return; }
    router.back();
  };
  const start = async () => {
    setError(null);
    const p = normalizePhone(phone), e = email.trim();
    if (flow === 'new' && (!p || !emailOK(e))) { setError('Enter both your cell phone number and email address.'); return; }
    const codeDigits = providerCode.trim();
    // An empty code gets a local, friendly nudge; the server's "doesn't match
    // an active office" copy is reserved for codes that were actually typed.
    if (flow === 'new' && !codeDigits) { setError('Enter your provider code — it’s the 6-digit code in your welcome packet.'); return; }
    const id = flow === 'invited' ? identifier() : null;
    if (flow === 'invited' && !id) { setError('Enter the email or phone number in your invitation.'); return; }
    const gen = ++genRef.current;
    setBusy(true);
    try {
      const r = await startSignup(flow === 'invited' ? { flow, identifier: id! } : { flow, phone: p!, email: e, code: codeDigits });
      if (genRef.current !== gen) return;
      if (!r.ok) { setError(r.error); return; }
      setRequestId(r.requestId); setDevCode(r.devCode); setNotice(r.message); setOtp(''); setPhase('code');
    } finally { if (genRef.current === gen) setBusy(false); }
  };
  const verify = async () => {
    if (!requestId || otp.length !== 6) { setError('Enter the 6-digit verification code.'); return; }
    const gen = ++genRef.current;
    setBusy(true); setError(null);
    try {
      const r = await verifySignupCode({ requestId, code: otp });
      if (genRef.current !== gen) return;
      if (!r.ok) setError(r.error); else { setSignupToken(r.signupToken); setPhase('details'); }
    } finally { if (genRef.current === gen) setBusy(false); }
  };
  const finish = async () => {
    if (!signupToken || !password) { setError('Create a password.'); return; }
    if (password.length < 8) { setError('Choose a password with at least 8 characters.'); return; }
    const submittedPassword = password; setPassword('');
    const gen = ++genRef.current;
    setBusy(true); setError(null);
    try {
      const r = await completeSignup({ signupToken, password: submittedPassword, name: name.trim() || undefined, email: emailOK(email) ? email.trim() : undefined });
      if (genRef.current !== gen) return;
      if (!r.ok) { setError(r.error); return; }
      const se = await signInWithTokenHash(r.tokenHash);
      if (genRef.current !== gen) return;
      if (se) setError(se); else { leaveDemo(); await setMode('patient'); router.replace('/today'); }
    } finally { if (genRef.current === gen) setBusy(false); }
  };
  return <View style={[s.page, { backgroundColor: colors.background, paddingTop: Platform.OS === 'web' ? Math.max(insets.top, 44) : insets.top + 12 }]}>
    <View style={s.headerRow}>
      <Pressable testID="signup-back" accessibilityRole="button" accessibilityLabel="Go back" onPress={goBack} style={({ pressed }) => [s.backBtn, { borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radiusSm }, pressed && { backgroundColor: colors.accent }]}>
        <Feather name="chevron-left" size={18} color={colors.navy} />
      </Pressable>
      <View style={[s.brandMark, { borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radiusSm }]}><Text style={[s.brandMarkText, { color: colors.navy }]}>TH</Text></View>
      <View style={s.backSpacer} />
    </View>
    <KeyboardAwareScrollViewCompat contentContainerStyle={s.content}>
      <Text style={[s.kicker, { color: colors.labelText }]}>CREATE YOUR ACCOUNT</Text>
      <Text style={[s.title, { color: colors.navy }]}>{phase === 'choose' ? 'How are you joining?' : phase === 'contact' ? (flow === 'invited' ? 'Your invitation details' : 'Tell us how to reach you') : phase === 'code' ? 'Verify your contact' : 'Secure your account'}</Text>
      <LedgerCard style={s.card}>
        {phase === 'choose' ? <>
          <Text style={[s.body, s.introBody, { color: colors.subtleText }]}>If your med spa invited you, your details are already on file. Brand new? You’ll enter the provider code from your welcome packet.</Text>
          <PrimaryButton testID="signup-invited" label="I have an invitation" onPress={() => { setFlow('invited'); clear(); setPhase('contact'); }} />
          <Pressable testID="signup-new" accessibilityRole="button" onPress={() => { setFlow('new'); clear(); setPhase('contact'); }} style={({ pressed }) => [s.secondaryBtn, { borderColor: colors.cobalt, backgroundColor: colors.card, borderRadius: colors.radiusSm }, pressed && { opacity: 0.7 }]}><Text style={[s.secondaryBtnText, { color: colors.cobalt }]}>I’m new to THINNR</Text></Pressable>
        </> : null}
        {phase === 'contact' ? <>
          <FieldLabel text={flow === 'invited' ? 'Invited phone number' : 'Cell phone number'} />
          <LedgerInput testID="signup-phone" accessibilityLabel={flow === 'invited' ? 'Invited phone number' : 'Cell phone number'} value={phone} onChangeText={setPhone} keyboardType="phone-pad" textContentType="telephoneNumber" autoComplete="tel" placeholder={flow === 'invited' ? 'Cell number from your invitation' : 'Your cell number'} />
          {flow === 'invited' ? <View style={s.gap}><FieldLabel text="Or invited email address" /><LedgerInput testID="signup-email" accessibilityLabel="Invited email address" value={email} onChangeText={setEmail} keyboardType="email-address" autoComplete="email" textContentType="emailAddress" autoCapitalize="none" placeholder="you@example.com" /></View> : <>
            <View style={s.gap}><FieldLabel text="Email address" /><LedgerInput testID="signup-email" accessibilityLabel="Email address" value={email} onChangeText={setEmail} keyboardType="email-address" autoComplete="email" textContentType="emailAddress" autoCapitalize="none" placeholder="you@example.com" /></View>
            <View style={s.gap}>
              <FieldLabel text="Provider code" />
              <LedgerInput testID="signup-provider-code" accessibilityLabel="Provider code" value={providerCode} onChangeText={setProviderCode} keyboardType="number-pad" maxLength={6} placeholder="6-digit code" />
              <View style={s.noteGap}><NoteText text="It’s the 6-digit code in your welcome packet. Can’t find it? Ask your med spa." /></View>
            </View>
          </>}
          <PrimaryButton testID="signup-send" label={busy ? 'Sending…' : 'Send verification code'} onPress={start} disabled={busy || !supabaseConfigured} style={s.gap} />
        </> : null}
        {phase === 'code' ? <>
          <Text style={[s.body, s.introBody, { color: colors.subtleText }]}>Enter the 6-digit code we sent to confirm it’s really you.</Text>
          <FieldLabel text="Verification code" />
          <CodeInput testID="signup-otp" value={otp} onChangeText={setOtp} />
          <PrimaryButton testID="signup-verify" label={busy ? 'Verifying…' : 'Verify'} onPress={verify} disabled={busy} style={s.gap} />
        </> : null}
        {phase === 'details' ? <>
          <FieldLabel text="Password" />
          <LedgerInput testID="signup-password" accessibilityLabel="Create password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" textContentType="newPassword" placeholder="At least 8 characters" />
          <View style={s.gap}><FieldLabel text="Name (optional)" /><LedgerInput testID="signup-name" accessibilityLabel="Name" value={name} onChangeText={setName} autoComplete="name" textContentType="name" placeholder="Your name" /></View>
          <PrimaryButton testID="signup-complete" label={busy ? 'Creating…' : 'Create account'} onPress={finish} disabled={busy} style={s.gap} />
        </> : null}
        {devCode ? <Text testID="signup-devcode" style={[s.body, { color: colors.subtleText }]}>Dev delivery mode — your code is {devCode}.</Text> : null}
        {notice ? <Text accessibilityLiveRegion="polite" style={[s.body, { color: colors.activeGreen }]}>{notice}</Text> : null}
        {error ? <View style={s.gap}><ErrorBox testID="signup-error" message={error} /></View> : null}
      </LedgerCard>
      {phase === 'choose' || phase === 'contact' ? <Pressable accessibilityRole="button" onPress={() => { invalidate(); router.push('/patient-login'); }} style={s.footerHit}><Text style={[s.footerCta, { color: colors.cobalt }]}>Already have an account? Log in</Text></Pressable> : null}
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
  kicker: { fontSize: 10.5, fontFamily: 'Inter_700Bold', letterSpacing: 1.4 },
  title: { fontSize: 29, fontFamily: 'PlayfairDisplay_700Bold' },
  card: { padding: 18 },
  gap: { marginTop: 14 },
  noteGap: { marginTop: 8 },
  secondaryBtn: { minHeight: 48, borderWidth: 1, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  secondaryBtnText: { fontSize: 14, fontFamily: 'Inter_700Bold', letterSpacing: 0.3 },
  footerHit: { alignSelf: 'center', paddingVertical: 6, paddingHorizontal: 8 },
  footerCta: { fontSize: 13.5, fontFamily: 'Inter_700Bold', textAlign: 'center' },
  introBody: { marginTop: 0, marginBottom: 14 },
  body: { fontSize: 13.5, lineHeight: 20, fontFamily: 'Inter_400Regular', marginTop: 10 },
});
