import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Alert, View, StyleSheet, Text, Pressable } from 'react-native';
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
import { BloodworkProcessingStatus } from '@/components/bloodwork/BloodworkProcessingStatus';
import { BloodworkDetailSkeleton } from '@/components/bloodwork/BloodworkSkeletons';
import { useQueryClient } from '@tanstack/react-query';
import { useOfficeRoster } from '@/components/office/LiveOfficeRoster';
import { useSupabaseSession } from '@/lib/supabase';
import { formatBloodworkDate } from '@/lib/bloodwork-date';
import { classifyBloodworkError } from '@/lib/bloodwork-recovery';
import { 
  useGetBloodworkReport, 
  useCorrectBloodworkResult,
  useRetryBloodworkExtraction,
  getGetBloodworkReportQueryKey,
} from '@workspace/api-client-react';

export default function ProviderBloodworkDetailScreen() {
  const { id: patientId, reportId } = useLocalSearchParams();
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const queryClient = useQueryClient();
  const { session } = useSupabaseSession();
  const userId = session?.user.id ?? '';
  const officeRoster = useOfficeRoster(userId);
  const pid = String(patientId);
  const rid = String(reportId);
  const isReal = officeRoster.status === 'ready'
    && !!session?.user.id
    && !!officeRoster.roster?.patients.some(patient => patient.id === pid);
  const officeId = officeRoster.roster?.office.providerId;
  const params = officeId ? { office: officeId } : undefined;
  const detailQueryKey = [...getGetBloodworkReportQueryKey(pid, rid, params), session?.user.id ?? ''] as const;

  const { data: detail, isLoading, isError, error, refetch } = useGetBloodworkReport(
    pid,
    rid,
    params,
    {
      query: { enabled: isReal && !!patientId && !!reportId, queryKey: detailQueryKey },
      request: { headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined },
    }
  );

  const pinnedRequest = {
    headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined,
  };
  const correctResult = useCorrectBloodworkResult({ request: pinnedRequest });
  const retryExtraction = useRetryBloodworkExtraction({ request: pinnedRequest });
  const detailRecovery = isError ? classifyBloodworkError(error) : null;

  const [viewerVisible, setViewerVisible] = useState(false);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [editResult, setEditResult] = useState<any>(null);
  const retryInFlightRef = useRef(false);
  const retryEpochRef = useRef(0);
  const scopeKey = `${session?.user.id ?? ''}:${officeId ?? ''}:${pid}:${rid}`;
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  useEffect(() => {
    retryEpochRef.current += 1;
    retryInFlightRef.current = false;
    setViewerVisible(false);
    setViewerIndex(0);
    setEditResult(null);
  }, [scopeKey]);

  // Poll if processing
  const isProcessing = detail?.report.extractionStatus === 'queued' || detail?.report.extractionStatus === 'processing';
  useFocusEffect(
    useCallback(() => {
      if (isReal) void refetch();
      let interval: ReturnType<typeof setInterval> | undefined;
      if (isReal && isProcessing) {
        interval = setInterval(() => refetch(), 5000);
      }
      return () => {
        if (interval) clearInterval(interval);
      };
    }, [isReal, isProcessing, refetch])
  );

  const handleSaveResult = async (payload: any) => {
    if (!editResult || !isReal || !detail) return;

    const captured = scopeKey;
    try {
      await correctResult.mutateAsync({
        patientId: pid,
        reportId: rid,
        resultId: editResult.id,
        params: { office: officeId },
        data: payload
      });
      if (captured !== scopeRef.current) return;

      queryClient.invalidateQueries({ queryKey: getGetBloodworkReportQueryKey(pid, rid, { office: officeId }) });
    } catch (e: any) {
      if (captured === scopeRef.current) throw e;
    }
  };

  if (isLoading && !isError) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <PatientHeader title="Report Detail" />
        <BloodworkBackRow label="Back to patient" onPress={() => router.back()} />
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, 24) }]}>
          <BloodworkDetailSkeleton />
        </ScrollView>
      </View>
    );
  }

   if (!detail) {
    const accessDenied = officeRoster.status === 'denied' || !userId;
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <PatientHeader title="Error" />
        <BloodworkBackRow label="Back to patient" onPress={() => router.back()} />
        <View style={styles.emptyWrap}>
           <Text style={[styles.emptyText, { color: colors.destructive }]}>
              {accessDenied ? 'This private report is unavailable for this account.' : detailRecovery?.title ?? 'Could not load report.'}
           </Text>
            {!accessDenied && detailRecovery ? (
              <Text style={[styles.emptyText, { color: colors.subtleText, marginTop: 8 }]}>
                {detailRecovery.message}
              </Text>
            ) : null}
           {!accessDenied ? (
              <Pressable testID="provider-bloodwork-detail-retry" onPress={() => void refetch()}>
                <Text style={{ color: colors.cobalt, padding: 12 }}>{detailRecovery?.actionLabel ?? 'Retry'}</Text>
              </Pressable>
           ) : null}
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <PatientHeader title="Report Detail" />
      <BloodworkBackRow label="Back to patient" onPress={() => router.back()} />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, 24) }]}>
        {isError && detailRecovery ? (
          <View
            testID="provider-bloodwork-detail-refresh-error"
            accessibilityRole="alert"
            style={[styles.refreshError, { backgroundColor: colors.warnBg, borderColor: colors.warnBorder }]}
          >
            <Text style={[styles.recoveryTitle, { color: colors.navy }]}>{detailRecovery.title}</Text>
            <Text style={[styles.recoveryMessage, { color: colors.bodyText }]}>{detailRecovery.message}</Text>
            <Pressable testID="provider-bloodwork-detail-refresh-retry" onPress={() => void refetch()} style={styles.retry}>
              <Text style={[styles.actionText, { color: colors.cobalt }]}>
                {detailRecovery.actionLabel ?? 'Retry'}
              </Text>
            </Pressable>
          </View>
        ) : null}
        
        {/* Header section */}
        <View style={styles.headerBox}>
           <Text style={[styles.title, { color: colors.navy }]} numberOfLines={2}>{detail.report.title}</Text>
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
                  await retryExtraction.mutateAsync({ patientId: pid, reportId: rid, params });
                  if (captured === scopeRef.current) await refetch();
                } catch (error) {
                  if (captured === scopeRef.current) {
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
                       patientId={pid}
                       reportId={rid}
                       officeId={officeId}
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

      {isReal && (
        <BloodworkViewer
          visible={viewerVisible}
          onClose={() => setViewerVisible(false)}
          reportDetail={detail}
          token={session?.access_token ?? ''}
          patientId={pid}
          officeId={officeId}
          initialIndex={viewerIndex}
        />
      )}
      
      <ResultEditModal
        visible={!!editResult}
        result={editResult}
        onClose={() => setEditResult(null)}
        onSave={handleSaveResult}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16 },
  headerBox: { marginBottom: 24 },
  title: { fontSize: 24, fontFamily: 'PlayfairDisplay_600SemiBold', paddingRight: 16, lineHeight: 32 },
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
});
