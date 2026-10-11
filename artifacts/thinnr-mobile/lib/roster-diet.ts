// Read-only diet facts for the provider app's roster rows and patient record.
// Pure display helpers so the three-way model (unknown / no diet / known) is
// rendered the same way everywhere and can be pinned under Node.
import type { RosterDietFacts } from '@/lib/office-roster-api';

export type DietFactsInput = RosterDietFacts | null | undefined;

/** "Unknown" when the family did not load, "No diet" when nothing is chosen, else the library name. */
export function dietDisplayName(facts: DietFactsInput): string {
  if (facts == null) return 'Unknown';
  if (!facts.diet) return 'No diet';
  return facts.diet.slug === 'just_tracking' ? 'Just tracking' : facts.diet.name;
}

/** Phase badge copy from the program stage; null when the stage is not known. */
export function phaseLabel(stage: 'protocol' | 'maintenance' | null | undefined, week?: number | null): string | null {
  if (!stage) return null;
  if (stage === 'maintenance') return 'Maintenance';
  return week ? `Protocol · wk ${week}` : 'Protocol';
}

/** "% fits diet": a number only when a sample exists; unknown reads as "Unknown", never "0%". */
export function fitsDietDisplay(facts: DietFactsInput): { text: string; known: boolean; detail: string } {
  const pct = facts?.fitsDietPct ?? null;
  if (pct == null) {
    return {
      text: 'Unknown',
      known: false,
      detail: facts == null
        ? 'Diet facts did not load'
        : !facts.diet
          ? 'No diet chosen'
          : 'No scored foods logged yet',
    };
  }
  const sample = facts!.fitsDietSample;
  return {
    text: `${pct}%`,
    known: true,
    detail: `${sample} scored food${sample === 1 ? '' : 's'} · last ${facts!.fitWindowDays} days`,
  };
}

/** Compact one-line roster summary: "Mediterranean · Protocol · wk 2 · 80% fits". */
export function dietRowSummary(facts: DietFactsInput, stage?: 'protocol' | 'maintenance' | null, week?: number | null): string {
  const parts = [dietDisplayName(facts)];
  const phase = phaseLabel(stage, week);
  if (phase) parts.push(phase);
  const fits = fitsDietDisplay(facts);
  parts.push(fits.known ? `${fits.text} fits` : 'fit unknown');
  return parts.join(' · ');
}
