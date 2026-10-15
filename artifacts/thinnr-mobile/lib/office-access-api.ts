/**
 * The office's own THINNR access, from the provider app: what it owes,
 * whether the workspace is narrowed for nonpayment, and paying it.
 *
 * Rides the same staff bearer as the rest of the office API. Any staff member
 * may pay — the server does not gate this on the owner role, and neither
 * does the app.
 */
import { officeBearerRequest, type OfficeRequestScope } from '@/lib/office-roster-api';

export interface OfficeAccessState {
  restricted: boolean;
  message: string | null;
  allowed_capabilities: string[] | null;
  share_percent: number;
  state: string | null;
  plan: string | null;
  price_cents: number | null;
  lifetime: boolean;
  included_period_ends_at: string | null;
  paid_through: string | null;
  grace_ends_at: string | null;
  restricted_at: string | null;
  setup_completed_at: string | null;
  /** 'software' offices have no Training; absent (older servers) reads as reseller. */
  office_kind?: 'reseller' | 'software';
}

export interface OfficeAccessPayment extends OfficeAccessState {
  paid: boolean;
  pending: boolean;
}

export function fetchOfficeAccess(scope?: OfficeRequestScope): Promise<OfficeAccessState> {
  return officeBearerRequest<OfficeAccessState>('GET', '/office/access', undefined, scope);
}

export function payOfficeAccess(scope?: OfficeRequestScope): Promise<OfficeAccessPayment> {
  return officeBearerRequest<OfficeAccessPayment>('POST', '/office/access/pay', {}, scope);
}
