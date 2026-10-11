import React, { useState } from 'react';
import { Platform, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { ErrorBox, FieldLabel, LedgerInput, PrimaryButton } from '@/components/onboarding/OnboardingFields';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';
import { LocalDatePicker } from '@/components/ui/LocalDatePicker';
import { useColors } from '@/hooks/useColors';
import { usePatient } from '@/context/PatientContext';
import { usePatientAccount } from '@/context/PatientAccountContext';
import { formatPhoneNumber, isValidContact, isValidDateKey } from '@/data/onboarding-data';
import { supabase } from '@/lib/supabase';
import { useDeviceFeatures } from '@/context/DeviceFeaturesContext';
import { PrivacyDataControls } from '@/components/account/PrivacyDataControls';
import { AccountSecurity } from '@/components/account/AccountSecurity';
import { MedicationsSection } from '@/components/account/MedicationsSection';
import {
  buildNotificationPrefsPatch,
  parseNotificationPrefs,
} from '@/lib/push-notification-core';

type VerifyKind = 'email' | 'phone';

export default function AccountScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const patient = usePatient();
  const { account } = usePatientAccount();
  const profile = patient.profile;
  const device = useDeviceFeatures();
  const biometricDescription =
    device.biometric === 'enabled' ? 'Biometric unlock is on for this account on this device. It never replaces account sign-in or two-factor security.' :
    device.biometric === 'web' ? 'Biometric unlock is unavailable on web.' :
    device.biometric === 'expo-go' ? 'Biometric unlock on iPhone requires a development or production build and is unavailable in Expo Go.' :
    device.biometric === 'unsupported' ? 'No supported enrolled biometric is available. Check Face ID, Touch ID, or biometric setup in system Settings.' :
    'Use an enrolled device biometric as a local convenience unlock. Account sign-in and two-factor security still apply.';
  const healthDescription =
    device.health === 'connected' ? 'Health data is connected. Only approved weight and step measurements from the last 30 days are imported.' :
    device.health === 'web' ? 'Apple Health and Health Connect are unavailable on web.' :
    device.health === 'expo-go' ? 'Health access requires a development or production build and is unavailable in Expo Go.' :
    device.health === 'unsupported' ? 'This device does not provide supported Apple Health or Health Connect access.' :
    'Connect Apple Health or Health Connect to import only approved weight and step measurements from the last 30 days.';
  const [name, setName] = useState(
    profile ? [profile.firstName, profile.lastName].filter(Boolean).join(' ') : '',
  );
  const [dateOfBirth, setDateOfBirth] = useState(profile?.dateOfBirth ?? '');
  const [email, setEmail] = useState(profile?.email ?? '');
  const [phone, setPhone] = useState(profile?.phone ? formatPhoneNumber(profile.phone) : '');
  const [heightInches, setHeightInches] = useState(
    profile?.heightInches === null || profile?.heightInches === undefined
      ? ''
      : String(profile.heightInches),
  );
  const [startingWeight, setStartingWeight] = useState(
    profile?.startingWeight === null || profile?.startingWeight === undefined
      ? ''
      : String(profile.startingWeight),
  );
  const [currentWeight, setCurrentWeight] = useState(
    profile?.currentWeight === null || profile?.currentWeight === undefined
      ? ''
      : String(profile.currentWeight),
  );
  const [goalWeight, setGoalWeight] = useState(
    profile?.goalWeight === null || profile?.goalWeight === undefined
      ? ''
      : String(profile.goalWeight),
  );
  const [programStartDate, setProgramStartDate] = useState(profile?.programStartDate ?? '');
  const [verifyKind, setVerifyKind] = useState<VerifyKind | null>(null);
  const [verificationId, setVerificationId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notificationPrefs = patient.hydratedFlags?.notificationPrefs;
  const initialPushPrefs = parseNotificationPrefs(notificationPrefs);
  const [pushCategories, setPushCategories] = useState(initialPushPrefs.categories);
  const [quietHoursEnabled, setQuietHoursEnabled] = useState(initialPushPrefs.quietHours !== null);
  const [quietStart, setQuietStart] = useState(initialPushPrefs.quietHours?.start ?? '22:00');
  const [quietEnd, setQuietEnd] = useState(initialPushPrefs.quietHours?.end ?? '07:00');
  const topPad = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  const accountLink = (testID: string, label: string, title: string, target: string, accessibilityLabel: string) => (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={() => router.push(target as never)}
      style={({ pressed }) => [
        styles.billingRow,
        { borderColor: colors.border, backgroundColor: colors.card },
        pressed && { opacity: 0.7 },
      ]}
    >
      <View>
        <FieldLabel text={label} />
        <Text style={[styles.billingTitle, { color: colors.navy }]}>{title}</Text>
      </View>
      <Feather name="chevron-right" size={20} color={colors.cobalt} />
    </Pressable>
  );
  const billingRow = (
    <View testID="account-billing-links">
      {accountLink('button-open-food-preferences', 'Eating', 'Food preferences', '/food-preferences', 'Open your diet and food preferences')}
      {accountLink('button-open-orders', 'Purchases', 'Orders', '/orders', 'Open your order history')}
      {accountLink('button-open-subscriptions', 'Purchases', 'Subscriptions', '/my-subscriptions', 'Manage your subscriptions')}
      {accountLink('button-open-billing', 'Payments', 'Shop & payments', '/billing', 'Open shop and payments')}
    </View>
  );

  if (account.kind !== 'real' || !profile) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Text style={[styles.body, { color: colors.bodyText }]}>
          Account settings are available for signed-in patient accounts.
        </Text>
        <Text testID="account-privacy-unavailable" style={[styles.body, { color: colors.subtleText }]}>
          Consent, data export, and account deletion become available once your account has finished loading.
        </Text>
        <PrimaryButton label="Go back" onPress={() => router.back()} />
      </View>
    );
  }

  const saveBasics = async () => {
    if (
      name.trim().split(/\s+/).length < 2 ||
      !isValidDateKey(dateOfBirth) ||
      (programStartDate.length > 0 && !isValidDateKey(programStartDate))
    ) {
      setError('Enter your first and last name, a valid birth date, and a valid program start date.');
      return;
    }
    const parts = name.trim().split(/\s+/);
    const height = Number(heightInches);
    const starting = Number(startingWeight);
    const current = Number(currentWeight);
    const goal = Number(goalWeight);
    if (
      !Number.isFinite(height) ||
      height < 24 ||
      height > 96 ||
      !Number.isFinite(starting) ||
      starting < 40 ||
      !Number.isFinite(current) ||
      current < 40 ||
      !Number.isFinite(goal) ||
      goal < 40
    ) {
      setError('Enter a valid height, starting weight, current weight, and goal weight.');
      return;
    }
    setBusy(true);
    setError(null);
    const saved = await patient.saveProfile({
      firstName: parts[0],
      lastName: parts.slice(1).join(' '),
      dateOfBirth,
      heightInches: height,
      startingWeight: starting,
      currentWeight: current,
      goalWeight: goal,
      ...(programStartDate ? { programStartDate } : {}),
    });
    setBusy(false);
    if (!saved) setError('Those changes didn’t save. Your values are still here—please try again.');
  };

  const beginVerification = async (kind: VerifyKind) => {
    const value = kind === 'email' ? email.trim().toLowerCase() : phone.replace(/\D/g, '');
    if (!isValidContact(kind, value)) {
      setError(`Enter a valid ${kind === 'email' ? 'email address' : 'phone number'} first.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const sent = await account.api.requestProfileVerification({ kind, value });
      setVerifyKind(kind);
      setVerificationId(sent.requestId);
      setCode(sent.devCode ?? '');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t send a verification code.');
    } finally {
      setBusy(false);
    }
  };

  const confirmVerification = async () => {
    if (!verifyKind || !verificationId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await account.api.verifyProfileContact({ requestId: verificationId, code });
      patient.applyProfile(result.profile);
      setVerifyKind(null);
      setVerificationId(null);
      setCode('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That code couldn’t be verified.');
    } finally {
      setBusy(false);
    }
  };

  const saveNotificationPreferences = async () => {
    setBusy(true);
    setError(null);
    try {
      const merged = buildNotificationPrefsPatch(notificationPrefs, {
        categories: pushCategories,
        quietHours: quietHoursEnabled ? { start: quietStart, end: quietEnd } : null,
      });
      await patient.saveOnboardingFlags({ notificationPrefs: merged });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Notification preferences didn’t save.');
    } finally {
      setBusy(false);
    }
  };

  const pushDescription =
    device.pushState.availability === 'expo-go' ? 'Not available in Expo Go — use a development build' :
    device.pushState.availability === 'web' ? 'Not available on web' :
    device.pushState.availability === 'simulator' ? 'Simulator: no push' :
    device.pushState.availability === 'unconfigured' ? 'Not configured for this build' :
    device.pushState.status === 'denied' ? 'Permission denied — enable in Settings' :
    device.pushState.status === 'registered' ? 'Registered' :
    device.pushState.status === 'registering' ? 'Registering…' :
    device.pushState.status === 'error' ? `Error: ${device.pushState.reason ?? 'registration failed'}` :
    'Ready to register';

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: topPad }]}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable testID="account-back" onPress={() => router.back()} hitSlop={10}>
          <Feather name="chevron-left" size={22} color={colors.navy} />
        </Pressable>
        <Text style={[styles.title, { color: colors.navy }]}>Account & Settings</Text>
        <View style={styles.spacer} />
      </View>
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 28 }]}
        bottomOffset={72}
      >
        {error ? <ErrorBox testID="account-error" message={error} /> : null}
        <AccountSecurity />
        {billingRow}
        <Text style={[styles.section, { color: colors.labelText }]}>PROFILE</Text>
        <LedgerCard style={styles.card}>
          <FieldLabel text="Full name" />
          <LedgerInput testID="account-name" value={name} onChangeText={setName} autoComplete="name" />
          <View style={styles.gap}>
            <FieldLabel text="Birth date" />
            <LedgerInput
              testID="account-dob"
              value={dateOfBirth}
              onChangeText={v => setDateOfBirth(v.replace(/[^0-9-]/g, '').slice(0, 10))}
              placeholder="YYYY-MM-DD"
              keyboardType="numbers-and-punctuation"
              accessibilityLabel="Birth date, year month day"
            />
          </View>
          <View style={styles.row}>
            <View style={styles.rowItem}>
              <FieldLabel text="Height (in)" />
              <LedgerInput
                testID="account-height"
                value={heightInches}
                onChangeText={v => setHeightInches(v.replace(/[^0-9.]/g, ''))}
                keyboardType="decimal-pad"
              />
            </View>
            <View style={styles.rowItem}>
              <FieldLabel text="Starting (lb)" />
              <LedgerInput
                testID="account-starting-weight"
                value={startingWeight}
                onChangeText={v => setStartingWeight(v.replace(/[^0-9.]/g, ''))}
                keyboardType="decimal-pad"
              />
            </View>
          </View>
          <View style={styles.row}>
            <View style={styles.rowItem}>
              <FieldLabel text="Current (lb)" />
              <LedgerInput
                testID="account-current-weight"
                value={currentWeight}
                onChangeText={v => setCurrentWeight(v.replace(/[^0-9.]/g, ''))}
                keyboardType="decimal-pad"
              />
            </View>
            <View style={styles.rowItem}>
              <FieldLabel text="Goal (lb)" />
              <LedgerInput
                testID="account-goal-weight"
                value={goalWeight}
                onChangeText={v => setGoalWeight(v.replace(/[^0-9.]/g, ''))}
                keyboardType="decimal-pad"
              />
            </View>
          </View>
          <View style={styles.gap}>
            <FieldLabel text="Program start date" />
            <LocalDatePicker
              testID="account-program-start-calendar"
              value={programStartDate}
              onChange={setProgramStartDate}
              minDate="2020-01-01"
              maxDate="2035-12-31"
            />
          </View>
          <PrimaryButton
            testID="account-save-profile"
            label={busy ? 'Saving…' : 'Save profile'}
            disabled={busy}
            onPress={saveBasics}
            style={styles.gap}
          />
        </LedgerCard>

        <Text style={[styles.section, { color: colors.labelText }]}>CONTACT & VERIFICATION</Text>
        <LedgerCard style={styles.card}>
          <FieldLabel text="Email" />
          <LedgerInput
            testID="account-email"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
          />
          <PrimaryButton
            testID="account-verify-email"
            label="Verify email change"
            disabled={busy}
            onPress={() => beginVerification('email')}
            style={styles.smallGap}
          />
          <View style={styles.gap}>
            <FieldLabel text="Phone" />
            <LedgerInput
              testID="account-phone"
              value={phone}
              onChangeText={v => setPhone(formatPhoneNumber(v))}
              keyboardType="phone-pad"
              autoComplete="tel"
            />
          </View>
          <PrimaryButton
            testID="account-verify-phone"
            label="Verify phone change"
            disabled={busy}
            onPress={() => beginVerification('phone')}
            style={styles.smallGap}
          />
          {verifyKind ? (
            <View style={styles.verify}>
              <FieldLabel text={`Code sent to your ${verifyKind}`} />
              <LedgerInput
                testID="account-code"
                value={code}
                onChangeText={v => setCode(v.replace(/\D/g, '').slice(0, 6))}
                keyboardType="number-pad"
                maxLength={6}
                autoFocus
                style={styles.code}
              />
              <PrimaryButton
                testID="account-confirm-code"
                label={busy ? 'Verifying…' : 'Confirm code'}
                disabled={busy || code.length !== 6}
                onPress={confirmVerification}
                style={styles.smallGap}
              />
            </View>
          ) : null}
        </LedgerCard>

        <Text style={[styles.section, { color: colors.labelText }]}>NOTIFICATIONS</Text>
        <LedgerCard style={styles.card}>
          {([
            ['coachOutreach', 'Coach outreach'],
            ['checkInReminders', 'Check-in reminders'],
            ['officeReminders', 'Reminders from my office'],
          ] as const).map(([key, label]) => (
            <View key={key} style={styles.switchRow}>
              <Text style={[styles.body, { color: colors.bodyText }]}>{label}</Text>
              <Switch
                testID={`account-push-${key}`}
                accessibilityRole="switch"
                accessibilityLabel={label}
                value={pushCategories[key]}
                onValueChange={value => setPushCategories(current => ({ ...current, [key]: value }))}
                trackColor={{ true: colors.cobaltMuted }}
                thumbColor={pushCategories[key] ? colors.cobalt : undefined}
              />
            </View>
          ))}
          <View style={styles.switchRow}>
            <Text style={[styles.body, { color: colors.bodyText }]}>Quiet hours</Text>
            <Switch
              testID="account-quiet-hours"
              accessibilityRole="switch"
              accessibilityLabel="Enable quiet hours"
              value={quietHoursEnabled}
              onValueChange={setQuietHoursEnabled}
              trackColor={{ true: colors.cobaltMuted }}
              thumbColor={quietHoursEnabled ? colors.cobalt : undefined}
            />
          </View>
          {quietHoursEnabled ? (
            <View style={styles.row}>
              <View style={styles.rowItem}>
                <FieldLabel text="Start (24-hour)" />
                <LedgerInput
                  testID="account-quiet-start"
                  value={quietStart}
                  onChangeText={setQuietStart}
                  placeholder="22:00"
                  accessibilityLabel="Quiet hours start in 24-hour HH:MM format"
                />
              </View>
              <View style={styles.rowItem}>
                <FieldLabel text="End (24-hour)" />
                <LedgerInput
                  testID="account-quiet-end"
                  value={quietEnd}
                  onChangeText={setQuietEnd}
                  placeholder="07:00"
                  accessibilityLabel="Quiet hours end in 24-hour HH:MM format"
                />
              </View>
            </View>
          ) : null}
          <PrimaryButton
            testID="account-save-push-preferences"
            label={busy ? 'Saving…' : 'Save notification preferences'}
            disabled={busy}
            onPress={() => void saveNotificationPreferences()}
            style={styles.gap}
          />
          <View style={styles.gap}>
            <Text style={[styles.body, { color: colors.bodyText }]}>
              Push on this device: {pushDescription}
            </Text>
            {device.pushState.status === 'denied' ? (
              <PrimaryButton label="Open device Settings" onPress={device.openSettings} style={styles.smallGap} />
            ) : null}
            {device.pushState.status === 'error' ? (
              <PrimaryButton label="Retry push registration" onPress={() => void device.retryPush()} style={styles.smallGap} />
            ) : null}
          </View>
        </LedgerCard>

        <MedicationsSection />

        <Text style={[styles.section, { color: colors.labelText }]}>DEVICE FEATURES</Text>
        <LedgerCard style={styles.card}>
          <Text style={[styles.body, { color: colors.bodyText }]}>
            Medication reminders: {device.notification}. Each medication above gets its own
            reminder at its scheduled times. Schedules stay on this phone and are removed when
            you sign out or switch accounts.
          </Text>
          <PrimaryButton
            testID="account-notifications-toggle"
            label={device.notification === 'enabled' ? 'Turn off medication reminders' : 'Enable medication reminders'}
            disabled={device.busy || device.notification === 'web'}
            onPress={() => void (device.notification === 'enabled'
              ? device.disableNotifications()
              : device.enableNotifications())}
            style={styles.smallGap}
          />
          {device.notification === 'denied' ? (
            <PrimaryButton testID="account-open-settings" label="Open device Settings" onPress={device.openSettings} style={styles.smallGap} />
          ) : null}
          <View style={styles.gap}>
            <Text style={[styles.body, { color: colors.bodyText }]}>
              {biometricDescription}
            </Text>
            <PrimaryButton
              testID="account-biometrics-toggle"
              label={device.biometric === 'enabled' ? 'Disable biometric unlock' : 'Enable biometric unlock'}
              disabled={device.busy || device.biometric === 'web' || device.biometric === 'expo-go' || device.biometric === 'unsupported'}
              onPress={() => void (device.biometric === 'enabled' ? device.disableBiometrics() : device.enableBiometrics())}
              style={styles.smallGap}
            />
          </View>
          <View style={styles.gap}>
            <Text style={[styles.body, { color: colors.bodyText }]}>
              {healthDescription}
            </Text>
            <PrimaryButton
              testID="account-health-import"
              label={device.health === 'connected' ? 'Import new health measurements' : 'Connect health data'}
              disabled={device.busy || device.health === 'web' || device.health === 'expo-go' || device.health === 'unsupported'}
              onPress={() => void device.connectAndImportHealth()}
              style={styles.smallGap}
            />
          </View>
          {device.message ? <View style={styles.gap}><Text style={[styles.body, { color: colors.subtleText }]}>{device.message}</Text></View> : null}
        </LedgerCard>

        <Text style={[styles.section, { color: colors.labelText }]}>PRIVACY & DATA</Text>
        <PrivacyDataControls />

        <Pressable
          testID="account-signout"
          onPress={() => void (async () => {
            await device.unregisterBeforeSignOut('signed_out');
            await supabase?.auth.signOut();
          })()}
          style={({ pressed }) => [styles.signout, { borderColor: colors.border }, pressed && { opacity: 0.7 }]}
        >
          <Feather name="log-out" size={16} color={colors.bodyText} />
          <Text style={[styles.body, { color: colors.bodyText }]}>Sign out</Text>
        </Pressable>
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', padding: 24, gap: 16 },
  header: {
    minHeight: 58,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
  },
  title: { fontSize: 18, fontFamily: 'PlayfairDisplay_700Bold' },
  spacer: { width: 22 },
  content: { padding: 18, maxWidth: 520, width: '100%', alignSelf: 'center' },
  section: { fontSize: 10, letterSpacing: 1.4, fontFamily: 'Inter_700Bold', marginTop: 20, marginBottom: 8 },
  card: { padding: 14 },
  gap: { marginTop: 14 },
  row: { flexDirection: 'row', gap: 8, marginTop: 14 },
  rowItem: { flex: 1 },
  switchRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  smallGap: { marginTop: 9 },
  verify: { marginTop: 18 },
  code: { textAlign: 'center', fontSize: 22, letterSpacing: 8 },
  signout: {
    marginTop: 20,
    minHeight: 48,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  body: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  billingRow: {
    minHeight: 66,
    marginTop: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderRadius: 9,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    boxShadow: '0 6px 15px rgba(40, 55, 74, 0.06)',
  },
  billingTitle: { marginTop: 3, fontSize: 17, fontFamily: 'PlayfairDisplay_700Bold' },
});