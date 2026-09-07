/**
 * Client for the office Audit page — GET /api/office/audit-events.
 *
 * The server scopes the list to the caller's office and resolves every id
 * to a name before responding, so nothing here ever sees a raw provider or
 * user id.
 */
import { officeQuery, officeRequest, OfficeApiError } from '@/lib/office-api';

export { OfficeApiError as OfficeAuditError };

export interface OfficeAuditEvent {
  id: number;
  occurredAt: string;
  action: string;
  actorName: string;
  actorKind: string;
  targetName: string | null;
  targetKind: string | null;
  metadata: Record<string, string | number | boolean | null>;
}

export interface OfficeAuditPage {
  office: { name: string };
  actions: string[];
  events: OfficeAuditEvent[];
  total?: number;
  hasMore?: boolean;
}

export interface OfficeAuditFilters {
  limit: number;
  offset: number;
  action?: string;
  from?: string;
  to?: string;
}

const MESSAGES = {
  unconfigured: 'The audit trail is not configured in this environment.',
  signedOut: 'Sign in to see this office’s audit trail.',
  unreachable: 'Could not reach the audit service. Check your connection and try again.',
  failed: 'The audit request failed',
};

export function officeAuditQueryKey(office: string | null, filters: OfficeAuditFilters): readonly unknown[] {
  return ['office-audit', office ?? 'self', filters];
}

export async function fetchOfficeAudit(filters: OfficeAuditFilters, office?: string | null): Promise<OfficeAuditPage> {
  const params = new URLSearchParams();
  params.set('limit', String(filters.limit));
  params.set('offset', String(filters.offset));
  if (filters.action) params.set('action', filters.action);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  return officeRequest<OfficeAuditPage>(`/api/office/audit-events${officeQuery(office, params)}`, MESSAGES);
}
