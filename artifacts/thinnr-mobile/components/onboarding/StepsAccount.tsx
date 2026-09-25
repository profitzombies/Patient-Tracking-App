/**
 * Simulated onboarding — account steps: welcome, contact method,
 * verification code, provider code, Face ID (simulated), password.
 */
import React, { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { OrdinaryTextInput as TextInput } from '@/components/ui/OrdinaryTextInput';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { LedgerCard, PillSelector } from '@/components/ui/LedgerPrimitives';
import { useOnboarding, useOnboardingFlow } from '@/context/OnboardingContext';
import { usePatient } from '@/context/PatientContext';
import { usePatientAccount } from '@/context/PatientAccountContext';
import { useDeviceFeatures } from '@/context/DeviceFeaturesContext';
import {
  allPasswordChecksPass,
  canonicalContact,
  contactsMatch,
  formatPhoneNumber,
  isBlockedPassword,
  isValidContact,
  maskContact,
  MOCK_PROVIDER_CODE,
  MOCK_VERIFICATION_CODE,
  passwordChecks,
  usNationalDigits,
  VALUE_PROPS,
  type ContactMethod,
} from '@/data/onboarding-data';
import { OnboardingFrame } from './OnboardingFrame';
import {
  ErrorBox,
  FieldLabel,
  GhostButton,
  InfoCard,
  LedgerInput,
  NoteText,
  PrimaryButton,
  RequirementRow,
} from './OnboardingFields';

// ─── Welcome / value props ───────────────────────────────────────────────────

export function WelcomeStep() {
  const colors = useColors();
  const { begun, reset } = useOnboarding();

  // Deep links straight to /onboarding/welcome still get a fresh run.
  useEffect(() => {
    if (!begun) reset();
  }, [begun, reset]);

  return (
    <OnboardingFrame
      stepKey="welcome"
      title="Welcome to THINNR"
      coach="Hi, I'm Coach Sarah. I'll walk you through setup — it only takes a few minutes."
      nextLabel="Get started"
    >
      <LedgerCard style={styles.propsCard}>
        {VALUE_PROPS.map(prop => (
          <View key={prop} style={styles.propRow}>
            <Feather name="check-square" size={15} color={colors.cobalt} />
            <Text style={[styles.propText, { color: colors.bodyText }]}>{prop}</Text>
          </View>
        ))}
      </LedgerCard>
      <NoteText text="By continuing, you agree to the demo Terms of Service and Privacy Policy. Synthetic data only — not medical advice." />
    </OnboardingFrame>
  );
}

// ─── Live account identity ────────────────────────────────────────────────────

/** Replaces a contact's send-code button once it matches what is on file. */
function ConfirmedBadge({ testID, what }: { testID: string; what: string }) {
  const colors = useColors();
  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={`${what} confirmed`}
      style={[
        styles.confirmedBadge,
        { backgroundColor: colors.activeBg, borderColor: colors.activeBorder, borderRadius: colors.radiusSm },
      ]}
    >
      <Feather name="check-circle" size={14} color={colors.activeGreen} />
      <Text style={[styles.confirmedText, { color: colors.activeGreen }]}>Confirmed</Text>
    </View>
  );
}

/** Real-only canonical identity step. The demo keeps its original contact flow. */
export function IdentityStep() {
  const { answers, patch } = useOnboarding();
  const flow = useOnboardingFlow('identity');
  const patient = usePatient();
  const { account } = usePatientAccount();
  const [request, setRequest] = useState<{ kind: ContactMethod; id: string } | null>(null);
  const [code, setCode] = useState('');
  const [contactError, setContactError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const nameValid = answers.name.trim().split(/\s+/).filter(Boolean).length >= 2;
  const emailValid = isValidContact('email', answers.email);
  const phoneValid = isValidContact('phone', answers.phone);
  // Compare in one canonical form so formatting (+1, dashes, case, spaces)
  // never makes an on-file detail look changed.
  const emailConfirmed = emailValid && contactsMatch('email', answers.email, patient.profile?.email);
  const phoneConfirmed = phoneValid && contactsMatch('phone', answers.phone, patient.profile?.phone);
  const valid = nameValid && emailValid && phoneValid && emailConfirmed && phoneConfirmed;
  // Name the first field that actually blocks Next — never a blanket hint.
  const blockedHint = !nameValid
    ? 'Enter your first and last name.'
    : !emailValid
      ? 'Enter a valid email address, like you@example.com.'
      : !phoneValid
        ? 'Enter a complete phone number, like (555) 123-4567.'
        : !emailConfirmed
          ? 'Your email is new — tap “Send email code” and confirm it to continue.'
          : !phoneConfirmed
            ? 'Your phone number is new — tap “Send text code” and confirm it to continue.'
            : null;

  const sendCode = async (kind: ContactMethod) => {
    if (account.kind !== 'real') return;
    const value = canonicalContact(kind, kind === 'email' ? answers.email : answers.phone);
    setBusy(true);
    setContactError(null);
    try {
      const sent = await account.api.requestProfileVerification({ kind, value });
      setRequest({ kind, id: sent.requestId });
      setCode(sent.devCode ?? '');
    } catch (cause) {
      setContactError(cause instanceof Error ? cause.message : 'Couldn’t send a code.');
    } finally {
      setBusy(false);
    }
  };

  const confirmCode = async () => {
    if (account.kind !== 'real' || !request) return;
    setBusy(true);
    setContactError(null);
    try {
      const result = await account.api.verifyProfileContact({ requestId: request.id, code });
      patient.applyProfile(result.profile);
      setRequest(null);
      setCode('');
    } catch (cause) {
      setContactError(cause instanceof Error ? cause.message : 'That code couldn’t be verified.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <OnboardingFrame
      stepKey="identity"
      title="Tell us about you"
      coach="Confirm the details your care team will use to identify and reach you."
      hideNext
    >
      <FieldLabel text="Full name" />
      <LedgerInput
        testID="ob-name-input"
        value={answers.name}
        onChangeText={name => patch({ name })}
        placeholder="First and last name"
        autoCapitalize="words"
        autoComplete="name"
        autoFocus
        returnKeyType="next"
      />
      <View style={styles.blockGapTop}>
        <FieldLabel text="Email address" />
        <LedgerInput
          testID="ob-email-input"
          value={answers.email}
          onChangeText={email => patch({ email })}
          placeholder="you@example.com"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          returnKeyType="next"
        />
        {emailConfirmed ? (
          <ConfirmedBadge testID="ob-email-confirmed" what="Email" />
        ) : emailValid ? (
          <PrimaryButton
            testID="ob-verify-email"
            label="Send email code"
            disabled={busy}
            onPress={() => sendCode('email')}
            style={styles.smallButtonGap}
          />
        ) : null}
      </View>
      <View style={styles.blockGapTop}>
        <FieldLabel text="Phone number" />
        <LedgerInput
          testID="ob-phone-input"
          value={answers.phone}
          onChangeText={phone => patch({ phone: formatPhoneNumber(usNationalDigits(phone)) })}
          placeholder="(555) 123-4567"
          keyboardType="phone-pad"
          autoComplete="tel"
        />
        {phoneConfirmed ? (
          <ConfirmedBadge testID="ob-phone-confirmed" what="Phone number" />
        ) : phoneValid ? (
          <PrimaryButton
            testID="ob-verify-phone"
            label="Send text code"
            disabled={busy}
            onPress={() => sendCode('phone')}
            style={styles.smallButtonGap}
          />
        ) : null}
      </View>
      {request ? (
        <View style={styles.blockGapTop}>
          <FieldLabel text={`Verification code sent by ${request.kind === 'phone' ? 'text' : 'email'}`} />
          <LedgerInput
            testID="ob-profile-code"
            value={code}
            onChangeText={v => setCode(v.replace(/\D/g, '').slice(0, 6))}
            keyboardType="number-pad"
            maxLength={6}
            autoFocus
            style={styles.codeInput}
          />
          <PrimaryButton
            testID="ob-confirm-profile-code"
            label={busy ? 'Verifying…' : 'Confirm code'}
            disabled={busy || code.length !== 6}
            onPress={confirmCode}
            style={styles.smallButtonGap}
          />
        </View>
      ) : null}
      {contactError ? (
        <View style={styles.blockGapTop}>
          <ErrorBox message={contactError} />
        </View>
      ) : null}
      {showHint && blockedHint ? (
        <View style={styles.blockGapTop}>
          <ErrorBox testID="ob-identity-hint" message={blockedHint} />
        </View>
      ) : null}
      <View style={styles.blockGapTop}>
        <NoteText text="Your contact details stay private to you and your care team." />
      </View>
      <PrimaryButton
        testID="ob-identity-next"
        label={flow.saving ? 'Saving…' : 'Next'}
        disabled={flow.saving}
        onPress={() => {
          if (!valid) {
            setShowHint(true);
            return;
          }
          void flow.goNext();
        }}
        style={styles.blockGapTop}
      />
    </OnboardingFrame>
  );
}

// ─── Contact method ──────────────────────────────────────────────────────────

export function ContactStep() {
  const { answers, patch } = useOnboarding();
  const valid = isValidContact(answers.contactMethod, answers.contactValue);

  return (
    <OnboardingFrame
      stepKey="contact"
      title="How should we reach you?"
      coach="First things first — where should we send your verification code?"
      nextDisabled={!valid}
      nextBlockedHint={
        answers.contactMethod === 'phone'
          ? 'Enter a complete phone number, like (555) 123-4567, so we can text your code.'
          : 'Enter a valid email address, like you@example.com, so we can send your code.'
      }
    >
      <PillSelector<ContactMethod>
        options={[
          { label: 'MY PHONE NUMBER', value: 'phone' },
          { label: 'MY EMAIL', value: 'email' },
        ]}
        selected={answers.contactMethod}
        onSelect={v => patch({ contactMethod: v })}
        style={styles.blockGap}
      />
      <FieldLabel text={answers.contactMethod === 'phone' ? 'Phone number' : 'Email address'} />
      <LedgerInput
        testID="ob-contact-input"
        value={answers.contactValue}
        onChangeText={v => patch({
          contactValue: answers.contactMethod === 'phone' ? formatPhoneNumber(v) : v,
        })}
        placeholder={answers.contactMethod === 'phone' ? '(555) 123-4567' : 'you@example.com'}
        keyboardType={answers.contactMethod === 'phone' ? 'phone-pad' : 'email-address'}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
      />
      <View style={styles.blockGapTop}>
        <NoteText text="We'll send a 6-digit verification code to confirm it's you." />
      </View>
    </OnboardingFrame>
  );
}

// ─── Verification code ───────────────────────────────────────────────────────

export function VerifyStep() {
  const { answers, patch } = useOnboarding();
  const flow = useOnboardingFlow('verify');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (code === MOCK_VERIFICATION_CODE) {
      patch({ verified: true });
      flow.goNext();
    } else {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError("That code didn't match. For this demo, use 123456.");
    }
  };

  return (
    <OnboardingFrame
      stepKey="verify"
      title="Enter your verification code"
      coach={`I just sent a 6-digit code to ${maskContact(answers.contactMethod, answers.contactValue)}.`}
      nextLabel="Verify"
      nextDisabled={code.length !== 6}
      nextBlockedHint="Enter all 6 digits of your verification code first."
      onNext={submit}
    >
      <LedgerInput
        testID="ob-code-input"
        value={code}
        onChangeText={v => {
          setCode(v.replace(/\D/g, '').slice(0, 6));
          setError(null);
        }}
        keyboardType="number-pad"
        autoFocus
        maxLength={6}
        placeholder="••••••"
        style={styles.codeInput}
      />
      {error ? (
        <View style={styles.blockGapTop}>
          <ErrorBox testID="ob-code-error" message={error} />
        </View>
      ) : null}
      <View style={styles.blockGapTop}>
        <NoteText center text="Demo hint — the code is always 123456." />
      </View>
    </OnboardingFrame>
  );
}

// ─── Provider code ───────────────────────────────────────────────────────────

export function ProviderCodeStep() {
  const { patch } = useOnboarding();
  const flow = useOnboardingFlow('provider-code');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (code === MOCK_PROVIDER_CODE) {
      patch({ providerLinked: true });
      flow.goNext();
    } else {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError("That provider code wasn't recognized. For this demo, use 123456.");
    }
  };

  return (
    <OnboardingFrame
      stepKey="provider-code"
      title="Connect to your provider"
      coach="Verified! Now enter the provider code from your med spa so your plan reaches the right care team."
      nextLabel="Link provider"
      nextDisabled={code.length !== 6}
      nextBlockedHint="Enter the 6-digit provider code from your care team first."
      onNext={submit}
    >
      <FieldLabel text="Provider code" />
      <LedgerInput
        testID="ob-provider-input"
        value={code}
        onChangeText={v => {
          setCode(v.replace(/\D/g, '').slice(0, 6));
          setError(null);
        }}
        keyboardType="number-pad"
        autoFocus
        maxLength={6}
        placeholder="••••••"
        style={styles.codeInput}
      />
      {error ? (
        <View style={styles.blockGapTop}>
          <ErrorBox testID="ob-provider-error" message={error} />
        </View>
      ) : null}
      <View style={styles.blockGapTop}>
        <InfoCard
          label="Where can I find my code?"
          body="Your care team shares a provider code when you enroll — on your welcome packet or from your coordinator. Demo code: 123456."
        />
      </View>
    </OnboardingFrame>
  );
}

// ─── Device biometrics ────────────────────────────────────────────────────────

export function FaceIdStep() {
  const colors = useColors();
  const { patch } = useOnboarding();
  const flow = useOnboardingFlow('face-id');
  const device = useDeviceFeatures();
  const unavailable = device.biometric === 'web' || device.biometric === 'expo-go' || device.biometric === 'unsupported';
  const availabilityMessage =
    device.biometric === 'web' ? 'Biometrics are unavailable on web.' :
    device.biometric === 'expo-go' ? 'Biometric unlock on iPhone requires a development or production build and is unavailable in Expo Go.' :
    device.biometric === 'unsupported' ? 'This device has no supported enrolled biometric. Check Face ID, Touch ID, or biometric setup in system Settings.' :
    'You must first enroll biometrics in your device settings.';

  const choose = (faceId: 'enabled' | 'skipped') => {
    patch({ faceId });
    flow.goNext();
  };

  return (
    <OnboardingFrame
      stepKey="face-id"
      title="Sign in faster with Face ID"
      coach="You're connected to your care team. Let's secure your account."
      hideNext
    >
      <View style={[styles.faceIcon, { backgroundColor: colors.accent }]}>
        <Feather name="smile" size={26} color={colors.cobalt} />
      </View>
      <Text style={[styles.faceBody, { color: colors.bodyText }]}>
        Use enrolled device biometrics as a convenient local app unlock. Your server session,
        password, and any two-factor checks remain required.
      </Text>
      <PrimaryButton
        testID="ob-face-enable"
        label={device.busy ? 'Checking device…' : 'Enable device biometrics'}
        disabled={device.busy || unavailable}
        onPress={() => void device.enableBiometrics().then(ok => { if (ok) choose('enabled'); })}
        style={styles.blockGap}
      />
      <GhostButton testID="ob-face-skip" label="Skip for now" onPress={() => choose('skipped')} />
      <View style={styles.blockGapTop}>
        <NoteText center text={device.message ?? availabilityMessage} />
      </View>
    </OnboardingFrame>
  );
}

// ─── Password ────────────────────────────────────────────────────────────────

/**
 * Web-only <form> wrapper so Chrome doesn't log "[DOM] Password field is not
 * contained in a form" for the bare password inputs (mirrors SignInFormWrap in
 * app/patient-entry.tsx). Native renders children untouched.
 */
function PasswordFormWrap({ children }: { children: React.ReactNode }) {
  if (Platform.OS !== 'web') return <>{children}</>;
  return (
    <form style={{ display: 'contents' }} onSubmit={event => event.preventDefault()}>
      {children}
    </form>
  );
}

function SecureInput({
  value,
  onChangeText,
  placeholder,
  testID,
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  testID: string;
}) {
  const colors = useColors();
  const [visible, setVisible] = useState(false);
  const [focused, setFocused] = useState(false);
  return (
    <View
      style={[
        styles.secureWrap,
        { borderColor: focused ? colors.cobalt : colors.border, backgroundColor: colors.card, borderRadius: colors.radiusSm },
      ]}
    >
      <TextInput
        testID={testID}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.subtleText}
        secureTextEntry={!visible}
        autoCapitalize="none"
        autoCorrect={false}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        // The wrap paints the focus border; the browser's own outline would
        // slice between the input and the eye toggle.
        style={[styles.secureInput, { color: colors.navy }, Platform.OS === 'web' && ({ outlineStyle: 'none' } as any)]}
      />
      <Pressable
        testID={`${testID}-toggle`}
        onPress={() => setVisible(v => !v)}
        style={({ pressed }) => [styles.eyeBtn, pressed && { opacity: 0.6 }]}
      >
        <Feather name={visible ? 'eye-off' : 'eye'} size={16} color={colors.subtleText} />
      </Pressable>
    </View>
  );
}

export function PasswordStep() {
  const flow = useOnboardingFlow('password');
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');

  const checks = passwordChecks(pw);
  const basePass = allPasswordChecksPass(pw);
  const blocked = basePass && isBlockedPassword(pw);
  const match = confirm.length > 0 && pw === confirm;
  const canNext = basePass && match && !blocked;

  let blockedHint: string;
  if (!basePass) {
    blockedHint = "Your password doesn't meet all the requirements below yet.";
  } else if (blocked) {
    blockedHint = "That password can't be used — try something more unique.";
  } else if (confirm.length === 0) {
    blockedHint = 'Re-enter your password in the confirm field.';
  } else {
    blockedHint = "The two passwords don't match yet.";
  }

  return (
    <OnboardingFrame
      stepKey="password"
      title="Create your password"
      coach="Pick something memorable — you can always use Face ID after this."
      nextDisabled={!canNext}
      nextBlockedHint={blockedHint}
      onNext={() => {
        flow.goNext();
      }}
    >
      <PasswordFormWrap>
        <FieldLabel text="Password" />
        <SecureInput testID="ob-password" value={pw} onChangeText={setPw} placeholder="Enter password" />
        <View style={styles.confirmGap}>
          <FieldLabel text="Confirm password" />
          <SecureInput
            testID="ob-password-confirm"
            value={confirm}
            onChangeText={setConfirm}
            placeholder="Re-enter password"
          />
        </View>
      </PasswordFormWrap>
      {blocked ? (
        <View style={styles.blockGapTop}>
          <ErrorBox
            testID="ob-password-blocked"
            message="For security reasons, that password can't be used. Try something more unique."
          />
        </View>
      ) : null}
      <View style={styles.reqList}>
        <RequirementRow met={checks.length} label="At least 8 characters" />
        <RequirementRow met={checks.upper} label="An uppercase letter" />
        <RequirementRow met={checks.lower} label="A lowercase letter" />
        <RequirementRow met={checks.symbol} label="A symbol (like ! or #)" />
        <RequirementRow met={match} label="Passwords match" />
      </View>
    </OnboardingFrame>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  propsCard: {
    padding: 16,
    gap: 12,
    marginBottom: 14,
  },
  propRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  propText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    fontFamily: 'Inter_500Medium',
  },
  blockGap: {
    marginBottom: 16,
  },
  blockGapTop: {
    marginTop: 16,
  },
  smallButtonGap: {
    marginTop: 8,
  },
  confirmedBadge: {
    marginTop: 8,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  confirmedText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
  codeInput: {
    textAlign: 'center',
    fontSize: 24,
    letterSpacing: 10,
    fontFamily: 'Inter_700Bold',
    paddingVertical: 16,
  },
  faceIcon: {
    width: 52,
    height: 52,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  faceBody: {
    fontSize: 13,
    lineHeight: 19,
    fontFamily: 'Inter_400Regular',
    marginBottom: 20,
  },
  secureWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
  },
  secureInput: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: 'Inter_500Medium',
  },
  eyeBtn: {
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  confirmGap: {
    marginTop: 14,
  },
  reqList: {
    marginTop: 16,
  },
});
