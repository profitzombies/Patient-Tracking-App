/**
 * Patient login state machine — phases, channel switch, password + MFA,
 * and the neutral password-recovery ladder. The screen is a pure view over
 * this hook; every route target, API call, and error/notice string lives here.
 */
import { useEffect, useRef, useState } from 'react';
import type { TextInput } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useAppMode } from '@/context/AppModeContext';
import {
  completeRecovery,
  requestPatientPasswordLogin,
  signInWithTokenHash,
  startRecovery,
  verifyLoginCode,
  verifyRecovery,
} from '@/lib/auth-api';
import { normalizePhone } from '@/lib/supabase';
import { formatUsPhoneInput } from '@/lib/office-roster-api';
import { attachSignIn } from '@/lib/security-api';

export type LoginChannel = 'phone' | 'email';
export type LoginPhase = 'login' | 'mfa' | 'recovery-identify' | 'recovery-code' | 'recovery-password';

const validEmail = (value: string) => /^\S+@\S+\.\S+$/.test(value.trim());

export function usePatientLogin() {
  const { setMode, admitDemo, leaveDemo } = useAppMode();
  const params = useLocalSearchParams<{ notice?: string | string[] }>();
  const initialNotice = Array.isArray(params.notice) ? params.notice[0] : params.notice;

  const [channel, setChannel] = useState<LoginChannel>('phone');
  const [phase, setPhase] = useState<LoginPhase>('login');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(initialNotice ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // iOS never swaps an already-presented keyboard in place, so the identifier
  // input gets a fresh mount per channel (key={channel} in the view) and, after
  // an explicit switch, this refocuses the new mount so the matching keyboard
  // (email vs phone pad) presents immediately.
  const identifierRef = useRef<TextInput>(null);
  const switchedChannel = useRef(false);
  useEffect(() => {
    if (!switchedChannel.current) return;
    switchedChannel.current = false;
    identifierRef.current?.focus();
  }, [channel]);

  // Every user navigation bumps this generation so an in-flight request that
  // settles late can never yank the screen into a stale phase. Submits bump it
  // too, so a fresh attempt orphans any older one.
  const genRef = useRef(0);
  const invalidate = () => {
    genRef.current += 1;
    setBusy(false);
  };

  const identifier = () => (channel === 'phone' ? normalizePhone(phone) : validEmail(email) ? email.trim() : null);
  const clear = () => {
    setError(null);
    setNotice(null);
  };
  const done = async () => {
    leaveDemo();
    await setMode('patient');
    router.replace('/today');
  };

  const backToSignIn = () => {
    invalidate();
    clear();
    setCode('');
    setPassword('');
    setConfirm('');
    setPhase('login');
  };

  const goBack = () => {
    Haptics.selectionAsync();
    invalidate();
    clear();
    if (phase === 'mfa') {
      setCode('');
      setPhase('login');
      return;
    }
    if (phase === 'recovery-code') {
      setCode('');
      setPhase('recovery-identify');
      return;
    }
    if (phase === 'recovery-identify' || phase === 'recovery-password') {
      backToSignIn();
      return;
    }
    router.back();
  };

  const switchChannel = () => {
    invalidate();
    switchedChannel.current = true;
    setChannel(channel === 'phone' ? 'email' : 'phone');
  };

  const setFormattedPhone = (value: string) => {
    setPhone(formatUsPhoneInput(value));
  };

  const startRecoveryFlow = () => {
    invalidate();
    clear();
    setPhase('recovery-identify');
  };

  const request = async (recovery = false) => {
    const value = identifier();
    clear();
    if (!value) {
      setError(channel === 'phone' ? 'Enter your cell phone number.' : 'Enter the email on your account.');
      return;
    }
    if (!recovery && !password) {
      setError('Enter your password.');
      return;
    }
    const submittedPassword = password;
    const gen = ++genRef.current;
    setBusy(true);
    try {
      const result = recovery
        ? await startRecovery(value)
        : await requestPatientPasswordLogin({ identifier: value, password: submittedPassword });
      if (genRef.current !== gen) return;
      if (!result.ok) {
        setError(result.error);
        if (result.code === 'PASSWORD_RESET_REQUIRED') setPhase('recovery-identify');
        return;
      }
      if (!recovery) setPassword('');
      setRequestId(result.requestId);
      setDevCode(result.devCode);
      setNotice(result.message);
      setCode('');
      setPhase(recovery ? 'recovery-code' : 'mfa');
    } finally {
      if (genRef.current === gen) setBusy(false);
    }
  };

  const verify = async () => {
    if (!requestId || code.length !== 6) {
      setError('Enter the 6-digit verification code.');
      return;
    }
    clear();
    const gen = ++genRef.current;
    setBusy(true);
    try {
      if (phase === 'mfa') {
        const result = await verifyLoginCode({ requestId, code });
        if (genRef.current !== gen) return;
        if (!result.ok) {
          setError(result.error);
          if (result.code === 'PASSWORD_RESET_REQUIRED') setPhase('recovery-identify');
          return;
        }
        const sessionError = await signInWithTokenHash(result.tokenHash);
        if (genRef.current !== gen) return;
        if (sessionError) setError(sessionError);
        else {
          if (result.signInId) void attachSignIn(result.signInId).catch(cause => console.warn('Could not attach sign-in ledger row:', cause));
          await done();
        }
      } else {
        const result = await verifyRecovery({ requestId, code });
        if (genRef.current !== gen) return;
        if (!result.ok) setError(result.error);
        else {
          setResetToken(result.resetToken);
          setCode('');
          setPhase('recovery-password');
        }
      }
    } finally {
      if (genRef.current === gen) setBusy(false);
    }
  };

  const resetPassword = async () => {
    if (!resetToken || !password) {
      setError('Enter a new password.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    const submittedPassword = password;
    setPassword('');
    setConfirm('');
    const gen = ++genRef.current;
    setBusy(true);
    clear();
    try {
      const result = await completeRecovery({ resetToken, password: submittedPassword });
      if (genRef.current !== gen) return;
      if (!result.ok) setError(result.error);
      else {
        setNotice('Password updated. You can sign in now.');
        setPhase('login');
      }
    } finally {
      if (genRef.current === gen) setBusy(false);
    }
  };

  const openSignup = () => {
    invalidate();
    router.push('/patient-signup');
  };
  const openDemo = async () => {
    invalidate();
    await admitDemo();
    router.push('/patient-entry');
  };
  const openProviderLogin = () => {
    invalidate();
    router.push('/provider-login');
  };

  return {
    channel,
    phase,
    phone,
    email,
    password,
    confirm,
    code,
    devCode,
    notice,
    error,
    busy,
    identifierRef,
    setPhone: setFormattedPhone,
    setEmail,
    setPassword,
    setConfirm,
    setCode,
    goBack,
    backToSignIn,
    switchChannel,
    startRecoveryFlow,
    request,
    verify,
    resetPassword,
    openSignup,
    openDemo,
    openProviderLogin,
  };
}
