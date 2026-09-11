import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getListBloodworkReportsQueryKey,
  listBloodworkReports,
  type BloodworkReportList,
  type ListBloodworkReportsParams,
} from '@workspace/api-client-react';

/** Shared prefix for every retained-page history query in one patient scope. */
export function getBloodworkHistoryQueryKey(input: {
  patientId: string;
  userId: string;
  officeId?: string;
}) {
  return [
    ...getListBloodworkReportsQueryKey(
      input.patientId,
      input.officeId ? { office: input.officeId } : undefined,
    ),
    input.userId,
    'retained-pages',
  ] as const;
}

export async function loadBloodworkHistoryPages(input: {
  patientId: string;
  officeId?: string;
  pageCount: number;
  token: string;
  signal?: AbortSignal;
  fetchPage?: typeof listBloodworkReports;
}): Promise<BloodworkReportList> {
  const reports: BloodworkReportList['reports'] = [];
  let cursor: string | null = null;
  for (let page = 0; page < input.pageCount; page += 1) {
    const params: ListBloodworkReportsParams = {
      ...(input.officeId ? { office: input.officeId } : {}),
      ...(cursor ? { cursor } : {}),
    };
    const response = await (input.fetchPage ?? listBloodworkReports)(input.patientId, params, {
      signal: input.signal,
      headers: { Authorization: `Bearer ${input.token}` },
    });
    reports.push(...response.reports);
    cursor = response.nextCursor;
    if (!cursor) break;
  }
  return { reports, nextCursor: cursor };
}

export function useBloodworkHistory(input: {
  patientId: string;
  officeId?: string;
  userId: string;
  token: string;
  enabled: boolean;
}) {
  const [pageCount, setPageCount] = useState(1);
  const scope = `${input.userId}:${input.patientId}:${input.officeId ?? ''}`;
  useEffect(() => setPageCount(1), [scope]);
  const historyKey = getBloodworkHistoryQueryKey(input);
  const query = useQuery<BloodworkReportList>({
    queryKey: [...historyKey, pageCount],
    enabled: input.enabled && !!input.token,
    // Keep the first page visible while a pull-to-refresh or a "load more"
    // request is in flight. The current query still owns the eventual error,
    // so callers can show an explicit retry without blanking known reports.
    placeholderData: (previous, previousQuery) => {
      const previousKey = previousQuery?.queryKey ?? [];
      const samePatientScope = historyKey.every((part, index) => (
        previousKey[index] === part
        || JSON.stringify(previousKey[index]) === JSON.stringify(part)
      ));
      return samePatientScope ? previous : undefined;
    },
    queryFn: ({ signal }) => loadBloodworkHistoryPages({
      patientId: input.patientId,
      officeId: input.officeId,
      pageCount,
      token: input.token,
      signal,
    }),
  });
  const loadMore = useCallback(() => {
    if (query.data?.nextCursor && !query.isFetching) setPageCount(value => value + 1);
  }, [query.data?.nextCursor, query.isFetching]);
  return { ...query, loadMore };
}