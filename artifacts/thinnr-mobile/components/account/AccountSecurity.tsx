import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { ErrorBox, FieldLabel, LedgerInput, PrimaryButton } from '@/components/onboarding/OnboardingFields';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';
import { useColors } from '@/hooks/useColors';
import {
  completePasswordChange,
  fetchSecurityOverview,
  reportSignIn,
  SecurityApiError,
  signOutOtherSessions,
  startPasswordChange,
  type SecurityOverview,
  type SessionDto,
  type SignInDto,
} from '@/lib/security-api';
import { supabase } from '@/lib/supabase';

const DEMO_SIGN_INS: SignInDto[] = [
  { id: 'preview-current', at: '2026-09-07T14:30:00.000Z', method: 'password_sms_code', methodLabel: 'Password + texted code', platform: 'ios', device: 'iPhone · THINNR app', region: 'Austin, Texas, US', newDevice: false, current: true, active: true, revokedAt: null, revokedReason: null, reportedAt: null },
  { id: 'preview-new', at: '2026-09-05T09:15:00.000Z', method: 'password_email_code', methodLabel: 'Password + emailed code', platform: 'web', device: 'Chrome on Mac', region: 'Austin, Texas, US', newDevice: true, current: false, active: true, revokedAt: null, revokedReason: null, reportedAt: null },
];
const DEMO_SESSIONS: SessionDto[] = [
  { ref: 'preview-session-1', createdAt: '2026-09-07T14:30:00.000Z', lastSeenAt: '2026-09-07T15:00:00.000Z', platform: 'ios', device: 'iPhone · THINNR app', region: 'Austin, Texas, US', current: true, signInId: 'preview-current' },
  { ref: 'preview-session-2', createdAt: '2026-09-05T09:15:00.000Z', lastSeenAt: '2026-09-06T18:45:00.000Z', platform: 'web', device: 'Chrome on Mac', region: 'Austin, Texas, US', current: false, signInId: 'preview-new' },
];

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function AccountSecurity({ demo = false }: { demo?: boolean }) {
  const colors = useColors();
  const [overview, setOverview] = useState<SecurityOverview | null>(demo ? {
    realm: 'patient', canChangePassword: true, contact: { phone: '•••-1212', email: 'p•••@example.com' },
    passwordChangedAt: '2026-08-20T12:00:00.000Z', currentSessionKnown: true,
    signIns: DEMO_SIGN_INS, sessions: DEMO_SESSIONS,
  } : null);
  const [loading, setLoading] = useState(!demo);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [request, setRequest] = useState<{ id: string; destination: string } | null>(null);
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [success, setSuccess] = useState<string | null>(null);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [confirmReport, setConfirmReport] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (demo) return;
    setLoading(true); setError(null);
    try { setOverview(await fetchSecurityOverview()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Couldn’t load account security.'); }
    finally { setLoading(false); }
  }, [demo]);
  useEffect(() => { void refresh(); }, [refresh]);

  const beginPassword = async () => {
    setBusy(true); setFieldErrors({}); setError(null); setSuccess(null);
    try {
      const result = await startPasswordChange(currentPassword);
      setRequest({ id: result.requestId, destination: result.destination });
      setCode(result.devCode ?? ''); setCurrentPassword('');
    } catch (cause) {
      if (cause instanceof SecurityApiError && cause.field) setFieldErrors({ [cause.field]: cause.message });
      else setError(cause instanceof Error ? cause.message : 'Couldn’t send a security code.');
    } finally { setBusy(false); }
  };
  const finishPassword = async () => {
    if (!request) return;
    setBusy(true); setFieldErrors({}); setError(null);
    try {
      await completePasswordChange({ requestId: request.id, code, newPassword });
      setRequest(null); setCode(''); setNewPassword('');
      setSuccess('Password changed. Other devices were signed out.');
      await refresh();
    } catch (cause) {
      if (cause instanceof SecurityApiError && cause.field) setFieldErrors({ [cause.field]: cause.message });
      else setError(cause instanceof Error ? cause.message : 'Couldn’t change your password.');
    } finally { setBusy(false); }
  };
  const signOutOthers = async () => {
    setBusy(true); setError(null);
    try { await signOutOtherSessions(); setConfirmSignOut(false); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Couldn’t sign out other sessions.'); }
    finally { setBusy(false); }
  };
  const report = async (id: string) => {
    setBusy(true); setError(null);
    try {
      await reportSignIn(id);
      await supabase?.auth.signOut();
      router.replace({ pathname: '/patient-login', params: { notice: 'For your protection, all sessions were signed out. Reset your password to continue.' } });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Couldn’t report that sign-in.'); }
    finally { setBusy(false); }
  };

  const signIns = overview?.signIns ?? [];
  const sessions = overview?.sessions ?? [];
  return (
    <View testID="account-security">
      <Text style={[styles.section, { color: colors.labelText }]}>SECURITY</Text>
      <LedgerCard style={styles.card}>
        {demo ? <Text testID="security-preview-note" style={[styles.note, { color: colors.subtleText }]}>Preview — sign in to manage your real account</Text> : null}
        {loading ? <Text testID="security-loading" style={[styles.body, { color: colors.subtleText }]}>Loading security activity…</Text> : null}
        {error ? <ErrorBox testID="security-error" message={error} /> : null}
        {!loading && overview ? (
          <>
            <Text style={[styles.heading, { color: colors.navy }]}>Change password</Text>
            {!request ? (
              <>
                <FieldLabel text="Current password" />
                <LedgerInput testID="security-current-password" value={currentPassword} onChangeText={setCurrentPassword} secureTextEntry editable={!demo && !busy} autoComplete="current-password" />
                {fieldErrors.currentPassword ? <ErrorBox testID="security-current-password-error" message={fieldErrors.currentPassword} /> : null}
                <PrimaryButton testID="security-password-start" label={busy ? 'Sending…' : 'Send security code'} disabled={demo || busy || !overview.canChangePassword} onPress={() => void beginPassword()} style={styles.smallGap} />
              </>
            ) : (
              <View testID="security-password-code-step">
                <Text style={[styles.note, { color: colors.subtleText }]}>Enter the code sent to {request.destination}.</Text>
                <FieldLabel text="Security code" />
                <LedgerInput testID="security-password-code" value={code} onChangeText={v => setCode(v.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" />
                {fieldErrors.code ? <ErrorBox testID="security-password-code-error" message={fieldErrors.code} /> : null}
                <View style={styles.smallGap}><FieldLabel text="New password" /><LedgerInput testID="security-new-password" value={newPassword} onChangeText={setNewPassword} secureTextEntry autoComplete="new-password" /></View>
                {fieldErrors.newPassword ? <ErrorBox testID="security-new-password-error" message={fieldErrors.newPassword} /> : null}
                <PrimaryButton testID="security-password-complete" label={busy ? 'Updating…' : 'Change password'} disabled={busy} onPress={() => void finishPassword()} style={styles.smallGap} />
              </View>
            )}
            {success ? <Text testID="security-password-success" style={[styles.success, { color: colors.activeGreen }]}>{success}</Text> : null}

            <Text style={[styles.heading, styles.divider, { color: colors.navy, borderTopColor: colors.border }]}>Recent sign-ins</Text>
            {signIns.length === 0 ? <Text testID="security-signins-empty" style={[styles.note, { color: colors.subtleText }]}>No recent sign-ins are available.</Text> : signIns.map((item, index) => (
              <View key={item.id} testID={`security-signin-${index}`} style={[styles.item, { borderTopColor: colors.border }]}>
                <View style={styles.itemTop}><Text style={[styles.itemTitle, { color: colors.bodyText }]}>{item.device}</Text><View style={styles.badges}>{item.newDevice ? <Text style={[styles.badge, { color: colors.cobalt }]}>New device</Text> : null}{item.current ? <Text style={[styles.badge, { color: colors.activeGreen }]}>Current</Text> : null}</View></View>
                <Text style={[styles.note, { color: colors.subtleText }]}>{item.methodLabel} · {item.region ?? 'Region unavailable'} · {demo ? (index === 0 ? 'Sep 7, 2026' : 'Sep 5, 2026') : relativeTime(item.at)}</Text>
                {!item.current ? confirmReport === item.id ? <View style={styles.confirm}><Text style={[styles.note, { color: colors.bodyText }]}>Sign out every session and require a password reset?</Text><PrimaryButton testID={`security-report-confirm-${item.id}`} label="Yes, this wasn’t me" disabled={demo || busy} onPress={() => void report(item.id)} /><Pressable onPress={() => setConfirmReport(null)}><Text style={[styles.link, { color: colors.subtleText }]}>Cancel</Text></Pressable></View> : <Pressable testID={`security-report-${item.id}`} disabled={demo} onPress={() => setConfirmReport(item.id)}><Text style={[styles.link, { color: demo ? colors.subtleText : colors.cobalt }]}>This wasn’t me</Text></Pressable> : null}
              </View>
            ))}

            <Text style={[styles.heading, styles.divider, { color: colors.navy, borderTopColor: colors.border }]}>Active sessions</Text>
            {sessions.length === 0 ? <Text testID="security-sessions-empty" style={[styles.note, { color: colors.subtleText }]}>No active sessions are available.</Text> : sessions.map((item, index) => (
              <View key={item.ref} testID={`security-session-${index}`} style={[styles.item, { borderTopColor: colors.border }]}>
                <View style={styles.itemTop}><Text style={[styles.itemTitle, { color: colors.bodyText }]}>{item.device}</Text>{item.current ? <Text style={[styles.badge, { color: colors.activeGreen }]}>Current</Text> : null}</View>
                <Text style={[styles.note, { color: colors.subtleText }]}>{item.region ?? 'Region unavailable'} · Last seen {demo ? (index === 0 ? 'Sep 7, 2026' : 'Sep 6, 2026') : relativeTime(item.lastSeenAt)}</Text>
              </View>
            ))}
            {confirmSignOut ? <View testID="security-signout-confirm" style={styles.confirm}><Text style={[styles.note, { color: colors.bodyText }]}>Keep this device signed in and sign out everywhere else?</Text><PrimaryButton testID="security-signout-others-confirm" label="Confirm sign out" disabled={demo || busy} onPress={() => void signOutOthers()} /><Pressable onPress={() => setConfirmSignOut(false)}><Text style={[styles.link, { color: colors.subtleText }]}>Cancel</Text></Pressable></View> : <PrimaryButton testID="security-signout-others" label="Sign out everywhere else" disabled={demo || busy} onPress={() => setConfirmSignOut(true)} style={styles.gap} />}
          </>
        ) : null}
      </LedgerCard>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { fontSize: 10, letterSpacing: 1.4, fontFamily: 'Inter_700Bold', marginTop: 20, marginBottom: 8 },
  card: { padding: 14 },
  heading: { fontSize: 17, fontFamily: 'PlayfairDisplay_700Bold', marginBottom: 10 },
  divider: { borderTopWidth: 1, paddingTop: 16, marginTop: 20 },
  body: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  note: { fontSize: 12.5, lineHeight: 18, fontFamily: 'Inter_400Regular', marginBottom: 9 },
  item: { borderTopWidth: 1, paddingVertical: 11 },
  itemTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  itemTitle: { flex: 1, fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  badges: { flexDirection: 'row', gap: 6 },
  badge: { fontSize: 10, fontFamily: 'Inter_700Bold' },
  link: { fontSize: 12, fontFamily: 'Inter_700Bold', paddingVertical: 6 },
  success: { fontSize: 12.5, fontFamily: 'Inter_600SemiBold', marginTop: 10 },
  confirm: { gap: 7, marginTop: 8 },
  gap: { marginTop: 14 },
  smallGap: { marginTop: 9 },
});