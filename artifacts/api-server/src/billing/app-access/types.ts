import type { AppAccessEntitlement } from "./entitlement";

/** GET /patient-data/billing/app-access */
export interface PatientAppAccessResponse extends AppAccessEntitlement {
  /** The governing app-access subscription in the patient's subscriptions list, when one exists. */
  subscription_id: string | null;
  /**
   * Public checkout page for starting the subscription (short-lived token).
   * Null while a free window, an existing subscription or a non-charging
   * office makes an upgrade pointless.
   */
  checkout_url: string | null;
}
