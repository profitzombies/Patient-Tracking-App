import React, { useState, useRef, useCallback, useEffect } from 'react';
import { View, StyleSheet, Text, Pressable, ActivityIndicator, Alert, TextInput } from 'react-native';
import { PageScrollView as ScrollView } from '@/components/ui/PageScrollView';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { useColors } from '@/hooks/useColors';
import { PatientHeader } from '@/components/patient/PatientHeader';
import { usePatientAccount } from '@/context/PatientAccountContext';
import { usePatient } from '@/context/PatientContext';
import { disposeBloodworkDraftFiles, disposeBloodworkOwnedUri, pickBloodworkPdf, prepareBloodworkImage, prepareBloodworkImageBatch, type BloodworkDraftFile } from '@/lib/bloodwork-media';
import { BloodworkCamera } from '@/components/bloodwork/BloodworkCamera';
import { uploadFileWithProgress } from '@/lib/bloodwork-upload';
import { createBloodworkReport, commitBloodworkReport, deleteBloodworkReport } from '@workspace/api-client-react';
import { supabase, useSupabaseSession } from '@/lib/supabase';
import { assertImageCapacity, bloodworkDraftFingerprint, BLOODWORK_TRANSCRIPTION_DISCLOSURE, BloodworkGeneration, clearDeletedStageRequest, emptyBloodworkDraftMetadata, isCommittedUploadReplay, makeBloodworkUuid } from '@/lib/bloodwork-scope';
import {
  bloodworkEntryRecovery,
  classifyBloodworkError,
  clearRetainedBloodworkDraft,
  setBloodworkRecoveryRoute,
  readRetainedBloodworkDraft,
  retainBloodworkDraft,
  type BloodworkRecovery,
} from '@/lib/bloodwork-recovery';
import { AppModal } from '@/components/ui/AppModal';

type DraftType = 'none' | 'pdf' | 'images';
type CameraCaptureScope = {
  key: string;
  operation: { generation: number; signal: AbortSignal };
  replacing: number | null;
  busyNonce: number;
};

type BusyOwner = {
  accountKey: string;
  nonce: number;
};

export default function NewBloodwork() {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const accountCtx = usePatientAccount();
  const patient = usePatient();
  const { session } = useSupabaseSession();

  const realAccount = accountCtx.account.kind === 'real' ? accountCtx.account : null;
  const canonicalAccountKey = realAccount && session?.user.id
    ? `${session.user.id}:${realAccount.patientId}`
    : null;
  const canonicalAccountKeyRef = useRef<string | null>(canonicalAccountKey);
  if (canonicalAccountKey) canonicalAccountKeyRef.current = canonicalAccountKey;
  // Keep the last verified patient binding as the draft scope while account
  // lookup is transient. Never rewrite a retained draft to an unresolved or
  // newly resolved patient key.
  const accountKey = canonicalAccountKey
    ?? (accountCtx.account.kind === 'unresolved' && session?.user.id &&
      canonicalAccountKeyRef.current?.startsWith(`${session.user.id}:`)
      ? canonicalAccountKeyRef.current
      : 'unavailable');
  const initialRetainedDraft = readRetainedBloodworkDraft(accountKey);
  const [draftType, setDraftType] = useState<DraftType>(
    initialRetainedDraft?.files.length ? (initialRetainedDraft.files[0].mimeType === 'application/pdf' ? 'pdf' : 'images') : 'none',
  );
  const [files, setFiles] = useState<BloodworkDraftFile[]>(() => [...(initialRetainedDraft?.files ?? [])]);
  const [title, setTitle] = useState(initialRetainedDraft?.title ?? '');
  const [reportDate, setReportDate] = useState(initialRetainedDraft?.reportDate ?? '');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0); 
  const [cameraVisible, setCameraVisible] = useState(false);
  const [statusText, setStatusText] = useState('Saving...');
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [retakeIndex, setRetakeIndex] = useState<number | null>(null);
  const [recovery, setRecovery] = useState<BloodworkRecovery | null>(null);
  
  const generationRef = useRef(new BloodworkGeneration());
  const requestRef = useRef<{ fingerprint: string; id: string } | null>(initialRetainedDraft?.request ?? null);
  const saveInFlightRef = useRef(false);
  const busyNonceRef = useRef(0);
  const busyOwnerRef = useRef<BusyOwner | null>(null);
  const cameraCaptureRef = useRef<CameraCaptureScope | null>(null);
  const filesRef = useRef(files);
  filesRef.current = files;
  const accountKeyRef = useRef(accountKey);
  accountKeyRef.current = accountKey;
  const initializedAccountKeyRef = useRef<string | null>(null);

  const isCurrent = useCallback((key: string, generation: number, signal?: AbortSignal) => (
    accountKeyRef.current === key
    && accountCtx.account.kind === 'real'
    && generationRef.current.isCurrent(generation, signal)
  ), [accountCtx.account.kind]);

  const beginBusy = useCallback((key: string, nextStatus: string): number => {
    const owner = { accountKey: key, nonce: ++busyNonceRef.current };
    busyOwnerRef.current = owner;
    setBusy(true);
    setStatusText(nextStatus);
    return owner.nonce;
  }, []);

  const ownsBusy = useCallback((key: string, nonce: number): boolean => (
    busyOwnerRef.current?.accountKey === key
    && busyOwnerRef.current.nonce === nonce
  ), []);

  const finishBusy = useCallback((key: string, nonce: number, cancelled = false): void => {
    if (!ownsBusy(key, nonce)) return;
    busyOwnerRef.current = null;
    setBusy(false);
    if (cancelled) setStatusText('Upload cancelled');
  }, [ownsBusy]);

  useEffect(() => {
    const previousKey = initializedAccountKeyRef.current;
    initializedAccountKeyRef.current = accountKey;
    generationRef.current.cancel();
    busyOwnerRef.current = null;
    saveInFlightRef.current = false;
    requestRef.current = null;
    const staleFiles = filesRef.current;
    const retained = readRetainedBloodworkDraft(accountKey);
    if (previousKey && previousKey !== accountKey) {
      void clearRetainedBloodworkDraft(previousKey, { disposeFiles: false });
    }
    setFiles(retained ? [...retained.files] : []);
    setDraftType(
      retained?.files.length
        ? retained.files[0].mimeType === 'application/pdf' ? 'pdf' : 'images'
        : 'none',
    );
    setCameraVisible(false);
    setPreviewIndex(null);
    setRetakeIndex(null);
    setBusy(false);
    setRecovery(null);
    setTitle(retained?.title ?? emptyBloodworkDraftMetadata().title);
    setReportDate(retained?.reportDate ?? emptyBloodworkDraftMetadata().reportDate);
    requestRef.current = retained?.request ?? null;
    const retainedFileIds = new Set(retained?.files.map(file => file.clientFileId) ?? []);
    const staleOwnedFiles = staleFiles.filter(file => !retainedFileIds.has(file.clientFileId));
    if (staleOwnedFiles.length > 0) void disposeBloodworkDraftFiles(staleOwnedFiles);
  }, [accountKey]);

  useEffect(() => {
    if (accountCtx.account.kind !== 'real') {
      generationRef.current.cancel();
      busyOwnerRef.current = null;
      saveInFlightRef.current = false;
      setBusy(false);
    }
  }, [accountCtx.account.kind]);

  useEffect(() => () => {
    generationRef.current.cancel();
    saveInFlightRef.current = false;
    // A retained draft is deliberately allowed to cross the setup/consent/
    // sign-in route transition. The root lifecycle rail disposes it on a
    // real sign-out or patient identity switch.
    if (!readRetainedBloodworkDraft(accountKeyRef.current)) {
      void disposeBloodworkDraftFiles(filesRef.current);
    }
  }, []);

  const abandonRetainedDraft = useCallback(() => {
    void clearRetainedBloodworkDraft(accountKey, { disposeFiles: false });
    requestRef.current = null;
    setRecovery(null);
  }, [accountKey]);

  useEffect(() => {
    if (!recovery || busy || recovery.actionLabel !== null) return;
    const entry = bloodworkEntryRecovery({
      accountKind: accountCtx.account.kind,
      accountResolving: accountCtx.resolving,
      patientHydrated: patient.hydrated,
      onboardingComplete: patient.hydratedFlags?.onboardingComplete ?? null,
      consentSatisfied: patient.hydratedPrivacy?.consent.satisfied ?? null,
    });
    if (entry !== null) return;
    if (recovery.action !== 'retry' && recovery.action !== 'account') return;
    setRecovery({
      ...recovery,
      title: recovery.action === 'account' ? 'Account ready to check' : 'Ready to retry',
      message: 'Your account is ready. Try the report again without losing this draft.',
      actionLabel: recovery.action === 'account' ? 'Try account again' : 'Try again',
    });
  }, [
    accountCtx.account.kind,
    accountCtx.resolving,
    busy,
    patient.hydrated,
    patient.hydratedFlags?.onboardingComplete,
    patient.hydratedPrivacy?.consent.satisfied,
    recovery,
  ]);

  const addPdf = async () => {
    if (busyOwnerRef.current || saveInFlightRef.current) return;
    const key = accountKey;
    const operation = generationRef.current.begin();
    const busyNonce = beginBusy(key, 'Choosing PDF...');
    try {
      const file = await pickBloodworkPdf();
      if (!file || !isCurrent(key, operation.generation, operation.signal)) {
        if (file) void disposeBloodworkDraftFiles([file]);
        return;
      }
      abandonRetainedDraft();
      await disposeBloodworkDraftFiles(filesRef.current);
      if (!isCurrent(key, operation.generation, operation.signal)) {
        void disposeBloodworkDraftFiles([file]);
        return;
      }
      setDraftType('pdf');
      setFiles([file]);
      setTitle(file.fileName || 'PDF Report');
    } catch (e: any) {
      if (isCurrent(key, operation.generation, operation.signal)) Alert.alert('Error', e.message);
    } finally {
      finishBusy(key, busyNonce, operation.signal.aborted);
    }
  };

  const beginCameraCapture = useCallback((): CameraCaptureScope | null => {
    if (busyOwnerRef.current || saveInFlightRef.current) return null;
    try {
      if (retakeIndex === null) assertImageCapacity(filesRef.current.length, 1);
    } catch (error) {
      Alert.alert('Limit Reached', error instanceof Error ? error.message : 'You can upload up to 10 images.');
      return null;
    }
    const operation = generationRef.current.begin();
    const busyNonce = beginBusy(accountKey, 'Preparing image...');
    const scope = {
      key: accountKey,
      operation,
      replacing: retakeIndex,
      busyNonce,
    };
    cameraCaptureRef.current = scope;
    return scope;
  }, [accountKey, beginBusy, busy, retakeIndex]);

  const handleCameraCapture = async (uri: string, width: number, height: number, rawScope: unknown) => {
    const { key, operation, replacing } = rawScope as CameraCaptureScope;
    const scope = rawScope as CameraCaptureScope;
    if (saveInFlightRef.current || !ownsBusy(key, scope.busyNonce)) {
      void disposeBloodworkOwnedUri(uri);
      return;
    }
    if (cameraCaptureRef.current?.busyNonce === scope.busyNonce) cameraCaptureRef.current = null;
    setCameraVisible(false);
    abandonRetainedDraft();
    try {
      const prepped = await prepareBloodworkImage({ uri, width, height, type: 'image' });
      if (!isCurrent(key, operation.generation, operation.signal)) {
        void disposeBloodworkDraftFiles([prepped]);
        return;
      }
      setDraftType('images');
      setFiles(prev => {
        if (replacing === null) return [...prev, prepped];
        const next = [...prev];
        const old = next[replacing];
        next[replacing] = prepped;
        if (old) void disposeBloodworkDraftFiles([old]);
        return next;
      });
      setRetakeIndex(null);
      if (!title) setTitle('Image Report');
    } catch (e: any) {
      if (isCurrent(key, operation.generation, operation.signal)) Alert.alert('Error', e.message);
    } finally {
      await disposeBloodworkOwnedUri(uri);
      finishBusy(key, scope.busyNonce, operation.signal.aborted);
    }
  };

  const addLibraryImages = async () => {
    if (busyOwnerRef.current || saveInFlightRef.current) return;
    if (files.length >= 10) {
      Alert.alert('Limit Reached', 'You can upload up to 10 images.');
      return;
    }
    const key = accountKey;
    const operation = generationRef.current.begin();
    const busyNonce = beginBusy(key, 'Choosing images...');
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!isCurrent(key, operation.generation, operation.signal)) return;
      if (!perm.granted) {
        Alert.alert('Photo Access Needed', 'Allow photo access to choose report images.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 1,
        allowsMultipleSelection: true,
        selectionLimit: 10 - files.length,
      });
      if (!isCurrent(key, operation.generation, operation.signal)) return;
      if (result.canceled || !result.assets.length) return;
      assertImageCapacity(filesRef.current.length, result.assets.length);

      abandonRetainedDraft();
      setStatusText('Preparing images...');
      const prepared = await prepareBloodworkImageBatch(
        result.assets,
        () => isCurrent(key, operation.generation, operation.signal),
      );
      if (!prepared.length || !isCurrent(key, operation.generation, operation.signal)) return;
      const newFiles = [...filesRef.current, ...prepared];
      setDraftType('images');
      setFiles(newFiles);
      if (!title) setTitle('Image Report');
    } catch (e: any) {
      if (isCurrent(key, operation.generation, operation.signal)) Alert.alert('Error', e.message);
    } finally {
      finishBusy(key, busyNonce, operation.signal.aborted);
    }
  };

  const removeFile = (index: number) => {
    if (busyOwnerRef.current || saveInFlightRef.current) return;
    abandonRetainedDraft();
    const next = [...files];
    const [removed] = next.splice(index, 1);
    if (removed) void disposeBloodworkDraftFiles([removed]);
    setFiles(next);
    if (next.length === 0) setDraftType('none');
  };

  const moveUp = (index: number) => {
    if (index === 0 || busyOwnerRef.current || saveInFlightRef.current) return;
    abandonRetainedDraft();
    const next = [...files];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    setFiles(next);
  };

  const moveDown = (index: number) => {
    if (index === files.length - 1 || busyOwnerRef.current || saveInFlightRef.current) return;
    abandonRetainedDraft();
    const next = [...files];
    [next[index + 1], next[index]] = [next[index], next[index + 1]];
    setFiles(next);
  };

  const handleUpload = async () => {
    if (busyOwnerRef.current || saveInFlightRef.current) return;
    if (accountCtx.account.kind === 'demo') {
      Alert.alert('Demo Mode', 'Uploading is disabled in demo mode.');
      return;
    }
    if (accountCtx.account.kind === 'unresolved') {
      const unresolvedRecovery = bloodworkEntryRecovery({
        accountKind: accountCtx.account.kind,
        accountResolving: accountCtx.resolving,
        patientHydrated: patient.hydrated,
        onboardingComplete: patient.hydratedFlags?.onboardingComplete ?? null,
        consentSatisfied: patient.hydratedPrivacy?.consent.satisfied ?? null,
      });
      if (unresolvedRecovery && accountKey !== 'unavailable' && files.length > 0 && title.trim()) {
        const unresolvedTitle = title.trim();
        const unresolvedDate = reportDate.trim();
        const unresolvedFingerprint = bloodworkDraftFingerprint(unresolvedTitle, unresolvedDate, files);
        const unresolvedRequest = requestRef.current?.fingerprint === unresolvedFingerprint
          ? requestRef.current
          : { fingerprint: unresolvedFingerprint, id: makeBloodworkUuid() };
        requestRef.current = unresolvedRequest;
        retainBloodworkDraft({
          accountKey,
          files: [...files],
          title: unresolvedTitle,
          reportDate: unresolvedDate,
          request: unresolvedRequest,
        });
      }
      setRecovery(unresolvedRecovery);
      return;
    }
    if (!title.trim() || files.length === 0) return;
    if (saveInFlightRef.current) return;

    const account = accountCtx.account;
    const key = accountKey;
    const operation = generationRef.current.begin();
    const selectedFiles = [...files];
    const selectedTitle = title.trim();
    const selectedDate = reportDate.trim();
    const fingerprint = bloodworkDraftFingerprint(selectedTitle, selectedDate, selectedFiles);
    if (!requestRef.current || requestRef.current.fingerprint !== fingerprint) {
      requestRef.current = { fingerprint, id: makeBloodworkUuid() };
    }
    const clientRequestId = requestRef.current.id;
    let stagedReportId: string | null = null;
    let committed = false;
    let capturedToken: string | null = null;
    const busyNonce = beginBusy(key, 'Creating report...');
    setProgress(0);
    setRecovery(null);
    saveInFlightRef.current = true;

    try {
      const entryRecovery = bloodworkEntryRecovery({
        accountKind: accountCtx.account.kind,
        accountResolving: accountCtx.resolving,
        patientHydrated: patient.hydrated,
        onboardingComplete: patient.hydratedFlags?.onboardingComplete ?? null,
        consentSatisfied: patient.hydratedPrivacy?.consent.satisfied ?? null,
      });
      if (entryRecovery) {
        retainBloodworkDraft({
          accountKey: key,
          files: selectedFiles,
          title: selectedTitle,
          reportDate: selectedDate,
          request: { fingerprint, id: clientRequestId },
        });
        setRecovery(entryRecovery);
        return;
      }

      const token = await accountCtx.getAccessToken?.();
      capturedToken = token ?? null;
      if (!isCurrent(key, operation.generation, operation.signal)) return;
      if (!token) throw { status: 401, data: { code: 'SESSION_REQUIRED' } };

      const headers = { Authorization: `Bearer ${token}` };

      const { reportId, uploads } = await createBloodworkReport(
        account.patientId,
        {
          clientRequestId,
          title: selectedTitle,
          reportDate: selectedDate || null,
          transcriptionConsent: true,
          files: selectedFiles.map(f => ({
            clientFileId: f.clientFileId,
            mimeType: f.mimeType === 'application/pdf' ? 'application/pdf' : 'image/jpeg',
            size: f.size,
          })),
        },
        { headers, signal: operation.signal }
      );
      stagedReportId = reportId;
      if (!isCurrent(key, operation.generation, operation.signal)) return;

      if (isCommittedUploadReplay(uploads.length, selectedFiles.length)) {
        committed = true;
        setProgress(100);
        await clearRetainedBloodworkDraft(key);
        if (!isCurrent(key, operation.generation, operation.signal)) return;
        router.replace(`/bloodwork/${reportId}`);
        return;
      }
      
      setProgress(10);
      setStatusText('Uploading files...');
      
      let uploadProgress = 10;
      const step = 80 / selectedFiles.length;
      
      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];
        const upload = uploads.find(u => u.clientFileId === file.clientFileId);
        if (!upload) throw new Error('Missing upload URL for file');
        
        await uploadFileWithProgress(upload.uploadUrl, file.uri, file.mimeType, (p) => {
           if (isCurrent(key, operation.generation, operation.signal)) {
             setProgress(uploadProgress + (p / 100) * step);
           }
        }, operation.signal);
        
        uploadProgress += step;
        if (!isCurrent(key, operation.generation, operation.signal)) return;
      }

      setStatusText('Committing report...');
      await commitBloodworkReport(
        account.patientId,
        reportId,
        { headers, signal: operation.signal }
      );
      committed = true;
      if (!isCurrent(key, operation.generation, operation.signal)) return;
      
      setProgress(100);
      await clearRetainedBloodworkDraft(key);
      if (!isCurrent(key, operation.generation, operation.signal)) return;
      router.replace(`/bloodwork/${reportId}`);
    } catch (e: unknown) {
      if (isCurrent(key, operation.generation, operation.signal)) {
        const nextRecovery = classifyBloodworkError(e);
        // Keep this exact request id and manifest. The server replays the
        // staged report for a repeated clientRequestId, so same-draft retries
        // cannot create a second report.
        requestRef.current = { fingerprint, id: clientRequestId };
        retainBloodworkDraft({
          accountKey: key,
          files: selectedFiles,
          title: selectedTitle,
          reportDate: selectedDate,
          request: { fingerprint, id: clientRequestId },
        });
        setRecovery(nextRecovery);
      }
    } finally {
      const retainedForRecovery = Boolean(readRetainedBloodworkDraft(key));
      const cleaningCancelledStage =
        operation.signal.aborted &&
        stagedReportId &&
        capturedToken &&
        !committed &&
        !retainedForRecovery;
      if (cleaningCancelledStage) {
        try {
          await deleteBloodworkReport(
            account.patientId,
            stagedReportId!,
            { expectedVersion: 1 },
            { headers: { Authorization: `Bearer ${capturedToken}` } },
          );
          requestRef.current = clearDeletedStageRequest(requestRef.current, clientRequestId);
        } catch {
          // The server's staged-object reconciliation is the final cleanup rail.
        }
      }
      if (accountKeyRef.current === key) {
        finishBusy(key, busyNonce, operation.signal.aborted);
      }
      saveInFlightRef.current = false;
    }
  };

  const handleRecoveryAction = async () => {
    if (!recovery || busy) return;
    switch (recovery.action) {
      case 'setup':
        patient.rehydrate();
        setBloodworkRecoveryRoute('/onboarding/welcome', accountKey);
        router.push('/onboarding/welcome');
        return;
      case 'consent':
        patient.rehydrate();
        setBloodworkRecoveryRoute('/consent', accountKey);
        router.push('/consent');
        return;
      case 'account':
        setRecovery({
          ...recovery,
          title: 'Checking your account…',
          message: 'Refreshing your patient account before offering another action.',
          actionLabel: null,
        });
        patient.rehydrate();
        accountCtx.retryResolve();
        return;
      case 'retry': {
        const entry = bloodworkEntryRecovery({
          accountKind: accountCtx.account.kind,
          accountResolving: accountCtx.resolving,
          patientHydrated: patient.hydrated,
          onboardingComplete: patient.hydratedFlags?.onboardingComplete ?? null,
          consentSatisfied: patient.hydratedPrivacy?.consent.satisfied ?? null,
        });
        if (
          accountCtx.account.kind === 'real' &&
          !accountCtx.resolving &&
          entry === null
        ) {
          await handleUpload();
          return;
        }
        setRecovery({
          ...recovery,
          title: 'Checking your account…',
          message: 'Refreshing your patient account before offering another action.',
          actionLabel: null,
        });
        patient.rehydrate();
        accountCtx.retryResolve();
        return;
      }
      case 'sign_in': {
        const result = await supabase?.auth.refreshSession();
        if (result?.error || !result?.data.session) {
          router.push('/patient-login');
          return;
        }
        patient.rehydrate();
        accountCtx.retryResolve();
        setRecovery(null);
        return;
      }
      case 'none':
        return;
    }
  };

  const closeCamera = useCallback(() => {
    const scope = cameraCaptureRef.current;
    if (scope) {
      cameraCaptureRef.current = null;
      generationRef.current.cancel();
      finishBusy(scope.key, scope.busyNonce, true);
    }
    setCameraVisible(false);
    setRetakeIndex(null);
  }, [finishBusy]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <PatientHeader
        title="New Report"
        right={(
          <Pressable onPress={() => router.back()} accessibilityLabel="Back to bloodwork">
            <Feather name="arrow-left" size={20} color={colors.navy} />
          </Pressable>
        )}
      />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, 24) }]}>
        
        <View style={styles.formGroup}>
          <Text style={[styles.label, { color: colors.labelText }]}>REPORT TITLE</Text>
          <TextInput
            style={[styles.input, { borderColor: colors.border, color: colors.navy }]}
            value={title}
            editable={!busy && !saveInFlightRef.current}
            onChangeText={value => {
              if (busyOwnerRef.current || saveInFlightRef.current) return;
              if (value !== title) abandonRetainedDraft();
              setTitle(value);
            }}
            placeholder="e.g. Annual Bloodwork 2026"
            placeholderTextColor={colors.subtleText}
          />
        </View>

        <View style={styles.formGroup}>
          <Text style={[styles.label, { color: colors.labelText }]}>REPORT DATE (OPTIONAL)</Text>
          <TextInput
            style={[styles.input, { borderColor: colors.border, color: colors.navy }]}
            value={reportDate}
            editable={!busy && !saveInFlightRef.current}
            onChangeText={value => {
              if (busyOwnerRef.current || saveInFlightRef.current) return;
              if (value !== reportDate) abandonRetainedDraft();
              setReportDate(value);
            }}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={colors.subtleText}
          />
        </View>

        {draftType === 'none' && (
          <View style={styles.pickerActions}>
            <Text style={[styles.label, { color: colors.labelText, marginBottom: 8 }]}>ADD FILES</Text>
            <Pressable disabled={busy || saveInFlightRef.current} onPress={() => { setRetakeIndex(null); setCameraVisible(true); }} style={[styles.btn, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Feather name="camera" size={18} color={colors.cobalt} />
              <Text style={[styles.btnText, { color: colors.navy }]}>Take Photos (up to 10)</Text>
            </Pressable>
            <Pressable disabled={busy || saveInFlightRef.current} onPress={addLibraryImages} style={[styles.btn, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Feather name="image" size={18} color={colors.cobalt} />
              <Text style={[styles.btnText, { color: colors.navy }]}>Choose Images</Text>
            </Pressable>
            <Pressable disabled={busy || saveInFlightRef.current} onPress={addPdf} style={[styles.btn, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Feather name="file-text" size={18} color={colors.cobalt} />
              <Text style={[styles.btnText, { color: colors.navy }]}>Choose PDF (up to 20MB)</Text>
            </Pressable>
          </View>
        )}

        {draftType === 'pdf' && files.length > 0 && (
          <View style={styles.draftSection}>
             <View style={[styles.pdfCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Feather name="file" size={24} color={colors.cobalt} />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={[styles.pdfName, { color: colors.navy }]} numberOfLines={1}>{files[0].fileName}</Text>
                  <Text style={[styles.pdfSize, { color: colors.subtleText }]}>{(files[0].size / 1024 / 1024).toFixed(2)} MB</Text>
                </View>
                <Pressable disabled={busy || saveInFlightRef.current} onPress={() => removeFile(0)} style={styles.removeBtn}>
                  <Feather name="x" size={18} color={colors.subtleText} />
                </Pressable>
             </View>
          </View>
        )}

        {draftType === 'images' && (
          <View style={styles.draftSection}>
             <View style={styles.draftHeader}>
               <Text style={[styles.label, { color: colors.labelText }]}>IMAGES ({files.length}/10)</Text>
               {files.length < 10 && (
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                     <Pressable disabled={busy || saveInFlightRef.current} onPress={() => { setRetakeIndex(null); setCameraVisible(true); }}><Feather name="camera" size={18} color={colors.cobalt}/></Pressable>
                    <Pressable disabled={busy || saveInFlightRef.current} onPress={addLibraryImages}><Feather name="image" size={18} color={colors.cobalt}/></Pressable>
                  </View>
               )}
             </View>
             
             <View style={styles.grid}>
               {files.map((file, i) => (
                 <View key={file.clientFileId} style={[styles.gridItem, { borderColor: colors.border }]}>
                     <Pressable onPress={() => setPreviewIndex(i)} style={StyleSheet.absoluteFill}>
                       <Image source={{ uri: file.uri }} style={styles.gridImg} contentFit="cover" />
                     </Pressable>
                    <View style={styles.gridActions}>
                       <Pressable onPress={() => moveUp(i)} disabled={i === 0 || busy || saveInFlightRef.current} style={styles.gridBtn}>
                        <Feather name="arrow-left" size={12} color={i === 0 ? 'rgba(255,255,255,0.2)' : '#fff'} />
                      </Pressable>
                       <Pressable onPress={() => removeFile(i)} disabled={busy || saveInFlightRef.current} style={styles.gridBtn}>
                        <Feather name="x" size={12} color="#fff" />
                      </Pressable>
                         <Pressable
                           disabled={busy || saveInFlightRef.current}
                         onPress={() => {
                           setRetakeIndex(i);
                           setCameraVisible(true);
                         }}
                         style={styles.gridBtn}
                       >
                         <Feather name="camera" size={12} color="#fff" />
                       </Pressable>
                       <Pressable onPress={() => moveDown(i)} disabled={i === files.length - 1 || busy || saveInFlightRef.current} style={styles.gridBtn}>
                        <Feather name="arrow-right" size={12} color={i === files.length - 1 ? 'rgba(255,255,255,0.2)' : '#fff'} />
                      </Pressable>
                    </View>
                 </View>
               ))}
             </View>
          </View>
        )}

        {files.length > 0 && (
          <View style={styles.footer}>
            <Text style={[styles.disclosure, { color: colors.subtleText }]}>
              {BLOODWORK_TRANSCRIPTION_DISCLOSURE}
            </Text>
            {recovery ? (
              <View
                testID="bloodwork-recovery"
                accessibilityRole="alert"
                style={[
                  styles.recoveryBox,
                  { backgroundColor: colors.warnBg, borderColor: colors.warnBorder },
                ]}
              >
                <Text style={[styles.recoveryTitle, { color: colors.navy }]}>{recovery.title}</Text>
                <Text style={[styles.recoveryMessage, { color: colors.bodyText }]}>{recovery.message}</Text>
                {recovery.actionLabel ? (
                  <Pressable
                    testID="bloodwork-recovery-action"
                    onPress={() => void handleRecoveryAction()}
                    disabled={busy}
                    style={[styles.recoveryAction, { borderColor: colors.cobalt }]}
                  >
                    <Text style={[styles.recoveryActionText, { color: colors.cobalt }]}>
                      {recovery.actionLabel}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
            {busy && (
               <View style={styles.progressWrap}>
                  <View style={[styles.progressBar, { backgroundColor: colors.border }]}>
                    <View style={[styles.progressFill, { backgroundColor: colors.cobalt, width: `${progress}%` }]} />
                  </View>
                  <Text style={{ fontSize: 11, color: colors.subtleText, marginTop: 4 }}>{statusText} {Math.round(progress)}%</Text>
                  <Pressable
                    onPress={() => {
                      generationRef.current.cancel();
                       setStatusText('Cancelling upload...');
                    }}
                    style={styles.cancelUpload}
                  >
                    <Text style={{ color: colors.destructive, fontFamily: 'Inter_600SemiBold' }}>Cancel upload</Text>
                  </Pressable>
               </View>
            )}
            
            <Pressable 
               onPress={handleUpload}
               disabled={busy || saveInFlightRef.current || !title}
               style={({pressed}) => [
                 styles.submitBtn,
                 { backgroundColor: colors.cobalt },
                 (busy || saveInFlightRef.current || !title) && { opacity: 0.5 },
                 pressed && !busy && { opacity: 0.8 }
               ]}
            >
              {busy && statusText.startsWith('Upload') ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>Save & Process</Text>}
            </Pressable>
          </View>
        )}

      </ScrollView>

      <BloodworkCamera 
         visible={cameraVisible} 
         onClose={closeCamera}
         onCaptureStart={beginCameraCapture}
         onCapture={handleCameraCapture}
         onDiscard={uri => { void disposeBloodworkOwnedUri(uri); }}
      />
      <AppModal
        visible={previewIndex !== null}
        onRequestClose={() => setPreviewIndex(null)}
        animationType="fade"
        transparent
      >
        <View style={styles.preview}>
          {previewIndex !== null && files[previewIndex] ? (
            <Image source={{ uri: files[previewIndex].uri }} style={styles.previewImage} contentFit="contain" />
          ) : null}
          <Pressable onPress={() => setPreviewIndex(null)} style={styles.previewClose} accessibilityLabel="Close preview">
            <Feather name="x" size={24} color="#fff" />
          </Pressable>
        </View>
      </AppModal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16 },
  formGroup: { marginBottom: 20 },
  label: { fontSize: 10, fontFamily: 'Inter_700Bold', letterSpacing: 1, marginBottom: 8 },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    height: 48,
    paddingHorizontal: 12,
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
  },
  pickerActions: { marginTop: 10, gap: 12 },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 8,
    padding: 16,
    gap: 12,
  },
  btnText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  draftSection: { marginTop: 10 },
  pdfCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderWidth: 1,
    borderRadius: 8,
  },
  pdfName: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  pdfSize: { fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 2 },
  removeBtn: { padding: 8 },
  draftHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  gridItem: { width: '48%', aspectRatio: 1, borderRadius: 8, overflow: 'hidden', borderWidth: 1 },
  gridImg: { width: '100%', height: '100%' },
  gridActions: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
    height: 28,
    backgroundColor: 'rgba(0,0,0,0.6)',
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  gridBtn: { padding: 4 },
  footer: { marginTop: 32 },
  disclosure: { fontSize: 12, lineHeight: 18, fontFamily: 'Inter_400Regular', marginBottom: 14 },
  recoveryBox: { borderWidth: 1, borderRadius: 8, padding: 14, marginBottom: 16 },
  recoveryTitle: { fontSize: 15, fontFamily: 'Inter_700Bold' },
  recoveryMessage: { fontSize: 13, lineHeight: 19, fontFamily: 'Inter_400Regular', marginTop: 6 },
  recoveryAction: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: 7, paddingHorizontal: 13, paddingVertical: 9, marginTop: 12 },
  recoveryActionText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  submitBtn: {
    height: 52,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitText: { color: '#fff', fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  progressWrap: { marginBottom: 16, alignItems: 'center' },
  progressBar: { width: '100%', height: 4, borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: '100%' },
  cancelUpload: { padding: 10, marginTop: 4 },
  preview: { flex: 1, backgroundColor: 'rgba(0,0,0,0.94)', justifyContent: 'center' },
  previewImage: { width: '100%', height: '100%' },
  previewClose: { position: 'absolute', top: 24, right: 16, padding: 12 },
});
