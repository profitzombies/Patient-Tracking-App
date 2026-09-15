import { OfficeRosterError, officeBearerRequest } from '@/lib/office-roster-api';

export interface OfficeAlertsData {
  asOf: string;
  count: number;
  total: number;
}

export async function fetchOfficeAlerts(input: {
  userId: string;
  signal?: AbortSignal;
}): Promise<OfficeAlertsData> {
  const json = await officeBearerRequest<OfficeAlertsData>(
    'GET',
    '/office/alerts',
    undefined,
    input,
  );
  if (!json || typeof json.count !== 'number' || typeof json.total !== 'number' || typeof json.asOf !== 'string') {
    throw new OfficeRosterError('The alerts service returned an invalid response.', 502);
  }
  return json;
}