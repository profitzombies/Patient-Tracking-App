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
import { disposeBloodworkDraftFiles, disposeBloodworkOwnedUri, pickBloodworkPdf, prepareBloodworkImage, prepareBloodworkImageBatch, type BloodworkDraftFile } from '@/lib/bloodwork-media';
import { BloodworkCamera } from '@/components/bloodwork/BloodworkCamera';
import { uploadFileWithProgress } from '@/lib/bloodwork-upload';
import { createBloodworkReport, commitBloodworkReport, deleteBloodworkReport } from '@workspace/api-client-react';
import { useSupabaseSession } from '@/lib/supabase';
import { assertImageCapacity, bloodworkDraftFingerprint, BLOODWORK_TRANSCRIPTION_DISCLOSURE, BloodworkGeneration, clearDeletedStageRequest, emptyBloodworkDraftMetadata, isCommittedUploadReplay, makeBloodworkUuid } from '@/lib/bloodwork-scope';
import { AppModal } from '@/components/ui/AppModal';

type DraftType = 'none' | 'pdf' | 'images';
type CameraCaptureScope = {
  key: string;
  operation: { generation: number; signal: AbortSignal };
  replacing: number | null;
};

export default function NewBloodwork() {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const accountCtx = usePatientAccount();
  const { session } = useSupabaseSession();
  
  const [draftType, setDraftType] = useState<DraftType>('none');
  const [files, setFiles] = useState<BloodworkDraftFile[]>([]);
  const [title, setTitle] = useState('');
  const [reportDate, setReportDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0); 
  const [cameraVisible, setCameraVisible] = useState(false);
  const [statusText, setStatusText] = useState('Saving...');
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [retakeIndex, setRetakeIndex] = useState<number | null>(null);
  
  const generationRef = useRef(new BloodworkGeneration());
  const requestRef = useRef<{ fingerprint: string; id: string } | null>(null);
  const filesRef = useRef(files);
  filesRef.current = files;
  const realAccount = accountCtx.account.kind === 'real' ? accountCtx.account : null;
  const accountKey = realAccount && session?.user.id ? `${session.user.id}:${realAccount.patientId}` : 'unavailable';
  const accountKeyRef = useRef(accountKey);
  accountKeyRef.current = accountKey;

  const isCurrent = useCallback((key: string, generation: number, signal?: AbortSignal) => (
    accountKeyRef.current === key
    && accountCtx.account.kind === 'real'
    && generationRef.current.isCurrent(generation, signal)
  ), [accountCtx.account.kind]);

  useEffect(() => {
    generationRef.current.cancel();
    requestRef.current = null;
    const staleFiles = filesRef.current;
    setFiles([]);
    setDraftType('none');
    setCameraVisible(false);
    setPreviewIndex(null);
    setRetakeIndex(null);
    setBusy(false);
    const clearedMetadata = emptyBloodworkDraftMetadata();
    setTitle(clearedMetadata.title);
    setReportDate(clearedMetadata.reportDate);
    void disposeBloodworkDraftFiles(staleFiles);
  }, [accountKey]);

  useEffect(() => () => {
    generationRef.current.cancel();
    void disposeBloodworkDraftFiles(filesRef.current);
  }, []);

  const addPdf = async () => {
    const key = accountKey;
    const operation = generationRef.current.begin();
    try {
      const file = await pickBloodworkPdf();
      if (!file || !isCurrent(key, operation.generation, operation.signal)) {
        if (file) void disposeBloodworkDraftFiles([file]);
        return;
      }
      await disposeBloodworkDraftFiles(filesRef.current);
      if (!isCurrent(key, operation.generation, operation.signal)) {
        void disposeBloodworkDraftFiles([file]);
        return;
      }
      setDraftType('pdf');
      setFiles([file]);
      setTitle(file.fileName || 'PDF Report');
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
  };

  const beginCameraCapture = useCallback((): CameraCaptureScope | null => {
    try {
      if (retakeIndex === null) assertImageCapacity(filesRef.current.length, 1);
    } catch (error) {
      Alert.alert('Limit Reached', error instanceof Error ? error.message : 'You can upload up to 10 images.');
      return null;
    }
    return {
      key: accountKey,
      operation: generationRef.current.begin(),
      replacing: retakeIndex,
    };
  }, [accountKey, retakeIndex]);

  const handleCameraCapture = async (uri: string, width: number, height: number, rawScope: unknown) => {
    const { key, operation, replacing } = rawScope as CameraCaptureScope;
    setCameraVisible(false);
    setBusy(true);
    setStatusText('Preparing image...');
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
      if (isCurrent(key, operation.generation, operation.signal)) setBusy(false);
    }
  };

  const addLibraryImages = async () => {
    if (files.length >= 10) {
      Alert.alert('Limit Reached', 'You can upload up to 10 images.');
      return;
    }
    const key = accountKey;
    const operation = generationRef.current.begin();
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

      setBusy(true);
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
      setBusy(false);
    }
  };

  const removeFile = (index: number) => {
    const next = [...files];
    const [removed] = next.splice(index, 1);
    if (removed) void disposeBloodworkDraftFiles([removed]);
    setFiles(next);
    if (next.length === 0) setDraftType('none');
  };

  const moveUp = (index: number) => {
    if (index === 0) return;
    const next = [...files];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    setFiles(next);
  };

  const moveDown = (index: number) => {
    if (index === files.length - 1) return;
    const next = [...files];
    [next[index + 1], next[index]] = [next[index], next[index + 1]];
    setFiles(next);
  };

  const saveReport = async () => {
    if (accountCtx.account.kind !== 'real') {
      Alert.alert('Demo Mode', 'Uploading is disabled in demo mode.');
      return;
    }
    if (!title.trim() || files.length === 0) return;

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
    setBusy(true);
    setProgress(0);
    setStatusText('Creating report...');

    try {
      const token = await accountCtx.getAccessToken?.();
      capturedToken = token ?? null;
      if (!isCurrent(key, operation.generation, operation.signal)) return;
      if (!token) throw new Error('Not authenticated');

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
      router.replace(`/bloodwork/${reportId}`);
    } catch (e: unknown) {
      if (isCurrent(key, operation.generation, operation.signal)) {
        Alert.alert('Upload Failed', e instanceof Error ? e.message : 'The report could not be uploaded.');
      }
    } finally {
      const cleaningCancelledStage = operation.signal.aborted && stagedReportId && capturedToken && !committed;
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
      if (isCurrent(key, operation.generation, operation.signal)) {
        setBusy(false);
      } else if (cleaningCancelledStage && accountKeyRef.current === key) {
        setBusy(false);
        setStatusText('Upload cancelled');
      }
    }
  };

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
            onChangeText={setTitle}
            placeholder="e.g. Annual Bloodwork 2026"
            placeholderTextColor={colors.subtleText}
          />
        </View>

        <View style={styles.formGroup}>
          <Text style={[styles.label, { color: colors.labelText }]}>REPORT DATE (OPTIONAL)</Text>
          <TextInput
            style={[styles.input, { borderColor: colors.border, color: colors.navy }]}
            value={reportDate}
            onChangeText={setReportDate}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={colors.subtleText}
          />
        </View>

        {draftType === 'none' && (
          <View style={styles.pickerActions}>
            <Text style={[styles.label, { color: colors.labelText, marginBottom: 8 }]}>ADD FILES</Text>
            <Pressable onPress={() => { setRetakeIndex(null); setCameraVisible(true); }} style={[styles.btn, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Feather name="camera" size={18} color={colors.cobalt} />
              <Text style={[styles.btnText, { color: colors.navy }]}>Take Photos (up to 10)</Text>
            </Pressable>
            <Pressable onPress={addLibraryImages} style={[styles.btn, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Feather name="image" size={18} color={colors.cobalt} />
              <Text style={[styles.btnText, { color: colors.navy }]}>Choose Images</Text>
            </Pressable>
            <Pressable onPress={addPdf} style={[styles.btn, { backgroundColor: colors.card, borderColor: colors.border }]}>
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
                <Pressable onPress={() => removeFile(0)} style={styles.removeBtn}>
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
                     <Pressable onPress={() => { setRetakeIndex(null); setCameraVisible(true); }}><Feather name="camera" size={18} color={colors.cobalt}/></Pressable>
                    <Pressable onPress={addLibraryImages}><Feather name="image" size={18} color={colors.cobalt}/></Pressable>
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
                      <Pressable onPress={() => moveUp(i)} disabled={i === 0} style={styles.gridBtn}>
                        <Feather name="arrow-left" size={12} color={i === 0 ? 'rgba(255,255,255,0.2)' : '#fff'} />
                      </Pressable>
                      <Pressable onPress={() => removeFile(i)} style={styles.gridBtn}>
                        <Feather name="x" size={12} color="#fff" />
                      </Pressable>
                       <Pressable
                         onPress={() => {
                           setRetakeIndex(i);
                           setCameraVisible(true);
                         }}
                         style={styles.gridBtn}
                       >
                         <Feather name="camera" size={12} color="#fff" />
                       </Pressable>
                      <Pressable onPress={() => moveDown(i)} disabled={i === files.length - 1} style={styles.gridBtn}>
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
               onPress={saveReport}
               disabled={busy || !title}
               style={({pressed}) => [
                 styles.submitBtn,
                 { backgroundColor: colors.cobalt },
                 (busy || !title) && { opacity: 0.5 },
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
         onClose={() => {
           setCameraVisible(false);
           setRetakeIndex(null);
         }}
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
