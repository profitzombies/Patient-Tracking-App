import { Loader2 } from 'lucide-react';

/**
 * A button's working state: a spinner beside the in-progress wording
 * ("Saving…"), or the idle label when nothing is happening. Screen readers
 * hear the label change; the spinner itself is decorative.
 */
export function BusyLabel({ busy, label, busyLabel = 'Saving…' }: { busy: boolean; label: React.ReactNode; busyLabel?: string }) {
  if (!busy) return <>{label}</>;
  return <span className="inline-flex items-center gap-2" data-busy="true">
    <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />{busyLabel}
  </span>;
}
