---
name: Staff Emails card (order + patient pages)
description: Lessons from building the shared customer-email ledger card used by HQ transaction detail, office order detail, and the patient record.
---

## Permissions come from the ledger routes, not a role lookup
The office email routes 403 anyone below owner/admin (they share the Payments-area scope), so a loaded list already proves the viewer may act. The card takes a single `canAct` and pages pass `true` for office viewers; the only extra client gate is HQ (`useHqCanManageEmails`: HQ needs Super Admin/Admin, non-HQ always true) because an HQ drill-in resolves as office owner server-side.
**Why:** The plan said "office staff can view only", but the API has no staff-readable route. Rather than widening the API, staff see a plain "visible to office owners and admins" 403 state.
**How to apply:** Don't add a billing-status request to patient pages just to learn the role; treat 403 as a fact about the caller (no retry) and everything else as transient (one retry, then an announced error with Retry).

## Demo dataset is derived from the page's own order/patient
Demo rows are deterministic per order id (`demo-email-<orderId>-<templateId>`), built from the order's own created/shipped/delivered dates, so no clock reads and no requests. Preview in demo renders the real template client-side via the email-templates lib instead of fetching.
**How to apply:** New demo surfaces call `demoEmailDataset(payer, orders)`; the "bounced send-to-other" fixture only rides orders whose id ends in 1 or 2 — pick such an order when asserting on it.

## Dialog conventions that the DOM-free suites can see
Resend sits absolutely at `right-12 top-3` beside Radix's built-in Close (`right-4 top-4`); confirmation is an inline strip inside the same dialog (no nested dialogs, which the stub dialog cannot render anyway). The stub dialog does not set `aria-labelledby`, so assert on the heading text, not the attribute.

## react-query retry knobs in RTR suites
Passing a `retry` function on the query overrides the test QueryClient's `retry: false`; a non-403 failure then waits the default ~1 s back-off before the error state lands. Wait >1 s in that check or the suite sees a loading card.
