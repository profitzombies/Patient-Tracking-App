/**
 * Patient signup state machine — invited vs new flows across the choose →
 * contact → code → details phases. The screen is a pure view over this hook.
 */
import { useRef, useState } from 'react';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useAppMode } from '@/context/AppModeContext';
import { completeSignup, signInWithTokenHash, startSignup, verifySignupCode } from '@/lib/auth-api';
import { normalizePhone } from '@/lib/supabase';
import { attachSignIn } from '@/lib/security-api';

export type SignupFlow = 'invited' | 'new';
export type SignupPhase = 'choose' | 'contact' | 'code' | 'details';

const emailOK = (x: string) => /^\S+@\S+\.\S+$/.test(x.trim());

export function usePatientSignup() {
  const { setMode, leaveDemo } = useAppMode();
  const [flow, setFlow] = useState<SignupFlow>('invited');
  const [phase, setPhase] = useState<SignupPhase>('choose');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [providerCode, setProviderCode] = useState('');
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [signupToken, setSignupToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const identifier = () => (emailOK(email) ? email.trim() : normalizePhone(phone));
  const clear = () => {
    setError(null);
    setNotice(null);
  };

  // Every user navigation bumps this generation so an in-flight request that
  // settles late can never yank the screen into a stale phase. Submits bump it
  // too, so a fresh attempt orphans any older one.
  const genRef = useRef(0);
  const invalidate = () => {
    genRef.current += 1;
    setBusy(false);
  };

  const goBack = () => {
    Haptics.selectionAsync();
    invalidate();
    clear();
    if (phase === 'contact') {
      setPhase('choose');
      return;
    }
    if (phase === 'code') {
      setOtp('');
      setPhase('contact');
      return;
    }
    if (phase === 'details') {
      setPassword('');
      setPhase('contact');
      return;
    }
    router.back();
  };

  const choose = (next: SignupFlow) => {
    setFlow(next);
    clear();
    setPhase('contact');
  };

  const start = async () => {
    setError(null);
    const p = normalizePhone(phone);
    const e = email.trim();
    if (flow === 'new' && (!p || !emailOK(e))) {
      setError('Enter both your cell phone number and email address.');
      return;
    }
    const codeDigits = providerCode.trim();
    // An empty code gets a local, friendly nudge; the server's "doesn't match
    // an active office" copy is reserved for codes that were actually typed.
    if (flow === 'new' && !codeDigits) {
      setError('Enter your provider code — it’s the 6-digit code in your welcome packet.');
      return;
    }
    const id = flow === 'invited' ? identifier() : null;
    if (flow === 'invited' && !id) {
      setError('Enter the email or phone number in your invitation.');
      return;
    }
    const gen = ++genRef.current;
    setBusy(true);
    try {
      const r = await startSignup(
        flow === 'invited' ? { flow, identifier: id! } : { flow, phone: p!, email: e, code: codeDigits },
      );
      if (genRef.current !== gen) return;
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setRequestId(r.requestId);
      setDevCode(r.devCode);
      setNotice(r.message);
      setOtp('');
      setPhase('code');
    } finally {
      if (genRef.current === gen) setBusy(false);
    }
  };

  const verify = async () => {
    if (!requestId || otp.length !== 6) {
      setError('Enter the 6-digit verification code.');
      return;
    }
    const gen = ++genRef.current;
    setBusy(true);
    setError(null);
    try {
      const r = await verifySignupCode({ requestId, code: otp });
      if (genRef.current !== gen) return;
      if (!r.ok) setError(r.error);
      else {
        setSignupToken(r.signupToken);
        setPhase('details');
      }
    } finally {
      if (genRef.current === gen) setBusy(false);
    }
  };

  const finish = async () => {
    if (!signupToken || !password) {
      setError('Create a password.');
      return;
    }
    if (password.length < 8) {
      setError('Choose a password with at least 8 characters.');
      return;
    }
    const submittedPassword = password;
    setPassword('');
    const gen = ++genRef.current;
    setBusy(true);
    setError(null);
    try {
      const r = await completeSignup({
        signupToken,
        password: submittedPassword,
        name: name.trim() || undefined,
        email: emailOK(email) ? email.trim() : undefined,
      });
      if (genRef.current !== gen) return;
      if (!r.ok) {
        setError(r.error);
        return;
      }
      const se = await signInWithTokenHash(r.tokenHash);
      if (genRef.current !== gen) return;
      if (se) setError(se);
      else {
        if (r.signInId) void attachSignIn(r.signInId).catch(cause => console.warn('Could not attach sign-in ledger row:', cause));
        leaveDemo();
        await setMode('patient');
        router.replace('/today');
      }
    } finally {
      if (genRef.current === gen) setBusy(false);
    }
  };

  const openLogin = () => {
    invalidate();
    router.push('/patient-login');
  };

  return {
    flow,
    phase,
    phone,
    email,
    providerCode,
    otp,
    password,
    name,
    error,
    notice,
    devCode,
    busy,
    setPhone,
    setEmail,
    setProviderCode,
    setOtp,
    setPassword,
    setName,
    goBack,
    choose,
    start,
    verify,
    finish,
    openLogin,
  };
}
