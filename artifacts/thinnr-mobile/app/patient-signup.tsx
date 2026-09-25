/**
 * Patient signup — pure view over usePatientSignup. Flows: invited (details
 * already on file) or new (provider code from the welcome packet). Phases:
 * choose → contact → code → name → password.
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
  OptionCard,
  PasswordChecklist,
} from '@/components/auth/AuthPrimitives';
import { CodeInput, LedgerInput, NoteText, PasswordInput, PrimaryButton } from '@/components/onboarding/OnboardingFields';
import { PASSWORD_MAX_LENGTH } from '@/lib/password-rules';
import { usePatientSignup } from '@/hooks/usePatientSignup';
import { supabaseConfigured } from '@/lib/supabase';
import { authLayout, space } from '@/constants/spacing';

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
          : phase === 'name'
            ? invited
              ? { title: 'What’s your name?', subtitle: 'This is the name your med spa has on file. Fix anything that isn’t right.' }
              : { title: 'What’s your name?', subtitle: 'So your care team knows who they’re talking to.' }
            : { title: 'Secure your account', subtitle: 'Create a password that meets every rule below.' };

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
      variant="patient"
      onBack={signup.goBack}
      backTestID="signup-back"
      title={heading.title}
      subtitle={heading.subtitle}
      pinFooter
      footer={
        phase === 'choose' || phase === 'contact' ? (
          <FooterLink testID="signup-login" label="Already have an account? Log in" onPress={signup.openLogin} style={styles.footerLink} />
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
        <View>
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
                placeholder="(555) 555-5555"
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
        </View>
      ) : null}

      {phase === 'code' ? (
        <View>
          <FieldStack>
            <Field label="Verification code">
              <CodeInput testID="signup-otp" value={signup.otp} onChangeText={signup.setOtp} />
            </Field>
          </FieldStack>
          <ActionGroup>
            <PrimaryButton testID="signup-verify" label={busy ? 'Verifying…' : 'Verify'} onPress={signup.verify} disabled={busy} />
          </ActionGroup>
          {feedback}
        </View>
      ) : null}

      {phase === 'name' ? (
        <View>
          <FieldStack>
            <Field label="First name">
              <LedgerInput
                testID="signup-first-name"
                accessibilityLabel="First name"
                value={signup.firstName}
                onChangeText={signup.setFirstName}
                autoComplete="given-name"
                textContentType="givenName"
                autoCapitalize="words"
                placeholder="First name"
              />
            </Field>
            <Field label="Last name">
              <LedgerInput
                testID="signup-last-name"
                accessibilityLabel="Last name"
                value={signup.lastName}
                onChangeText={signup.setLastName}
                autoComplete="family-name"
                textContentType="familyName"
                autoCapitalize="words"
                placeholder="Last name"
              />
            </Field>
          </FieldStack>
          <ActionGroup>
            <PrimaryButton
              testID="signup-name-continue"
              label="Continue"
              onPress={signup.continueToPassword}
              disabled={busy || !signup.nameReady}
            />
          </ActionGroup>
          {feedback}
        </View>
      ) : null}

      {phase === 'password' ? (
        <View>
          <FieldStack>
            <Field label="Password">
              <PasswordInput
                testID="signup-password"
                accessibilityLabel="Password"
                value={signup.password}
                onChangeText={signup.setPassword}
                autoCapitalize="none"
                autoComplete="new-password"
                textContentType="newPassword"
                maxLength={PASSWORD_MAX_LENGTH}
                placeholder="Create a password"
              />
              <PasswordChecklist checks={signup.checks} testIDPrefix="signup-rule" />
            </Field>
            <Field
              label="Confirm password"
              hint={
                signup.passwordConfirm.length > 0 && !signup.passwordsMatch ? (
                  <NoteText text="These don’t match yet." />
                ) : undefined
              }
            >
              <PasswordInput
                testID="signup-confirm"
                accessibilityLabel="Confirm password"
                value={signup.passwordConfirm}
                onChangeText={signup.setPasswordConfirm}
                autoCapitalize="none"
                autoComplete="new-password"
                textContentType="newPassword"
                maxLength={PASSWORD_MAX_LENGTH}
                placeholder="Type it again"
              />
            </Field>
          </FieldStack>
          <ActionGroup>
            <PrimaryButton
              testID="signup-complete"
              label={busy ? 'Creating…' : 'Create account'}
              onPress={signup.finish}
              disabled={busy || !signup.canFinish}
            />
          </ActionGroup>
          {feedback}
        </View>
      ) : null}
    </AuthPageFrame>
  );
}

const styles = StyleSheet.create({
  options: { gap: space.md },
  footerLink: { minHeight: authLayout.headerControl, justifyContent: 'center' },
});
