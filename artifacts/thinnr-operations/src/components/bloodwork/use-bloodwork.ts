import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import {
  useGetBloodworkReport,
  useRetryBloodworkExtraction,
  useReviewBloodworkReport,
  useCorrectBloodworkResult,
  listBloodworkReports,
  useListBloodworkCorrections,
  type BloodworkReport,
  type BloodworkDetail,
  type BloodworkFile,
  type BloodworkResult,
  type BloodworkCorrection,
  type BloodworkReportList,
} from '@workspace/api-client-react';
import { useSession } from '@/contexts/session';
import { politeInterval } from '@/lib/polite-refetch';

export type { BloodworkReport, BloodworkDetail, BloodworkFile, BloodworkResult, BloodworkCorrection };

export const bloodworkKeys = {
  all: (patientId: string, office: string | null, userId?: string) => 
    ['bloodwork', office ?? 'own', patientId, userId] as const,
  list: (patientId: string, office: string | null, userId?: string) => 
    [...bloodworkKeys.all(patientId, office, userId), 'list'] as const,
  detail: (patientId: string, office: string | null, reportId: string, userId?: string) => 
    [...bloodworkKeys.all(patientId, office, userId), 'detail', reportId] as const,
  corrections: (patientId: string, office: string | null, reportId: string, resultId: string, userId?: string) => 
    [...bloodworkKeys.detail(patientId, office, reportId, userId), 'corrections', resultId] as const,
};

export function useBloodworkReportsQuery(patientId: string, office: string | null) {
  const { authUser } = useSession();
  const queryClient = useQueryClient();
  const queryKey = bloodworkKeys.list(patientId, office, authUser?.id);
  const query = useInfiniteQuery({
    queryKey,
    enabled: !!authUser?.id,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => listBloodworkReports(
      patientId,
      {
        ...(office ? { office } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      },
    ),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  return {
    ...query,
    reports: query.data?.pages.flatMap((page) => page.reports) ?? [],
    refresh: () => queryClient.resetQueries({ queryKey, exact: true }),
  };
}

export function useBloodworkDetailQuery(patientId: string, office: string | null, reportId: string | null) {
  const { authUser } = useSession();
  return useGetBloodworkReport(
    patientId,
    reportId!,
    office ? { office } : undefined,
    {
      query: {
        queryKey: bloodworkKeys.detail(patientId, office, reportId!, authUser?.id),
        enabled: !!reportId && !!authUser?.id,
        // Pauses while the tab is hidden and slows down once the reader is idle.
        refetchInterval: (query) => {
          const state = query.state.data?.report.extractionStatus;
          return politeInterval((state === 'queued' || state === 'processing') ? 5000 : false);
        },
      }
    }
  );
}

export function useCorrectResultMutation(patientId: string, office: string | null, reportId: string) {
  const { authUser } = useSession();
  const queryClient = useQueryClient();
  
  return useCorrectBloodworkResult({
    mutation: {
      onSuccess: (updatedResult) => {
        // Update the result in the detail cache
        queryClient.setQueryData<BloodworkDetail>(
          bloodworkKeys.detail(patientId, office, reportId, authUser?.id),
          (old) => {
            if (!old) return old;
            return {
              ...old,
              results: old.results.map((r) => (r.id === updatedResult.id ? updatedResult : r)),
            };
          }
        );
        // Invalidate the correction history for this specific result
        queryClient.invalidateQueries({
          queryKey: bloodworkKeys.corrections(patientId, office, reportId, updatedResult.id, authUser?.id),
        });
      },
    }
  });
}

export function useRetryExtractionMutation(patientId: string, office: string | null) {
  const { authUser } = useSession();
  const queryClient = useQueryClient();
  
  return useRetryBloodworkExtraction({
    mutation: {
      onSuccess: (updatedReport) => {
        // Update the report in the detail cache
        queryClient.setQueryData<BloodworkDetail>(
          bloodworkKeys.detail(patientId, office, updatedReport.id, authUser?.id),
          (old) => {
            if (!old) return old;
            return { ...old, report: updatedReport };
          }
        );
        // Update the report in the list cache
        queryClient.setQueryData<InfiniteData<BloodworkReportList, string | undefined>>(
          bloodworkKeys.list(patientId, office, authUser?.id),
          (old) => {
            if (!old) return old;
            return {
              ...old,
              pages: old.pages.map((page) => ({
                ...page,
                reports: page.reports.map((r) => (r.id === updatedReport.id ? updatedReport : r)),
              })),
            };
          }
        );
      },
    }
  });
}

export function useReviewReportMutation(patientId: string, office: string | null) {
  const { authUser } = useSession();
  const queryClient = useQueryClient();

  return useReviewBloodworkReport({
    mutation: {
      onSuccess: (updatedReport) => {
        queryClient.setQueryData<BloodworkDetail>(
          bloodworkKeys.detail(patientId, office, updatedReport.id, authUser?.id),
          (old) => old ? { ...old, report: updatedReport } : old,
        );
        queryClient.setQueryData<InfiniteData<BloodworkReportList, string | undefined>>(
          bloodworkKeys.list(patientId, office, authUser?.id),
          (old) => old ? {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              reports: page.reports.map((report) => report.id === updatedReport.id ? updatedReport : report),
            })),
          } : old,
        );
        queryClient.invalidateQueries({
          queryKey: bloodworkKeys.detail(patientId, office, updatedReport.id, authUser?.id),
          refetchType: 'none',
        });
        queryClient.invalidateQueries({
          queryKey: bloodworkKeys.list(patientId, office, authUser?.id),
          refetchType: 'none',
        });
      },
    },
  });
}

export function useBloodworkCorrectionsQuery(patientId: string, office: string | null, reportId: string, resultId: string | null) {
  const { authUser } = useSession();
  return useListBloodworkCorrections(
    patientId,
    reportId,
    resultId!,
    office ? { office } : undefined,
    {
      query: {
        queryKey: bloodworkKeys.corrections(patientId, office, reportId, resultId!, authUser?.id),
        enabled: !!resultId && !!authUser?.id,
      }
    }
  );
}
