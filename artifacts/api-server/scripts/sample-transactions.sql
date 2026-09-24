-- Seed sample sandbox transactions for the demo office.
--
-- The office's current Test connected account cannot take charges (onboarding
-- was never finished on it), so these rows cannot be produced by driving the
-- real checkout the way scripts/seed-test-sales.mts does. They are written
-- directly instead, in exactly the shape a real paid order leaves behind:
-- order + items + shipment + ledger, plus refunds and subscriptions where the
-- mix calls for it.
--
-- The money model mirrors src/billing/fees.ts exactly:
--   thinnr share  = floor(floor_price * 60%) per unit
--   platform fee  = share total + what the patient paid for shipping
--   office net    = total - fee - card fee (card fee is 0 on these rows,
--                   which is how this office's existing history records it)
--   HQ profit     = fee - hard cost - shipping cost
--
-- Everything is stamped stripe_mode='test' with the platform account already
-- present on this office's history (never hard-coded: it is read back from
-- those rows), and every order carries metadata->>'sample_seed', so the whole
-- batch can be found or removed as one set:
--
--   select order_number from billing_orders where metadata->>'sample_seed' = 'sample-2026-09';
--
-- scripts/sample-transactions-remove.sql deletes exactly this batch.
--
-- Idempotent: re-running with the same tag is a no-op.
-- Stripe identifiers are obviously synthetic (pi_sample_*, ch_sample_*) so no
-- one mistakes these for objects that exist in the Stripe dashboard. The
-- subscriptions are written already canceled for the same reason: an open
-- subscription would send the reconcile job looking for a Stripe subscription
-- that does not exist.
do $$
declare
  v_provider  constant text := 'live-74913542d0cf4f5292642ceee81dcfc2';
  v_mode      constant text := 'test';
  v_tag       constant text := 'sample-2026-09';
  v_count     constant int  := 30;   -- orders to create
  v_span_days constant int  := 56;   -- spread across the last eight weeks
  v_ship_charge constant int := 1000; -- what the patient pays for shipping
  v_ship_cost   constant int := 1000; -- what shipping costs HQ
  v_share_pct   constant int := 60;   -- THINNR's share of floor (fees.ts)

  v_account text; v_accounts text[];

  prod_id uuid[]; prod_name text[]; prod_sell int[]; prod_floor int[]; prod_hard int[]; prod_sub boolean[];
  sub_slots int[] := '{}';
  payer_id uuid[]; payer_name text[]; payer_patient uuid[]; payer_customer text[];
  n_prod int; n_payer int;

  cities  constant text[] := array['Tampa','Miami','Orlando','Sarasota','Naples','Jacksonville','St. Petersburg','Clearwater'];
  streets constant text[] := array['545 Channelside Dr','1180 Brickell Bay Dr','300 S Orange Ave','1990 Main St','850 5th Ave S','121 W Forsyth St','360 Central Ave','600 Cleveland St'];
  zips    constant text[] := array['33602','33131','32801','34236','34102','32202','33701','33755'];

  -- Orders that are something other than a plain paid sale. Each subscription
  -- charges once, then renews fifteen slots later, which is four weeks apart
  -- at this spacing.
  sub_start  constant int[] := array[5, 9, 13];
  sub_renew  constant int[] := array[20, 24, 28];
  refund_half constant int[] := array[11, 26];   -- half refunded
  refund_full constant int[] := array[17];       -- fully refunded, order canceled

  placed_ts timestamptz[] := '{}';
  i int; item int; slot int; p int; q int; place int;
  items_in_order int; it_p int[]; it_q int[];
  subtotal int; floor_sum int; share_sum int; hard_sum int; total int; fee int; net int; hq_profit int;
  placed_at timestamptz; age_days int;
  v_order_id uuid; v_order_no text; v_salt int;
  v_kind text; v_status text; v_fulfillment text; v_shipment text;
  v_pi text; v_ch text; v_txn text; v_invoice text;
  v_shipped_at timestamptz; v_delivered_at timestamptz; v_tracking text;
  v_address jsonb;
  v_sub_id uuid; v_sub_ids uuid[] := '{}'; v_sub_place int[] := '{}'; v_sub_prod int[] := '{}';
  v_period_end timestamptz;
  v_refund_cents int; v_refund_at timestamptz;
  made_orders int := 0; made_refunds int := 0; made_subs int := 0;
begin
  if v_mode <> 'test' then
    raise exception 'Sample transactions may only be written in sandbox (test) mode.';
  end if;

  -- Identity: reuse the platform account this office's real history already
  -- carries, and refuse to run if that history spans more than one.
  select array_agg(distinct stripe_platform_account_id) into v_accounts
    from public.billing_orders
    where provider_id = v_provider and stripe_mode = v_mode
      and stripe_platform_account_id is not null;
  if coalesce(array_length(v_accounts, 1), 0) = 0 then
    raise exception 'No existing % order for % to take the platform identity from.', v_mode, v_provider;
  end if;
  if array_length(v_accounts, 1) > 1 then
    raise exception 'Office % has % history on more than one platform account; refusing to guess.', v_provider, v_mode;
  end if;
  v_account := v_accounts[1];
  if exists (select 1 from public.billing_orders
               where stripe_platform_account_id = v_account and livemode) then
    raise exception 'Platform account % has live orders; refusing to seed sample data against it.', v_account;
  end if;

  if exists (select 1 from public.billing_orders where provider_id = v_provider and metadata->>'sample_seed' = v_tag) then
    raise notice 'Sample transactions tagged % already exist; nothing to do.', v_tag;
    return;
  end if;

  -- Catalog the office actually sells, at the office's own prices, inside this
  -- billing identity only.
  select array_agg(p.id order by p.name), array_agg(p.name order by p.name),
         array_agg(op.sell_price_cents order by p.name), array_agg(p.floor_price_cents order by p.name),
         array_agg(p.hard_cost_cents order by p.name), array_agg(coalesce(op.subscription_enabled, false) order by p.name)
    into prod_id, prod_name, prod_sell, prod_floor, prod_hard, prod_sub
    from public.billing_office_prices op
    join public.billing_products p on p.id = op.product_id
    where op.provider_id = v_provider and op.stripe_mode = v_mode
      and op.stripe_platform_account_id = v_account
      and coalesce(op.enabled, true) and coalesce(p.active, true)
      and op.sell_price_cents is not null;
  n_prod := coalesce(array_length(prod_id, 1), 0);
  if n_prod = 0 then raise exception 'Office % has no priced products to sell.', v_provider; end if;
  for p in 1..n_prod loop
    if prod_sub[p] then sub_slots := sub_slots || p; end if;
  end loop;
  if array_length(sub_slots, 1) is null then sub_slots := array[1]; end if;

  -- Buyers already known to this office, so names match the rest of the history.
  select array_agg(id order by created_at), array_agg(name order by created_at),
         array_agg(patient_id order by created_at), array_agg(stripe_customer_id order by created_at)
    into payer_id, payer_name, payer_patient, payer_customer
    from public.billing_payers
    where provider_id = v_provider and stripe_mode = v_mode
      and stripe_platform_account_id = v_account;
  n_payer := coalesce(array_length(payer_id, 1), 0);
  if n_payer = 0 then raise exception 'Office % has no % payers to attribute sales to.', v_provider, v_mode; end if;

  -- When each order was placed: evenly across the window, during business
  -- hours, never in the future.
  for i in 1..v_count loop
    placed_ts := placed_ts || (date_trunc('day', now())
      - make_interval(days => v_span_days - ((i * v_span_days) / v_count) + 1)
      + make_interval(hours => 9 + ((i * 7) % 9), mins => (i * 17) % 60));
  end loop;

  -- These rows are backdated and must not re-trigger live-order machinery
  -- (warehouse queueing, identity guards, updated_at touches). PostgreSQL
  -- rolls the whole DO block back on any error, so the tables cannot be left
  -- with their triggers off.
  alter table public.billing_orders disable trigger user;
  alter table public.billing_order_items disable trigger user;
  alter table public.billing_shipments disable trigger user;
  alter table public.billing_ledger disable trigger user;
  alter table public.billing_refunds disable trigger user;
  alter table public.billing_subscriptions disable trigger user;

  for i in 1..v_count loop
    placed_at := placed_ts[i];
    age_days := greatest(0, (extract(epoch from now() - placed_at) / 86400)::int);

    v_kind := case when i = any(sub_start) then 'subscription_initial'
                   when i = any(sub_renew) then 'subscription_renewal'
                   else 'one_time' end;
    v_status := case when i = any(refund_full) then 'refunded'
                     when i = any(refund_half) then 'partially_refunded'
                     else 'paid' end;

    -- A renewal belongs to the same patient and product as its first charge.
    slot := null;
    if v_kind = 'subscription_renewal' then
      slot := array_position(sub_renew, i);
      if slot is null or slot > coalesce(array_length(v_sub_ids, 1), 0) then
        v_kind := 'one_time'; slot := null;
      end if;
    end if;
    if slot is not null then
      place := v_sub_place[slot];
    else
      place := ((i * 5) % n_payer) + 1;
    end if;

    -- Subscription orders are a single unit of a subscribable product.
    items_in_order := case when v_kind <> 'one_time' then 1
                           when i % 4 = 0 then 2 else 1 end;

    v_salt := 0;
    loop
      v_order_no := 'TH-' || upper(substr(md5(v_tag || ':' || i::text || ':' || v_salt::text), 1, 6));
      exit when not exists (select 1 from public.billing_orders where order_number = v_order_no);
      v_salt := v_salt + 1;
    end loop;

    v_order_id := gen_random_uuid();
    v_pi := 'pi_sample_' || lower(right(v_order_no, 6));
    v_ch := 'ch_sample_' || lower(right(v_order_no, 6));
    v_txn := 'txn_sample_' || lower(right(v_order_no, 6));
    v_invoice := case when v_kind = 'one_time' then null else 'in_sample_' || lower(right(v_order_no, 6)) end;

    v_address := jsonb_build_object(
      'name', payer_name[place], 'line1', streets[((i * 3) % array_length(streets, 1)) + 1], 'line2', null,
      'city', cities[((i * 3) % array_length(cities, 1)) + 1], 'state', 'FL',
      'postal_code', zips[((i * 3) % array_length(zips, 1)) + 1], 'country', 'US', 'phone', '8135550100');

    subtotal := 0; floor_sum := 0; share_sum := 0; hard_sum := 0; it_p := '{}'; it_q := '{}';
    -- Decide what was sold first, so the order totals are the sum of its items.
    -- The item rows themselves are written after the order they hang off.
    for item in 1..items_in_order loop
      if slot is not null then
        p := v_sub_prod[slot];
        q := 1;
      elsif v_kind = 'subscription_initial' then
        p := sub_slots[((i / 4) % array_length(sub_slots, 1)) + 1];
        q := 1;
      else
        p := (((i * 7) + (item * 3)) % n_prod) + 1;
        q := case when item = 1 and i % 6 = 0 then 2 else 1 end;
      end if;
      it_p := it_p || p; it_q := it_q || q;
      subtotal := subtotal + prod_sell[p] * q;
      floor_sum := floor_sum + prod_floor[p] * q;
      share_sum := share_sum + (prod_floor[p] * v_share_pct / 100) * q;
      hard_sum := hard_sum + prod_hard[p] * q;
    end loop;

    -- Same money model as the live checkout (fees.ts).
    total := subtotal + v_ship_charge;
    fee := share_sum + v_ship_charge;
    net := total - fee;
    hq_profit := fee - hard_sum - v_ship_cost;

    if v_status = 'refunded' then
      v_fulfillment := 'canceled'; v_shipment := 'canceled';
      v_shipped_at := null; v_delivered_at := null; v_tracking := null;
    elsif age_days >= 14 then
      v_fulfillment := 'shipped'; v_shipment := 'delivered';
      v_shipped_at := placed_at + interval '2 days'; v_delivered_at := placed_at + interval '6 days';
      v_tracking := '9400' || lpad(((i * 918273) % 100000000)::text, 8, '0');
    elsif age_days >= 5 then
      v_fulfillment := 'shipped'; v_shipment := 'shipped';
      v_shipped_at := placed_at + interval '2 days'; v_delivered_at := null;
      v_tracking := '9400' || lpad(((i * 918273) % 100000000)::text, 8, '0');
    else
      v_fulfillment := 'to_ship'; v_shipment := 'processing';
      v_shipped_at := null; v_delivered_at := null; v_tracking := null;
    end if;

    -- A subscription order needs the subscription it belongs to. It is written
    -- closed: it charged twice and then ended, so nothing keeps polling Stripe
    -- for an id that was never real.
    v_sub_id := null;
    if v_kind = 'subscription_initial' then
      v_sub_id := gen_random_uuid();
      v_period_end := least(
        placed_ts[sub_renew[coalesce(array_position(sub_start, i), 1)]] + interval '4 weeks',
        now() - interval '1 hour');
      insert into public.billing_subscriptions (
        id, provider_id, payer_id, patient_id, product_id, stripe_subscription_id, stripe_customer_id,
        status, unit_price_cents, shipping_charge_cents, application_fee_cents, shipping_address,
        current_period_end, cancel_at_period_end, canceled_at, cancel_token, livemode, cadence_weeks, quantity,
        next_shipment_at, shipping_cost_cents, created_at, updated_at, stripe_mode, stripe_platform_account_id)
      values (
        v_sub_id, v_provider, payer_id[place], payer_patient[place], prod_id[it_p[1]],
        'sub_sample_' || lower(right(v_order_no, 6)), payer_customer[place],
        'canceled', subtotal, v_ship_charge, fee, v_address,
        v_period_end, false, v_period_end, md5(v_tag || v_order_no), false, 4, 1,
        null, v_ship_cost, placed_at, v_period_end, v_mode, v_account);
      v_sub_ids := v_sub_ids || v_sub_id;
      v_sub_place := v_sub_place || place;
      v_sub_prod := v_sub_prod || it_p[1];
      made_subs := made_subs + 1;
    elsif slot is not null then
      v_sub_id := v_sub_ids[slot];
    end if;

    insert into public.billing_orders (
      id, order_number, provider_id, payer_id, patient_id, kind, subscription_id, status, currency,
      subtotal_cents, shipping_charge_cents, tax_cents, total_cents,
      application_fee_cents, application_fee_collected_cents, stripe_fee_cents, office_net_cents,
      hard_cost_cents, shipping_cost_cents, hq_profit_cents, thinnr_share_percent, shipping_address,
      stripe_invoice_id, stripe_payment_intent_id, stripe_charge_id, stripe_balance_transaction_id,
      livemode, paid_at, fulfillment_status, tracking_number, carrier, shipped_at, canceled_reason,
      metadata, created_at, updated_at, stripe_mode, stripe_platform_account_id)
    values (
      v_order_id, v_order_no, v_provider, payer_id[place], payer_patient[place], v_kind, v_sub_id, v_status, 'usd',
      subtotal, v_ship_charge, 0, total,
      fee, fee, 0, net,
      hard_sum, v_ship_cost, hq_profit, v_share_pct, v_address,
      v_invoice, v_pi, v_ch, v_txn,
      false, placed_at, v_fulfillment, v_tracking, case when v_tracking is null then null else 'USPS' end, v_shipped_at,
      case when v_status = 'refunded' then 'Refunded to the patient' else null end,
      jsonb_build_object('sample_seed', v_tag), placed_at, placed_at, v_mode, v_account);
    made_orders := made_orders + 1;

    for item in 1..items_in_order loop
      p := it_p[item]; q := it_q[item];
      insert into public.billing_order_items (
        order_id, product_id, product_name_snapshot, quantity, unit_price_cents,
        floor_price_cents_snapshot, thinnr_share_cents, hard_cost_cents_snapshot,
        created_at, updated_at, stripe_mode, stripe_platform_account_id)
      values (
        v_order_id, prod_id[p], prod_name[p], q, prod_sell[p],
        prod_floor[p], (prod_floor[p] * v_share_pct / 100) * q, prod_hard[p],
        placed_at, placed_at, v_mode, v_account);
    end loop;

    insert into public.billing_shipments (
      order_id, provider_id, status, carrier, tracking_number, source,
      shipped_at, delivered_at, canceled_at, canceled_reason,
      created_at, updated_at, stripe_mode, stripe_platform_account_id)
    values (
      v_order_id, v_provider, v_shipment, case when v_tracking is null then null else 'USPS' end, v_tracking, 'staff',
      v_shipped_at, v_delivered_at,
      case when v_shipment = 'canceled' then placed_at + interval '3 days' else null end,
      case when v_shipment = 'canceled' then 'Refunded to the patient' else null end,
      placed_at, coalesce(v_delivered_at, v_shipped_at, placed_at), v_mode, v_account);

    insert into public.billing_ledger (
      provider_id, order_id, subscription_id, kind, amount_cents, application_fee_cents, stripe_ref,
      detail, occurred_at, created_at, updated_at, stripe_mode, stripe_platform_account_id)
    values (
      v_provider, v_order_id, v_sub_id, 'sale', net, fee, v_ch,
      jsonb_build_object('total_cents', total, 'stripe_fee_cents', 0), placed_at, placed_at, placed_at, v_mode, v_account);

    if v_status <> 'paid' then
      v_refund_cents := case when v_status = 'refunded' then total else greatest(100, (total / 2)) end;
      v_refund_at := placed_at + interval '3 days';
      insert into public.billing_refunds (
        order_id, stripe_refund_id, amount_cents, reason, status,
        created_at, updated_at, stripe_mode, stripe_platform_account_id)
      values (
        v_order_id, 're_sample_' || lower(right(v_order_no, 6)), v_refund_cents,
        case when v_status = 'refunded' then 'Returned unopened' else 'One item returned' end, 'succeeded',
        v_refund_at, v_refund_at, v_mode, v_account);
      insert into public.billing_ledger (
        provider_id, order_id, subscription_id, kind, amount_cents, application_fee_cents, stripe_ref,
        detail, occurred_at, created_at, updated_at, stripe_mode, stripe_platform_account_id)
      values (
        v_provider, v_order_id, null, 'refund', -v_refund_cents, 0, 're_sample_' || lower(right(v_order_no, 6)),
        jsonb_build_object('order_number', v_order_no), v_refund_at, v_refund_at, v_refund_at, v_mode, v_account);
      made_refunds := made_refunds + 1;
    end if;
  end loop;

  alter table public.billing_orders enable trigger user;
  alter table public.billing_order_items enable trigger user;
  alter table public.billing_shipments enable trigger user;
  alter table public.billing_ledger enable trigger user;
  alter table public.billing_refunds enable trigger user;
  alter table public.billing_subscriptions enable trigger user;

  raise notice 'Seeded % sample orders (% refunded, % subscriptions) tagged %.', made_orders, made_refunds, made_subs, v_tag;
end $$;
