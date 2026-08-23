/**
 * Compact header date-range control.
 *
 * Shows the active shared range (e.g. "Jul 24 – Aug 22, 2026") in a cream
 * paper box; opening it reveals a calendar range picker with Apply/Cancel.
 * Edits are drafted locally and only committed on Apply, so Cancel/Escape
 * always leaves the shared range untouched. Focus returns to the trigger on
 * close (Radix popover behavior).
 */
import { useState } from 'react';
import { CalendarRange } from 'lucide-react';
import type { DateRange } from 'react-day-picker';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  dateToKey,
  formatRangeLabel,
  keyToDate,
  useDateRange,
} from '@/contexts/date-range';

export function DateRangeControl() {
  const { range, setRange, minKey, maxKey } = useDateRange();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>();

  const label = formatRangeLabel(range);
  const shortLabel = formatRangeLabel(range, 'short');

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      // Start every edit from the committed range.
      setDraft({ from: keyToDate(range.start), to: keyToDate(range.end) });
    }
    setOpen(nextOpen);
  };

  const handleSelect = (next: DateRange | undefined, day: Date) => {
    // Once a full range is drafted, the next click starts a fresh selection
    // (react-day-picker's default would silently stretch the old range).
    setDraft((prev) => (prev?.from && prev?.to ? { from: day, to: undefined } : next));
  };

  const draftComplete = Boolean(draft?.from && draft?.to);
  const draftSummary = draft?.from
    ? draft.to
      ? formatRangeLabel({ start: dateToKey(draft.from), end: dateToKey(draft.to) })
      : `${draft.from.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – pick an end day`
    : 'Pick a start day';

  const handleApply = () => {
    if (!draft?.from || !draft?.to) return;
    setRange({ start: dateToKey(draft.from), end: dateToKey(draft.to) });
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="button-date-range"
          aria-label={`Change date range (currently ${label})`}
          className="inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-md border border-border bg-card px-2.5 text-xs font-semibold text-navy shadow-xs transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-3"
        >
          <CalendarRange size={14} className="shrink-0 text-primary" aria-hidden="true" />
          <span className="hidden sm:inline">{label}</span>
          <span className="sm:hidden">{shortLabel}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-auto max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg p-0 shadow-lifted"
      >
        <Calendar
          mode="range"
          numberOfMonths={isMobile ? 1 : 2}
          defaultMonth={draft?.from}
          selected={draft}
          onSelect={handleSelect}
          disabled={{ before: keyToDate(minKey), after: keyToDate(maxKey) }}
          startMonth={keyToDate(minKey)}
          endMonth={keyToDate(maxKey)}
        />
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border bg-secondary px-3 py-2.5">
          <p aria-live="polite" className="text-xs font-medium text-muted-foreground" data-testid="text-date-range-draft">
            {draftSummary}
          </p>
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
              data-testid="button-date-range-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleApply}
              disabled={!draftComplete}
              data-testid="button-date-range-apply"
            >
              Apply
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
