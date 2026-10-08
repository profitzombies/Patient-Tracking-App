/**
 * Patient signup state machine — invited vs new flows across the choose →
 * contact → code → name → password phases. The screen is a pure view over
 * this hook.
 */
import { useMemo, useRef, useState } from 'react';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useAppMode } from '@/context/AppModeContext';
import { completeSignup, signInWithTokenHash, startSignup, verifySignupCode } from '@/lib/auth-api';
import { normalizePhone } from '@/lib/supabase';
import { formatUsPhoneInput } from '@/lib/office-roster-api';
import { passwordChecks, passwordMeetsRules } from '@/lib/password-rules';
import { attachSignIn } from '@/lib/security-api';
import { clearSignupSeed, setSignupSeed } from '@/lib/signup-seed';
import type { PrivacyState } from '@/lib/patient-privacy';

/** The steps after "Create account", in the order the patient sees them. */
export type SignupFinishStage = 'creating' | 'signing-in' | 'opening';

export const SIGNUP_FINISH_LABELS: Record<SignupFinishStage, string> = {
  creating: 'Creating your account…',
  'signing-in': 'Signing you in…',
  opening: 'Opening your account…',
};

export type SignupFlow = 'invited' | 'new';
export type SignupPhase = 'choose' | 'contact' | 'code' | 'name' | 'password';

const emailOK = (x: string) => /^\S+@\S+\.\S+$/.test(x.trim());

export function usePatientSignup() {
  const { setMode } = useAppMode();
  const [flow, setFlow] = useState<SignupFlow>('invited');
  const [phase, setPhase] = useState<SignupPhase>('choose');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [providerCode, setProviderCode] = useState('');
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [signupToken, setSignupToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Which part of account creation is running, so the wait after "Create
  // account" (request, sign-in, opening consent) never looks frozen.
  const [finishStage, setFinishStage] = useState<SignupFinishStage | null>(null);

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
    setFinishStage(null);
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
    if (phase === 'password') {
      // Back to the name step; what was typed stays put.
      setPhase('name');
      return;
    }
    if (phase === 'name') {
      setPassword('');
      setPasswordConfirm('');
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
        // Invited patients confirm (or edit) the name their office entered;
        // brand-new patients start blank.
        setFirstName(flow === 'invited' ? (r.invitedName?.firstName ?? '') : '');
        setLastName(flow === 'invited' ? (r.invitedName?.lastName ?? '') : '');
        setPhase('name');
      }
    } finally {
      if (genRef.current === gen) setBusy(false);
    }
  };

  const nameReady = firstName.trim().length > 0 && lastName.trim().length > 0;
  const checks = useMemo(() => passwordChecks(password), [password]);
  const passwordReady = passwordMeetsRules(password);
  const passwordsMatch = passwordConfirm.length > 0 && passwordConfirm === password;
  const canFinish = passwordReady && passwordsMatch;

  const continueToPassword = () => {
    if (!firstName.trim()) {
      setError('Enter your first name.');
      return;
    }
    if (!lastName.trim()) {
      setError('Enter your last name.');
      return;
    }
    clear();
    setPhase('password');
  };

  const finish = async () => {
    if (!signupToken) {
      setError('Your verification expired. Go back and request a fresh code.');
      return;
    }
    if (!nameReady) {
      setError('Enter your first and last name.');
      setPhase('name');
      return;
    }
    if (!passwordReady) {
      setError('Choose a password that meets every rule below.');
      return;
    }
    if (!passwordsMatch) {
      setError('The two passwords don’t match yet.');
      return;
    }
    const gen = ++genRef.current;
    setBusy(true);
    setFinishStage('creating');
    setError(null);
    let leaving = false;
    try {
      // Entered values stay in place: a refused password or a server hiccup
      // leaves the patient on the right step with nothing to retype.
      const r = await completeSignup({
        signupToken,
        password,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: emailOK(email) ? email.trim() : undefined,
      });
      if (genRef.current !== gen) return;
      if (!r.ok) {
        setError(r.error);
        if (r.field === 'firstName' || r.field === 'lastName' || r.field === 'name') setPhase('name');
        return;
      }
      setFinishStage('signing-in');
      // What the server just told us about the new account lets the app
      // open consent as soon as the session lands, without waiting on the
      // account lookup and full hydration. Set before the session exists so
      // the first account resolution already sees it.
      const seeded = r.patientId !== null && r.privacy !== null && !r.privacy.consent.satisfied;
      if (seeded) setSignupSeed({ patientId: r.patientId as string, privacy: r.privacy as PrivacyState });
      else clearSignupSeed();
      const se = await signInWithTokenHash(r.tokenHash);
      if (genRef.current !== gen) return;
      if (se) {
        clearSignupSeed();
        setError(se);
      } else {
        setFinishStage('opening');
        if (r.signInId) void attachSignIn(r.signInId).catch(cause => console.warn('Could not attach sign-in ledger row:', cause));
        await setMode('patient');
        if (genRef.current !== gen) return;
        // A new account has no consent on record, so it goes straight to the
        // consent page. Without the server's snapshot, Today's entry gate
        // routes it there once hydration confirms the same.
        leaving = true;
        router.replace(seeded ? '/consent' : '/today');
      }
    } finally {
      // Leaving keeps the progress on screen through the navigation.
      if (genRef.current === gen && !leaving) {
        setBusy(false);
        setFinishStage(null);
      }
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
    passwordConfirm,
    firstName,
    lastName,
    nameReady,
    checks,
    passwordsMatch,
    canFinish,
    error,
    notice,
    devCode,
    busy,
    finishStage,
    setPhone: (value: string) => setPhone(formatUsPhoneInput(value)),
    setEmail,
    setProviderCode,
    setOtp,
    setPassword,
    setPasswordConfirm,
    setFirstName,
    setLastName,
    goBack,
    choose,
    start,
    verify,
    continueToPassword,
    finish,
    openLogin,
  };
}
