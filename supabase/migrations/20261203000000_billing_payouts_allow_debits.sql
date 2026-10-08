-- Office payouts can be negative.
--
-- When a connected office's Stripe balance stays negative (refunds or
-- disputes larger than new sales), Stripe creates a "negative payout" that
-- debits the office's bank account. Its amount arrives below zero. The
-- original check refused those rows, so the payout webhook failed and stayed
-- unprocessed, and every billing-reconcile run failed that office's payout
-- sync. The ledger already records a negative payout correctly (money moving
-- back into the Stripe balance), so only the mirror's check was wrong.
alter table public.billing_payouts drop constraint if exists billing_payouts_amount_cents_check;
