/**
 * HQ Payments area (Stripe Connect program view). Mounted with `nest` at
 * /admin/payments, so every route below is relative to that base.
 */
import { Route, Switch } from 'wouter';
import NotFound from '@/pages/not-found';
import {
  PaymentProviderDetail,
  PaymentTransactionDetail,
  PaymentsFulfillment,
  PaymentsOverview,
  PaymentsProviders,
  PaymentsSubscriptions,
  PaymentsTransactions,
} from './HqPaymentsPages';
import { PaymentsActivity } from './PaymentsActivity';
import { PaymentsCatalog } from './catalog/CatalogPage';
import { PaymentsCatalogHistory } from './catalog/CatalogHistory';
import { ProductEditorPage } from './catalog/ProductEditor';

export default function HqPaymentsArea() {
  return (
    <Switch>
      <Route path="/" component={PaymentsOverview} />
      <Route path="/activity" component={PaymentsActivity} />
      <Route path="/providers" component={PaymentsProviders} />
      <Route path="/providers/:providerId" component={PaymentProviderDetail} />
      <Route path="/transactions" component={PaymentsTransactions} />
      <Route path="/transactions/:orderId" component={PaymentTransactionDetail} />
      <Route path="/fulfillment" component={PaymentsFulfillment} />
      <Route path="/catalog" component={PaymentsCatalog} />
      <Route path="/catalog/history" component={PaymentsCatalogHistory} />
      <Route path="/catalog/products/new" component={ProductEditorPage} />
      <Route path="/catalog/products/:productId" component={ProductEditorPage} />
      <Route path="/subscriptions" component={PaymentsSubscriptions} />
      <Route component={NotFound} />
    </Switch>
  );
}
