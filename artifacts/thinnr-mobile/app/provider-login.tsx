/**
 * Provider login — the staff door inside the patient app. Pure view over
 * useProviderLogin (email → 6-digit code → staff session), rendered on the
 * same auth page frame as the patient screens.
 */
import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { AuthPageFrame } from '@/components/auth/AuthPageFrame';
import { PlateHero, PROVIDER_PLATE_CAPTION } from '@/components/auth/PlateHero';
import { ActionGroup, FeedbackSlot, Field, FieldStack, FooterLink, FormCard, QuietLinkRow } from '@/components/auth/AuthPrimitives';
import { ErrorBox, LedgerInput, NoteText, PrimaryButton } from '@/components/onboarding/OnboardingFields';
import { useColors } from '@/hooks/useColors';
import { useProviderLogin } from '@/hooks/useProviderLogin';
import { supabaseConfigured } from '@/lib/supabase';
import { fonts } from '@/constants/colors';
import { space } from '@/constants/spacing';

/** On web, wrapping the fields in a form lets Enter submit via the browser. */
function FormWrap({ children }: { children: React.ReactNode }) {
  if (Platform.OS !== 'web') return <>{children}</>;
  return (
    <form style={{ display: 'contents' }} onSubmit={event => event.preventDefault()}>
      {children}
    </form>
  );
}

export default function ProviderLoginScreen() {
  const colors = useColors();
  const login = useProviderLogin();
  const { phase, busy } = login;

  return (
    <AuthPageFrame
      testID="provider-login"
      onBack={login.goBack}
      backTestID="provider-back-login"
      backAccessibilityLabel="Back to patient sign-in"
      banner={!supabaseConfigured ? <ErrorBox testID="provider-not-configured" message="Real sign-in isn’t configured in this environment." /> : null}
      hero={<PlateHero caption={PROVIDER_PLATE_CAPTION()} />}
      kicker="PROVIDER ACCESS"
      title={
        phase === 'email'
          ? 'Provider sign-in'
          : phase === 'code'
            ? 'Check your inbox'
            : phase === 'phone'
              ? 'Add a sign-in phone'
              : `Enter the code we texted to ${login.destination ?? 'your phone'}`
      }
      subtitle={
        phase === 'email'
          ? 'For office staff and HQ. We’ll email a 6-digit sign-in code — no password.'
          : phase === 'code'
            ? `If ${login.pendingEmail} has an account, a 6-digit code is on its way. It expires in 10 minutes.`
            : phase === 'phone'
              ? 'Your role requires a second check at sign-in. We’ll text a code to this number each time you sign in.'
              : 'Enter the 6-digit code from the text message.'
      }
      footer={
        <View style={styles.footer}>
          {phase === 'code' ? (
            <QuietLinkRow>
              <FooterLink testID="provider-resend" label="Send a fresh code" onPress={login.resendCode} disabled={busy} />
              <FooterLink quiet testID="provider-back" label="Use a different email" onPress={login.backToEmail} />
            </QuietLinkRow>
          ) : phase === 'sms' ? (
            <QuietLinkRow>
              <FooterLink
                testID="button-provider-sms-resend"
                label="Resend text"
                onPress={login.resendSms}
                disabled={busy}
              />
              <FooterLink quiet testID="provider-back" label="Use a different email" onPress={login.backToEmail} />
            </QuietLinkRow>
          ) : null}
          <Text style={[styles.disclaimer, { color: colors.labelText }]}>SYNTHETIC DEMO DATA  •  NOT MEDICAL ADVICE</Text>
        </View>
      }
    >
      {phase === 'email' ? (
        <FormCard>
          <FormWrap>
            <FieldStack>
              <Field
                label="Work email"
                hint={<NoteText text="Patients sign in with their phone on the previous screen." />}
              >
                <LedgerInput
                  testID="provider-email"
                  accessibilityLabel="Work email"
                  value={login.email}
                  onChangeText={login.setEmail}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  autoComplete="email"
                  textContentType="emailAddress"
                  placeholder="you@yourclinic.com"
                  editable={!busy && supabaseConfigured}
                />
              </Field>
            </FieldStack>
            <ActionGroup>
              <PrimaryButton
                testID="provider-send"
                label={busy ? 'Sending code…' : 'Email me a code'}
                onPress={login.submitEmail}
                disabled={busy || !supabaseConfigured}
                onDisabledPress={supabaseConfigured ? undefined : login.explainNotConfigured}
              />
            </ActionGroup>
            <FeedbackSlot
              notice={login.error ? null : login.notice}
              noticeTestID="provider-notice"
              error={login.error}
              errorTestID="provider-error"
            />
          </FormWrap>
        </FormCard>
      ) : phase === 'code' ? (
        <FormCard>
          <FormWrap>
            <FieldStack>
              <Field label="Verification code">
                <LedgerInput
                  testID="provider-otp"
                  accessibilityLabel="6-digit verification code"
                  value={login.otp}
                  onChangeText={login.setOtp}
                  keyboardType="number-pad"
                  autoComplete="sms-otp"
                  textContentType="oneTimeCode"
                  maxLength={6}
                  editable={!busy}
                  style={styles.otpInput}
                />
              </Field>
            </FieldStack>
            <ActionGroup>
              <PrimaryButton
                testID="provider-verify"
                label={busy ? 'Verifying…' : 'Verify and sign in'}
                onPress={login.submitOtp}
                disabled={busy}
              />
            </ActionGroup>
            <FeedbackSlot
              devCode={login.devCode}
              devCodeTestID="provider-devcode"
              notice={login.error ? null : login.notice}
              noticeTestID="provider-notice"
              error={login.error}
              errorTestID="provider-error"
            />
          </FormWrap>
        </FormCard>
      ) : phase === 'phone' ? (
        <FormCard>
          <FormWrap>
            <FieldStack>
              <Field
                label="Mobile phone"
                hint={<NoteText text="Use a US mobile number that can receive text messages." />}
              >
                <LedgerInput
                  testID="input-provider-phone"
                  accessibilityLabel="Sign-in phone number"
                  value={login.phone}
                  onChangeText={login.setPhone}
                  keyboardType="phone-pad"
                  autoComplete="tel"
                  textContentType="telephoneNumber"
                  editable={!busy}
                  placeholder="(555) 555-1234"
                />
              </Field>
            </FieldStack>
            <ActionGroup>
              <PrimaryButton
                testID="button-provider-phone-send"
                label={busy ? 'Sending…' : 'Text me a code'}
                onPress={login.submitPhone}
                disabled={busy}
              />
            </ActionGroup>
            {login.error ? <ErrorBox testID="provider-error" message={login.error} /> : null}
          </FormWrap>
        </FormCard>
      ) : (
        <FormCard>
          <FormWrap>
            <FieldStack>
              <Field label="Texted code">
                <LedgerInput
                  testID="input-provider-sms-code"
                  accessibilityLabel="6-digit texted code"
                  value={login.smsCode}
                  onChangeText={login.setSmsCode}
                  keyboardType="number-pad"
                  autoComplete="sms-otp"
                  textContentType="oneTimeCode"
                  maxLength={6}
                  editable={!busy}
                  style={styles.otpInput}
                />
              </Field>
            </FieldStack>
            <ActionGroup>
              <PrimaryButton
                testID="button-provider-sms-verify"
                label={busy ? 'Verifying…' : 'Verify and sign in'}
                onPress={login.submitSmsCode}
                disabled={busy}
              />
            </ActionGroup>
            <FeedbackSlot
              devCode={login.smsDevCode}
              devCodeTestID="provider-sms-devcode"
              error={login.error}
              errorTestID="provider-error"
            />
          </FormWrap>
        </FormCard>
      )}
    </AuthPageFrame>
  );
}

const styles = StyleSheet.create({
  footer: { alignItems: 'center', gap: space.md },
  otpInput: { textAlign: 'center', fontSize: 20, letterSpacing: 8, fontFamily: fonts.sansBold },
  disclaimer: { fontSize: 9, letterSpacing: 1.6, fontFamily: fonts.sansBold, textAlign: 'center' },
});
