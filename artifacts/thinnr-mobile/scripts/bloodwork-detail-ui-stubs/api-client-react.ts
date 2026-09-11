import React from 'react';
import type { BloodworkDetail as GeneratedBloodworkDetail } from '../../../lib/api-client-react/src/generated/api.schemas';

export type BloodworkDetail = GeneratedBloodworkDetail;

export const detailState: {
  data: BloodworkDetail | undefined;
  error: boolean;
  refetches: number;
  retryCalls: number;
  retryResolvers: Array<() => void>;
  listeners: Set<() => void>;
  heldRefetch: boolean;
  refetchResolve: (() => void) | null;
  refetchGeneration: number;
  cancelQueries(): void;
} = {
  data: undefined,
  error: false,
  refetches: 0,
  retryCalls: 0,
  retryResolvers: [],
  listeners: new Set(),
  heldRefetch: false,
  refetchResolve: null,
  refetchGeneration: 0,
  cancelQueries: () => undefined,
};

export function publishDetail(data: BloodworkDetail | undefined, error = false) {
  detailState.data = data;
  detailState.error = error;
  detailState.listeners.forEach(listener => listener());
}

export function resetDetailState(data?: BloodworkDetail, error = false) {
  detailState.data = data;
  detailState.error = error;
  detailState.refetches = 0;
  detailState.retryCalls = 0;
  detailState.retryResolvers = [];
  detailState.listeners.clear();
  detailState.heldRefetch = false;
  detailState.refetchResolve = null;
  detailState.refetchGeneration = 0;
  detailState.cancelQueries = () => { detailState.refetchGeneration += 1; };
}

export function resolveRetry() {
  detailState.retryResolvers.splice(0).forEach(resolve => resolve());
}

export function resolveRefetch() {
  detailState.refetchResolve?.();
  detailState.refetchResolve = null;
}

export function useGetBloodworkReport() {
  const [, render] = React.useState(0);
  React.useEffect(() => {
    const listener = () => render(value => value + 1);
    detailState.listeners.add(listener);
    return () => detailState.listeners.delete(listener);
  }, []);
  const refetch = React.useCallback(async () => {
    detailState.refetches += 1;
    const capturedData = detailState.data;
    const capturedGeneration = detailState.refetchGeneration;
    if (detailState.heldRefetch) {
      await new Promise<void>(resolve => {
        detailState.refetchResolve = () => {
          if (capturedGeneration === detailState.refetchGeneration) publishDetail(capturedData, detailState.error);
          resolve();
        };
      });
    }
    render(value => value + 1);
  }, []);
  return {
    data: detailState.data,
    isLoading: !detailState.data,
    isError: detailState.error,
    refetch,
  };
}

export function useRetryBloodworkExtraction() {
  return {
    isPending: false,
    mutateAsync: async () => {
      detailState.retryCalls += 1;
      await new Promise<void>(resolve => detailState.retryResolvers.push(resolve));
    },
  };
}

export function useUpdateBloodworkReport() {
  return {
    isPending: false,
    mutateAsync: async ({ data }: { data: { title: string; reportDate: string | null } }) => {
      const current = detailState.data?.report;
      if (!current) throw new Error('No report');
      return { ...current, ...data };
    },
  };
}

export function useDeleteBloodworkReport() {
  return { isPending: false, mutateAsync: async () => undefined };
}

export function useCorrectBloodworkResult() {
  return { isPending: false, mutateAsync: async () => undefined };
}

export function getGetBloodworkReportQueryKey(patientId: string, reportId: string) {
  return ['bloodwork-report', patientId, reportId] as const;
}

export function getListBloodworkReportsQueryKey(patientId: string) {
  return ['bloodwork-reports', patientId] as const;
}