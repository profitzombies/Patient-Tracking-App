/**
 * Human-readable wording for audit events, shared by the HQ Audit Log and
 * the office Audit page. Actions arrive as fixed server-side identifiers;
 * every one maps to a short sentence here, and an unknown identifier falls
 * back to a readable version of itself so a new action is never blank.
 */

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  patient_invitation_created: 'Invited a patient',
  patient_invitation_resent: 'Resent a patient invitation',
  patient_follow_up_open: 'Opened a patient follow-up',
  patient_follow_up_resolved: 'Resolved a patient follow-up',
  patient_profile_updated: 'Updated a patient profile',
  patient_status_changed: 'Changed a patient status',
  patient_note_added: 'Added a patient note',
  patient_note_deleted: 'Deleted a patient note',
  patient_weight_recorded: 'Recorded a patient weight',
  patient_weight_updated: 'Corrected a patient weight',
  patient_weight_removed: 'Removed a patient weight',
  patient_measurements_recorded: 'Recorded body measurements',
  patient_measurements_removed: 'Removed body measurements',
  patient_medication_added: 'Added a patient medication',
  patient_medication_updated: 'Updated a patient medication',
  patient_medication_stopped: 'Stopped a patient medication',
  provider_account_created: 'Created an office account',
  provider_account_updated: 'Updated an office account',
  office_team_invited: 'Invited a teammate',
  office_team_role_changed: 'Changed a teammate role',
  office_team_deactivated: 'Deactivated a teammate',
  office_team_reactivated: 'Reactivated a teammate',
  office_team_signed_out: 'Signed a teammate out everywhere',
  hq_team_invited: 'Invited an HQ member',
  hq_team_updated: 'Updated an HQ member',
  hq_team_revoked: 'Revoked HQ access',
  hq_settings_updated: 'Updated organization settings',
  office_policy_override_updated: 'Updated an office policy override',
  hq_file_uploaded: 'Uploaded a file',
  hq_file_downloaded: 'Downloaded a file',
  hq_file_deleted: 'Deleted a file',
  knowledge_document_uploaded: 'Uploaded a knowledge document',
  knowledge_document_replaced: 'Replaced a knowledge document',
  knowledge_document_deleted: 'Deleted a knowledge document',
  training_published: 'Published training content',
  training_unpublished: 'Unpublished training content',
  training_deleted: 'Deleted training content',
  training_media_deleted: 'Removed training media',
  training_attachment_downloaded: 'Downloaded a training attachment',
  ai_support_used: 'Used AI Support',
  conversation_transcript_read: 'Read a patient conversation transcript',
  conversation_replied: 'Replied to a patient conversation',
  conversation_assigned: 'Assigned a patient conversation',
  conversation_status_changed: 'Changed a conversation status',
  conversation_note_added: 'Added an internal conversation note',
  conversation_escalated: 'Escalated a conversation to HQ',
  conversation_escalation_resolved: 'Resolved a conversation escalation',
  data_export_requested: 'Requested a data export',
  data_export_downloaded: 'Downloaded a data export',
  security_password_changed: 'Changed their password',
  security_sessions_signed_out: 'Signed out other devices',
  security_sign_in_reported: 'Reported a sign-in as not theirs',
  security_recovery_completed: 'Recovered their account',
  office_team_sessions_viewed: 'Viewed a teammate\'s sessions',
  hq_team_sessions_viewed: 'Viewed an HQ member\'s sessions',
  hq_team_signed_out: 'Signed an HQ member out everywhere',
  patient_sessions_viewed: 'Viewed a patient\'s sessions',
  patient_signed_out: 'Signed a patient out everywhere',
  access_denied: 'Was refused access',
  billing_refund_issued: 'Issued a refund',
  billing_subscription_cancelled: 'Cancelled a subscription',
  billing_subscription_payment_retried: 'Retried a subscription payment',
  billing_subscription_payment_email_sent: 'Emailed a payment link',
  billing_subscription_paused: 'Paused a subscription',
  billing_subscription_resumed: 'Resumed a subscription',
  billing_subscription_changed: 'Changed a subscription product',
  billing_order_fulfillment_updated: 'Updated order fulfilment',
  billing_prices_updated: 'Updated prices',
  billing_payment_link_created: 'Created a payment link',
  billing_payment_link_updated: 'Updated a payment link',
  billing_connect_started: 'Started Stripe connection',
  billing_connect_completed: 'Completed Stripe connection',
  billing_connect_disconnected: 'Disconnected Stripe',
  billing_settings_updated: 'Updated billing settings',
  billing_sandbox_reset: 'Reset billing sandbox',
  billing_product_created: 'Created a billing product',
  billing_product_updated: 'Updated a billing product',
  billing_product_archived: 'Archived a billing product',
  billing_product_floor_updated: 'Updated a product floor price',
};

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

const METADATA_LABELS: Record<string, string> = {
  reason: 'Reason',
  channel: 'Channel',
  sessions: 'Sessions',
  scope: 'Scope',
  role: 'Role',
  status: 'Status',
  field: 'Field',
  fields: 'Fields',
  from: 'From',
  to: 'To',
  size: 'Size',
  contentType: 'Type',
  thread: 'Thread',
  kind: 'Kind',
  office: 'Office scope',
  rows: 'Rows',
  route: 'Route',
  method: 'Method',
  turn: 'Turn',
  mediaKind: 'Media',
  version: 'Version',
  section: 'Section',
  areaCount: 'Areas',
  dateKey: 'Date',
  page: 'Page',
  self: 'Self-assigned',
  length: 'Characters',
  department: 'Department',
  hasNote: 'With note',
  order_id: 'Order ID',
  subscription_id: 'Subscription ID',
  link_id: 'Link ID',
  product_id: 'Product ID',
  amount_cents: 'Amount in cents',
  floor_price_cents: 'Floor price in cents',
  at_period_end: 'At period end',
  fulfillment_status: 'Fulfilment',
  has_tracking: 'Has tracking',
  keys_changed: 'Settings changed',
  products_changed: 'Products changed',
  active: 'Active',
};

/** Keys that are internal record ids: hidden from the office page, shown as fine print at HQ. */
const ID_KEYS = new Set(['noteId', 'weightId', 'visitId', 'medicationId', 'attachmentId', 'assigneeUserId', 'previousAssigneeUserId', 'messageClientId', 'escalationId', 'order_id', 'subscription_id', 'link_id', 'product_id']);

export interface AuditDetail {
  label: string;
  value: string;
}

export function auditDetails(
  metadata: Record<string, string | number | boolean | null>,
  options: { includeIds?: boolean } = {},
): AuditDetail[] {
  const details: AuditDetail[] = [];
  for (const [key, raw] of Object.entries(metadata)) {
    if (raw === null || raw === undefined) continue;
    if (ID_KEYS.has(key) && !options.includeIds) continue;
    const label = METADATA_LABELS[key] ?? key;
    let value: string;
    if (key === 'size' && typeof raw === 'number') value = formatBytes(raw);
    else if (typeof raw === 'string') value = raw.replace(/_/g, ' ');
    else value = String(raw);
    details.push({ label, value });
  }
  return details;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
