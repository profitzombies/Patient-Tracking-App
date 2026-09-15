import { authedRequest } from '@/lib/patient-data-api';
import type {
  PatientBillingOverview,
  PatientBillingSubscription,
  PatientCheckoutLink,
  PatientCheckoutLinkRequest,
  PatientReceipt,
} from '@/lib/patient-billing-types';

function mutationKey(kind: string, id = ''): string {
  return `patient-billing-${kind}-${id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function getBillingOverview(): Promise<PatientBillingOverview> {
  return authedRequest('GET', '/patient-data/billing/overview') as Promise<PatientBillingOverview>;
}

export function createCheckoutLink(input: PatientCheckoutLinkRequest): Promise<PatientCheckoutLink> {
  return authedRequest('POST', '/patient-data/billing/checkout-link', input, {
    idempotencyKey: mutationKey('checkout', input.product_id ?? 'general'),
  }) as Promise<PatientCheckoutLink>;
}

export function getOrderReceipt(orderId: string): Promise<PatientReceipt> {
  return authedRequest(
    'GET',
    `/patient-data/billing/orders/${encodeURIComponent(orderId)}/receipt`,
  ) as Promise<PatientReceipt>;
}

export function cancelSubscription(id: string): Promise<PatientBillingSubscription> {
  return authedRequest(
    'POST',
    `/patient-data/billing/subscriptions/${encodeURIComponent(id)}/cancel`,
    {},
    { idempotencyKey: mutationKey('cancel', id) },
  ) as Promise<PatientBillingSubscription>;
}