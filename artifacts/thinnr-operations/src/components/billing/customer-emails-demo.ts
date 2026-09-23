/**
 * Fixed guided-demo dataset for the Emails card. Every demo surface (HQ
 * transaction detail, office order detail, the patient record) builds its
 * rows from the order or patient already on screen, so the demo never reads
 * the clock and never issues a request. Rows are deterministic per order id.
 */
import type { CustomerEmail, CustomerEmailDelivery, CustomerEmailEvent, NotificationContact, OrderDetail } from '@/lib/billing-types';

export interface DemoEmailOrder {
  id: string;
  order_number: string;
  created_at: string;
  shipped_at?: string | null;
  delivered_at?: string | null;
  /** A failed card: the demo shows the payment-failed notice for this order. */
  payment_failed?: boolean;
}
export interface DemoEmailPayer { id: string; name: string; email: string | null; patient_id?: string | null }
export interface DemoEmailDataset {
  emails: CustomerEmail[];
  contacts: NotificationContact[];
  payer: DemoEmailPayer;
}

const HOUR = 3_600_000;
const iso = (base: string, hours: number) => new Date(Date.parse(base) + hours * HOUR).toISOString();
let eventSeq = 0;
const event = (event_type: string, occurred_at: string): CustomerEmailEvent => ({ id: `demo-event-${(eventSeq += 1)}`, event_type, occurred_at });

function row(
  order: DemoEmailOrder, payer: DemoEmailPayer, template_id: string, subject: string, at: string,
  overrides: Partial<CustomerEmail> = {},
): CustomerEmail {
  const built: Omit<CustomerEmail, 'delivery'> = {
    id: `demo-email-${order.id}-${template_id}`, kind: 'automatic', parent_id: null, contact_id: null, template_id, status: 'sent',
    recipient: payer.email ?? 'patient@example.com', subject, provider_id: 'office-1', office_name: null, payer_id: payer.id,
    payer_name: payer.name, patient_id: payer.patient_id ?? null, order_id: order.id, order_number: order.order_number, subscription_id: null,
    attempts: 1, max_attempts: 3, last_attempt_at: at, next_attempt_at: null, sent_at: at, vendor_message_id: `demo_${order.id}`,
    error: null, requested_by: null, created_at: at,
    attempt_log: [{ at, outcome: 'sent', error: null, vendor_message_id: `demo_${order.id}`, recipient_domain: 'example.com' }],
    events: [event('sent', at), event('delivered', iso(at, 0.05))],
    ...overrides,
  };
  return { ...built, delivery: deliveryFromEvents(built.events) };
}

/** The folded delivery columns a live row carries, derived from the demo's event list so both views agree. */
export function deliveryFromEvents(events: CustomerEmailEvent[]): CustomerEmailDelivery {
  const first = (type: string) => events.find((row) => row.event_type === type)?.occurred_at ?? null;
  const last = [...events].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))[0] ?? null;
  return {
    delivered_at: first('delivered'), delayed_at: first('delivery_delayed'), bounced_at: first('bounced'), complained_at: first('complained'),
    opened_at: first('opened'), clicked_at: first('clicked'), last_event_type: last?.event_type ?? null, last_event_at: last?.occurred_at ?? null,
  };
}

/** Emails for one order: confirmation (opened), shipped (clicked), delivered, plus a retrying/failed row on some orders. */
export function demoEmailsForOrder(order: DemoEmailOrder, payer: DemoEmailPayer): CustomerEmail[] {
  const emails: CustomerEmail[] = [];
  const confirmedAt = iso(order.created_at, 0.02);
  emails.push(row(order, payer, 'order-confirmation', `Order ${order.order_number} confirmed`, confirmedAt, {
    events: [event('sent', confirmedAt), event('delivered', iso(confirmedAt, 0.05)), event('opened', iso(confirmedAt, 2))],
  }));
  if (order.payment_failed) {
    const failedAt = iso(order.created_at, 0.5);
    emails.push(row(order, payer, 'subscription-payment-failed', 'Your payment did not go through', failedAt, {
      status: 'retrying', attempts: 2, sent_at: null, vendor_message_id: null, next_attempt_at: iso(failedAt, 1),
      error: 'The email service did not respond in time.', events: [],
      attempt_log: [
        { at: failedAt, outcome: 'failed', error: 'ETIMEDOUT', vendor_message_id: null, recipient_domain: 'example.com' },
        { at: iso(failedAt, 0.25), outcome: 'failed', error: 'ETIMEDOUT', vendor_message_id: null, recipient_domain: 'example.com' },
      ],
    }));
  }
  if (order.shipped_at) {
    const shippedAt = iso(order.shipped_at, 0.1);
    emails.push(row(order, payer, 'order-shipped', `Your order ${order.order_number} is on the way`, shippedAt, {
      events: [event('sent', shippedAt), event('delivered', iso(shippedAt, 0.05)), event('opened', iso(shippedAt, 1)), event('clicked', iso(shippedAt, 1.1))],
    }));
    // A prior send to the wrong address that bounced, then a manual resend by staff.
    if (/[12]$/.test(order.id)) {
      const bouncedAt = iso(shippedAt, 0.2);
      emails.push(row(order, payer, 'order-shipped', `Your order ${order.order_number} is on the way`, bouncedAt, {
        id: `demo-email-${order.id}-order-shipped-other`, kind: 'send_to_other', parent_id: `demo-email-${order.id}-order-shipped`,
        recipient: 'front-desk@example.com', status: 'failed', attempts: 3, sent_at: null, vendor_message_id: null,
        error: 'The address rejected the message (mailbox not found).',
        events: [],
        attempt_log: [1, 2, 3].map((attempt) => ({
          at: iso(bouncedAt, attempt * 0.2), outcome: 'failed' as const, error: '550 mailbox not found', vendor_message_id: null, recipient_domain: 'example.com',
        })),
      }));
    }
  }
  if (order.delivered_at) {
    const deliveredAt = iso(order.delivered_at, 0.05);
    emails.push(row(order, payer, 'order-delivered', `Your order ${order.order_number} was delivered`, deliveredAt));
  }
  // Newest first, like the live ledger.
  return emails.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

export function demoContactsForPayer(payer: DemoEmailPayer): NotificationContact[] {
  return [{
    id: `demo-contact-${payer.id}`, payer_id: payer.id, email: `family.${payer.id}@example.com`, label: 'Spouse', active: true,
    created_at: '2026-09-02T15:20:00.000Z', removed_at: null, added_by_name: 'Dr. Elena Park',
  }];
}

export function demoEmailDataset(payer: DemoEmailPayer, orders: DemoEmailOrder[]): DemoEmailDataset {
  return {
    payer,
    emails: orders.flatMap((order) => demoEmailsForOrder(order, payer)).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)),
    contacts: demoContactsForPayer(payer),
  };
}

/** The demo order pages already hold an OrderDetail; derive the email timeline from its own dates. */
export function demoEmailDatasetForOrder(order: OrderDetail): DemoEmailDataset {
  const shipped = order.shipment?.status === 'shipped' || order.shipment?.status === 'delivered' || order.fulfillment_status === 'shipped';
  return demoEmailDataset(
    { id: order.payer.id, name: order.payer.name, email: order.payer.email, patient_id: order.payer.patient_id },
    [{
      id: order.id, order_number: order.order_number, created_at: order.created_at,
      shipped_at: shipped ? order.shipped_at ?? order.paid_at ?? order.created_at : null,
      delivered_at: order.shipment?.status === 'delivered' ? order.shipment.delivered_at ?? order.shipped_at ?? order.created_at : null,
      payment_failed: order.status === 'failed',
    }],
  );
}
