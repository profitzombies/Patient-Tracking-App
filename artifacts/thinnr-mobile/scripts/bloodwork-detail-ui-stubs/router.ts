import { useEffect } from 'react';

export const router = {
  back() {},
  replace() {},
  push() {},
};

export function useLocalSearchParams() {
  return { id: 'report-a' };
}

export function useFocusEffect(effect: () => void | (() => void)) {
  useEffect(effect, [effect]);
}