import React, { useEffect, useState, useCallback, useRef } from 'react';
import { View, StyleSheet, Text, Pressable, Alert, TextInput } from 'react-native';
import { PageScrollView as ScrollView } from '@/components/ui/PageScrollView';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router, useFocusEffect } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { PatientHeader } from '@/components/patient/PatientHeader';
import { ResultRow } from '@/components/bloodwork/ResultRow';
import { ResultEditModal } from '@/components/bloodwork/ResultEditModal';
import { BloodworkViewer } from '@/components/bloodwork/BloodworkViewer';
import { BloodworkBackRow } from '@/components/bloodwork/BloodworkBackRow';
import { BloodworkDateField } from '@/components/bloodwork/BloodworkDateField';
import { BloodworkProcessingStatus } from '@/components/bloodwork/BloodworkProcessingStatus';
import { BloodworkDetailSkeleton } from '@/components/bloodwork/BloodworkSkeletons';
import { AppModal } from '@/components/ui/AppModal';
import { usePatientAccount } from '@/context/PatientAccountContext';
import { useSupabaseSession } from '@/lib/supabase';
import { useQueryClient } from '@tanstack/react-query';
import { 
  useGetBloodworkReport, 
  getListBloodworkReportsQueryKey,
  useUpdateBloodworkReport, 
  useDeleteBloodworkReport, 
  useCorrectBloodworkResult,
  getGetBloodworkReportQueryKey,
  useRetryBloodworkExtraction,
} from '@workspace/api-client-react';
import { buildBloodworkMetadataUpdate } from '@/lib/bloodwork-scope';
import { formatBloodworkDate } from '@/lib/bloodwork-date';
import { classifyBloodworkError } from '@/lib/bloodwork-recovery';

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

  const { data: detail, isLoading, isError, error, refetch } = useGetBloodworkReport(
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
  const detailRecovery = isError ? classifyBloodworkError(error) : null;

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
  const retryInFlightRef = useRef(false);
  const retryEpochRef = useRef(0);
  
  const scopeKey = `${userId}:${patientId}:${reportId}`;
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;
  const checkScope = useCallback((captured: string) => (
    captured === scopeKeyRef.current && accountCtx.account.kind === 'real'
  ), [accountCtx.account.kind]);

  useEffect(() => {
    retryEpochRef.current += 1;
    retryInFlightRef.current = false;
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
    if (!detail || !metadataSnapshot || !titleDraft.trim() || updateReport.isPending) {
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
      const updatedReport = await updateReport.mutateAsync({
        patientId,
        reportId,
        data: {
          ...update,
        }
      });
      if (!checkScope(captured)) return;
      const baseDetailQueryKey = getGetBloodworkReportQueryKey(patientId, reportId);
      await Promise.all([
        queryClient.cancelQueries({ queryKey: detailQueryKey }),
        queryClient.cancelQueries({ queryKey: baseDetailQueryKey }),
      ]);
      if (!checkScope(captured)) return;
      const nextDetail = detail
        ? { ...detail, report: updatedReport }
        : undefined;
      if (nextDetail) {
        queryClient.setQueryData(detailQueryKey, nextDetail);
        queryClient.setQueryData(baseDetailQueryKey, nextDetail);
      }
      await queryClient.invalidateQueries({
        queryKey: getListBloodworkReportsQueryKey(patientId),
      });
      if (!checkScope(captured)) return;
      setEditingTitle(false);
      setMetadataSnapshot(null);
    } catch (e: any) {
      if (checkScope(captured)) Alert.alert('Failed to update title', e.message);
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
      if (checkScope(captured)) throw e;
    }
  };

  if (isLoading && !isError) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, justifyContent: 'center' }]}>
        <PatientHeader title="Report Detail" />
        <BloodworkBackRow onPress={() => router.back()} />
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, 24) }]}>
          <BloodworkDetailSkeleton />
        </ScrollView>
      </View>
    );
  }

  if (!detail) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <PatientHeader title="Error" />
        <BloodworkBackRow onPress={() => router.back()} />
        <View style={styles.emptyWrap}>
            <Text style={[styles.emptyText, { color: colors.destructive }]}>
              {detailRecovery?.title ?? 'Could not load report.'}
            </Text>
            <Text style={[styles.emptyText, { color: colors.subtleText, marginTop: 8 }]}>
              {detailRecovery?.message ?? 'Try again in a moment.'}
            </Text>
            <Pressable testID="bloodwork-detail-retry" onPress={() => void refetch()} style={styles.iconBtn}>
              <Text style={{ color: colors.cobalt }}>{detailRecovery?.actionLabel ?? 'Retry'}</Text>
            </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <PatientHeader title="Report Detail" />
      <BloodworkBackRow onPress={() => router.back()} />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, 24) }]}>
        {isError && detailRecovery ? (
          <View
            testID="bloodwork-detail-refresh-error"
            accessibilityRole="alert"
            style={[styles.refreshError, { backgroundColor: colors.warnBg, borderColor: colors.warnBorder }]}
          >
            <Text style={[styles.recoveryTitle, { color: colors.navy }]}>{detailRecovery.title}</Text>
            <Text style={[styles.recoveryMessage, { color: colors.bodyText }]}>{detailRecovery.message}</Text>
            <Pressable testID="bloodwork-detail-refresh-retry" onPress={() => void refetch()} style={styles.retry}>
              <Text style={[styles.actionText, { color: colors.cobalt }]}>
                {detailRecovery.actionLabel ?? 'Retry'}
              </Text>
            </Pressable>
          </View>
        ) : null}
        
        {/* Header section */}
        <View style={styles.headerBox}>
           {editingTitle ? (
              <View testID="bloodwork-edit-metadata-row" style={styles.titleEditRow}>
                  <TextInput
                   testID="bloodwork-edit-title"
                  style={[styles.titleInput, { borderColor: colors.border, color: colors.navy }]}
                  value={titleDraft}
                  onChangeText={setTitleDraft}
                   editable={!updateReport.isPending}
                  autoFocus
                  onSubmitEditing={saveTitle}
                />
                 <View style={styles.dateField}>
                   <BloodworkDateField
                     testID="bloodwork-edit-date"
                     value={dateDraft}
                     disabled={updateReport.isPending}
                     onChange={setDateDraft}
                   />
                 </View>
                  <Pressable
                    disabled={updateReport.isPending}
                    onPress={() => void saveTitle()}
                   style={[styles.metadataSaveButton, updateReport.isPending && { opacity: 0.5 }]}
                    accessibilityRole="button"
                    accessibilityLabel="Save report changes"
                  >
                   <Feather name="check" size={20} color={colors.cobalt} />
                 </Pressable>
             </View>
           ) : (
             <View style={styles.titleRow}>
               <Text style={[styles.title, { color: colors.navy }]} numberOfLines={2}>{detail.report.title}</Text>
                <Pressable
                   testID="bloodwork-edit-metadata"
                   accessibilityRole="button"
                   accessibilityLabel="Edit report details"
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
              {formatBloodworkDate(detail.report.reportDate)}
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
            <BloodworkProcessingStatus
              report={detail.report}
              pollingError={isError && isProcessing}
              onRefresh={() => void refetch()}
              onRetryExtraction={detail.report.extractionStatus === 'failed' ? async () => {
                if (retryInFlightRef.current) return;
                retryInFlightRef.current = true;
                const captured = scopeKey;
                const retryEpoch = retryEpochRef.current;
                try {
                  await retryExtraction.mutateAsync({ patientId, reportId });
                  if (checkScope(captured)) await refetch();
                } catch (error) {
                  if (checkScope(captured)) {
                    Alert.alert('Retry failed', error instanceof Error ? error.message : 'Extraction could not be retried.');
                  }
                } finally {
                  if (retryEpochRef.current === retryEpoch) retryInFlightRef.current = false;
                }
              } : undefined}
              retryPending={retryExtraction.isPending || retryInFlightRef.current}
            />
            {detail.report.extractionStatus === 'completed' && detail.results.length === 0 ? (
              <View style={styles.emptyWrap}>
                 <Text style={[styles.emptyText, { color: colors.subtleText }]}>No results found in this document.</Text>
              </View>
            ) : detail.report.extractionStatus === 'completed' ? (
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
            ) : null}
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
  titleEditRow: { flexDirection: 'column', alignItems: 'stretch', gap: 8 },
  title: { fontSize: 24, fontFamily: 'PlayfairDisplay_600SemiBold', flex: 1, paddingRight: 16, lineHeight: 32 },
  titleInput: { 
    width: '100%', height: 44, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12,
    fontSize: 18, fontFamily: 'PlayfairDisplay_600SemiBold' 
  },
  dateField: { width: '100%' },
  metadataSaveButton: { alignSelf: 'flex-end', minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
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
  refreshError: { borderWidth: 1, borderRadius: 8, padding: 14, marginBottom: 16 },
  recoveryTitle: { fontSize: 15, fontFamily: 'Inter_700Bold' },
  recoveryMessage: { fontSize: 13, lineHeight: 19, fontFamily: 'Inter_400Regular', marginTop: 6 },
  retry: { alignSelf: 'flex-start', paddingVertical: 10, paddingHorizontal: 2 },
  confirmBackdrop: { flex: 1, backgroundColor: 'rgba(13,18,25,0.55)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  confirmCard: { width: '100%', maxWidth: 380, borderWidth: 1, borderRadius: 12, padding: 20 },
  confirmTitle: { fontSize: 18, fontFamily: 'Inter_600SemiBold', marginBottom: 8 },
  confirmText: { fontSize: 14, lineHeight: 20, fontFamily: 'Inter_400Regular' },
  confirmActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 20 },
  confirmButton: { minHeight: 44, minWidth: 72, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
});
