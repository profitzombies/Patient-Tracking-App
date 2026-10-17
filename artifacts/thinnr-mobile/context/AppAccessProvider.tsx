/**
 * AppAccessProvider — reads the signed-in patient's app-access entitlement
 * and hosts the one upgrade sheet.
 *
 * Reads happen on open, on every account change, when the app returns to
 * the foreground, after a premium request answers 402, and when the patient
 * comes back from the checkout page — so a new subscription unlocks (and a
 * lapse re-locks) without a restart. Demo and signed-out sessions never
 * probe: there is no account to read, and nothing to lock.
 *
 * Account epoch: every account change bumps a generation; a read that
 * started under an earlier generation is discarded on arrival, so a slow
 * answer for patient A can never paint patient B's lock. Mirrors the coach
 * availability probe: a read that cannot answer leaves the state alone —
 * the premium request itself is the authority and answers 402 while
 * locked, which `reportUpgradeRequired` turns into the same lock.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Linking, Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { UpgradeSheet } from '@/components/patient/UpgradeSheet';
import { AppAccessContext, type AppAccessState } from '@/context/AppAccessContext';
import { usePatientAccount } from '@/context/PatientAccountContext';
import {
  fetchPatientAppAccess,
  premiumLocked,
  type AppAccessEntitlement,
  type PatientAppAccess,
} from '@/lib/app-access';

async function openExternal(url: string): Promise<void> {
  if (Platform.OS !== 'web') {
    await WebBrowser.openBrowserAsync(url);
    return;
  }
  const opened = typeof window !== 'undefined' ? window.open(url, '_blank', 'noopener') : null;
  if (!opened) await Linking.openURL(url);
}

export function AppAccessProvider({ children }: { children: React.ReactNode }) {
  const { account, resolving, getAccessToken } = usePatientAccount();
  const realAccount = !resolving && account.kind === 'real' ? account : null;
  const accountKey = realAccount ? `real:${realAccount.patientId}` : null;

  const [access, setAccess] = useState<PatientAppAccess | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [opening, setOpening] = useState(false);

  // Generation of the current account; reads capture it and compare on
  // arrival. Bumped by the account effect below, read synchronously here.
  const epochRef = useRef(0);
  const accountKeyRef = useRef<string | null>(null);
  if (accountKeyRef.current !== accountKey) {
    accountKeyRef.current = accountKey;
    epochRef.current += 1;
  }
  const getTokenRef = useRef(getAccessToken);
  getTokenRef.current = getAccessToken;
  const inFlightRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!accountKeyRef.current) return;
    const epoch = epochRef.current;
    inFlightRef.current?.abort();
    const controller = new AbortController();
    inFlightRef.current = controller;
    const getToken = getTokenRef.current ?? (async () => null);
    const result = await fetchPatientAppAccess(getToken, controller.signal);
    if (controller.signal.aborted || epoch !== epochRef.current) return;
    if (inFlightRef.current === controller) inFlightRef.current = null;
    // A read that cannot answer keeps the current state (never a lock on
    // silence, never an unlock either).
    if (result) setAccess(result);
  }, []);

  // Account change: forget the previous account's entitlement and sheet,
  // then read for the new one. No account → nothing to read.
  useEffect(() => {
    setAccess(null);
    setSheetOpen(false);
    setOpening(false);
    if (!accountKey) return;
    void refresh();
    return () => inFlightRef.current?.abort();
  }, [accountKey, refresh]);

  // Foreground return (also fires when the browser hands control back on
  // native, and on web when the checkout tab is left for this one).
  useEffect(() => {
    if (!accountKey) return;
    const listener = AppState.addEventListener('change', state => {
      if (state === 'active') void refresh();
    });
    return () => listener.remove();
  }, [accountKey, refresh]);

  const locked = premiumLocked(access);

  // The lock lifting (payment landed, provider restarted the protocol,
  // office stopped charging) closes the sheet by itself.
  useEffect(() => {
    if (!locked) setSheetOpen(false);
  }, [locked]);

  const openUpgradeSheet = useCallback(() => {
    if (!accountKeyRef.current) return;
    setSheetOpen(true);
  }, []);

  const reportUpgradeRequired = useCallback(
    (entitlement: AppAccessEntitlement | null) => {
      if (!accountKeyRef.current) return;
      setAccess(current => {
        const base: AppAccessEntitlement = entitlement ?? {
          available: false,
          reason: 'locked',
          free_window: current?.free_window ?? null,
          office_charges: current?.office_charges ?? true,
          price_cents: current?.price_cents ?? null,
          cadence: current?.cadence ?? null,
          subscription: current?.subscription ?? null,
        };
        return {
          ...base,
          // The server has the final word on the lock itself.
          available: false,
          subscription_id: current?.subscription_id ?? null,
          checkout_url: current?.checkout_url ?? null,
        };
      });
      setSheetOpen(true);
      // The 402 carries no checkout link; the read supplies it.
      void refresh();
    },
    [refresh],
  );

  const openCheckout = useCallback(async () => {
    const url = access?.checkout_url;
    if (!url || opening) return;
    const epoch = epochRef.current;
    setOpening(true);
    try {
      await openExternal(url);
    } catch (error) {
      console.error('Could not open the app-access checkout page', error);
    } finally {
      if (epoch === epochRef.current) setOpening(false);
    }
    // Native: the in-app browser resolved — the patient is back. Web: the
    // tab switch already fired an AppState 'active'; this read is the
    // belt to that suspender.
    if (epoch === epochRef.current) void refresh();
  }, [access?.checkout_url, opening, refresh]);

  const closeSheet = useCallback(() => setSheetOpen(false), []);

  const value = useMemo<AppAccessState>(
    () => ({ access, locked, refresh, openUpgradeSheet, reportUpgradeRequired }),
    [access, locked, refresh, openUpgradeSheet, reportUpgradeRequired],
  );

  return (
    <AppAccessContext.Provider value={value}>
      {children}
      <UpgradeSheet
        visible={sheetOpen && locked}
        access={access}
        opening={opening}
        onOpenCheckout={() => void openCheckout()}
        onClose={closeSheet}
      />
    </AppAccessContext.Provider>
  );
}
