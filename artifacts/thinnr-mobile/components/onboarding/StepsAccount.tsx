/**
 * Onboarding — account steps: welcome and identity confirmation. Account
 * creation itself (contact, verification, provider link, password) happens
 * in the signup / claim flows before onboarding starts.
 */
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';
import { useOnboarding, useOnboardingFlow } from '@/context/OnboardingContext';
import { usePatient } from '@/context/PatientContext';
import { usePatientAccount } from '@/context/PatientAccountContext';
import {
  canonicalContact,
  contactsMatch,
  formatPhoneNumber,
  isValidContact,
  usNationalDigits,
  VALUE_PROPS,
  type ContactMethod,
} from '@/data/onboarding-data';
import { OnboardingFrame } from './OnboardingFrame';
import {
  ErrorBox,
  FieldLabel,
  GhostButton,
  LedgerInput,
  NoteText,
  PrimaryButton,
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
      <NoteText text="Your answers set up your program with your care team. Not medical advice." />
    </OnboardingFrame>
  );
}

// ─── Live account identity ────────────────────────────────────────────────────

/** Shown in place of a code action once a contact is proven with a code. */
function VerifiedBadge({ testID, what }: { testID: string; what: string }) {
  const colors = useColors();
  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={`${what} verified`}
      style={[
        styles.confirmedBadge,
        { backgroundColor: colors.activeBg, borderColor: colors.activeBorder, borderRadius: colors.radiusSm },
      ]}
    >
      <Feather name="check-circle" size={14} color={colors.activeGreen} />
      <Text style={[styles.confirmedText, { color: colors.activeGreen }]}>Verified</Text>
    </View>
  );
}

const CONTACT_COPY: Record<ContactMethod, { label: string; action: string; channel: string }> = {
  email: { label: 'Email address', action: 'Send email code', channel: 'email' },
  phone: { label: 'Phone number', action: 'Send text code', channel: 'text' },
};

/**
 * Real-only "Confirm your details" step. The name comes from signup (or the
 * office's invite) and is only re-typed if the patient taps Edit. The contact
 * proven at signup shows as verified from the profile's verified flags; only
 * the other one gets a code — an email code for phone-verified patients, a
 * text code for email-invited ones.
 */
export function IdentityStep() {
  const colors = useColors();
  const { answers, patch } = useOnboarding();
  const flow = useOnboardingFlow('identity');
  const patient = usePatient();
  const profile = patient.profile;
  const { account } = usePatientAccount();
  const [request, setRequest] = useState<{ kind: ContactMethod; id: string } | null>(null);
  const [code, setCode] = useState('');
  const [contactError, setContactError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const nameValid = answers.name.trim().split(/\s+/).filter(Boolean).length >= 2;
  // Only a missing name opens the field on arrival; otherwise it is a summary.
  const [editingName, setEditingName] = useState(() => !nameValid);
  const valueOf = (kind: ContactMethod) => (kind === 'email' ? answers.email : answers.phone);
  const validOf = (kind: ContactMethod) => isValidContact(kind, valueOf(kind));
  // Verified = proven by a code AND still the detail on file. Compared in one
  // canonical form so formatting (+1, dashes, case, spaces) never matters.
  const verifiedOf = (kind: ContactMethod) =>
    (kind === 'email' ? profile?.emailVerified : profile?.phoneVerified) === true &&
    contactsMatch(kind, valueOf(kind), kind === 'email' ? profile?.email : profile?.phone);
  const emailVerified = verifiedOf('email');
  const phoneVerified = verifiedOf('phone');
  const valid = nameValid && emailVerified && phoneVerified;
  // Verified details read first; what is still pending sits by the button.
  const order: ContactMethod[] = emailVerified && !phoneVerified ? ['email', 'phone'] : ['phone', 'email'];

  const pendingHint = (kind: ContactMethod): string => {
    if (!validOf(kind)) {
      return kind === 'email'
        ? 'Enter a valid email address, like you@example.com.'
        : 'Enter a complete phone number, like (555) 123-4567.';
    }
    if (request?.kind === kind) return `Enter the 6-digit code we sent by ${CONTACT_COPY[kind].channel}.`;
    return kind === 'email'
      ? 'Tap “Send email code” and enter the code to verify your email.'
      : 'Tap “Send text code” and enter the code to verify your phone number.';
  };
  const firstPending = order.find(kind => !verifiedOf(kind));
  // Name the one thing that actually blocks Confirm — never a blanket hint.
  const blockedHint = !nameValid
    ? 'Enter your first and last name.'
    : firstPending
      ? pendingHint(firstPending)
      : null;

  const editContact = (kind: ContactMethod, value: string) => {
    if (request?.kind === kind) {
      setRequest(null);
      setCode('');
    }
    setContactError(null);
    patch(kind === 'email' ? { email: value } : { phone: formatPhoneNumber(usNationalDigits(value)) });
  };

  const sendCode = async (kind: ContactMethod) => {
    if (account.kind !== 'real') return;
    const value = canonicalContact(kind, valueOf(kind));
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

  const renderContact = (kind: ContactMethod) => {
    const copy = CONTACT_COPY[kind];
    if (verifiedOf(kind)) {
      return (
        <View key={kind} testID={`ob-${kind}-row`} style={[styles.detailRow, { borderTopColor: colors.border }]}>
          <FieldLabel text={copy.label} />
          <Text testID={`ob-${kind}-value`} style={[styles.detailValue, { color: colors.navy }]}>
            {valueOf(kind)}
          </Text>
          <VerifiedBadge testID={`ob-${kind}-confirmed`} what={kind === 'email' ? 'Email' : 'Phone number'} />
        </View>
      );
    }
    const awaiting = request?.kind === kind;
    return (
      <View key={kind} testID={`ob-${kind}-row`} style={[styles.detailRow, { borderTopColor: colors.border }]}>
        <FieldLabel text={copy.label} />
        {kind === 'email' ? (
          <LedgerInput
            testID="ob-email-input"
            value={answers.email}
            onChangeText={v => editContact('email', v)}
            placeholder="you@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
          />
        ) : (
          <LedgerInput
            testID="ob-phone-input"
            value={answers.phone}
            onChangeText={v => editContact('phone', v)}
            placeholder="(555) 123-4567"
            keyboardType="phone-pad"
            autoComplete="tel"
          />
        )}
        {awaiting ? (
          <View style={styles.smallButtonGap}>
            <FieldLabel text={`Code sent by ${copy.channel}`} />
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
              label={busy ? 'Verifying…' : 'Verify code'}
              disabled={busy || code.length !== 6}
              onPress={confirmCode}
              style={styles.smallButtonGap}
            />
            <GhostButton
              testID={`ob-resend-${kind}`}
              label="Send a new code"
              disabled={busy}
              onPress={() => sendCode(kind)}
              style={styles.smallButtonGap}
            />
          </View>
        ) : (
          <PrimaryButton
            testID={kind === 'email' ? 'ob-verify-email' : 'ob-verify-phone'}
            label={copy.action}
            disabled={busy || !validOf(kind)}
            onDisabledPress={busy ? undefined : () => setShowHint(true)}
            onPress={() => sendCode(kind)}
            style={styles.smallButtonGap}
          />
        )}
      </View>
    );
  };

  return (
    <OnboardingFrame
      stepKey="identity"
      title="Confirm your details"
      coach={
        valid
          ? 'Everything is verified. Tap Confirm to continue.'
          : 'Your care team uses these to identify and reach you. Verify what’s left, then confirm.'
      }
      hideNext
    >
      <LedgerCard testID="ob-identity-card" style={styles.detailCard}>
        <View style={styles.detailFirstRow}>
          <FieldLabel text="Full name" />
          {editingName ? (
            <>
              <LedgerInput
                testID="ob-name-input"
                value={answers.name}
                onChangeText={name => patch({ name })}
                placeholder="First and last name"
                autoCapitalize="words"
                autoComplete="name"
                autoFocus
                returnKeyType="done"
                onSubmitEditing={() => nameValid && setEditingName(false)}
              />
              {nameValid ? (
                <GhostButton
                  testID="ob-name-done"
                  label="Done"
                  onPress={() => setEditingName(false)}
                  style={styles.smallButtonGap}
                />
              ) : null}
            </>
          ) : (
            <View style={styles.nameSummary}>
              <Text testID="ob-name-summary" style={[styles.detailValue, styles.nameText, { color: colors.navy }]}>
                {answers.name.trim()}
              </Text>
              <Pressable
                testID="ob-name-edit"
                accessibilityRole="button"
                accessibilityLabel="Edit your name"
                hitSlop={10}
                onPress={() => setEditingName(true)}
              >
                <Text style={[styles.editLink, { color: colors.cobalt }]}>Edit</Text>
              </Pressable>
            </View>
          )}
        </View>
        {order.map(renderContact)}
      </LedgerCard>
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
        label={flow.saving ? 'Saving…' : 'Confirm'}
        disabled={flow.saving || !valid}
        onDisabledPress={flow.saving ? undefined : () => setShowHint(true)}
        onPress={() => {
          setEditingName(false);
          void flow.goNext();
        }}
        style={styles.blockGapTop}
      />
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
  blockGapTop: {
    marginTop: 16,
  },
  smallButtonGap: {
    marginTop: 8,
  },
  detailCard: {
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  detailFirstRow: {
    paddingTop: 16,
  },
  detailRow: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
  },
  detailValue: {
    fontSize: 16,
    fontFamily: 'Inter_600SemiBold',
  },
  nameSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  nameText: {
    flex: 1,
  },
  editLink: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
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
});
