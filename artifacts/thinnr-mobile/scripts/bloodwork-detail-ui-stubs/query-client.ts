import { detailState } from './api-client-react';

export function useQueryClient() {
  return {
    cancelQueries: async () => {
      detailState.cancelQueries();
    },
    setQueryData: (_key: unknown, value: unknown) => {
      if (value && typeof value === 'object' && 'report' in value) {
        detailState.data = value as typeof detailState.data;
        detailState.listeners.forEach(listener => listener());
      }
    },
    invalidateQueries: async () => undefined,
  };
}