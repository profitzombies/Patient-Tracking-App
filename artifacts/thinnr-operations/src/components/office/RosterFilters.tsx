/**
 * Stackable roster filters UI: the quick-set row, the Filter button with its
 * builder (popover on desktop, bottom sheet at phone width), the active
 * filter chips, and the phone sort picker.
 *
 * The builder edits a local draft (so a half-filled row survives while the
 * roster updates underneath) and pushes every complete condition up through
 * `onApply` as soon as it is usable. The parent owns the applied view (it
 * lives in the URL); when it changes from outside — a chip removed, a quick
 * set tapped, a shared link — the draft re-syncs to it.
 *
 * Every control is a design-system component (Select, Popover + Command,
 * Calendar, Badge, Input, Sheet); no browser-native selects remain.
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { CalendarDays, Check, ChevronsUpDown, Filter, Plus, Save, X } from 'lucide-react';
import type { DateRange } from 'react-day-picker';
import { Badge, badgeVariants } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import { dateToKey, keyToDate } from '@/lib/date-range-keys';
import {
  FILTER_FIELDS,
  OPERATOR_LABELS,
  OPERATOR_SPOKEN,
  completeConditions,
  describeCondition,
  encodeCondition,
  fieldDefinition,
  isCompleteCondition,
  type FieldOption,
  type FilterCondition,
  type FilterField,
  type FilterOperator,
  type QuickSet,
  type RosterSort,
} from '@/lib/roster-filters';
import { cn } from '@/lib/utils';

const CONTROL = 'h-9 rounded-md border-border bg-card text-xs text-foreground shadow-xs';
const PILL_BASE = 'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const PILL_IDLE = 'border-border bg-card text-navy hover:bg-accent';
const PILL_ACTIVE = 'border-navy bg-navy text-white';

// ---------------------------------------------------------------------------
// Quick sets
// ---------------------------------------------------------------------------

export function RosterQuickSets({ sets, activeId, onSelect, onRemove }: {
  sets: readonly QuickSet[];
  activeId: string | null;
  onSelect: (set: QuickSet) => void;
  onRemove: (set: QuickSet) => void;
}) {
  return (
    <div role="group" aria-label="Quick sets" data-testid="roster-quick-sets" className="flex items-center gap-2 overflow-x-auto border-b border-border px-4 py-3 [scrollbar-width:thin]">
      {sets.map((set) => {
        const active = set.id === activeId;
        return (
          <span key={set.id} className={cn('inline-flex shrink-0 items-center', !set.builtIn && 'rounded-full border border-dashed border-border pr-1')}>
            <button
              type="button"
              aria-pressed={active}
              data-testid={`quick-set-${set.id}`}
              onClick={() => onSelect(set)}
              className={cn(PILL_BASE, active ? PILL_ACTIVE : PILL_IDLE, !set.builtIn && 'border-transparent')}
            >
              {set.label}
            </button>
            {!set.builtIn && (
              <button
                type="button"
                aria-label={`Remove quick set ${set.label}`}
                data-testid={`quick-set-remove-${set.id}`}
                onClick={() => onRemove(set)}
                className="grid h-6 w-6 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X size={12} aria-hidden="true" />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

export function RosterFilterChips({ conditions, programOptions, onRemove, onClearAll }: {
  conditions: readonly FilterCondition[];
  programOptions: readonly FieldOption[];
  onRemove: (index: number) => void;
  onClearAll: () => void;
}) {
  if (conditions.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5" data-testid="roster-filter-chips">
      <ul aria-label="Active filters" className="contents">
        {conditions.map((condition, index) => {
          const text = describeCondition(condition, programOptions);
          return (
            <li key={`${encodeCondition(condition)}-${index}`} className="contents">
              <Badge variant="outline" className="h-7 gap-1 rounded-full border-accent-border bg-accent pl-2.5 pr-1 text-[11px] font-semibold text-primary" data-testid={`filter-chip-${index}`}>
                <span>{text}</span>
                <button
                  type="button"
                  aria-label={`Remove filter: ${text}`}
                  onClick={() => onRemove(index)}
                  className="grid h-5 w-5 place-items-center rounded-full transition-colors hover:bg-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X size={11} aria-hidden="true" />
                </button>
              </Badge>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={onClearAll}
        data-testid="button-clear-filters"
        className="ml-1 text-[11px] font-semibold text-muted-foreground underline-offset-2 hover:text-navy hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Clear all
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Value editors
// ---------------------------------------------------------------------------

function splitRange(value: string): [string, string] {
  const index = value.indexOf('..');
  return index < 0 ? [value, ''] : [value.slice(0, index), value.slice(index + 2)];
}

function formatKey(key: string): string {
  return keyToDate(key).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Searchable option picker: Popover + Command list. */
function OptionPicker({ label, value, options, onChange, testId }: {
  label: string;
  value: string;
  options: readonly FieldOption[];
  onChange: (value: string) => void;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((option) => option.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          data-testid={testId}
          data-value={value}
          className={cn(CONTROL, 'flex w-full min-w-0 items-center justify-between gap-2 border px-3 focus:outline-none focus:ring-1 focus:ring-ring', !current && 'text-muted-foreground')}
        >
          <span className="truncate">{current?.label ?? 'Choose…'}</span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[240px] p-0" align="start">
        <Command>
          <CommandInput placeholder={`Search ${label.toLowerCase()}…`} className="h-9 text-xs" />
          <CommandList>
            <CommandEmpty>No match.</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.label}
                  data-value={option.value}
                  onSelect={() => { onChange(option.value); setOpen(false); }}
                  className="text-xs"
                >
                  {option.label}
                  <Check className={cn('ml-auto h-4 w-4', option.value === value ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function NumberInput({ label, value, onChange, integer, unit, testId }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  integer?: boolean;
  unit?: string;
  testId: string;
}) {
  return (
    <div className="relative min-w-0 flex-1">
      {unit === '$' && <span aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$</span>}
      <Input
        type="number"
        inputMode={integer ? 'numeric' : 'decimal'}
        step={integer ? 1 : 'any'}
        min={0}
        aria-label={label}
        data-testid={testId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(CONTROL, 'border md:text-xs', unit === '$' ? 'pl-6 pr-2' : 'px-2.5')}
      />
    </div>
  );
}

/** One day, picked from the themed calendar. */
function DayPickerButton({ label, value, onChange, testId }: {
  label: string;
  value: string;
  onChange: (key: string) => void;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = value ? keyToDate(value) : undefined;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={value ? `${label}: ${formatKey(value)}` : label}
          aria-expanded={open}
          data-testid={testId}
          data-value={value}
          className={cn(CONTROL, 'flex w-full min-w-0 items-center gap-2 border px-3 focus:outline-none focus:ring-1 focus:ring-ring', !value && 'text-muted-foreground')}
        >
          <CalendarDays size={14} className="shrink-0 text-primary" aria-hidden="true" />
          <span className="truncate">{value ? formatKey(value) : 'Pick a day'}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected}
          onSelect={(day) => { if (day) { onChange(dateToKey(day)); setOpen(false); } }}
        />
      </PopoverContent>
    </Popover>
  );
}

/** A from..to range from the calendar; a complete range restarts on the next click. */
function RangePickerButton({ label, value, onChange, testId }: {
  label: string;
  value: string;
  onChange: (range: string) => void;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const [from, to] = splitRange(value);
  const [draft, setDraft] = useState<DateRange | undefined>();
  const summary = from && to ? `${formatKey(from)} – ${formatKey(to)}` : 'Pick a range';

  const handleOpenChange = (next: boolean) => {
    if (next) setDraft(from && to ? { from: keyToDate(from), to: keyToDate(to) } : undefined);
    setOpen(next);
  };
  const handleSelect = (next: DateRange | undefined, day: Date) => {
    // Once a full range is drafted, the next click starts a fresh selection
    // (react-day-picker's default would silently stretch the old range).
    const resolved = draft?.from && draft?.to ? { from: day, to: undefined } : next;
    setDraft(resolved);
    if (resolved?.from && resolved.to) {
      onChange(`${dateToKey(resolved.from)}..${dateToKey(resolved.to)}`);
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={from && to ? `${label}: ${summary}` : label}
          aria-expanded={open}
          data-testid={testId}
          data-value={value}
          className={cn(CONTROL, 'flex w-full min-w-0 items-center gap-2 border px-3 focus:outline-none focus:ring-1 focus:ring-ring', !(from && to) && 'text-muted-foreground')}
        >
          <CalendarDays size={14} className="shrink-0 text-primary" aria-hidden="true" />
          <span className="truncate">{summary}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar mode="range" selected={draft} defaultMonth={draft?.from} onSelect={handleSelect} />
        <p aria-live="polite" className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          {draft?.from ? (draft.to ? summary : `${draft.from.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – pick an end day`) : 'Pick a start day'}
        </p>
      </PopoverContent>
    </Popover>
  );
}

function ValueEditor({ index, condition, programOptions, onChange }: {
  index: number;
  condition: FilterCondition;
  programOptions: readonly FieldOption[];
  onChange: (value: string) => void;
}) {
  const field = fieldDefinition(condition.field);
  const label = `Value for filter ${index + 1}`;
  const testId = `filter-value-${index}`;
  if (field.kind === 'enum' || field.kind === 'boolean') {
    const options = condition.field === 'program' ? programOptions : field.options ?? [];
    if (options.length <= 3) {
      return (
        <Select value={condition.value || undefined} onValueChange={onChange}>
          <SelectTrigger aria-label={label} data-testid={testId} className={cn(CONTROL, 'border')}>
            <SelectValue placeholder="Choose…" />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => <SelectItem key={option.value} value={option.value} className="text-xs">{option.label}</SelectItem>)}
          </SelectContent>
        </Select>
      );
    }
    return <OptionPicker label={label} value={condition.value} options={options} onChange={onChange} testId={testId} />;
  }
  if (condition.operator === 'in_last') {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <NumberInput label={`${label} (days)`} value={condition.value} onChange={onChange} integer testId={testId} />
        <span className="shrink-0 text-xs text-muted-foreground">days</span>
      </div>
    );
  }
  if (field.kind === 'date') {
    return condition.operator === 'between'
      ? <RangePickerButton label={label} value={condition.value} onChange={onChange} testId={testId} />
      : <DayPickerButton label={label} value={condition.value} onChange={onChange} testId={testId} />;
  }
  if (condition.operator === 'between') {
    const [min, max] = splitRange(condition.value);
    return (
      <div className="flex min-w-0 items-center gap-2">
        <NumberInput label={`Minimum ${label.toLowerCase()}`} value={min} onChange={(next) => onChange(`${next}..${max}`)} integer={field.integer} unit={field.unit} testId={`${testId}-min`} />
        <span className="shrink-0 text-xs text-muted-foreground">and</span>
        <NumberInput label={`Maximum ${label.toLowerCase()}`} value={max} onChange={(next) => onChange(`${min}..${next}`)} integer={field.integer} unit={field.unit} testId={`${testId}-max`} />
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-2">
      <NumberInput label={label} value={condition.value} onChange={onChange} integer={field.integer} unit={field.unit} testId={testId} />
      {field.unit && field.unit !== '$' && <span className="shrink-0 text-xs text-muted-foreground">{field.unit}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const FIELD_OPTIONS: readonly FieldOption[] = FILTER_FIELDS.map((field) => ({ value: field.key, label: field.label }));

function signatureOf(conditions: readonly FilterCondition[]): string {
  return completeConditions(conditions).map(encodeCondition).join('&');
}

/** Re-typing a value across operators of the same shape keeps it; shape changes clear it. */
function carriedValue(field: FilterField, previous: FilterOperator, next: FilterOperator, value: string): string {
  const kind = fieldDefinition(field).kind;
  if (kind === 'enum' || kind === 'boolean') return value;
  const shape = (operator: FilterOperator) => (operator === 'between' ? 'range' : operator === 'in_last' ? 'days' : 'single');
  return shape(previous) === shape(next) ? value : '';
}

function BuilderPanel({ draft, setDraft, programOptions, onClearAll, onSaveQuickSet, onDone, matchCount }: {
  draft: FilterCondition[];
  setDraft: (next: FilterCondition[]) => void;
  programOptions: readonly FieldOption[];
  onClearAll: () => void;
  onSaveQuickSet: (name: string) => void;
  onDone: () => void;
  matchCount: number;
}) {
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const applied = completeConditions(draft).length;
  const nameId = useId();

  const update = (index: number, next: FilterCondition) => setDraft(draft.map((row, i) => (i === index ? next : row)));
  const remove = (index: number) => setDraft(draft.filter((_, i) => i !== index));
  const add = () => setDraft([...draft, { field: 'status', operator: 'is', value: '' }]);

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) { setNameError('Give the quick set a name.'); return; }
    onSaveQuickSet(trimmed);
    setName('');
    setNameError(null);
    setSaving(false);
  };

  return (
    <div className="flex flex-col gap-3" data-testid="roster-filter-builder">
      <p className="sr-only" aria-live="polite">{applied} filter{applied === 1 ? '' : 's'} applied, {matchCount} patient{matchCount === 1 ? '' : 's'} shown</p>
      {draft.length === 0 && <p className="text-xs text-muted-foreground">No conditions yet. Add one to narrow the roster; conditions stack (every one must match).</p>}
      <ol className="flex flex-col gap-2" aria-label="Conditions">
        {draft.map((condition, index) => {
          const field = fieldDefinition(condition.field);
          return (
            <li key={index} role="group" aria-label={`Filter ${index + 1}`} data-testid={`filter-row-${index}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded-md border border-border bg-paper-alt p-2 sm:grid-cols-[minmax(0,11rem)_minmax(0,7.5rem)_minmax(0,1fr)_auto]">
              <Select
                value={condition.field}
                onValueChange={(next) => {
                  const nextField = fieldDefinition(next as FilterField);
                  update(index, { field: nextField.key, operator: nextField.operators[0], value: '' });
                }}
              >
                <SelectTrigger aria-label={`Field for filter ${index + 1}`} data-testid={`filter-field-${index}`} className={cn(CONTROL, 'border')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FIELD_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value} className="text-xs">{option.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select
                value={condition.operator}
                onValueChange={(next) => {
                  const operator = next as FilterOperator;
                  update(index, { ...condition, operator, value: carriedValue(condition.field, condition.operator, operator, condition.value) });
                }}
              >
                <SelectTrigger aria-label={`Operator for filter ${index + 1}`} data-testid={`filter-operator-${index}`} className={cn(CONTROL, 'border')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {field.operators.map((operator) => (
                    <SelectItem key={operator} value={operator} className="text-xs" aria-label={OPERATOR_SPOKEN[operator]}>
                      {OPERATOR_LABELS[operator]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="col-span-2 min-w-0 sm:col-span-1">
                <ValueEditor index={index} condition={condition} programOptions={programOptions} onChange={(value) => update(index, { ...condition, value })} />
              </div>
              <button
                type="button"
                aria-label={`Remove filter ${index + 1}`}
                data-testid={`filter-remove-${index}`}
                onClick={() => remove(index)}
                className="col-start-2 row-start-1 grid h-9 w-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:col-start-4"
              >
                <X size={14} aria-hidden="true" />
              </button>
              {!isCompleteCondition(condition) && condition.value !== '' && (
                <p className="col-span-2 text-[11px] text-destructive sm:col-span-4" role="status">Finish this condition to apply it.</p>
              )}
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={add} data-testid="button-add-filter" className="h-8 text-xs">
          <Plus size={14} aria-hidden="true" /> Add condition
        </Button>
        {applied > 0 && (
          <Button type="button" variant="ghost" size="sm" onClick={onClearAll} data-testid="button-builder-clear" className="h-8 text-xs text-muted-foreground">
            Clear all
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-2 border-t border-border pt-3">
        {saving ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => { event.preventDefault(); save(); }}
          >
            <div className="min-w-0 flex-1">
              <label htmlFor={nameId} className="mb-1 block text-[10px] font-bold uppercase tracking-[.1em] text-muted-foreground">Quick set name</label>
              <Input
                id={nameId}
                value={name}
                onChange={(event) => { setName(event.target.value); if (nameError) setNameError(null); }}
                placeholder="e.g. Big spenders past day 50"
                data-testid="input-quick-set-name"
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError ? `${nameId}-error` : undefined}
                className={cn(CONTROL, 'border md:text-xs')}
                autoFocus
              />
            </div>
            <Button type="submit" size="sm" data-testid="button-save-quick-set" className="h-9 text-xs">Save</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => { setSaving(false); setNameError(null); }} className="h-9 text-xs">Cancel</Button>
            {nameError && <p id={`${nameId}-error`} role="alert" className="w-full text-[11px] text-destructive">{nameError}</p>}
          </form>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setSaving(true)}
              disabled={applied === 0}
              data-testid="button-save-quick-set-open"
              className="h-8 text-xs"
            >
              <Save size={14} aria-hidden="true" /> Save as quick set
            </Button>
            <Button type="button" size="sm" onClick={onDone} data-testid="button-filters-done" className="h-8 text-xs">Done</Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function RosterFilterButton({ applied, onApply, programOptions, onSaveQuickSet, matchCount }: {
  applied: readonly FilterCondition[];
  onApply: (conditions: FilterCondition[]) => void;
  programOptions: readonly FieldOption[];
  onSaveQuickSet: (name: string) => void;
  matchCount: number;
}) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [draft, setDraftState] = useState<FilterCondition[]>(() => [...applied]);
  const appliedSignature = useMemo(() => signatureOf(applied), [applied]);

  // The applied view changed from outside (chip, quick set, link): re-sync.
  useEffect(() => {
    setDraftState((current) => (signatureOf(current) === appliedSignature ? current : [...applied]));
  }, [applied, appliedSignature]);

  const setDraft = (next: FilterCondition[]) => {
    setDraftState(next);
    if (signatureOf(next) !== appliedSignature) onApply(completeConditions(next));
  };

  const count = applied.length;
  const trigger = (
    <button
      type="button"
      aria-label={count > 0 ? `Filter, ${count} active` : 'Filter'}
      aria-expanded={open}
      aria-haspopup="dialog"
      data-testid="button-filter"
      onClick={() => setOpen(true)}
      className={cn(
        'inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-xs font-semibold shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        count > 0 ? 'border-navy bg-navy text-white hover:bg-navy/90' : 'border-border bg-card text-navy hover:bg-accent',
      )}
    >
      <Filter size={14} aria-hidden="true" />
      Filter
      {count > 0 && (
        <span data-testid="badge-filter-count" className={cn(badgeVariants({ variant: 'secondary' }), 'h-5 min-w-5 justify-center rounded-full bg-white px-1.5 text-[10px] text-navy')} aria-hidden="true">
          {count}
        </span>
      )}
    </button>
  );

  const panel = (
    <BuilderPanel
      draft={draft}
      setDraft={setDraft}
      programOptions={programOptions}
      onClearAll={() => setDraft([])}
      onSaveQuickSet={onSaveQuickSet}
      onDone={() => setOpen(false)}
      matchCount={matchCount}
    />
  );

  if (isMobile) {
    return (
      <>
        {trigger}
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto rounded-t-lg" data-testid="roster-filter-sheet">
            <SheetHeader className="text-left">
              <SheetTitle className="font-serif text-navy">Filters</SheetTitle>
              <SheetDescription>Conditions stack: every one must match.</SheetDescription>
            </SheetHeader>
            <div className="mt-4">{panel}</div>
          </SheetContent>
        </Sheet>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-[min(40rem,calc(100vw-2rem))] rounded-lg bg-white p-4 shadow-lifted" aria-label="Filters" data-testid="roster-filter-popover">
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h2 className="font-serif text-base font-semibold text-navy">Filters</h2>
          <p className="text-[11px] text-muted-foreground">Conditions stack: every one must match.</p>
        </div>
        {panel}
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Sort (phone width; the table headers sort on desktop)
// ---------------------------------------------------------------------------

export const SORT_CHOICES: ReadonlyArray<{ sort: RosterSort; label: string }> = [
  { sort: { field: 'startDate', order: 'desc' }, label: 'Newest start' },
  { sort: { field: 'name', order: 'asc' }, label: 'Name A–Z' },
  { sort: { field: 'weightLoss', order: 'desc' }, label: 'Most weight lost' },
  { sort: { field: 'logging', order: 'asc' }, label: 'Lowest logging rate' },
  { sort: { field: 'spent', order: 'desc' }, label: 'Highest spend' },
  { sort: { field: 'status', order: 'asc' }, label: 'Status' },
];

export function RosterSortSelect({ sort, onChange, className }: { sort: RosterSort; onChange: (sort: RosterSort) => void; className?: string }) {
  const key = `${sort.field}.${sort.order}`;
  const known = SORT_CHOICES.some((choice) => `${choice.sort.field}.${choice.sort.order}` === key);
  return (
    <Select
      value={known ? key : undefined}
      onValueChange={(next) => {
        const choice = SORT_CHOICES.find((item) => `${item.sort.field}.${item.sort.order}` === next);
        if (choice) onChange(choice.sort);
      }}
    >
      <SelectTrigger aria-label="Sort patients" data-testid="select-sort" className={cn(CONTROL, 'w-auto border', className)}>
        <SelectValue placeholder="Sort" />
      </SelectTrigger>
      <SelectContent>
        {SORT_CHOICES.map((choice) => (
          <SelectItem key={`${choice.sort.field}.${choice.sort.order}`} value={`${choice.sort.field}.${choice.sort.order}`} className="text-xs">{choice.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
