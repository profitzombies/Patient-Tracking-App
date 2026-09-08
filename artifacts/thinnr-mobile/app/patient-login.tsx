/**
 * Patient login — pure view over usePatientLogin. Phases: login (phone/email
 * + password), mfa, recovery-identify, recovery-code, recovery-password.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { AuthPageFrame } from '@/components/auth/AuthPageFrame';
import { PlateHero } from '@/components/auth/PlateHero';
import {
  ActionGroup,
  FeedbackSlot,
  Field,
  FieldStack,
  FooterLink,
  Footnote,
  FormCard,
  QuietLinkRow,
} from '@/components/auth/AuthPrimitives';
import { CodeInput, ErrorBox, LedgerInput, PrimaryButton } from '@/components/onboarding/OnboardingFields';
import { usePatientLogin, type LoginPhase } from '@/hooks/usePatientLogin';
import { supabaseConfigured } from '@/lib/supabase';
import { space } from '@/constants/spacing';

const HEADINGS: Record<LoginPhase, { kicker: string; title: string; subtitle: string }> = {
  login: {
    kicker: 'PATIENT ACCESS',
    title: 'Welcome back',
    subtitle: 'Sign in with the phone or email on your account.',
  },
  mfa: {
    kicker: 'PATIENT ACCESS',
    title: 'Verify your sign-in',
    subtitle: 'Enter the 6-digit code we sent. If the account details match, a code is on its way.',
  },
  'recovery-identify': {
    kicker: 'PASSWORD RECOVERY',
    title: 'Reset your password',
    subtitle: 'Enter the phone or email on your account and we’ll send a 6-digit reset code.',
  },
  'recovery-code': {
    kicker: 'PASSWORD RECOVERY',
    title: 'Enter your reset code',
    subtitle: 'Enter the 6-digit code we sent. If the account details match, a code is on its way.',
  },
  'recovery-password': {
    kicker: 'PASSWORD RECOVERY',
    title: 'Create a new password',
    subtitle: 'Choose at least 8 characters you don’t use anywhere else.',
  },
};

export default function PatientLoginScreen() {
  const login = usePatientLogin();
  const { phase, channel, busy } = login;
  const heading = HEADINGS[phase];
  const recovery = phase.startsWith('recovery');
  const isCode = phase === 'mfa' || phase === 'recovery-code';
  const isPhone = channel === 'phone';

  const feedback = (
    <FeedbackSlot
      devCode={login.devCode}
      devCodeTestID="login-devcode"
      notice={login.notice}
      error={login.error}
      errorTestID="login-error"
    />
  );

  return (
    <AuthPageFrame
      testID="patient-login"
      onBack={login.goBack}
      backTestID="login-back"
      banner={!supabaseConfigured ? <ErrorBox testID="login-not-configured" message="Real sign-in isn’t configured in this environment." /> : null}
      hero={<PlateHero />}
      kicker={heading.kicker}
      title={heading.title}
      subtitle={heading.subtitle}
      footer={
        phase === 'login' ? (
          <View style={styles.footer}>
            <FooterLink testID="login-signup" label="Create new account" onPress={login.openSignup} />
            <QuietLinkRow>
              <FooterLink quiet testID="login-demo" label="Explore demo" onPress={login.openDemo} />
              <FooterLink quiet testID="login-provider" label="Provider login" onPress={login.openProviderLogin} />
            </QuietLinkRow>
            <Footnote text="Your health journey, supported by your care team." />
          </View>
        ) : (
          <FooterLink testID="login-back-to-signin" label="Back to sign in" onPress={login.backToSignIn} />
        )
      }
    >
      {phase === 'login' || phase === 'recovery-identify' ? (
        <FormCard>
          <FieldStack>
            <Field
              label={isPhone ? 'Cell phone number' : 'Email address'}
              link={{
                testID: 'login-switch-channel',
                label: isPhone ? 'Use email instead' : 'Use phone instead',
                onPress: login.switchChannel,
              }}
            >
              <LedgerInput
                key={channel}
                ref={login.identifierRef}
                testID={isPhone ? 'login-phone' : 'login-email'}
                accessibilityLabel={isPhone ? 'Cell phone number' : 'Email address'}
                value={isPhone ? login.phone : login.email}
                onChangeText={isPhone ? login.setPhone : login.setEmail}
                keyboardType={isPhone ? 'phone-pad' : 'email-address'}
                autoComplete={isPhone ? 'tel' : 'email'}
                textContentType={isPhone ? 'telephoneNumber' : 'emailAddress'}
                autoCapitalize="none"
                placeholder={isPhone ? 'Your cell number' : 'you@example.com'}
                style={!isPhone ? styles.emailInput : undefined}
              />
            </Field>
            {!recovery ? (
              <Field label="Password" link={{ testID: 'login-forgot', label: 'Forgot password?', onPress: login.startRecoveryFlow }}>
                <LedgerInput
                  testID="login-password"
                  accessibilityLabel="Password"
                  value={login.password}
                  onChangeText={login.setPassword}
                  secureTextEntry
                  autoComplete="current-password"
                  textContentType="password"
                  autoCapitalize="none"
                  placeholder="Your password"
                />
              </Field>
            ) : null}
          </FieldStack>
          <ActionGroup>
            <PrimaryButton
              testID={recovery ? 'recovery-start' : 'login-submit'}
              label={busy ? 'Please wait…' : recovery ? 'Send recovery code' : 'Continue'}
              onPress={() => login.request(recovery)}
              disabled={busy || !supabaseConfigured}
            />
          </ActionGroup>
          {feedback}
        </FormCard>
      ) : null}

      {isCode ? (
        <FormCard>
          <FieldStack>
            <Field label="Verification code">
              <CodeInput
                testID={phase === 'mfa' ? 'login-otp' : 'recovery-otp'}
                value={login.code}
                onChangeText={login.setCode}
                autoFocus
              />
            </Field>
          </FieldStack>
          <ActionGroup>
            <PrimaryButton
              testID={phase === 'mfa' ? 'login-verify' : 'recovery-verify'}
              label={busy ? 'Verifying…' : 'Verify'}
              onPress={login.verify}
              disabled={busy}
            />
          </ActionGroup>
          {feedback}
        </FormCard>
      ) : null}

      {phase === 'recovery-password' ? (
        <FormCard>
          <FieldStack>
            <Field label="New password">
              <LedgerInput
                testID="recovery-password"
                accessibilityLabel="New password"
                value={login.password}
                onChangeText={login.setPassword}
                secureTextEntry
                autoComplete="new-password"
                textContentType="newPassword"
                placeholder="At least 8 characters"
              />
            </Field>
            <Field label="Confirm new password">
              <LedgerInput
                testID="recovery-confirm"
                accessibilityLabel="Confirm new password"
                value={login.confirm}
                onChangeText={login.setConfirm}
                secureTextEntry
                autoComplete="new-password"
                textContentType="newPassword"
                placeholder="Same password again"
              />
            </Field>
          </FieldStack>
          <ActionGroup>
            <PrimaryButton
              testID="recovery-complete"
              label={busy ? 'Updating…' : 'Update password'}
              onPress={login.resetPassword}
              disabled={busy}
            />
          </ActionGroup>
          {feedback}
        </FormCard>
      ) : null}
    </AuthPageFrame>
  );
}

const styles = StyleSheet.create({
  footer: { alignItems: 'center', gap: space.xs },
  emailInput: { fontSize: 15, letterSpacing: 0 },
});
