/**
 * Date range shared by every list/overview page of the Payments area (the
 * web area keeps one range in its header; here a preset strip does the same
 * job on a phone). Pages anchor to the DEVICE-LOCAL calendar day and default
 * to the last 30 days, matching the web's default.
 */
import React, { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { ChipRow } from './primitives';

export type RangePreset = 7 | 30 | 90;

export interface PaymentsRange {
  /** Inclusive YYYY-MM-DD keys in the device's local calendar. */
  from: string;
  to: string;
  preset: RangePreset;
}

const PRESETS: readonly { label: string; value: `${RangePreset}` }[] = [
  { label: 'Last 7 days', value: '7' },
  { label: 'Last 30 days', value: '30' },
  { label: 'Last 90 days', value: '90' },
];

export function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function rangeForPreset(preset: RangePreset, today: Date = new Date()): PaymentsRange {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (preset - 1));
  return { from: localDayKey(start), to: localDayKey(today), preset };
}

interface RangeContextValue {
  range: PaymentsRange;
  setPreset: (preset: RangePreset) => void;
}

const RangeContext = createContext<RangeContextValue | null>(null);

export function PaymentsRangeProvider({ children }: { children: ReactNode }) {
  const [preset, setPreset] = useState<RangePreset>(30);
  const value = useMemo<RangeContextValue>(() => ({ range: rangeForPreset(preset), setPreset }), [preset]);
  return <RangeContext.Provider value={value}>{children}</RangeContext.Provider>;
}

export function usePaymentsRange(): RangeContextValue {
  const ctx = useContext(RangeContext);
  if (!ctx) {
    // Screens rendered outside the area (tests, previews) get the live default.
    return { range: rangeForPreset(30), setPreset: () => {} };
  }
  return ctx;
}

export function RangePicker({ testIDPrefix = 'range' }: { testIDPrefix?: string }) {
  const { range, setPreset } = usePaymentsRange();
  return (
    <ChipRow
      label="Date range"
      options={PRESETS}
      value={`${range.preset}`}
      onChange={(value) => setPreset(Number(value) as RangePreset)}
      testIDPrefix={testIDPrefix}
    />
  );
}
