/**
 * The office-level CSVs inside a whole-office bundle. Four reuse the staff
 * export generators verbatim (all-time range); payments, refunds, shipments,
 * and the staff team are bundle-only sheets over the billing and team tables.
 */
import type { CsvCell } from "./csv";
import { dollars, GENERATORS, pageAll, type ExportSheet } from "./generators";
import type { ExportScope } from "./kinds";
import { withExportBillingIdentity } from "./billing-identity";

const enc = encodeURIComponent;

async function payments(providerId: string): Promise<ExportSheet> {
  const rows = await pageAll(
    `/rest/v1/billing_ledger?provider_id=eq.${enc(providerId)}&select=id,occurred_at,kind,amount_cents,application_fee_cents,stripe_ref,order_id,subscription_id,billing_orders(order_number)&order=occurred_at.asc,id.asc`,
  );
  return {
    header: ["Ledger ID", "Occurred at", "Kind", "Amount (USD)", "Application fee (USD)", "Stripe reference", "Order number", "Order ID", "Subscription ID"],
    rows: rows.map((row): CsvCell[] => {
      const order = (row.billing_orders ?? {}) as Record<string, unknown>;
      return [
        String(row.id ?? ""), String(row.occurred_at ?? ""), String(row.kind ?? ""), dollars(row.amount_cents),
        dollars(row.application_fee_cents), String(row.stripe_ref ?? ""), String(order.order_number ?? ""),
        String(row.order_id ?? ""), String(row.subscription_id ?? ""),
      ];
    }),
  };
}

async function refunds(providerId: string): Promise<ExportSheet> {
  const rows = await pageAll(
    `/rest/v1/billing_refunds?billing_orders.provider_id=eq.${enc(providerId)}&select=id,created_at,amount_cents,reason,status,stripe_refund_id,order_id,billing_orders!inner(order_number,provider_id)&order=created_at.asc,id.asc`,
  );
  return {
    header: ["Refund ID", "Date", "Order number", "Order ID", "Amount (USD)", "Reason", "Status", "Stripe refund ID"],
    rows: rows.map((row): CsvCell[] => {
      const order = (row.billing_orders ?? {}) as Record<string, unknown>;
      return [
        String(row.id ?? ""), String(row.created_at ?? ""), String(order.order_number ?? ""), String(row.order_id ?? ""),
        dollars(row.amount_cents), String(row.reason ?? ""), String(row.status ?? ""), String(row.stripe_refund_id ?? ""),
      ];
    }),
  };
}

async function shipments(providerId: string): Promise<ExportSheet> {
  const rows = await pageAll(
    `/rest/v1/billing_shipments?provider_id=eq.${enc(providerId)}&select=id,order_id,status,carrier,tracking_number,tracking_url,source,external_id,label_created_at,shipped_at,delivered_at,canceled_at,canceled_reason,created_at,billing_orders(order_number)&order=created_at.asc,id.asc`,
  );
  return {
    header: [
      "Shipment ID", "Order number", "Order ID", "Status", "Carrier", "Tracking number", "Tracking URL", "Source",
      "Provider reference", "Label created at", "Shipped at", "Delivered at", "Canceled at", "Cancel reason", "Created at",
    ],
    rows: rows.map((row): CsvCell[] => {
      const order = (row.billing_orders ?? {}) as Record<string, unknown>;
      return [
        String(row.id ?? ""), String(order.order_number ?? ""), String(row.order_id ?? ""), String(row.status ?? ""),
        String(row.carrier ?? ""), String(row.tracking_number ?? ""), String(row.tracking_url ?? ""), String(row.source ?? ""),
        String(row.external_id ?? ""), String(row.label_created_at ?? ""), String(row.shipped_at ?? ""),
        String(row.delivered_at ?? ""), String(row.canceled_at ?? ""), String(row.canceled_reason ?? ""), String(row.created_at ?? ""),
      ];
    }),
  };
}

async function staffTeam(providerId: string): Promise<ExportSheet> {
  const [owners, members] = await Promise.all([
    pageAll(`/rest/v1/providers?provider_id=eq.${enc(providerId)}&select=provider_id,provider_name,email,office_name,created_at`),
    pageAll(`/rest/v1/team_members?provider_id=eq.${enc(providerId)}&select=id,name,email,office_role,activation_status,auth_user_id,created_at,claimed_at&order=created_at.asc,id.asc`),
  ]);
  const header = ["Member ID", "Name", "Email", "Role", "Status", "Signed in before", "Added at", "Claimed at"];
  const rows: CsvCell[][] = [
    ...owners.map((owner): CsvCell[] => [
      String(owner.provider_id ?? ""), String(owner.provider_name ?? ""), String(owner.email ?? ""), "owner", "active", "", String(owner.created_at ?? ""), "",
    ]),
    ...members.map((member): CsvCell[] => [
      String(member.id ?? ""), String(member.name ?? ""), String(member.email ?? ""), String(member.office_role ?? ""),
      String(member.activation_status ?? ""), member.auth_user_id ? "yes" : "no", String(member.created_at ?? ""), String(member.claimed_at ?? ""),
    ]),
  ];
  return { header, rows };
}

/** Every office sheet, in bundle order. `scope.range` spans all time. */
export async function officeBusinessSheets(scope: ExportScope, _today: string): Promise<Array<{ file: string; sheet: ExportSheet }>> {
  return withExportBillingIdentity(scope, () => scopedOfficeBusinessSheets(scope));
}
async function scopedOfficeBusinessSheets(scope: ExportScope): Promise<Array<{ file: string; sheet: ExportSheet }>> {
  if (!scope.providerId) throw new Error("office sheets need an office scope");
  const providerId = scope.providerId;
  return [
    { file: "office/orders.csv", sheet: await GENERATORS.billing_transactions(scope) },
    { file: "office/payments.csv", sheet: await payments(providerId) },
    { file: "office/refunds.csv", sheet: await refunds(providerId) },
    { file: "office/shipments.csv", sheet: await shipments(providerId) },
    { file: "office/subscriptions.csv", sheet: await GENERATORS.billing_subscriptions(scope) },
    { file: "office/staff-team.csv", sheet: await staffTeam(providerId) },
    { file: "office/audit-events.csv", sheet: await GENERATORS.audit_events(scope) },
    { file: "office/patient-activity.csv", sheet: await GENERATORS.patient_activity(scope) },
  ];
}
