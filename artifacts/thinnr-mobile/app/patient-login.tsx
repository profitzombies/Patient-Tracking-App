import React, { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';
import { ErrorBox, FieldLabel, LedgerInput, NoteText, PrimaryButton } from '@/components/onboarding/OnboardingFields';
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
  const [phone, setPhone] = useState(''); const [email, setEmail] = useState('');
  const [password, setPassword] = useState(''); const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState(''); const [requestId, setRequestId] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const identifier = () => channel === 'phone' ? normalizePhone(phone) : validEmail(email) ? email.trim() : null;
  const clear = () => { setError(null); setNotice(null); };
  const done = async () => { leaveDemo(); await setMode('patient'); router.replace('/today'); };
  const request = async (recovery = false) => {
    const value = identifier(); clear();
    if (!value) { setError(channel === 'phone' ? 'Enter your cell phone number.' : 'Enter the email on your account.'); return; }
    if (!recovery && !password) { setError('Enter your password.'); return; }
    const submittedPassword = password;
    if (!recovery) setPassword('');
    setBusy(true);
    try {
      const result = recovery ? await startRecovery(value) : await requestPatientPasswordLogin({ identifier: value, password: submittedPassword });
      if (!result.ok) { setError(result.error); return; }
      setRequestId(result.requestId); setDevCode(result.devCode); setNotice(result.message); setCode('');
      setPhase(recovery ? 'recovery-code' : 'mfa');
    } finally { setBusy(false); }
  };
  const verify = async () => {
    if (!requestId || code.length !== 6) { setError('Enter the 6-digit verification code.'); return; }
    clear(); setBusy(true);
    try {
      if (phase === 'mfa') {
        const result = await verifyLoginCode({ requestId, code });
        if (!result.ok) { setError(result.error); return; }
        const sessionError = await signInWithTokenHash(result.tokenHash);
        if (sessionError) setError(sessionError); else await done();
      } else {
        const result = await verifyRecovery({ requestId, code });
        if (!result.ok) setError(result.error); else { setResetToken(result.resetToken); setCode(''); setPhase('recovery-password'); }
      }
    } finally { setBusy(false); }
  };
  const resetPassword = async () => {
    if (!resetToken || !password) { setError('Enter a new password.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    const submittedPassword = password;
    setPassword(''); setConfirm('');
    setBusy(true); clear();
    try { const result = await completeRecovery({ resetToken, password: submittedPassword }); if (!result.ok) setError(result.error); else { setNotice('Password updated. You can sign in now.'); setPhase('login'); } } finally { setBusy(false); }
  };
  const isCode = phase === 'mfa' || phase === 'recovery-code';
  const recovery = phase.startsWith('recovery');
  return <View style={[s.page, { backgroundColor: colors.background, paddingTop: Platform.OS === 'web' ? Math.max(insets.top, 50) : insets.top + 16 }]}>
    <KeyboardAwareScrollViewCompat contentContainerStyle={s.content}>
      <Text style={[s.brand, { color: colors.navy }]}>THINNR</Text>
      <Text style={[s.kicker, { color: colors.labelText }]}>PATIENT ACCESS</Text>
      <Text style={[s.title, { color: colors.navy }]}>{isCode ? 'Verify your sign-in' : recovery ? 'Reset your password' : 'Welcome back'}</Text>
      {!supabaseConfigured ? <ErrorBox testID="login-not-configured" message="Real sign-in isn’t configured in this environment." /> : null}
      <LedgerCard style={s.card}>
        {!isCode && phase !== 'recovery-password' ? <>
          <FieldLabel text={channel === 'phone' ? 'Cell phone number' : 'Email address'} />
          <LedgerInput testID={channel === 'phone' ? 'login-phone' : 'login-email'} accessibilityLabel={channel === 'phone' ? 'Cell phone number' : 'Email address'} value={channel === 'phone' ? phone : email} onChangeText={channel === 'phone' ? setPhone : setEmail} keyboardType={channel === 'phone' ? 'phone-pad' : 'email-address'} autoComplete={channel === 'phone' ? 'tel' : 'email'} textContentType={channel === 'phone' ? 'telephoneNumber' : 'emailAddress'} autoCapitalize="none" />
          {!recovery ? <View style={s.gap}><FieldLabel text="Password" /><LedgerInput testID="login-password" accessibilityLabel="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" textContentType="password" autoCapitalize="none" /></View> : null}
          <Pressable testID="login-switch-channel" accessibilityRole="button" onPress={() => setChannel(channel === 'phone' ? 'email' : 'phone')}><Text style={[s.link, { color: colors.cobalt }]}>{channel === 'phone' ? 'Use email instead' : 'Use phone instead'}</Text></Pressable>
          {!recovery ? <Pressable testID="login-forgot" accessibilityRole="button" onPress={() => { clear(); setPhase('recovery-identify'); }}><Text style={[s.link, { color: colors.cobalt }]}>Forgot password?</Text></Pressable> : null}
          <PrimaryButton testID={recovery ? 'recovery-start' : 'login-submit'} label={busy ? 'Please wait…' : recovery ? 'Send recovery code' : 'Continue'} onPress={() => request(recovery)} disabled={busy || !supabaseConfigured} style={s.gap} />
        </> : isCode ? <>
          <Text style={[s.body, { color: colors.subtleText }]}>Enter the 6-digit code we sent. If the account details match, a code is on its way.</Text>
          <View style={s.gap}><FieldLabel text="Verification code" /><LedgerInput testID={phase === 'mfa' ? 'login-otp' : 'recovery-otp'} accessibilityLabel="6-digit verification code" value={code} onChangeText={v => setCode(v.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" autoComplete="sms-otp" textContentType="oneTimeCode" maxLength={6} /></View>
          <PrimaryButton testID={phase === 'mfa' ? 'login-verify' : 'recovery-verify'} label={busy ? 'Verifying…' : 'Verify'} onPress={verify} disabled={busy} />
        </> : <>
          <FieldLabel text="New password" /><LedgerInput testID="recovery-password" accessibilityLabel="New password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" textContentType="newPassword" />
          <View style={s.gap}><FieldLabel text="Confirm new password" /><LedgerInput testID="recovery-confirm" accessibilityLabel="Confirm new password" value={confirm} onChangeText={setConfirm} secureTextEntry autoComplete="new-password" textContentType="newPassword" /></View>
          <PrimaryButton testID="recovery-complete" label={busy ? 'Updating…' : 'Update password'} onPress={resetPassword} disabled={busy} style={s.gap} />
        </>}
        {devCode ? <Text testID="login-devcode" style={[s.body, { color: colors.subtleText }]}>Dev delivery mode — your code is {devCode}.</Text> : null}
        {notice ? <Text accessibilityLiveRegion="polite" style={[s.body, { color: colors.activeGreen }]}>{notice}</Text> : null}
        {error ? <View style={s.gap}><ErrorBox testID="login-error" message={error} /></View> : null}
      </LedgerCard>
      <Pressable testID="login-signup" accessibilityRole="button" onPress={() => router.push('/patient-signup')}><Text style={[s.link, { color: colors.cobalt }]}>Create new account</Text></Pressable>
      <Pressable testID="login-demo" accessibilityRole="button" onPress={async () => { await admitDemo(); router.push('/patient-entry'); }}><Text style={[s.link, { color: colors.subtleText }]}>Explore demo</Text></Pressable>
      <Pressable testID="login-provider" accessibilityRole="button" onPress={() => router.push('/provider-login')}><Text style={[s.link, { color: colors.subtleText }]}>Provider login</Text></Pressable>
      <NoteText center text="Your health journey, supported by your care team." />
    </KeyboardAwareScrollViewCompat>
  </View>;
}
const s = StyleSheet.create({ page:{flex:1},content:{padding:20,gap:14,maxWidth:520,width:'100%',alignSelf:'center'},brand:{fontSize:22,fontFamily:'PlayfairDisplay_700Bold',letterSpacing:4},kicker:{fontSize:10,fontFamily:'Inter_700Bold',letterSpacing:1.5,marginTop:16},title:{fontSize:30,fontFamily:'PlayfairDisplay_700Bold'},card:{padding:18},gap:{marginTop:14},link:{fontSize:13,fontFamily:'Inter_700Bold',textAlign:'center',marginTop:14,padding:4},body:{fontSize:13,lineHeight:19,fontFamily:'Inter_400Regular',marginTop:12} });