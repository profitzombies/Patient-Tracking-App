/**
 * Confirmation pattern for billing actions: one snackbar slot (a newer
 * notice replaces the current one) plus a screen-reader announcement, then
 * the caller re-reads the record so the screen shows server truth.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

export interface BillingNotice {
  message: string;
  key: number;
}

const NOTICE_MS = 5000;

export function useBillingNotice(): {
  notice: BillingNotice | null;
  announce: (message: string) => void;
  dismiss: () => void;
} {
  const [notice, setNotice] = useState<BillingNotice | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => clear, [clear]);
  const dismiss = useCallback(() => {
    clear();
    setNotice(null);
  }, [clear]);
  const announce = useCallback((message: string) => {
    clear();
    setNotice({ message, key: Date.now() });
    AccessibilityInfo.announceForAccessibility(message);
    timer.current = setTimeout(() => {
      timer.current = null;
      setNotice(null);
    }, NOTICE_MS);
  }, [clear]);
  return { notice, announce, dismiss };
}
