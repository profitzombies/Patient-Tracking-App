import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { usePatientAccount } from './PatientAccountContext';
import { usePatient } from './PatientContext';
import { useColors } from '@/hooks/useColors';
import { supabase } from '@/lib/supabase';
import {
  approvedMeasurements,
  AccountOperationEpoch,
  biometricEligibility,
  ReminderCoordinator,
  type HealthMeasurement,
  type ReminderPrefs,
  type ReminderRecord,
} from '@/lib/device-feature-core';
import { getSessionAccessToken } from '@/lib/patient-data-api';

type Availability = 'available' | 'web' | 'expo-go' | 'unsupported';
interface FeatureState {
  notification: Availability | 'undetermined' | 'denied' | 'enabled';
  biometric: Availability | 'enabled';
  health: Availability | 'connected';
  message: string | null;
  busy: boolean;
  locked: boolean;
  enableNotifications(prefs?: ReminderPrefs): Promise<boolean>;
  disableNotifications(): Promise<void>;
  enableBiometrics(): Promise<boolean>;
  disableBiometrics(): Promise<void>;
  authenticate(): Promise<boolean>;
  connectAndImportHealth(): Promise<boolean>;
  openSettings(): Promise<void>;
}

const Context = createContext<FeatureState | null>(null);
const recordKey = (id: string) => `thinnr_device_reminders_v1:${id}`;
const bioKey = (id: string) => `thinnr_biometric_v1:${id}`;
const healthKey = (id: string) => `thinnr_health_v1:${id}`;
const isExpoGo = Constants.appOwnership === 'expo';

const store = {
  async read(accountId: string): Promise<ReminderRecord | null> {
    const raw = await AsyncStorage.getItem(recordKey(accountId));
    return raw ? JSON.parse(raw) as ReminderRecord : null;
  },
  async write(accountId: string, value: ReminderRecord | null) {
    if (value) await AsyncStorage.setItem(recordKey(accountId), JSON.stringify(value));
    else await AsyncStorage.removeItem(recordKey(accountId));
  },
};

const notificationDriver = {
  async permission() {
    const p = await Notifications.getPermissionsAsync();
    return p.granted ? 'granted' as const : p.status === 'denied' ? 'denied' as const : 'undetermined' as const;
  },
  async requestPermission() {
    const p = await Notifications.requestPermissionsAsync();
    return p.granted ? 'granted' as const : 'denied' as const;
  },
  async schedule(slot: 'morning' | 'afternoon' | 'evening', hour: number, minute: number) {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('medication-reminders', {
        name: 'Medication reminders',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
    return Notifications.scheduleNotificationAsync({
      content: {
        title: 'Medication reminder',
        body: `It’s time for your ${slot} medication.`,
        data: { feature: 'medication-reminder', slot },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DAILY,
        hour,
        minute,
        ...(Platform.OS === 'android' ? { channelId: 'medication-reminders' } : {}),
      },
    });
  },
  cancel(identifier: string) {
    return Notifications.cancelScheduledNotificationAsync(identifier);
  },
};

function prefsFrom(raw: Record<string, unknown> | null): ReminderPrefs {
  return {
    enabled: raw?.notifications === 'enabled',
    times: {
      morning: typeof raw?.reminderMorning === 'string' ? raw.reminderMorning : '8:00 AM',
      afternoon: typeof raw?.reminderAfternoon === 'string' ? raw.reminderAfternoon : '3:00 PM',
      evening: typeof raw?.reminderEvening === 'string' ? raw.reminderEvening : '9:00 PM',
    },
  };
}

export function DeviceFeaturesProvider({ children }: { children: ReactNode }) {
  const { account } = usePatientAccount();
  const patient = usePatient();
  const accountId = account.kind === 'real' ? account.patientId : null;
  const [notification, setNotification] = useState<FeatureState['notification']>(Platform.OS === 'web' ? 'web' : 'undetermined');
  const [biometric, setBiometric] = useState<FeatureState['biometric']>(Platform.OS === 'web' ? 'web' : (Platform.OS === 'ios' && isExpoGo ? 'expo-go' : 'available'));
  const [health, setHealth] = useState<FeatureState['health']>(Platform.OS === 'web' ? 'web' : isExpoGo ? 'expo-go' : 'available');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [biometricLoadedFor, setBiometricLoadedFor] = useState<string | null>(null);
  const previousAccount = useRef<string | null>(null);
  const accountRef = useRef<string | null>(null);
  accountRef.current = accountId;
  const operationEpochRef = useRef(new AccountOperationEpoch());
  operationEpochRef.current.activate(accountId);
  const coordinatorRef = useRef(new ReminderCoordinator(notificationDriver, store));
  const flags = patient.hydratedFlags?.notificationPrefs ?? null;

  useEffect(() => {
    previousAccount.current = accountId;
    void coordinatorRef.current.activate(accountId);
    if (!accountId || Platform.OS === 'web') return;
    void notificationDriver.permission().then(p => {
      if (accountRef.current === accountId) setNotification(p === 'granted' ? 'available' : p);
    });
    void SecureStore.getItemAsync(bioKey(accountId))
      .then(v => {
        if (accountRef.current !== accountId) return;
        const enabled = v?.startsWith('enabled') ?? false;
        setBiometric(enabled ? 'enabled' : 'available');
        setLocked(enabled);
        setBiometricLoadedFor(accountId);
      })
      .catch(() => {
        if (accountRef.current !== accountId) return;
        setBiometric('available');
        setLocked(false);
        setBiometricLoadedFor(accountId);
        setMessage('Couldn’t read biometric settings. Use normal account sign-in for now.');
      });
    void SecureStore.getItemAsync(healthKey(accountId))
      .then(v => {
        if (accountRef.current === accountId) setHealth(v === 'connected' ? 'connected' : isExpoGo ? 'expo-go' : 'available');
      })
      .catch(() => {
        if (accountRef.current === accountId) setHealth(isExpoGo ? 'expo-go' : 'available');
      });
  }, [accountId]);

  useEffect(() => {
    if (!accountId || !flags || Platform.OS === 'web') return;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    void coordinatorRef.current.reconcile(accountId, prefsFrom(flags), timezone, false)
      .then(result => accountRef.current === accountId && setNotification(result.status === 'denied' || result.status === 'undetermined' ? result.status : result.count ? 'enabled' : 'available'))
      .catch(cause => setMessage(cause instanceof Error ? cause.message : 'Couldn’t reconcile reminders.'));
  }, [accountId, flags]);

  useEffect(() => {
    if (!accountId || Platform.OS === 'web') return;
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active' && flags) {
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        void coordinatorRef.current.reconcile(accountId, prefsFrom(flags), timezone, false);
      }
      if (state !== 'active' && biometric === 'enabled') setLocked(true);
    });
    return () => sub.remove();
  }, [accountId, flags, biometric]);

  const enableNotifications = useCallback(async (provided?: ReminderPrefs) => {
    if (!accountId || Platform.OS === 'web') {
      setMessage('Local medication reminders are available only in the signed-in mobile app.');
      return false;
    }
    setBusy(true);
    try {
      const operation = operationEpochRef.current.capture(accountId);
      const result = await coordinatorRef.current.reconcile(
        accountId,
        provided ?? prefsFrom(flags),
        Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        true,
        true,
      );
      if (!operationEpochRef.current.isCurrent(operation)) return false;
      setNotification(result.status === 'denied' || result.status === 'undetermined' ? result.status : 'enabled');
      setMessage(result.status === 'denied' ? 'Notifications are off. Enable them in device Settings to receive medication reminders.' : null);
      if (result.status !== 'denied' && result.status !== 'undetermined' && result.status !== 'stale') {
        const saved = provided ?? prefsFrom(flags);
        patient.saveOnboardingFlags({
          notificationPrefs: {
            ...(flags ?? {}),
            notifications: 'enabled',
            reminderMorning: saved.times.morning,
            reminderAfternoon: saved.times.afternoon,
            reminderEvening: saved.times.evening,
          },
        });
      }
      return result.status !== 'denied' && result.status !== 'undetermined' && result.status !== 'stale';
    } finally {
      if (accountRef.current === accountId) setBusy(false);
    }
  }, [accountId, flags, patient]);

  const disableNotifications = useCallback(async () => {
    if (!accountId || Platform.OS === 'web') return;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const disabled = { ...prefsFrom(flags), enabled: false };
    await coordinatorRef.current.cancel(accountId, disabled, timezone);
    if (accountRef.current !== accountId) return;
    patient.saveOnboardingFlags({
      notificationPrefs: { ...(flags ?? {}), notifications: 'later' },
    });
    setNotification('available');
  }, [accountId, flags, patient]);

  const authenticate = useCallback(async () => {
    if (!accountId || Platform.OS === 'web' || (Platform.OS === 'ios' && isExpoGo)) return false;
    const operation = operationEpochRef.current.capture(accountId);
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Unlock THINNR',
      cancelLabel: 'Use account sign-in',
      disableDeviceFallback: true,
      ...(Platform.OS === 'android' ? { biometricsSecurityLevel: 'strong' as const } : {}),
    });
    if (!operationEpochRef.current.isCurrent(operation)) return false;
    if (result.success) setLocked(false);
    return result.success;
  }, [accountId]);

  const enableBiometrics = useCallback(async () => {
    if (!accountId || Platform.OS === 'web' || (Platform.OS === 'ios' && isExpoGo)) {
      setMessage('Biometric convenience is available only for signed-in accounts on supported phones.');
      return false;
    }
    const operation = operationEpochRef.current.capture(accountId);
    const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
    if (!operationEpochRef.current.isCurrent(operation)) return false;
    const biometricTypes = [
      LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION,
      LocalAuthentication.AuthenticationType.FINGERPRINT,
      LocalAuthentication.AuthenticationType.IRIS,
    ];
    const eligibility = biometricEligibility({
      platform: Platform.OS,
      expoGo: isExpoGo,
      hardware: await LocalAuthentication.hasHardwareAsync(),
      enrolled: await LocalAuthentication.isEnrolledAsync(),
      supportedTypes: types,
      biometricTypes,
    });
    if (!operationEpochRef.current.isCurrent(operation)) return false;
    if (eligibility !== 'available') {
      setBiometric('unsupported');
      setMessage('Set up Face ID, Touch ID, or device biometrics in system Settings first.');
      return false;
    }
    const ok = await authenticate();
    if (!ok || !operationEpochRef.current.isCurrent(operation)) return false;
    const enrollmentMarker = `enabled:${operation.generation}`;
    await SecureStore.setItemAsync(bioKey(accountId), enrollmentMarker, { requireAuthentication: false });
    if (!operationEpochRef.current.isCurrent(operation)) {
      if (await SecureStore.getItemAsync(bioKey(accountId)) === enrollmentMarker) {
        await SecureStore.deleteItemAsync(bioKey(accountId));
      }
      return false;
    }
    setBiometric('enabled');
    setLocked(false);
    setMessage('Biometrics unlock this app on this device only. Password and two-factor requirements still apply to your server session.');
    return true;
  }, [accountId, authenticate]);

  const disableBiometrics = useCallback(async () => {
    if (!accountId) return;
    const operation = operationEpochRef.current.capture(accountId);
    await SecureStore.deleteItemAsync(bioKey(accountId));
    if (!operationEpochRef.current.isCurrent(operation)) return;
    setLocked(false);
    setBiometric(Platform.OS === 'web' ? 'web' : 'available');
  }, [accountId]);

  const connectAndImportHealth = useCallback(async () => {
    if (!accountId || account.kind !== 'real') {
      setMessage('Health imports require a signed-in patient account.');
      return false;
    }
    if (Platform.OS === 'web' || isExpoGo) {
      setMessage(Platform.OS === 'web' ? 'Health data is unavailable on web.' : 'Health access needs a development build; Expo Go cannot load HealthKit or Health Connect.');
      return false;
    }
    setBusy(true);
    try {
      const operation = operationEpochRef.current.capture(accountId);
      const accessToken = await getSessionAccessToken();
      if (!accessToken || !operationEpochRef.current.isCurrent(operation)) {
        if (operationEpochRef.current.isCurrent(operation)) setMessage('You’re signed out. Sign in again before importing health data.');
        return false;
      }
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      let values: HealthMeasurement[] = [];
      if (Platform.OS === 'ios') {
        const module = await import('react-native-health');
        if (!operationEpochRef.current.isCurrent(operation)) return false;
        const kit: any = module.default;
        await new Promise<void>((resolve, reject) => kit.initHealthKit({
          permissions: { read: [kit.Constants.Permissions.Weight, kit.Constants.Permissions.Steps], write: [] },
        }, (error: string) => error ? reject(new Error(error)) : resolve()));
        if (!operationEpochRef.current.isCurrent(operation)) return false;
        const weight = await new Promise<any[]>((resolve, reject) => kit.getWeightSamples({ startDate: since }, (e: string, rows: any[]) => e ? reject(new Error(e)) : resolve(rows ?? [])));
        if (!operationEpochRef.current.isCurrent(operation)) return false;
        const steps = await new Promise<any[]>((resolve, reject) => kit.getDailyStepCountSamples({ startDate: since }, (e: string, rows: any[]) => e ? reject(new Error(e)) : resolve(rows ?? [])));
        if (!operationEpochRef.current.isCurrent(operation)) return false;
        values = [
          ...weight.map(row => ({ sourceId: `hk-weight:${row.id ?? `${row.startDate}:${row.value}`}`, kind: 'weight_lb' as const, value: Number(row.value), measuredAt: row.startDate, source: 'apple_health' as const })),
          ...steps.map(row => ({ sourceId: `hk-steps:${row.startDate}:${row.value}`, kind: 'steps' as const, value: Math.round(Number(row.value)), measuredAt: row.startDate, source: 'apple_health' as const })),
        ];
      } else if (Platform.OS === 'android') {
        const hc = await import('react-native-health-connect');
        if (!operationEpochRef.current.isCurrent(operation)) return false;
        if (!await hc.initialize()) throw new Error('Health Connect is not installed or available.');
        if (!operationEpochRef.current.isCurrent(operation)) return false;
        const granted = await hc.requestPermission([
          { accessType: 'read', recordType: 'Weight' },
          { accessType: 'read', recordType: 'Steps' },
        ]);
        if (!operationEpochRef.current.isCurrent(operation)) return false;
        const allowed = new Set(granted.map(item => `${item.accessType}:${item.recordType}`));
        if (!allowed.has('read:Weight') || !allowed.has('read:Steps')) {
          throw new Error('Weight and steps permission was not granted in Health Connect.');
        }
        const range = { operator: 'between' as const, startTime: since, endTime: new Date().toISOString() };
        const weights = await hc.readRecords('Weight', { timeRangeFilter: range });
        if (!operationEpochRef.current.isCurrent(operation)) return false;
        const steps = await hc.readRecords('Steps', { timeRangeFilter: range });
        if (!operationEpochRef.current.isCurrent(operation)) return false;
        values = [
          ...weights.records.map((row: any) => ({ sourceId: `hc-weight:${row.metadata?.id}`, kind: 'weight_lb' as const, value: Number(row.weight?.inPounds), measuredAt: row.time, source: 'health_connect' as const })),
          ...steps.records.map((row: any) => ({ sourceId: `hc-steps:${row.metadata?.id}`, kind: 'steps' as const, value: Math.round(Number(row.count)), measuredAt: row.startTime, source: 'health_connect' as const })),
        ];
      } else {
        setHealth('unsupported');
        setMessage('This device does not provide Apple Health or Health Connect.');
        return false;
      }
      const approved = approvedMeasurements(values);
      if (!operationEpochRef.current.isCurrent(operation)) return false;
      await account.api.importHealthMeasurements(approved, accessToken);
      if (!operationEpochRef.current.isCurrent(operation)) return false;
      await SecureStore.setItemAsync(healthKey(accountId), 'connected');
      if (!operationEpochRef.current.isCurrent(operation)) return false;
      setHealth('connected');
      setMessage(approved.length
        ? `Imported ${approved.length} approved weight and step measurements from the last 30 days.`
        : 'No approved weight or step measurements were available. Check health permissions and try again.');
      return true;
    } catch (cause) {
      if (accountRef.current === accountId) setMessage(cause instanceof Error ? cause.message : 'Health permission or import failed.');
      return false;
    } finally {
      if (accountRef.current === accountId) setBusy(false);
    }
  }, [account, accountId]);

  const value = useMemo<FeatureState>(() => ({
    notification, biometric, health, message, busy,
    locked: Boolean(accountId) && (biometricLoadedFor !== accountId || locked), enableNotifications, disableNotifications,
    enableBiometrics, disableBiometrics, authenticate, connectAndImportHealth,
    openSettings: async () => { if (Platform.OS !== 'web') await Linking.openSettings(); },
  }), [notification, biometric, health, message, busy, accountId, biometricLoadedFor, locked, enableNotifications, disableNotifications, enableBiometrics, disableBiometrics, authenticate, connectAndImportHealth]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useDeviceFeatures() {
  const value = useContext(Context);
  if (!value) throw new Error('useDeviceFeatures must be used within DeviceFeaturesProvider');
  return value;
}

export function DeviceBiometricGate({ children }: { children: ReactNode }) {
  const device = useDeviceFeatures();
  const colors = useColors();
  if (!device.locked) return <>{children}</>;
  return (
    <View style={[gateStyles.container, { backgroundColor: colors.background }]}>
      <Text style={[gateStyles.title, { color: colors.navy }]}>Unlock THINNR</Text>
      <Text style={[gateStyles.body, { color: colors.bodyText }]}>
        Confirm with your enrolled device biometric, or sign out and use your normal account sign-in.
      </Text>
      <Pressable
        testID="biometric-unlock"
        onPress={() => void device.authenticate()}
        style={[gateStyles.button, { backgroundColor: colors.cobalt }]}
      >
        <Text style={{ color: colors.primaryForeground }}>Unlock</Text>
      </Pressable>
      <Pressable testID="biometric-use-signin" onPress={() => void supabase?.auth.signOut()} style={gateStyles.link}>
        <Text style={{ color: colors.cobalt }}>Sign out and use account sign-in</Text>
      </Pressable>
    </View>
  );
}

const gateStyles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 16 },
  title: { fontFamily: 'PlayfairDisplay_700Bold', fontSize: 26 },
  body: { fontFamily: 'Inter_400Regular', fontSize: 14, lineHeight: 21, textAlign: 'center', maxWidth: 360 },
  button: { minHeight: 48, minWidth: 180, alignItems: 'center', justifyContent: 'center' },
  link: { padding: 12 },
});