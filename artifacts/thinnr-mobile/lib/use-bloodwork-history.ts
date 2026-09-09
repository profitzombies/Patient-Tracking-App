import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getListBloodworkReportsQueryKey,
  listBloodworkReports,
  type BloodworkReportList,
  type ListBloodworkReportsParams,
} from '@workspace/api-client-react';

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
  const baseParams = input.officeId ? { office: input.officeId } : undefined;
  const baseKey = getListBloodworkReportsQueryKey(input.patientId, baseParams);
  const query = useQuery({
    queryKey: [...baseKey, input.userId, 'retained-pages', pageCount],
    enabled: input.enabled && !!input.token,
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