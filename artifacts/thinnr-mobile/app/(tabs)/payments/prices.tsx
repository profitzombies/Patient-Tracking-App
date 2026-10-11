import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { PaymentsScreen, type PaymentsLive } from '@/components/payments/PaymentsScreen';
import { MoneyField, Toggle } from '@/components/payments/dialogs';
import { Body, Button, DetailList, ErrorBox, InlineNotice, LoadingBox, Panel, StatusPill } from '@/components/payments/primitives';
import { useOfficeBillingMutation, useOfficePrices } from '@/hooks/useOfficeBilling';
import { useColors } from '@/hooks/useColors';
import { officeBilling } from '@/lib/office-billing-api';
import {
  cadenceSummary,
  centsToDollarsInput,
  formatCents,
  parseDollarsToCents,
  PRODUCT_CATEGORY_LABEL,
} from '@/lib/office-billing-format';
import type { OfficePrice } from '@/lib/office-billing-types';
import { fonts } from '@/constants/colors';

const TITLE = 'Products and prices';
const SUB = 'Choose what your office offers and set each patient price.';

export default function PricesScreen() {
  return (
    <PaymentsScreen
      section="prices"
      title={TITLE}
      sub={SUB}
      live={(ctx) => <LivePrices ctx={ctx} />}
    />
  );
}

function LivePrices({ ctx }: { ctx: PaymentsLive }) {
  const query = useOfficePrices(ctx.userId);
  if (query.isPending) return <LoadingBox label="Loading prices…" testID="prices-loading" />;
  if (query.isError || !query.data) return <ErrorBox error={query.error} retry={() => void query.refetch()} testID="prices-error" />;
  return <PricesView products={query.data.products} userId={ctx.userId} />;
}

function PricesView({ products, userId }: { products: OfficePrice[]; userId: string }) {
  return (
    <Panel
      title="Catalog"
      sub="Set your own price for each product; anything you have not priced is sold to your patients at its Retail MSRP, one-time only. Subscriptions need your own price at or above the minimum."
      testID="prices-catalog"
    >
      {products.map((product) => <PriceRow key={product.product_id} product={product} userId={userId} />)}
    </Panel>
  );
}

function PriceRow({ product, userId }: { product: OfficePrice; userId: string }) {
  const colors = useColors();
  const [editing, setEditing] = useState(false);
  const [offered, setOffered] = useState(product.offered);
  const [subscription, setSubscription] = useState(product.subscription_enabled);
  const [price, setPrice] = useState(centsToDollarsInput(product.sell_price_cents));
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const mutation = useOfficeBillingMutation(
    userId,
    (body: { sell_price_cents: number | null; subscription_enabled: boolean }, scope) =>
      officeBilling.updatePrice(product.product_id, body, scope),
  );

  const restore = () => {
    setOffered(product.offered);
    setSubscription(product.subscription_enabled);
    setPrice(centsToDollarsInput(product.sell_price_cents));
    setError('');
    setSuccess('');
    setEditing(false);
  };
  useEffect(() => {
    setOffered(product.offered);
    setSubscription(product.subscription_enabled);
    setPrice(centsToDollarsInput(product.sell_price_cents));
    setError('');
  }, [product]);

  const toggleOffered = (next: boolean) => {
    setOffered(next);
    setError('');
    if (next && !price.trim()) setPrice(centsToDollarsInput(product.floor_price_cents));
  };
  const save = () => {
    let cents: number | null = null;
    if (offered) {
      const parsed = parseDollarsToCents(price);
      if (!parsed.ok) {
        setError(price.trim() ? parsed.error : `Enter a sell price of at least ${formatCents(product.break_even_minimum_cents)}, or uncheck Own price to sell ${product.name} at its Retail MSRP.`);
        return;
      }
      if (parsed.cents < product.break_even_minimum_cents) {
        setError(`Price must be at least ${formatCents(product.break_even_minimum_cents)}.`);
        return;
      }
      cents = parsed.cents;
    }
    setError('');
    setSuccess('');
    mutation.mutate(
      { sell_price_cents: cents, subscription_enabled: offered && subscription },
      {
        onSuccess: (result) => {
          setEditing(false);
          setSuccess((result as { stripe_mirror?: string }).stripe_mirror === 'failed'
            ? 'Price saved, but Stripe could not be updated'
            : `${product.name} saved`);
        },
        onError: (failure) => setError(failure.message || 'Price could not be saved.'),
      },
    );
  };

  return (
    <View
      testID={`price-row-${product.product_id}`}
      style={[styles.row, { borderColor: colors.border, backgroundColor: product.below_minimum ? colors.warnBg : colors.paperCardAlt }]}
    >
      <View style={styles.titleRow}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[styles.name, { color: colors.navy }]}>{product.name}</Text>
          <Body>{PRODUCT_CATEGORY_LABEL[product.category]} · {product.description}</Body>
        </View>
        {product.below_minimum ? <StatusPill tone="warn">Below minimum</StatusPill> : null}
      </View>
      <Body testID={`text-price-plan-${product.product_id}`}>
        Subscriptions {cadenceSummary(product.offered_cadences_weeks, product.default_cadence_weeks).toLowerCase()}
        {product.subscribe_save_percent > 0 && product.subscription_price_cents != null
          ? ` · subscribe and save ${product.subscribe_save_percent}% (${formatCents(product.subscription_price_cents)} per renewal)`
          : ''}
      </Body>
      <DetailList items={[
        { label: 'Retail MSRP', value: formatCents(product.floor_price_cents) },
        { label: 'Minimum', value: formatCents(product.break_even_minimum_cents) },
        { label: 'Sell price', value: product.offered ? formatCents(product.sell_price_cents) : 'Default price' },
        { label: 'Own price', value: product.offered ? 'Yes' : 'No' },
        { label: 'Subscription', value: product.offered && product.subscription_enabled ? 'On' : 'Off' },
      ]} />
      {editing ? (
        <View style={styles.edit}>
          <MoneyField
            label="Sell price"
            value={price}
            onChangeText={(next) => { setPrice(next); setError(''); }}
            invalid={Boolean(error)}
            editable={offered}
            testID={`input-price-${product.product_id}`}
          />
          <Toggle label="Own price" value={offered} onChange={toggleOffered} testID={`toggle-offered-${product.product_id}`} />
          <Toggle label="Subscription" value={subscription} onChange={setSubscription} disabled={!offered} testID={`toggle-subscription-${product.product_id}`} />
          <View style={styles.actions}>
            <Button small label="Cancel" onPress={restore} testID={`button-cancel-price-${product.product_id}`} />
            <Button small label="Save" variant="primary" busy={mutation.isPending} onPress={save} testID={`button-save-price-${product.product_id}`} />
          </View>
        </View>
      ) : (
        <Button
          small
          label="Edit"
          onPress={() => setEditing(true)}
          accessibilityLabel={`Edit ${product.name} price`}
          testID={`button-edit-price-${product.product_id}`}
        />
      )}
      {error ? <InlineNotice tone="bad" testID={`price-error-${product.product_id}`}>{error}</InlineNotice> : null}
      {success ? <InlineNotice tone="good" testID={`price-success-${product.product_id}`}>{success}</InlineNotice> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { borderWidth: 1, borderRadius: 7, padding: 12, gap: 9 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  name: { fontSize: 17, fontFamily: fonts.serifBold },
  edit: { gap: 9 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8 },
});
