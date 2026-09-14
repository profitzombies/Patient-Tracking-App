/**
 * HQ Payments area (Stripe Connect program view). Mounted with `nest` at
 * /admin/payments, so every route below is relative to that base.
 * Filled in by the payments build.
 */
import { Route, Switch } from 'wouter';
import NotFound from '@/pages/not-found';
import {
  PaymentProviderDetail,
  PaymentTransactionDetail,
  PaymentsCatalog,
  PaymentsCatalogHistory,
  PaymentsFulfillment,
  PaymentsOverview,
  PaymentsProviders,
  PaymentsSubscriptions,
  PaymentsTransactions,
} from './HqPaymentsPages';

export default function HqPaymentsArea() {
  return (
    <Switch>
      <Route path="/" component={PaymentsOverview} />
      <Route path="/providers" component={PaymentsProviders} />
      <Route path="/providers/:providerId" component={PaymentProviderDetail} />
      <Route path="/transactions" component={PaymentsTransactions} />
      <Route path="/transactions/:orderId" component={PaymentTransactionDetail} />
      <Route path="/fulfillment" component={PaymentsFulfillment} />
      <Route path="/catalog" component={PaymentsCatalog} />
      <Route path="/catalog/history" component={PaymentsCatalogHistory} />
      <Route path="/subscriptions" component={PaymentsSubscriptions} />
      <Route component={NotFound} />
    </Switch>
  );
}
