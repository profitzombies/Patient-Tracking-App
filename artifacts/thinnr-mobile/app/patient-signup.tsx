/**
 * Patient signup — pure view over usePatientSignup. Flows: invited (details
 * already on file) or new (provider code from the welcome packet). Phases:
 * choose → contact → code → details.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { AuthPageFrame } from '@/components/auth/AuthPageFrame';
import {
  ActionGroup,
  FeedbackSlot,
  Field,
  FieldStack,
  FooterLink,
  FormCard,
  OptionCard,
} from '@/components/auth/AuthPrimitives';
import { CodeInput, LedgerInput, NoteText, PrimaryButton } from '@/components/onboarding/OnboardingFields';
import { usePatientSignup } from '@/hooks/usePatientSignup';
import { supabaseConfigured } from '@/lib/supabase';
import { space } from '@/constants/spacing';

export default function PatientSignupScreen() {
  const signup = usePatientSignup();
  const { phase, flow, busy } = signup;
  const invited = flow === 'invited';

  const heading =
    phase === 'choose'
      ? { title: 'How are you joining?', subtitle: 'If your med spa invited you, your details are already on file. Brand new? You’ll enter the provider code from your welcome packet.' }
      : phase === 'contact'
        ? invited
          ? { title: 'Your invitation details', subtitle: 'Enter the phone number or email your med spa used to invite you.' }
          : { title: 'Tell us how to reach you', subtitle: 'We’ll send a 6-digit code to confirm it’s really you.' }
        : phase === 'code'
          ? { title: 'Verify your contact', subtitle: 'Enter the 6-digit code we sent to confirm it’s really you.' }
          : { title: 'Secure your account', subtitle: 'Choose a password with at least 8 characters.' };

  const feedback = (
    <FeedbackSlot
      devCode={signup.devCode}
      devCodeTestID="signup-devcode"
      notice={signup.notice}
      error={signup.error}
      errorTestID="signup-error"
    />
  );

  return (
    <AuthPageFrame
      testID="patient-signup"
      onBack={signup.goBack}
      backTestID="signup-back"
      kicker="CREATE YOUR ACCOUNT"
      title={heading.title}
      subtitle={heading.subtitle}
      footer={
        phase === 'choose' || phase === 'contact' ? (
          <FooterLink testID="signup-login" label="Already have an account? Log in" onPress={signup.openLogin} />
        ) : null
      }
    >
      {phase === 'choose' ? (
        <View style={styles.options}>
          <OptionCard
            testID="signup-invited"
            icon="mail"
            title="I have an invitation"
            body="My med spa already set me up."
            onPress={() => signup.choose('invited')}
          />
          <OptionCard
            testID="signup-new"
            icon="user-plus"
            title="I’m new to THINNR"
            body="I have a provider code from my welcome packet."
            onPress={() => signup.choose('new')}
          />
          {feedback}
        </View>
      ) : null}

      {phase === 'contact' ? (
        <FormCard>
          <FieldStack>
            <Field label={invited ? 'Invited phone number' : 'Cell phone number'}>
              <LedgerInput
                testID="signup-phone"
                accessibilityLabel={invited ? 'Invited phone number' : 'Cell phone number'}
                value={signup.phone}
                onChangeText={signup.setPhone}
                keyboardType="phone-pad"
                textContentType="telephoneNumber"
                autoComplete="tel"
                placeholder={invited ? 'Cell number from your invitation' : 'Your cell number'}
              />
            </Field>
            <Field label={invited ? 'Or invited email address' : 'Email address'}>
              <LedgerInput
                testID="signup-email"
                accessibilityLabel={invited ? 'Invited email address' : 'Email address'}
                value={signup.email}
                onChangeText={signup.setEmail}
                keyboardType="email-address"
                autoComplete="email"
                textContentType="emailAddress"
                autoCapitalize="none"
                placeholder="you@example.com"
              />
            </Field>
            {!invited ? (
              <Field
                label="Provider code"
                hint={<NoteText text="It’s the 6-digit code in your welcome packet. Can’t find it? Ask your med spa." />}
              >
                <LedgerInput
                  testID="signup-provider-code"
                  accessibilityLabel="Provider code"
                  value={signup.providerCode}
                  onChangeText={signup.setProviderCode}
                  keyboardType="number-pad"
                  maxLength={6}
                  placeholder="6-digit code"
                />
              </Field>
            ) : null}
          </FieldStack>
          <ActionGroup>
            <PrimaryButton
              testID="signup-send"
              label={busy ? 'Sending…' : 'Send verification code'}
              onPress={signup.start}
              disabled={busy || !supabaseConfigured}
            />
          </ActionGroup>
          {feedback}
        </FormCard>
      ) : null}

      {phase === 'code' ? (
        <FormCard>
          <FieldStack>
            <Field label="Verification code">
              <CodeInput testID="signup-otp" value={signup.otp} onChangeText={signup.setOtp} />
            </Field>
          </FieldStack>
          <ActionGroup>
            <PrimaryButton testID="signup-verify" label={busy ? 'Verifying…' : 'Verify'} onPress={signup.verify} disabled={busy} />
          </ActionGroup>
          {feedback}
        </FormCard>
      ) : null}

      {phase === 'details' ? (
        <FormCard>
          <FieldStack>
            <Field label="Password">
              <LedgerInput
                testID="signup-password"
                accessibilityLabel="Create password"
                value={signup.password}
                onChangeText={signup.setPassword}
                secureTextEntry
                autoComplete="new-password"
                textContentType="newPassword"
                placeholder="At least 8 characters"
              />
            </Field>
            <Field label="Name (optional)">
              <LedgerInput
                testID="signup-name"
                accessibilityLabel="Name"
                value={signup.name}
                onChangeText={signup.setName}
                autoComplete="name"
                textContentType="name"
                placeholder="Your name"
              />
            </Field>
          </FieldStack>
          <ActionGroup>
            <PrimaryButton testID="signup-complete" label={busy ? 'Creating…' : 'Create account'} onPress={signup.finish} disabled={busy} />
          </ActionGroup>
          {feedback}
        </FormCard>
      ) : null}
    </AuthPageFrame>
  );
}

const styles = StyleSheet.create({
  options: { gap: space.md },
});
