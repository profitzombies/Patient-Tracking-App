import React, { useEffect, useState, useCallback, useRef } from 'react';
import { View, StyleSheet, Text, ScrollView, Pressable, ActivityIndicator, Alert, TextInput, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router, useFocusEffect } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { PatientHeader } from '@/components/patient/PatientHeader';
import { ResultRow } from '@/components/bloodwork/ResultRow';
import { ResultEditModal } from '@/components/bloodwork/ResultEditModal';
import { BloodworkViewer } from '@/components/bloodwork/BloodworkViewer';
import { AppModal } from '@/components/ui/AppModal';
import { usePatientAccount } from '@/context/PatientAccountContext';
import { useSupabaseSession } from '@/lib/supabase';
import { useQueryClient } from '@tanstack/react-query';
import { 
  useGetBloodworkReport, 
  useUpdateBloodworkReport, 
  useDeleteBloodworkReport, 
  useCorrectBloodworkResult,
  getGetBloodworkReportQueryKey,
  useRetryBloodworkExtraction,
} from '@workspace/api-client-react';
import { buildBloodworkMetadataUpdate } from '@/lib/bloodwork-scope';

export default function BloodworkDetailScreen() {
  const { id } = useLocalSearchParams();
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const accountCtx = usePatientAccount();
  const { session } = useSupabaseSession();
  const queryClient = useQueryClient();
  const isReal = accountCtx.account.kind === 'real';
  const reportId = String(id);
  const patientId = accountCtx.account.kind === 'real' ? accountCtx.account.patientId : '';
  const userId = session?.user.id ?? '';
  const detailQueryKey = [...getGetBloodworkReportQueryKey(patientId, reportId), userId] as const;

  const { data: detail, isLoading, isError, refetch } = useGetBloodworkReport(
    patientId,
    reportId,
    undefined,
    {
      query: { enabled: isReal && !!id && !!userId, queryKey: detailQueryKey },
      request: { headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined },
    }
  );

  const pinnedRequest = {
    headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined,
  };
  const updateReport = useUpdateBloodworkReport({ request: pinnedRequest });
  const deleteReport = useDeleteBloodworkReport({ request: pinnedRequest });
  const correctResult = useCorrectBloodworkResult({ request: pinnedRequest });
  const retryExtraction = useRetryBloodworkExtraction({ request: pinnedRequest });

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [dateDraft, setDateDraft] = useState('');
  const [metadataSnapshot, setMetadataSnapshot] = useState<{
    version: number;
    title: string;
    reportDate: string | null;
  } | null>(null);
  
  const [viewerVisible, setViewerVisible] = useState(false);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [editResult, setEditResult] = useState<any>(null);
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  
  const scopeKey = `${userId}:${patientId}`;
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;
  const checkScope = useCallback((captured: string) => (
    captured === scopeKeyRef.current && accountCtx.account.kind === 'real'
  ), [accountCtx.account.kind]);

  useEffect(() => {
    setViewerVisible(false);
    setEditResult(null);
    setEditingTitle(false);
    setMetadataSnapshot(null);
    setDeleteConfirmVisible(false);
  }, [scopeKey]);

  useEffect(() => {
    if (detail && !editingTitle) {
      setTitleDraft(detail.report.title);
      setDateDraft(detail.report.reportDate ?? '');
    }
  }, [detail, editingTitle]);

  // Poll if processing
  const isProcessing = detail?.report.extractionStatus === 'queued' || detail?.report.extractionStatus === 'processing';
  useFocusEffect(
    useCallback(() => {
      if (isReal && userId) void refetch();
      let interval: ReturnType<typeof setInterval> | undefined;
      if (isReal && isProcessing) {
        interval = setInterval(() => refetch(), 5000);
      }
      return () => {
        if (interval) clearInterval(interval);
      };
    }, [isReal, userId, isProcessing, refetch])
  );

  const saveTitle = async () => {
    if (!detail || !metadataSnapshot || !titleDraft.trim()) {
      setEditingTitle(false);
      return;
    }
    const update = buildBloodworkMetadataUpdate({
      version: metadataSnapshot.version,
      originalTitle: metadataSnapshot.title,
      originalReportDate: metadataSnapshot.reportDate,
      titleDraft,
      dateDraft,
    });
    if (!update) {
      setEditingTitle(false);
      return;
    }
    
    if (accountCtx.account.kind !== 'real') return;

    const captured = scopeKey;
    try {
      await updateReport.mutateAsync({
        patientId,
        reportId,
        data: {
          ...update,
        }
      });
      if (!checkScope(captured)) return;
      queryClient.invalidateQueries({ queryKey: getGetBloodworkReportQueryKey(patientId, reportId) });
      setEditingTitle(false);
      setMetadataSnapshot(null);
    } catch (e: any) {
      Alert.alert('Failed to update title', e.message);
    }
  };

  const deleteConfirmedReport = async () => {
    const captured = scopeKey;
    if (accountCtx.account.kind !== 'real' || !detail) return;
    setDeleteConfirmVisible(false);
    try {
      await deleteReport.mutateAsync({
        patientId,
        reportId,
        params: { expectedVersion: detail.report.version },
      });
      if (!checkScope(captured)) return;
      router.replace('/bloodwork');
    } catch (e: any) {
      if (checkScope(captured)) Alert.alert('Delete Failed', e.message);
    }
  };

  const handleSaveResult = async (payload: any) => {
    if (!editResult || accountCtx.account.kind !== 'real' || !detail) return;

    const captured = scopeKey;
    try {
      await correctResult.mutateAsync({
        patientId,
        reportId,
        resultId: editResult.id,
        data: payload
      });

      if (!checkScope(captured)) return;
      queryClient.invalidateQueries({ queryKey: getGetBloodworkReportQueryKey(patientId, reportId) });
    } catch (e: any) {
      throw e;
    }
  };

  if (isLoading) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, justifyContent: 'center' }]}>
        <ActivityIndicator color={colors.cobalt} />
      </View>
    );
  }

  if (isError || !detail) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <PatientHeader title="Error" right={<Pressable onPress={() => router.back()}><Feather name="arrow-left" size={20} color={colors.navy} /></Pressable>} />
        <View style={styles.emptyWrap}>
           <Text style={[styles.emptyText, { color: colors.destructive }]}>Could not load report.</Text>
           <Pressable onPress={() => void refetch()} style={styles.iconBtn}><Text style={{ color: colors.cobalt }}>Retry</Text></Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <PatientHeader title="Report Detail" right={<Pressable onPress={() => router.back()}><Feather name="arrow-left" size={20} color={colors.navy} /></Pressable>} />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, 24) }]}>
        
        {/* Header section */}
        <View style={styles.headerBox}>
           {editingTitle ? (
             <View style={styles.titleEditRow}>
                <TextInput
                  style={[styles.titleInput, { borderColor: colors.border, color: colors.navy }]}
                  value={titleDraft}
                  onChangeText={setTitleDraft}
                  autoFocus
                  onSubmitEditing={saveTitle}
                />
                 <TextInput
                   style={[styles.dateInput, { borderColor: colors.border, color: colors.navy }]}
                   value={dateDraft}
                   onChangeText={setDateDraft}
                   placeholder="YYYY-MM-DD"
                   placeholderTextColor={colors.subtleText}
                   onSubmitEditing={saveTitle}
                 />
                 <Pressable onPress={() => void saveTitle()} style={styles.iconBtn} accessibilityLabel="Save report title and date">
                   <Feather name="check" size={20} color={colors.cobalt} />
                 </Pressable>
             </View>
           ) : (
             <View style={styles.titleRow}>
               <Text style={[styles.title, { color: colors.navy }]} numberOfLines={2}>{detail.report.title}</Text>
                <Pressable
                  onPress={() => {
                    setTitleDraft(detail.report.title);
                    setDateDraft(detail.report.reportDate ?? '');
                    setMetadataSnapshot({
                      version: detail.report.version,
                      title: detail.report.title,
                      reportDate: detail.report.reportDate,
                    });
                    setEditingTitle(true);
                  }}
                  style={styles.iconBtn}
                >
                 <Feather name="edit-2" size={16} color={colors.subtleText} />
               </Pressable>
             </View>
           )}
           <Text style={[styles.meta, { color: colors.subtleText }]}>
             {detail.report.reportDate ? new Date(detail.report.reportDate).toLocaleDateString() : 'No date'}
             {' • '}
             {detail.report.kind === 'pdf' ? `${detail.report.pageCount} pages` : `${detail.report.fileCount} images`}
           </Text>
            <Text style={[styles.meta, { color: colors.subtleText }]}>
              Uploaded {new Date(detail.report.uploadedAt).toLocaleString()}
            </Text>
           
           <View style={styles.actions}>
              <Pressable onPress={() => { setViewerIndex(0); setViewerVisible(true); }} style={[styles.actionBtn, { backgroundColor: colors.card, borderColor: colors.border }]}>
               <Feather name="eye" size={16} color={colors.cobalt} />
               <Text style={[styles.actionText, { color: colors.navy }]}>View Source</Text>
             </Pressable>
             <Pressable onPress={() => setDeleteConfirmVisible(true)} style={[styles.actionBtn, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Feather name="trash-2" size={16} color={colors.destructive} />
                <Text style={[styles.actionText, { color: colors.destructive }]}>Delete</Text>
             </Pressable>
           </View>
        </View>

        {/* Results section */}
        <View style={styles.resultsBox}>
            <Text style={[styles.sectionTitle, { color: colors.navyLight }]}>Extracted Results · Unreviewed</Text>
           {isProcessing ? (
              <View style={styles.emptyWrap}>
                 <ActivityIndicator color={colors.cobalt} style={{ marginBottom: 12 }} />
                 <Text style={[styles.emptyText, { color: colors.subtleText }]}>Processing document...</Text>
              </View>
           ) : detail.report.extractionStatus === 'failed' ? (
              <View style={styles.emptyWrap}>
                  <Feather name="alert-triangle" size={24} color={colors.destructive} style={{ marginBottom: 12 }} />
                  <Text style={[styles.emptyText, { color: colors.destructive }]}>Extraction failed. The saved source is still available.</Text>
                  <Pressable
                    onPress={async () => {
                      const captured = scopeKey;
                      try {
                        await retryExtraction.mutateAsync({ patientId, reportId });
                        if (checkScope(captured)) await refetch();
                      } catch (error) {
                        if (checkScope(captured)) {
                          Alert.alert('Retry failed', error instanceof Error ? error.message : 'Extraction could not be retried.');
                        }
                      }
                    }}
                    disabled={retryExtraction.isPending}
                    style={styles.iconBtn}
                  >
                    <Text style={{ color: colors.cobalt }}>{retryExtraction.isPending ? 'Retrying…' : 'Retry extraction'}</Text>
                  </Pressable>
              </View>
           ) : detail.results.length === 0 ? (
              <View style={styles.emptyWrap}>
                 <Text style={[styles.emptyText, { color: colors.subtleText }]}>No results found in this document.</Text>
              </View>
           ) : (
              <View style={styles.list}>
                  {[...detail.results].sort((a, b) => (a.sourcePage - b.sourcePage) || (a.position - b.position)).map((r, i) => (
                   <React.Fragment key={r.id}>
                     {i > 0 && <View style={[styles.divider, { backgroundColor: colors.border }]} />}
                     <ResultRow 
                       result={r} 
                       patientId={patientId}
                       reportId={reportId}
                       onPress={() => setEditResult(r)} 
                        onViewSource={(fileId, page) => {
                          const ordered = [...detail.files].sort((a, b) => a.position - b.position);
                          const fileOffset = ordered
                            .slice(0, Math.max(0, ordered.findIndex(file => file.id === fileId)))
                            .reduce((total, file) => total + file.pageCount, 0);
                          setViewerIndex(fileOffset + page - 1);
                         setViewerVisible(true);
                       }}
                     />
                   </React.Fragment>
                 ))}
              </View>
           )}
        </View>

      </ScrollView>

      {accountCtx.account.kind === 'real' && (
        <BloodworkViewer
          visible={viewerVisible}
          onClose={() => setViewerVisible(false)}
          reportDetail={detail}
          token={session?.access_token ?? ''}
          patientId={patientId}
          initialIndex={viewerIndex}
        />
      )}
      
      <ResultEditModal
        visible={!!editResult}
        result={editResult}
        onClose={() => setEditResult(null)}
        onSave={handleSaveResult}
      />
      <AppModal
        visible={deleteConfirmVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setDeleteConfirmVisible(false)}
      >
        <View style={styles.confirmBackdrop}>
          <View style={[styles.confirmCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.confirmTitle, { color: colors.navy }]}>Delete report?</Text>
            <Text style={[styles.confirmText, { color: colors.bodyText }]}>
              This permanently removes the bloodwork report and cannot be undone.
            </Text>
            <View style={styles.confirmActions}>
              <Pressable onPress={() => setDeleteConfirmVisible(false)} style={styles.confirmButton}>
                <Text style={{ color: colors.navy }}>Cancel</Text>
              </Pressable>
              <Pressable onPress={() => void deleteConfirmedReport()} style={styles.confirmButton}>
                <Text style={{ color: colors.destructive }}>Delete</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </AppModal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16 },
  headerBox: { marginBottom: 24 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  titleEditRow: { flexDirection: 'row', alignItems: 'center' },
  title: { fontSize: 24, fontFamily: 'PlayfairDisplay_600SemiBold', flex: 1, paddingRight: 16, lineHeight: 32 },
  titleInput: { 
    flex: 1, height: 44, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, 
    fontSize: 18, fontFamily: 'PlayfairDisplay_600SemiBold' 
  },
  dateInput: { height: 44, width: 130, marginLeft: 8, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10 },
  iconBtn: { padding: 8, margin: -8 },
  meta: { fontSize: 13, fontFamily: 'Inter_400Regular', marginTop: 8 },
  actions: { flexDirection: 'row', gap: 12, marginTop: 16 },
  actionBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, height: 44, borderWidth: 1, borderRadius: 8,
  },
  actionText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  resultsBox: { marginTop: 8 },
  sectionTitle: { fontSize: 15, fontFamily: 'Inter_700Bold', letterSpacing: 1, marginBottom: 12 },
  list: { borderWidth: 1, borderColor: 'rgba(0,0,0,0.05)', borderRadius: 8, overflow: 'hidden' },
  divider: { height: 1, width: '100%' },
  emptyWrap: { padding: 32, alignItems: 'center', justifyContent: 'center' },
  emptyText: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center' },
  confirmBackdrop: { flex: 1, backgroundColor: 'rgba(13,18,25,0.55)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  confirmCard: { width: '100%', maxWidth: 380, borderWidth: 1, borderRadius: 12, padding: 20 },
  confirmTitle: { fontSize: 18, fontFamily: 'Inter_600SemiBold', marginBottom: 8 },
  confirmText: { fontSize: 14, lineHeight: 20, fontFamily: 'Inter_400Regular' },
  confirmActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 20 },
  confirmButton: { minHeight: 44, minWidth: 72, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
});
