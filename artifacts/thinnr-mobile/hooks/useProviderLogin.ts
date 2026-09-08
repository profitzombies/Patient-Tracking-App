/**
 * Provider login state — the staff door inside the patient app.
 *
 * Staff accounts (provider offices and HQ) are keyed on work email, never
 * phone — so a provider's personal cell stays free for their own patient
 * account. Same passwordless shape as the operations web app: email in, a
 * 6-digit code back, and a real session that flips the app into staff mode.
 */
import { useState } from 'react';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useAppMode } from '@/context/AppModeContext';
import { requestStaffLoginCode, signInWithTokenHash, verifyLoginCode } from '@/lib/auth-api';
import { supabaseConfigured } from '@/lib/supabase';
import { attachSignIn } from '@/lib/security-api';

export type ProviderLoginPhase = 'email' | 'code';

export function useProviderLogin() {
  const { setMode } = useAppMode();
  const [phase, setPhase] = useState<ProviderLoginPhase>('email');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [pendingEmail, setPendingEmail] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sendCode = async (address: string) => {
    const result = await requestStaffLoginCode(address);
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
      if (result.signInId) void attachSignIn(result.signInId).catch(cause => console.warn('Could not attach sign-in ledger row:', cause));
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

  const explainNotConfigured = () => setError('Real sign-in isn’t configured in this environment.');

  return {
    phase,
    email,
    otp,
    pendingEmail,
    devCode,
    error,
    notice,
    busy,
    setEmail,
    setOtp: (value: string) => setOtp(value.replace(/\D/g, '')),
    submitEmail,
    submitOtp,
    resendCode,
    backToEmail,
    goBack,
    explainNotConfigured,
  };
}
