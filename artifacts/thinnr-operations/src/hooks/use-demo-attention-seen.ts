import { useCallback, useEffect, useState } from 'react';

const PREFIX = 'thinnr-demo-attention-seen:';
const CHANGE_EVENT = 'thinnr-demo-attention-seen-change';

function read(key: string): string[] {
  if (typeof window === 'undefined' || !window.sessionStorage) return [];
  try {
    const value = JSON.parse(window.sessionStorage.getItem(key) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function useDemoAttentionSeen(scope: string, enabled: boolean) {
  const key = `${PREFIX}${scope}`;
  const [seen, setSeen] = useState<string[]>(() => enabled ? read(key) : []);

  useEffect(() => {
    if (!enabled) {
      setSeen([]);
      return;
    }
    setSeen(read(key));
    const refresh = () => setSeen(read(key));
    window.addEventListener(CHANGE_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(CHANGE_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, [enabled, key]);

  const markSeen = useCallback((patientId: string, signature: string) => {
    if (!enabled || typeof window === 'undefined' || !window.sessionStorage) return;
    const value = `${patientId}:${signature}`;
    const next = [...new Set([...read(key), value])];
    window.sessionStorage.setItem(key, JSON.stringify(next));
    setSeen(next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, [enabled, key]);

  return [seen, markSeen] as const;
}