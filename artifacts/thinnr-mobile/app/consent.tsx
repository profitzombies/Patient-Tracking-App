/**
 * Consent gate for real patient accounts.
 *
 * The route guard parks a signed-in patient here whenever the server holds
 * no consent for the current policy version (first visit, or a policy
 * update) — before onboarding, so no health data is entered or read without
 * a recorded agreement. The same screen hosts the pending-closure notice:
 * signing in during the grace period lands here with "Keep my account"
 * (cancels the deletion) or "Sign out".
 */
import React, { useEffect, useState } from 'react';
import Constants from 'expo-constants';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import {
  CheckRow,
  ErrorBox,
  GhostButton,
  InfoCard,
  PrimaryButton,
} from '@/components/onboarding/OnboardingFields';
import { useColors } from '@/hooks/useColors';
import { usePatient } from '@/context/PatientContext';
import { usePatientAccount } from '@/context/PatientAccountContext';
import { supabase } from '@/lib/supabase';
import { describeGrace } from '@/lib/patient-privacy';

/** Placeholder policy copy; legal drafting lands separately under the same version key. */
const POLICY_SUMMARY = {
  terms: 'How the THINNR app may be used, what we provide, and what we ask of you.',
  privacy: 'What we collect, how it is protected, who at your office can see it, and how to get a copy or delete it.',
  healthData: 'Your weight, measurements, diary, check-ins, and progress photos are health data. We process them only to run your program with your care team.',
  photoAnalysis: 'Optional. Lets the coach read meal, label, and menu photos you choose to share. You can change this any time from your account.',
};

function appVersion(): string {
  return Constants.expoConfig?.version ?? 'unknown';
}

export default function ConsentScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const patient = usePatient();
  const { account } = usePatientAccount();
  const privacy = patient.hydratedPrivacy;
  const [terms, setTerms] = useState(false);
  const [privacyAgreed, setPrivacyAgreed] = useState(false);
  const [healthData, setHealthData] = useState(false);
  const [photoAnalysis, setPhotoAnalysis] = useState(privacy?.consent.photoAnalysis ?? true);
  // Privacy usually lands after the first render; a re-prompt (policy bump)
  // must start from the patient's recorded photo choice, never flip an
  // earlier opt-out back on by default.
  const recordedPhotoChoice = privacy?.consent.photoAnalysis ?? null;
  const [choiceSeeded, setChoiceSeeded] = useState(recordedPhotoChoice !== null);
  useEffect(() => {
    if (choiceSeeded || recordedPhotoChoice === null) return;
    setPhotoAnalysis(recordedPhotoChoice);
    setChoiceSeeded(true);
  }, [choiceSeeded, recordedPhotoChoice]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const topPad = Platform.OS === 'web' ? Math.max(insets.top, 44) : insets.top + 12;

  const api = account.kind === 'real' ? account.api.privacy : null;
  const required = terms && privacyAgreed && healthData;

  const signOut = async () => {
    await supabase?.auth.signOut();
  };

  if (!api || !privacy) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Text style={[styles.body, { color: colors.bodyText }]}>Loading your account…</Text>
      </View>
    );
  }

  const deletion = privacy.deletion;
  if (deletion) {
    const keep = async () => {
      setBusy(true);
      setError(null);
      try {
        await api.cancelDeletion();
        patient.applyPrivacy(previous => (previous ? { ...previous, deletion: null } : previous));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'That didn’t go through. Please try again.');
      } finally {
        setBusy(false);
      }
    };
    return (
      <View style={[styles.page, { backgroundColor: colors.background, paddingTop: topPad }]}>
        <KeyboardAwareScrollViewCompat contentContainerStyle={styles.content}>
          <Text style={[styles.brand, { color: colors.navy }]}>THINNR</Text>
          <Text style={[styles.kicker, { color: colors.labelText }]}>ACCOUNT CLOSURE REQUESTED</Text>
          <Text style={[styles.title, { color: colors.navy }]}>Your account is scheduled to close.</Text>
          <View
            testID="consent-deletion-pending"
            accessibilityRole="alert"
            style={[styles.notice, { backgroundColor: colors.warnBg, borderColor: colors.warnBorder, borderRadius: colors.radiusSm }]}
          >
            <Text style={[styles.body, { color: colors.warnText }]}>
              {describeGrace(deletion.purgeAfter)} Choose “Keep my account” to cancel and carry on where you left off, or sign out to let the closure go ahead.
            </Text>
          </View>
          {error ? <ErrorBox testID="consent-error" message={error} /> : null}
          <PrimaryButton
            testID="consent-keep-account"
            label={busy ? 'Keeping…' : 'Keep my account'}
            disabled={busy}
            onPress={() => void keep()}
            style={styles.primary}
          />
          <GhostButton testID="consent-sign-out" label="Sign out" disabled={busy} onPress={() => void signOut()} style={styles.secondary} />
        </KeyboardAwareScrollViewCompat>
      </View>
    );
  }

  const consent = privacy.consent;
  const isUpdate = consent.recordedVersion !== null && consent.recordedVersion !== consent.requiredVersion;

  const agree = async () => {
    if (!required) {
      setError('Please review and agree to the three required items to continue.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.recordConsent({
        policyVersion: consent.requiredVersion,
        terms: true,
        privacy: true,
        healthData: true,
        photoAnalysis,
        appVersion: appVersion(),
        platform: Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web',
      });
      patient.applyPrivacy(previous => (previous ? { ...previous, consent: result.consent } : previous));
      // The server refused the account's data slice until now; load it.
      patient.rehydrate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That didn’t go through. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[styles.page, { backgroundColor: colors.background, paddingTop: topPad }]}>
      <KeyboardAwareScrollViewCompat contentContainerStyle={styles.content}>
        <Text style={[styles.brand, { color: colors.navy }]}>THINNR</Text>
        <Text style={[styles.kicker, { color: colors.labelText }]}>
          {isUpdate ? 'OUR POLICIES HAVE CHANGED' : 'BEFORE WE BEGIN'}
        </Text>
        <Text testID="consent-title" style={[styles.title, { color: colors.navy }]}>
          {isUpdate ? 'Please review the updated terms.' : 'Your data, your say.'}
        </Text>
        <Text style={[styles.body, { color: colors.subtleText }]}>
          {isUpdate
            ? `You agreed to policy ${consent.recordedVersion}. Policy ${consent.requiredVersion} is now in effect and needs a fresh agreement before you continue.`
            : 'THINNR stores health information to run your program with your care team. Please agree to the items below to continue.'}
        </Text>
        <Text testID="consent-version" style={[styles.version, { color: colors.labelText }]}>
          Policy version {consent.requiredVersion} · App {appVersion()}
        </Text>

        <View style={styles.rows}>
          <CheckRow testID="consent-terms" label="Terms of use" sub={POLICY_SUMMARY.terms} checked={terms} onPress={() => setTerms(v => !v)} />
          <CheckRow testID="consent-privacy" label="Privacy policy" sub={POLICY_SUMMARY.privacy} checked={privacyAgreed} onPress={() => setPrivacyAgreed(v => !v)} />
          <CheckRow testID="consent-health" label="Health-data processing" sub={POLICY_SUMMARY.healthData} checked={healthData} onPress={() => setHealthData(v => !v)} />
          <CheckRow testID="consent-photo" label="Photo analysis (optional)" sub={POLICY_SUMMARY.photoAnalysis} checked={photoAnalysis} onPress={() => setPhotoAnalysis(v => !v)} />
        </View>

        <InfoCard label="Your controls" body="You can download a copy of your data or delete your account at any time from Account → Privacy & data." />
        {error ? <ErrorBox testID="consent-error" message={error} /> : null}
        <PrimaryButton
          testID="consent-agree"
          label={busy ? 'Saving…' : 'Agree and continue'}
          disabled={busy || !required}
          onDisabledPress={() => setError('Please review and agree to the three required items to continue.')}
          onPress={() => void agree()}
          style={styles.primary}
        />
        <GhostButton testID="consent-sign-out" label="Not now — sign out" disabled={busy} onPress={() => void signOut()} style={styles.secondary} />
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', padding: 24 },
  content: { paddingHorizontal: 24, paddingBottom: 28, flexGrow: 1, maxWidth: 520, width: '100%', alignSelf: 'center' },
  brand: { fontSize: 22, fontFamily: 'PlayfairDisplay_700Bold', letterSpacing: 4 },
  kicker: { fontSize: 10.5, fontFamily: 'Inter_700Bold', letterSpacing: 1.4, marginTop: 22 },
  title: { fontSize: 28, lineHeight: 35, fontFamily: 'PlayfairDisplay_700Bold', marginTop: 10 },
  body: { fontSize: 14, lineHeight: 21, fontFamily: 'Inter_400Regular', marginTop: 12 },
  version: { fontSize: 11, fontFamily: 'Inter_600SemiBold', marginTop: 10, letterSpacing: 0.4 },
  rows: { marginTop: 18, gap: 10 },
  notice: { borderWidth: 1, padding: 14, marginTop: 18 },
  primary: { marginTop: 18 },
  secondary: { marginTop: 10 },
});
