import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Redirect, Tabs, usePathname } from 'expo-router';
import { useAppMode } from '@/context/AppModeContext';
import { usePatient, usePatientSyncNotice } from '@/context/PatientContext';
import { usePatientAccount } from '@/context/PatientAccountContext';
import { PatientFabMenu } from '@/components/patient/PatientFabMenu';
import { PatientTabBar } from '@/components/patient/PatientTabBar';
import { SyncStatusChip } from '@/components/patient/SyncStatusChip';
import {
  PatientRouteShell,
  type PatientShellStatus,
} from '@/components/patient/PatientRouteShell';

/**
 * The five patient screens still live in a tab navigator — swapping between
 * them keeps each one's scroll position and state, and deep links into
 * /diary or /plan keep working — but the navigator draws no bar of its own.
 * Navigation is the floating row mounted below: the pill bar (Today, Diary,
 * Progress, Coach) and the corner launcher, which carries Library and Plan
 * at the top of its menu.
 */
function PatientTabs() {
  return (
    <Tabs
      screenOptions={{ headerShown: false }}
      tabBar={() => null}
    >
      <Tabs.Screen name="today" options={{ title: 'Today' }} />
      <Tabs.Screen name="diary" options={{ title: 'Diary' }} />
      <Tabs.Screen name="recipes" options={{ title: 'Library' }} />
      <Tabs.Screen name="progress" options={{ title: 'Progress' }} />
      <Tabs.Screen name="plan" options={{ title: 'Plan' }} />
    </Tabs>
  );
}

export default function PatientTabLayout() {
  const { mode, hydrated, demoAdmitted } = useAppMode();
  const patient = usePatient();
  const { resolving, account, accountNotice, retryResolve } = usePatientAccount();
  const pathname = usePathname();
  const syncNotice = usePatientSyncNotice();

  // A patient group can be mounted by a deep link before the root admission
  // decision has settled.  Keep that path data-free rather than returning
  // null: the root gate and this layout now have a stable, non-interactive
  // frame to paint while account and patient hydration run independently.
  if (mode !== 'patient') {
    if (!hydrated) {
      return (
        <PatientRouteShell
          pathname={pathname}
          status="loading"
          detail="Preparing your space."
        />
      );
    }
    return <Redirect href={mode === 'staff' ? '/' : '/patient-welcome'} />;
  }

  const patientHydrated = patient.hydrated;
  // The guided demo has no server admission fields, but it still has a
  // persisted local store to read.  Treat an admitted demo held at that
  // boundary as loading too; otherwise the consent/onboarding detail below
  // is rendered briefly while the demo store is still unknown.
  const loading =
    !hydrated ||
    resolving ||
    (!patientHydrated &&
      (account.kind === 'real' || (account.kind === 'demo' && demoAdmitted)));
  const admitted =
    !loading &&
    ((account.kind === 'demo' && demoAdmitted && patientHydrated) ||
      (account.kind === 'real' &&
        patientHydrated &&
        patient.hydratedFlags?.onboardingComplete === true &&
        patient.hydratedPrivacy?.consent.satisfied === true &&
        patient.hydratedPrivacy?.deletion === null));

  // The tab bar contains only destinations and is safe for an already
  // admitted demo while its local store finishes reading.  Real accounts do
  // not receive it until their own record, onboarding, and consent are known.
  const navigationAllowed =
    account.kind === 'demo' && demoAdmitted ||
    account.kind === 'real' && admitted;

  if (!admitted) {
    let status: PatientShellStatus = loading ? 'loading' : 'denied';
    let detail: string | undefined;
    let onRetry: (() => void) | undefined;

    if (syncNotice) {
      status = 'error';
      detail = syncNotice.message;
      onRetry = account.kind === 'unresolved' ? retryResolve : patient.rehydrate;
    } else if (account.kind === 'unresolved' && !resolving) {
      status = 'offline';
      detail = accountNotice ?? undefined;
      onRetry = retryResolve;
    } else if (!loading) {
      detail =
        account.kind === 'demo' && !demoAdmitted
          ? 'Sign in or choose the guided patient demo before opening patient data.'
          : patient.hydratedPrivacy?.consent.satisfied !== true
            ? 'Consent is required before your private record can open.'
            : 'Finish onboarding before opening your private record.';
    }

    return (
      <PatientRouteShell
        pathname={pathname}
        status={status}
        detail={detail}
        onRetry={onRetry}
        navigationAllowed={navigationAllowed}
      />
    );
  }

  // The floating row mounts once here, beside the navigator, so every
  // patient screen shows the same bar + circle (mirrors the staff layout's
  // launcher mount in app/(tabs)/_layout.tsx).
  return (
    <View style={layoutStyles.container}>
      <PatientTabs />
      <PatientTabBar />
      <PatientFabMenu />
      {/* Offline-queue status, above the pill bar; real accounts only. */}
      <SyncStatusChip />
    </View>
  );
}

const layoutStyles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
