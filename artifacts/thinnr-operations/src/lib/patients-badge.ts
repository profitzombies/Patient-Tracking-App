/**
 * The Patients menu badge and the attention-first roster flag.
 *
 * The badge shows the office's total patient count. When the shared attention
 * evaluator (the same one behind the "Needs attention" page and the bell)
 * flags anyone, the badge turns amber and shows the flagged count instead,
 * and the Patients link carries `?attention=first` so the roster opens with
 * the flagged patients pinned to the top. The URL flag is the only source of
 * truth for that ordering (reload and shared links keep it).
 */

export const PATIENTS_ATTENTION_PARAM = 'attention';
export const PATIENTS_ATTENTION_FIRST = 'first';

export interface PatientsBadgeCounts {
  /** Total roster size; null while the roster is loading or failed. */
  total: number | null;
  /** Evaluator-flagged patients; null while unknown. */
  flagged: number | null;
}

export interface PatientsBadge {
  /** Number shown in the chip; undefined renders no chip at all. */
  count: number | undefined;
  tone: 'default' | 'attention';
  /** Hover / screen-reader text naming which number is showing. */
  label: string | undefined;
  /** Menu link target: carries the attention-first flag while amber. */
  href: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Derives the chip from the counts; loading/error states show no number rather than 0. */
export function patientsBadge(counts: PatientsBadgeCounts): PatientsBadge {
  if (counts.total === null) {
    return { count: undefined, tone: 'default', label: undefined, href: '/patients' };
  }
  const flagged = counts.flagged ?? 0;
  if (flagged > 0) {
    return {
      count: flagged,
      tone: 'attention',
      label: `${flagged} need${flagged === 1 ? 's' : ''} attention · ${plural(counts.total, 'patient')}`,
      href: `/patients?${PATIENTS_ATTENTION_PARAM}=${PATIENTS_ATTENTION_FIRST}`,
    };
  }
  return { count: counts.total, tone: 'default', label: plural(counts.total, 'patient'), href: '/patients' };
}

/** True when the roster URL asks for evaluator-flagged patients first. */
export function isAttentionFirst(search: string): boolean {
  return new URLSearchParams(search).get(PATIENTS_ATTENTION_PARAM) === PATIENTS_ATTENTION_FIRST;
}

/** The same query string with the attention-first flag removed (empty string when nothing is left). */
export function withoutAttentionFirst(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(PATIENTS_ATTENTION_PARAM);
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

/**
 * Stable partition: flagged rows first, then everyone else, each group keeping
 * the order it arrived in (the roster's current sort decides ties).
 */
export function pinFlaggedFirst<T>(rows: T[], isFlagged: (row: T) => boolean): T[] {
  const flagged: T[] = [];
  const rest: T[] = [];
  for (const row of rows) (isFlagged(row) ? flagged : rest).push(row);
  return flagged.concat(rest);
}
