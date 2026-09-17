-- Tap to Pay (Stripe Terminal) on the provider's phone.
--
-- Each office's connected account gets exactly one Terminal location, created
-- on first use from the office's own address. The Tap to Pay reader registers
-- itself against that location from the SDK, so no reader rows are kept here.
-- The location id is account-scoped: a reconnect to a different Stripe
-- account clears it (the reconnect path rewrites the row).
alter table public.billing_connected_accounts
  add column if not exists terminal_location_id text,
  add column if not exists terminal_location_checked_at timestamptz;
