/**
 * Privacy & data controls on the account screen: consent status, a
 * self-service data export (request → status → download), and account
 * closure with a typed confirmation, a grace countdown, and cancel.
 *
 * Everything here is real-account only. The demo persona and the
 * account-less states render one honest "unavailable" card instead of
 * buttons that would silently do nothing.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { ErrorBox, FieldLabel, GhostButton, LedgerInput, PrimaryButton } from '@/components/onboarding/OnboardingFields';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';
import { useColors } from '@/hooks/useColors';
import { usePatient } from '@/context/PatientContext';
import { usePatientAccount } from '@/context/PatientAccountContext';
import {
  describeExport,
  describeGrace,
  exportIsExpired,
  type ExportJob,
  type PrivacyState,
} from '@/lib/patient-privacy';

export const DELETE_CONFIRM_WORD = 'DELETE';
const EXPORT_POLL_MS = 15_000;

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : 'That didn’t go through. Please try again.';
}

export function PrivacyDataControls() {
  const colors = useColors();
  const patient = usePatient();
  const { account } = usePatientAccount();
  const privacy = patient.hydratedPrivacy;
  const [busy, setBusy] = useState<'export' | 'download' | 'delete' | 'cancel' | 'photo' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const api = account.kind === 'real' ? account.api.privacy : null;
  const applyPrivacy = patient.applyPrivacy;

  const patch = useCallback(
    (part: Partial<PrivacyState>) =>
      applyPrivacy(previous => (previous ? { ...previous, ...part } : previous)),
    [applyPrivacy],
  );

  // While an archive is being built, poll the export status so the download
  // button appears without a reload (the push notification covers the
  // backgrounded case).
  const exportJob = privacy?.export ?? null;
  const exportInFlight = exportJob?.status === 'queued' || exportJob?.status === 'running';
  useEffect(() => {
    if (!api || !exportInFlight) return;
    const timer = setInterval(() => {
      api.fetchExport().then(
        result => { if (mounted.current) patch({ export: result.export }); },
        () => { /* transient; the next tick retries */ },
      );
    }, EXPORT_POLL_MS);
    return () => clearInterval(timer);
  }, [api, exportInFlight, patch]);

  if (!api || !privacy) {
    return (
      <LedgerCard style={styles.card} testID="privacy-unavailable">
        <Text style={[styles.body, { color: colors.bodyText }]}>
          {account.kind === 'demo'
            ? 'Consent records, data export, and account deletion apply to real patient accounts. The guided demo holds no personal data to export or delete.'
            : 'Consent, data export, and account deletion become available once your account has finished loading.'}
        </Text>
      </LedgerCard>
    );
  }

  const run = async (kind: NonNullable<typeof busy>, work: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await work();
    } catch (caught) {
      if (mounted.current) setError(errorMessage(caught));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const requestExport = () =>
    run('export', async () => {
      const result = await api.requestExport();
      patch({ export: result.export });
    });

  const download = (job: ExportJob) =>
    run('download', async () => {
      const link = await api.exportDownloadUrl(job.id);
      await Linking.openURL(link.url);
    });

  const requestDeletion = () =>
    run('delete', async () => {
      const result = await api.requestDeletion();
      patch({ deletion: result.deletion });
      setConfirming(false);
      setConfirmText('');
    });

  const cancelDeletion = () =>
    run('cancel', async () => {
      await api.cancelDeletion();
      patch({ deletion: null });
    });

  const consent = privacy.consent;

  // Photo analysis is the one optional item, and the server enforces it on
  // every photo route — so the switch here re-records the current policy
  // version with the new choice (the required items stay agreed).
  const setPhotoAnalysis = (photoAnalysis: boolean) =>
    run('photo', async () => {
      const result = await api.recordConsent({
        policyVersion: consent.requiredVersion,
        terms: true,
        privacy: true,
        healthData: true,
        photoAnalysis,
        appVersion: Constants.expoConfig?.version ?? 'unknown',
        platform: Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web',
      });
      patch({ consent: result.consent });
    });
  const deletion = privacy.deletion;
  const retentionYears = privacy.deletionPolicy.retentionYears;
  const exportReady = exportJob?.status === 'ready' && !exportIsExpired(exportJob);
  const confirmMatches = confirmText.trim().toUpperCase() === DELETE_CONFIRM_WORD;

  return (
    <LedgerCard style={styles.card} testID="privacy-controls">
      <FieldLabel text="Consent" />
      <Text testID="privacy-consent-status" style={[styles.body, { color: colors.bodyText }]}>
        {consent.satisfied
          ? `You agreed to the terms, privacy policy, and health-data processing (policy ${consent.recordedVersion})${consent.recordedAt ? ` on ${new Date(consent.recordedAt).toLocaleDateString()}` : ''}. Photo analysis: ${consent.photoAnalysis ? 'on' : 'off'}.`
          : `Policy ${consent.requiredVersion} is waiting for your review.`}
      </Text>
      {consent.satisfied ? (
        <GhostButton
          testID="privacy-photo-analysis-toggle"
          label={
            busy === 'photo'
              ? 'Saving…'
              : consent.photoAnalysis
                ? 'Turn photo analysis off'
                : 'Turn photo analysis on'
          }
          disabled={busy !== null || deletion !== null}
          onPress={() => void setPhotoAnalysis(!consent.photoAnalysis)}
          style={styles.smallGap}
        />
      ) : null}
      <Text style={[styles.hint, { color: colors.labelText }]}>
        Photo analysis lets the coach read meal, label, and menu photos you choose to share. When it is off, those photo features are unavailable.
      </Text>

      <View style={styles.gap}>
        <FieldLabel text="Your data" />
        <Text testID="privacy-export-status" style={[styles.body, { color: colors.bodyText }]}>
          {describeExport(exportJob)}
        </Text>
        {exportReady && exportJob ? (
          <PrimaryButton
            testID="privacy-export-download"
            label={busy === 'download' ? 'Opening…' : 'Download archive'}
            disabled={busy !== null}
            onPress={() => void download(exportJob)}
            style={styles.smallGap}
          />
        ) : null}
        <GhostButton
          testID="privacy-export-request"
          label={busy === 'export' ? 'Requesting…' : exportInFlight ? 'Preparing your archive…' : exportJob ? 'Request a new export' : 'Request my data'}
          disabled={busy !== null || exportInFlight || deletion !== null}
          onPress={() => void requestExport()}
          style={styles.smallGap}
        />
      </View>

      <View style={styles.gap}>
        <FieldLabel text="Close my account" />
        {deletion ? (
          <View
            testID="privacy-deletion-pending"
            accessibilityRole="alert"
            style={[styles.notice, { backgroundColor: colors.warnBg, borderColor: colors.warnBorder, borderRadius: colors.radiusSm }]}
          >
            <Text style={[styles.body, { color: colors.warnText }]}>
              {describeGrace(deletion.purgeAfter)} Choose “Keep my account” before then to cancel the closure.
            </Text>
            <PrimaryButton
              testID="privacy-deletion-cancel"
              label={busy === 'cancel' ? 'Keeping…' : 'Keep my account'}
              disabled={busy !== null}
              onPress={() => void cancelDeletion()}
              style={styles.smallGap}
            />
          </View>
        ) : confirming ? (
          <View testID="privacy-deletion-confirm">
            <Text style={[styles.body, { color: colors.bodyText }]}>
              Closing your account removes your login and devices, AI coach chats, food diary, and preferences. Your provider is required by law to keep your medical record — weights and measurements, medications, labs, progress photos, care-team messages, and orders — for {retentionYears} years. After that, it is deleted. You have 7 days to change your mind by signing in. Type {DELETE_CONFIRM_WORD} to continue.
            </Text>
            <LedgerInput
              testID="privacy-deletion-confirm-input"
              value={confirmText}
              onChangeText={setConfirmText}
              autoCapitalize="characters"
              autoCorrect={false}
              placeholder={DELETE_CONFIRM_WORD}
              accessibilityLabel={`Type ${DELETE_CONFIRM_WORD} to confirm`}
            />
            <PrimaryButton
              testID="privacy-deletion-submit"
              label={busy === 'delete' ? 'Closing…' : 'Close my account'}
              disabled={busy !== null || !confirmMatches}
              onDisabledPress={() => setError(`Type ${DELETE_CONFIRM_WORD} exactly to confirm.`)}
              onPress={() => void requestDeletion()}
              style={styles.smallGap}
            />
            <GhostButton
              testID="privacy-deletion-back"
              label="Never mind"
              disabled={busy !== null}
              onPress={() => { setConfirming(false); setConfirmText(''); setError(null); }}
              style={styles.smallGap}
            />
          </View>
        ) : (
          <>
            <Text style={[styles.body, { color: colors.bodyText }]}>
              Close your account after a 7-day grace period. Personal app data is removed, while your provider keeps the medical record required by law for {retentionYears} years.
            </Text>
            <GhostButton
              testID="privacy-deletion-start"
              label="Close my account…"
              disabled={busy !== null}
              onPress={() => setConfirming(true)}
              style={styles.smallGap}
            />
          </>
        )}
      </View>

      {error ? <ErrorBox testID="privacy-error" message={error} /> : null}
      {Platform.OS === 'web' && exportReady ? (
        <Text style={[styles.hint, { color: colors.subtleText }]}>Downloads open in a new browser tab.</Text>
      ) : null}
    </LedgerCard>
  );
}

const styles = StyleSheet.create({
  card: { padding: 14 },
  gap: { marginTop: 14 },
  smallGap: { marginTop: 9 },
  notice: { borderWidth: 1, padding: 12 },
  body: { fontSize: 13, lineHeight: 19, fontFamily: 'Inter_500Medium' },
  hint: { fontSize: 11, marginTop: 8, fontFamily: 'Inter_400Regular' },
});
