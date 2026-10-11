import { AlertTriangle, ShieldAlert } from "lucide-react";
import type { RosterDietFacts } from "@/lib/office-roster";

/**
 * Roster diet facts. Three-way model shared with the activity signals:
 *  - `facts === null`  → the diet family could not be read: renders "Unknown"
 *    in the dashed neutral tint (a data gap, never "no diet").
 *  - `facts.diet === null` → a real "no diet chosen".
 *  - `fitsDietPct === null` → unknown (no scored foods yet), never 0 %.
 * The phase badge rides the row's program stage (protocol week / maintenance).
 */
export function dietDisplayName(facts: RosterDietFacts | null | undefined): string {
  if (facts == null) return 'Unknown';
  if (!facts.diet) return 'No diet';
  return facts.diet.slug === 'just_tracking' ? 'Just tracking' : facts.diet.name;
}

export function PhaseBadge({ stage, week, className = '' }: { stage: 'protocol' | 'maintenance' | null | undefined; week?: number | null; className?: string }) {
  if (!stage) return null;
  const protocol = stage === 'protocol';
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-sm border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[.05em] ${
        protocol ? 'border-accent-border bg-accent text-primary' : 'border-border bg-secondary text-muted-foreground'
      } ${className}`}
      data-testid="badge-diet-phase"
    >
      {protocol ? (week ? `Protocol · wk ${week}` : 'Protocol') : 'Maintenance'}
    </span>
  );
}

export function PendingBlockBadge({ patientId, className = '' }: { patientId: string; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm border border-[#e8b47c] bg-[#fff4e6] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[.05em] text-[#b65c22] ${className}`}
      title="A diet safety block is waiting for provider review"
      data-testid={`badge-pending-block-${patientId}`}
    >
      <ShieldAlert size={10} aria-hidden="true" />
      Block pending
    </span>
  );
}

export function SevereAllergyBadge({ patientId, className = '' }: { patientId: string; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm border border-[#d5a7a7] bg-[#fff0f0] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[.05em] text-destructive ${className}`}
      title="A severe allergy is on file"
      data-testid={`badge-severe-allergy-${patientId}`}
    >
      <AlertTriangle size={10} aria-hidden="true" />
      Severe allergy
    </span>
  );
}

export function RosterDietCell({ patientId, facts, stage, week, align = 'left' }: {
  patientId: string;
  facts: RosterDietFacts | null | undefined;
  stage: 'protocol' | 'maintenance' | null | undefined;
  week?: number | null;
  align?: 'left' | 'right';
}) {
  const unknown = facts == null;
  return (
    <div className={`flex flex-col gap-1 ${align === 'right' ? 'items-end text-right' : 'items-start'}`} data-testid={`diet-cell-${patientId}`}>
      <span
        className={unknown ? 'text-[11px] italic text-muted-foreground' : facts.diet ? 'text-xs font-semibold text-navy' : 'text-xs text-muted-foreground'}
        title={unknown ? 'Diet facts did not load for this patient' : undefined}
      >
        {dietDisplayName(facts)}
      </span>
      <div className={`flex flex-wrap gap-1 ${align === 'right' ? 'justify-end' : ''}`}>
        <PhaseBadge stage={stage} week={week} />
        {facts?.pendingBlock && <PendingBlockBadge patientId={patientId} />}
        {facts?.severeAllergy && <SevereAllergyBadge patientId={patientId} />}
      </div>
    </div>
  );
}

/** "% fits diet": a number only when there is a sample; unknown reads as unknown, never 0 %. */
export function FitsDietCell({ patientId, facts, align = 'left' }: { patientId: string; facts: RosterDietFacts | null | undefined; align?: 'left' | 'right' }) {
  const pct = facts?.fitsDietPct ?? null;
  if (pct == null) {
    return (
      <span
        className={`block text-[11px] italic text-muted-foreground ${align === 'right' ? 'text-right' : ''}`}
        data-testid={`fits-diet-${patientId}`}
        title={facts == null ? 'Diet facts did not load for this patient' : !facts.diet ? 'No diet chosen' : 'No scored foods logged in the window yet'}
      >
        Unknown
      </span>
    );
  }
  return (
    <span
      className={`block font-mono font-semibold text-navy ${align === 'right' ? 'text-right' : ''}`}
      data-testid={`fits-diet-${patientId}`}
      title={`${facts!.fitsDietSample} scored food${facts!.fitsDietSample === 1 ? '' : 's'} in the last ${facts!.fitWindowDays} days`}
    >
      {pct}%
    </span>
  );
}
