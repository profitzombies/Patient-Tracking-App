---
name: Synthetic billing sample data
description: Rules for hand-writing sandbox billing rows (orders, ledger, subscriptions) so they match real checkout and do not wake background workers.
---

Hand-written sample billing rows must reproduce the fee model in the billing fee
module, not whatever the oldest rows in the table happen to show. Derive nothing
from existing rows without checking the current code: an older seed can leave
history that uses a superseded model, and copying it silently mislabels every
fee, office-net and profit figure on the detail screens.

**Why:** a sample batch was first written with an application fee of
sell-minus-floor, taken from the office's existing history. Checkout actually
charges THINNR's percentage share of the floor price plus the shipping
recovery, and office net is total minus fee minus card fee. Totals reconciled,
so every row looked correct while every breakdown was wrong.

**How to apply:** when seeding orders, items, ledger and subscriptions by hand,
1. read the fee module and reproduce it, then verify with one SQL check across
   the whole batch plus a comparison against real rows;
2. scope every source read (prices, payers) by mode *and* platform account, and
   refuse to run if the office's history spans more than one account or the
   account has any live-mode row — the identity guards are disabled during the
   insert, so they cannot catch a cross-identity reference;
3. write subscriptions already closed. Reconcile workers scan any subscription
   that is not canceled and call the payment provider with its stored id; a
   synthetic id turns into a recurring failure forever;
4. tag the batch in order metadata and ship a paired removal script whose
   safety predicate is null-safe (a row with a missing mode flag must count as
   non-sandbox, not slip through);
5. insert parents before children — subscription, then order, then items,
   shipment and ledger.

The whole seed belongs in one `do $$ ... $$` block: PostgreSQL rolls back both
the inserts and the `disable trigger user` statements if any step fails, so the
tables can never be left with triggers off.
