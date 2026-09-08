/**
 * Patient welcome — the first screen a signed-out patient sees. Framed Plate
 * hero, a short promise, and two clearly separated doors (log in / create),
 * with the demo and provider entrances kept quiet underneath.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { AuthPageFrame } from '@/components/auth/AuthPageFrame';
import { PlateHero } from '@/components/auth/PlateHero';
import { ActionGroup, FooterLink, Footnote, QuietLinkRow, SecondaryButton } from '@/components/auth/AuthPrimitives';
import { PrimaryButton } from '@/components/onboarding/OnboardingFields';
import { useAppMode } from '@/context/AppModeContext';
import { space } from '@/constants/spacing';

export default function PatientWelcomeScreen() {
  const { admitDemo } = useAppMode();
  return (
    <AuthPageFrame
      testID="patient-welcome"
      topNote="Patient app"
      balance
      hero={<PlateHero photoHeight={168} />}
      kicker="YOUR PERSONAL HEALTH COMPANION"
      title="Progress, with your care team beside you."
      subtitle="Keep your daily plan, meals, check-ins, and coaching in one calm place."
      footer={
        <View style={styles.footer}>
          <QuietLinkRow>
            <FooterLink
              quiet
              testID="welcome-demo"
              label="Explore demo"
              onPress={async () => {
                await admitDemo();
                router.push('/patient-entry');
              }}
            />
            <FooterLink quiet testID="welcome-provider" label="Provider login" onPress={() => router.push('/provider-login')} />
          </QuietLinkRow>
          <Footnote text="Your health journey, supported by your care team." />
        </View>
      }
    >
      <ActionGroup style={styles.actions}>
        <PrimaryButton testID="welcome-login" label="Log In" onPress={() => router.push('/patient-login')} />
        <SecondaryButton
          testID="welcome-signup"
          label="Create New Account"
          accessibilityLabel="Create new account"
          onPress={() => router.push('/patient-signup')}
        />
      </ActionGroup>
    </AuthPageFrame>
  );
}

const styles = StyleSheet.create({
  actions: { marginTop: space.sm },
  footer: { alignItems: 'center', gap: space.xs },
});
