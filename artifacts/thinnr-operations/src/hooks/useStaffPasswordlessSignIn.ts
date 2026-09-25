/**
 * The passwordless staff sign-in phase machine, shared by the front door and
 * the HQ invitation setup page.
 *
 * Both screens run exactly the same flow — email, one-time code, and the
 * texted-code step where policy requires it — so the phases, the resend
 * behaviour and the expiry handling live here once. Only the surrounding
 * copy differs.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSession } from '@/contexts/session';
import { formatUsPhone, isValidUsPhone, normalizeUsPhone } from '@/lib/us-contact';

export type StaffSignInPhase = 'email' | 'code' | 'phone';

export interface StaffPhoneStep {
  stepToken: string;
  mode: 'sms' | 'enroll';
  destination: string | null;
}

export interface StaffPasswordlessSignIn {
  phase: StaffSignInPhase;
  email: string;
  setEmail: (value: string) => void;
  otp: string;
  setOtp: (value: string) => void;
  phone: string;
  setPhone: (value: string) => void;
  smsCode: string;
  setSmsCode: (value: string) => void;
  smsRequestId: string | null;
  phoneStep: StaffPhoneStep | null;
  pendingEmail: string;
  devCode: string | null;
  error: string | null;
  setError: (value: string | null) => void;
  notice: string | null;
  setNotice: (value: string | null) => void;
  busy: boolean;
  submitEmail: (event: FormEvent) => Promise<void>;
  submitCode: (event: FormEvent) => Promise<void>;
  submitPhone: (event: FormEvent) => Promise<void>;
  resendCode: () => Promise<void>;
  sendPhoneCode: (enteredPhone?: string) => Promise<void>;
  changePhoneNumber: () => void;
  backToEmail: () => void;
  supabaseEnabled: boolean;
}

export function useStaffPasswordlessSignIn(options: {
  /** Pre-filled address; the setup page locks this to the invited email. */
  initialEmail?: string;
  /** When set, "use a different email" is not offered — the invitation owns the address. */
  lockEmail?: boolean;
} = {}): StaffPasswordlessSignIn {
  const {
    requestStaffCode,
    verifyStaffCode,
    startStaffPhoneStep,
    verifyStaffPhoneCode,
    supabaseEnabled,
  } = useSession();

  const [phase, setPhase] = useState<StaffSignInPhase>('email');
  const [email, setEmail] = useState(options.initialEmail ?? '');
  const [otp, setOtp] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [pendingEmail, setPendingEmail] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [phoneStep, setPhoneStep] = useState<StaffPhoneStep | null>(null);
  const [phone, setPhoneValue] = useState('');
  // Sign-in phones are US mobiles: format as (555) 123-4567 while typing, hide
  // a typed "+1", and stop at 10 digits.
  const setPhone = useCallback((value: string) => setPhoneValue(formatUsPhone(value)), []);
  const [smsRequestId, setSmsRequestId] = useState<string | null>(null);
  const [smsCode, setSmsCode] = useState('');
  const [busy, setBusy] = useState(false);

  // The invited address arrives after the token lookup resolves, so adopt it
  // while the form is still untouched at the email step.
  const initialEmail = options.initialEmail;
  useEffect(() => {
    if (initialEmail && phase === 'email' && !email) setEmail(initialEmail);
  }, [initialEmail, phase, email]);

  const sendCode = useCallback(async (address: string) => {
    const result = await requestStaffCode(address);
    if (result.error || !result.requestId) {
      setError(result.error ?? 'Could not send a code right now. Try again in a moment.');
      return false;
    }
    setRequestId(result.requestId);
    setPendingEmail(address);
    setDevCode(result.devCode);
    setNotice(result.message ?? 'If that address has an account, a sign-in code is on its way.');
    return true;
  }, [requestStaffCode]);

  const submitEmail = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !supabaseEnabled) return;
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

  const submitCode = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !requestId) return;
    setError(null);
    if (otp.trim().length < 6) {
      setError('Enter the 6-digit code from the email.');
      return;
    }
    setBusy(true);
    try {
      const result = await verifyStaffCode({ requestId, code: otp.trim() });
      if (result.error) setError(result.error);
      else if (result.secondFactor) {
        setPhoneStep(result.secondFactor);
        setSmsRequestId(null);
        setSmsCode('');
        setDevCode(null);
        setNotice(null);
        setPhase('phone');
      }
      // Success: the session listener re-routes to the right workspace.
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
    setPhoneStep(null);
    setSmsRequestId(null);
    setSmsCode('');
    if (!options.lockEmail) setPhone('');
  };

  const expiredPhoneStep = () => {
    backToEmail();
    setError('That sign-in step expired. Start again with your email.');
  };

  const sendPhoneCode = async (enteredPhone?: string) => {
    if (!phoneStep || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await startStaffPhoneStep({
        stepToken: phoneStep.stepToken,
        // The box shows (555) 123-4567; the wire carries E.164.
        ...(enteredPhone ? { phone: isValidUsPhone(enteredPhone) ? `+1${normalizeUsPhone(enteredPhone)}` : enteredPhone } : {}),
      });
      if (result.code === 'STEP_EXPIRED') {
        expiredPhoneStep();
        return;
      }
      if (result.error || !result.requestId) {
        setError(result.error ?? 'Could not send a text right now. Try again.');
        return;
      }
      setSmsRequestId(result.requestId);
      setDevCode(result.devCode ?? null);
      setPhoneStep({ ...phoneStep, destination: result.destination ?? phoneStep.destination });
      setSmsCode('');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (phase === 'phone' && phoneStep?.mode === 'sms' && !smsRequestId) {
      void sendPhoneCode();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, phoneStep?.mode, phoneStep?.stepToken]);

  const submitPhone = async (event: FormEvent) => {
    event.preventDefault();
    if (!phoneStep) return;
    if (!smsRequestId) {
      const trimmed = phone.trim();
      if (!trimmed) {
        setError('Enter a mobile number.');
        return;
      }
      if (!isValidUsPhone(trimmed)) {
        setError('Enter a 10-digit US mobile number.');
        return;
      }
      await sendPhoneCode(trimmed);
      return;
    }
    if (smsCode.length !== 6) {
      setError('Enter the 6-digit code from the text.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await verifyStaffPhoneCode({
        stepToken: phoneStep.stepToken,
        requestId: smsRequestId,
        code: smsCode,
      });
      if (result.code === 'STEP_EXPIRED') expiredPhoneStep();
      else if (result.error) setError(result.error);
    } finally {
      setBusy(false);
    }
  };

  const changePhoneNumber = () => {
    setSmsRequestId(null);
    setSmsCode('');
    setDevCode(null);
    setError(null);
  };

  return {
    phase, email, setEmail, otp, setOtp, phone, setPhone, smsCode, setSmsCode,
    smsRequestId, phoneStep, pendingEmail, devCode, error, setError, notice, setNotice,
    busy, submitEmail, submitCode, submitPhone, resendCode, sendPhoneCode,
    changePhoneNumber, backToEmail, supabaseEnabled,
  };
}
