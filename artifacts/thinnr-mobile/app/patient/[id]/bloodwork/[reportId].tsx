import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Alert, View, StyleSheet, Text, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router, useFocusEffect } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { PatientHeader } from '@/components/patient/PatientHeader';
import { ResultRow } from '@/components/bloodwork/ResultRow';
import { ResultEditModal } from '@/components/bloodwork/ResultEditModal';
import { BloodworkViewer } from '@/components/bloodwork/BloodworkViewer';
import { useQueryClient } from '@tanstack/react-query';
import { useOfficeRoster } from '@/components/office/LiveOfficeRoster';
import { useSupabaseSession } from '@/lib/supabase';
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
  const officeRoster = useOfficeRoster();
  const { session } = useSupabaseSession();
  const pid = String(patientId);
  const rid = String(reportId);
  const isReal = officeRoster.status === 'ready'
    && !!session?.user.id
    && !!officeRoster.roster?.patients.some(patient => patient.id === pid);
  const officeId = officeRoster.roster?.office.providerId;
  const params = officeId ? { office: officeId } : undefined;
  const detailQueryKey = [...getGetBloodworkReportQueryKey(pid, rid, params), session?.user.id ?? ''] as const;

  const { data: detail, isLoading, isError, refetch } = useGetBloodworkReport(
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

  const [viewerVisible, setViewerVisible] = useState(false);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [editResult, setEditResult] = useState<any>(null);
  const scopeKey = `${session?.user.id ?? ''}:${officeId ?? ''}:${pid}`;
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  useEffect(() => {
    setViewerVisible(false);
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
           <Pressable onPress={() => void refetch()}><Text style={{ color: colors.cobalt, padding: 12 }}>Retry</Text></Pressable>
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
           <Text style={[styles.title, { color: colors.navy }]} numberOfLines={2}>{detail.report.title}</Text>
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
                    disabled={retryExtraction.isPending}
                    onPress={async () => {
                      const captured = scopeKey;
                      try {
                        await retryExtraction.mutateAsync({ patientId: pid, reportId: rid, params });
                        if (captured === scopeRef.current) await refetch();
                      } catch (error) {
                        if (captured === scopeRef.current) {
                          Alert.alert('Retry failed', error instanceof Error ? error.message : 'Extraction could not be retried.');
                        }
                      }
                    }}
                    style={{ padding: 12 }}
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
           )}
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
});
