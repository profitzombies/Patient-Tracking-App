/**
 * Protocol episodes (every restart from day one) and activity-level history
 * for Plan and Progress, read from the server. Errors stay errors so an
 * outage never looks like "never restarted / never recorded".
 */
import { useCallback, useEffect, useState } from 'react';
import { usePatient } from '@/context/PatientContext';
import { usePatientAccount } from '@/context/PatientAccountContext';
import { isActivityLevel, type ActivityLevel } from '@/lib/diet-fit';

export interface DietEpisodeRow {
  id: string;
  episodeNumber: number;
  startedOn: string;
  endedOn: string | null;
  reason: string;
}

export interface ActivityHistoryRow {
  level: ActivityLevel;
  source: string;
  recordedOn: string;
}

export interface DietHistory {
  episodes: DietEpisodeRow[];
  activity: ActivityHistoryRow[];
}

export type DietHistoryStatus = 'loading' | 'live' | 'error';

function strOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Tolerant parse of the history payload; malformed rows are dropped, not thrown. */
export function parseDietHistory(json: unknown): DietHistory {
  const data = (json ?? {}) as Record<string, unknown>;
  const episodes: DietEpisodeRow[] = [];
  for (const raw of Array.isArray(data.episodes) ? data.episodes : []) {
    const row = (raw ?? {}) as Record<string, unknown>;
    const id = strOf(row.id);
    const startedOn = strOf(row.startedOn);
    if (!id || !startedOn || typeof row.episodeNumber !== 'number') continue;
    episodes.push({ id, episodeNumber: row.episodeNumber, startedOn, endedOn: strOf(row.endedOn), reason: strOf(row.reason) ?? '' });
  }
  const activity: ActivityHistoryRow[] = [];
  for (const raw of Array.isArray(data.activity) ? data.activity : []) {
    const row = (raw ?? {}) as Record<string, unknown>;
    const recordedOn = strOf(row.recordedOn);
    if (!recordedOn || !isActivityLevel(row.level)) continue;
    activity.push({ level: row.level, source: strOf(row.source) ?? '', recordedOn });
  }
  episodes.sort((a, b) => b.episodeNumber - a.episodeNumber);
  activity.sort((a, b) => (a.recordedOn < b.recordedOn ? 1 : a.recordedOn > b.recordedOn ? -1 : 0));
  return { episodes, activity };
}

export function useDietHistory(): { history: DietHistory | null; status: DietHistoryStatus; reload: () => void } {
  const { account } = usePatientAccount();
  const { diet } = usePatient();
  const [state, setState] = useState<{ history: DietHistory | null; status: DietHistoryStatus }>({ history: null, status: 'loading' });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick(t => t + 1), []);
  // Suite fakes may omit the diet rail; treat that like an unresolved read.
  const api = account.kind === 'real' && typeof account.api.diet?.fetchHistory === 'function' ? account.api.diet : null;
  const accountKey = account.kind === 'real' ? `real:${account.patientId}` : account.kind;
  // A new activity answer (check-in, settings) re-reads the ledger.
  const activityKey = diet?.activityLevel ? `${diet.activityLevel.recordedOn}:${diet.activityLevel.level}` : '';

  useEffect(() => {
    let active = true;
    if (!api) {
      // Not a resolved account: nothing to show yet; the account must settle first.
      setState({ history: null, status: 'loading' });
      return () => {
        active = false;
      };
    }
    setState(prev => ({ history: prev.history, status: 'loading' }));
    api.fetchHistory().then(
      json => {
        if (active) setState({ history: parseDietHistory(json), status: 'live' });
      },
      () => {
        if (active) setState(prev => ({ history: prev.history, status: 'error' }));
      },
    );
    return () => {
      active = false;
    };
    // accountKey stands in for the api identity (one api per resolved account).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountKey, account.kind, tick, activityKey]);

  return { history: state.history, status: state.status, reload };
}
