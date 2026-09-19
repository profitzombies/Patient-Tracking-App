/**
 * Provider login state — the staff door inside the patient app.
 *
 * Staff accounts (provider offices and HQ) are keyed on work email, never
 * phone — so a provider's personal cell stays free for their own patient
 * account. Same passwordless shape as the operations web app: email in, a
 * 6-digit code back, and a real session that flips the app into staff mode.
 */
import { useRef, useState } from 'react';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useAppMode } from '@/context/AppModeContext';
import {
  requestStaffLoginCode,
  signInWithTokenHash,
  startStaffPhoneStep,
  verifyLoginCode,
  verifyStaffPhoneCode,
} from '@/lib/auth-api';
import { supabaseConfigured } from '@/lib/supabase';
import { attachSignIn } from '@/lib/security-api';

export type ProviderLoginPhase = 'email' | 'code' | 'phone' | 'sms';

export function useProviderLogin() {
  const { setMode } = useAppMode();
  const [phase, setPhase] = useState<ProviderLoginPhase>('email');
  const generationRef = useRef(0);
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [pendingEmail, setPendingEmail] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [smsCode, setSmsCode] = useState('');
  const [stepToken, setStepToken] = useState<string | null>(null);
  const [smsRequestId, setSmsRequestId] = useState<string | null>(null);
  const [destination, setDestination] = useState<string | null>(null);
  const [smsDevCode, setSmsDevCode] = useState<string | null>(null);
  const [phoneStepMode, setPhoneStepMode] = useState<'sms' | 'enroll' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const changePhase = (next: ProviderLoginPhase) => {
    generationRef.current += 1;
    setPhase(next);
  };

  const expireStep = () => {
    setBusy(false);
    changePhase('email');
    setRequestId(null);
    setStepToken(null);
    setSmsRequestId(null);
    setOtp('');
    setSmsCode('');
    setError(null);
    setNotice('That sign-in step expired. Start again with your email.');
  };

  const sendCode = async (address: string, generation: number) => {
    const result = await requestStaffLoginCode(address);
    if (generation !== generationRef.current) return false;
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
    const generation = generationRef.current;
    try {
      if (await sendCode(trimmed, generation) && generation === generationRef.current) {
        setOtp('');
        setBusy(false);
        changePhase('code');
      }
    } finally {
      if (generation === generationRef.current) setBusy(false);
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
    const generation = generationRef.current;
    try {
      const result = await verifyLoginCode({ requestId, code: otp.trim() });
      if (generation !== generationRef.current) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if ('secondFactor' in result) {
        setStepToken(result.secondFactor.stepToken);
        setPhoneStepMode(result.secondFactor.mode);
        setDestination(result.secondFactor.destination);
        setSmsCode('');
        setSmsDevCode(null);
        if (result.secondFactor.mode === 'enroll') {
          setPhone('');
          setBusy(false);
          changePhase('phone');
          return;
        }
        setBusy(true);
        const sendResult = await startStaffPhoneStep({ stepToken: result.secondFactor.stepToken });
        if (generation !== generationRef.current) return;
        if (!sendResult.ok) {
          if (sendResult.expired) expireStep();
          else setError(sendResult.error);
          return;
        }
        setSmsRequestId(sendResult.requestId);
        setDestination(sendResult.destination);
        setSmsDevCode(sendResult.devCode);
        setBusy(false);
        changePhase('sms');
        return;
      }
      const sessionError = await signInWithTokenHash(result.tokenHash);
      if (generation !== generationRef.current) return;
      if (sessionError) {
        setError(sessionError);
        return;
      }
      if (result.signInId) void attachSignIn(result.signInId).catch(cause => console.warn('Could not attach sign-in ledger row:', cause));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await setMode('staff');
      router.replace('/');
    } finally {
      if (generation === generationRef.current) setBusy(false);
    }
  };

  const submitPhone = async () => {
    if (busy || !stepToken) return;
    setError(null);
    const digits = phone.replace(/\D/g, '');
    if (digits.length !== 10) {
      setError('Enter a 10-digit US phone number.');
      return;
    }
    setBusy(true);
    const generation = generationRef.current;
    try {
      const result = await startStaffPhoneStep({ stepToken, phone: `+1${digits}` });
      if (generation !== generationRef.current) return;
      if (!result.ok) {
        if (result.expired) expireStep();
        else setError(result.error);
        return;
      }
      setSmsRequestId(result.requestId);
      setDestination(result.destination);
      setSmsDevCode(result.devCode);
      setSmsCode('');
      setBusy(false);
      changePhase('sms');
    } finally {
      if (generation === generationRef.current) setBusy(false);
    }
  };

  const submitSmsCode = async () => {
    if (busy || !stepToken || !smsRequestId) return;
    setError(null);
    if (smsCode.trim().length < 6) {
      setError('Enter the 6-digit code from the text.');
      return;
    }
    setBusy(true);
    const generation = generationRef.current;
    try {
      const result = await verifyStaffPhoneCode({
        stepToken,
        requestId: smsRequestId,
        code: smsCode.trim(),
      });
      if (generation !== generationRef.current) return;
      if (!result.ok) {
        if (result.expired) expireStep();
        else setError(result.error);
        return;
      }
      const sessionError = await signInWithTokenHash(result.tokenHash);
      if (generation !== generationRef.current) return;
      if (sessionError) {
        setError(sessionError);
        return;
      }
      if (result.signInId) {
        void attachSignIn(result.signInId)
          .catch(cause => console.warn('Could not attach sign-in ledger row:', cause));
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await setMode('staff');
      if (generation !== generationRef.current) return;
      router.replace('/');
    } finally {
      if (generation === generationRef.current) setBusy(false);
    }
  };

  const resendSms = async () => {
    if (busy || !stepToken) return;
    setBusy(true);
    setError(null);
    const generation = generationRef.current;
    try {
      const digits = phone.replace(/\D/g, '');
      const result = await startStaffPhoneStep({
        stepToken,
        ...(phoneStepMode === 'enroll' && digits.length === 10
          ? { phone: `+1${digits}` }
          : {}),
      });
      if (generation !== generationRef.current) return;
      if (!result.ok) {
        if (result.expired) expireStep();
        else setError(result.error);
        return;
      }
      setSmsRequestId(result.requestId);
      setDestination(result.destination);
      setSmsDevCode(result.devCode);
      setSmsCode('');
    } finally {
      if (generation === generationRef.current) setBusy(false);
    }
  };

  const resendCode = async () => {
    if (busy || !pendingEmail) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    const generation = generationRef.current;
    try {
      setOtp('');
      await sendCode(pendingEmail, generation);
    } finally {
      if (generation === generationRef.current) setBusy(false);
    }
  };

  const backToEmail = () => {
    setBusy(false);
    changePhase('email');
    setOtp('');
    setRequestId(null);
    setDevCode(null);
    setError(null);
    setNotice(null);
    setStepToken(null);
    setSmsRequestId(null);
    setSmsCode('');
    setSmsDevCode(null);
    setPhoneStepMode(null);
  };

  const goBack = () => {
    generationRef.current += 1;
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
    phone,
    smsCode,
    destination,
    smsDevCode,
    error,
    notice,
    busy,
    setEmail,
    setOtp: (value: string) => setOtp(value.replace(/\D/g, '')),
    setPhone,
    setSmsCode: (value: string) => setSmsCode(value.replace(/\D/g, '')),
    submitEmail,
    submitOtp,
    submitPhone,
    submitSmsCode,
    resendSms,
    resendCode,
    backToEmail,
    goBack,
    explainNotConfigured,
  };
}
