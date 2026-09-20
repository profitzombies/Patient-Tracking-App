import Stripe from "stripe";

type Check = { name: string; ok: boolean; detail: string };

const checks: Check[] = [];
const residue: string[] = [];
const unverified: string[] = [];
const created: {
  account?: string;
  paymentIntent?: string;
  customer?: string;
  product?: string;
  price?: string;
  subscription?: string;
} = {};

function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
}

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown error";
  const stripe = error as Error & { code?: string; statusCode?: number; type?: string };
  const message = error.message
    .replace(/\b(?:sk|pk)_(?:test|live)_[A-Za-z0-9]+\b/g, "[redacted key]")
    .replace(/\bwhsec_\S+/g, "[redacted webhook secret]")
    .replace(/\bca_[A-Za-z0-9]+\b/g, "[redacted client id]");
  return [stripe.type, stripe.code, stripe.statusCode, message].filter(Boolean).join(" · ");
}

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is missing`);
  return value;
}

const secret = env("STRIPE_TEST_SECRET_KEY");
const publishable = env("STRIPE_TEST_PUBLISHABLE_KEY");
const expectedAccount = env("STRIPE_TEST_PLATFORM_ACCOUNT_ID");
if (!secret.startsWith("sk_test_") || !publishable.startsWith("pk_test_")) {
  throw new Error("Refusing all Stripe writes: configured Test credentials are not test-mode keys.");
}

const stripe = new Stripe(secret, {
  appInfo: { name: "THINNR sandbox verification" },
  timeout: 15_000,
  maxNetworkRetries: 1,
});

async function assertTestMode(): Promise<void> {
  const balance = await stripe.balance.retrieve();
  if (balance.livemode !== false) throw new Error("Refusing all Stripe writes: Stripe API reports livemode.");
}

async function cleanup(): Promise<void> {
  try {
    await assertTestMode();
  } catch (error) {
    residue.push(`cleanup test-mode guard refused writes: ${safeError(error)}`);
    return;
  }
  if (created.paymentIntent) {
    try {
      const intent = await stripe.paymentIntents.retrieve(created.paymentIntent);
      const chargeId = typeof intent.latest_charge === "string" ? intent.latest_charge : intent.latest_charge?.id;
      if (chargeId) {
        const charge = await stripe.charges.retrieve(chargeId);
        const refundable = charge.amount - charge.amount_refunded;
        if (refundable > 0) {
          await assertTestMode();
          await stripe.refunds.create({ charge: charge.id, amount: refundable });
        }
      }
    } catch (error) {
      residue.push(`payment ${created.paymentIntent}: ${safeError(error)}`);
    }
  }
  if (created.subscription) {
    try { await stripe.subscriptions.cancel(created.subscription); } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "resource_missing") residue.push(`subscription ${created.subscription}: ${safeError(error)}`);
    }
  }
  if (created.customer) {
    try { await stripe.customers.del(created.customer); } catch (error) {
      residue.push(`customer ${created.customer}: ${safeError(error)}`);
    }
  }
  if (created.price) {
    try { await stripe.prices.update(created.price, { active: false }); } catch (error) {
      residue.push(`price ${created.price}: ${safeError(error)}`);
    }
  }
  if (created.product) {
    try {
      await stripe.products.update(created.product, { active: false });
      residue.push(`archived test catalog objects ${created.product} / ${created.price ?? "price unavailable"} (Stripe prices are immutable)`);
    } catch (error) {
      residue.push(`product ${created.product}: ${safeError(error)}`);
    }
  }
  if (created.account) {
    try { await stripe.accounts.del(created.account); } catch (error) {
      residue.push(`connected account ${created.account}: ${safeError(error)}`);
    }
  }
}

try {
  await assertTestMode();
  const retrieveSelf = stripe.accounts.retrieve as unknown as () => Promise<Stripe.Account>;
  const platform = await retrieveSelf.call(stripe.accounts);
  check("Test key and platform identity", platform.id === expectedAccount,
    platform.id === expectedAccount ? "Authenticated platform matches configured account; Stripe reports test mode." : "Authenticated platform does not match configured account.");
  if (platform.id !== expectedAccount) throw new Error("Refusing writes because platform identity does not match.");

  const origin = process.env.BILLING_PUBLIC_ORIGIN?.trim().replace(/\/$/, "");
  const expectedUrls = origin ? {
    platform: `${origin}/api/billing/webhooks/test/platform`,
    connect: `${origin}/api/billing/webhooks/test/connect`,
  } : null;
  if (!expectedUrls) {
    check("Test webhook destinations", false, "BILLING_PUBLIC_ORIGIN is missing.");
  } else {
    const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
    for (const [kind, url] of Object.entries(expectedUrls)) {
      const endpoint = endpoints.data.find((item) => item.url === url);
      const expectsConnect = kind === "connect";
      const required = expectsConnect
        ? ["account.updated", "capability.updated", "invoice.created", "invoice.paid", "invoice.payment_failed",
          "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
          "invoice.finalized", "charge.refunded", "refund.updated", "charge.dispute.created",
          "charge.dispute.updated", "charge.dispute.closed", "charge.dispute.funds_withdrawn",
          "charge.dispute.funds_reinstated", "payout.paid", "payout.failed", "payment_intent.payment_failed"]
        : ["account.application.deauthorized"];
      const missing = endpoint ? required.filter((event) => !endpoint.enabled_events.includes(event as Stripe.WebhookEndpoint.EnabledEvent)) : required;
      check(`Test ${kind} webhook destination`, Boolean(endpoint && endpoint.status === "enabled" && missing.length === 0),
        !endpoint ? "No matching enabled destination is registered at the configured public origin."
          : `Found destination; status=${endpoint.status}, missing-required-events=${missing.length}.`);
      if (endpoint && expectsConnect) {
        // `connect` is accepted when creating a v1 webhook endpoint, but it is
        // not part of Stripe's returned WebhookEndpoint object schema. Absence
        // must never be interpreted as false.
        const returned = endpoint as Stripe.WebhookEndpoint & { connect?: boolean };
        unverified.push("Connect webhook source scope and actual event delivery are not exposed by the WebhookEndpoint list response; confirm them from Stripe delivery evidence.");
        if (Object.hasOwn(returned, "connect")) {
          unverified.push(`Unexpected response extension reported connect=${String(returned.connect)}; this harness does not treat that undocumented field as proof.`);
        }
      }
    }
  }

  const clientId = process.env.STRIPE_TEST_CONNECT_CLIENT_ID?.trim();
  if (!clientId) {
    check("Test Connect OAuth configuration", false, "STRIPE_TEST_CONNECT_CLIENT_ID is absent.");
  } else if (!/^ca_[A-Za-z0-9]+$/.test(clientId) || !origin) {
    check("Test Connect OAuth configuration", false, "Client ID or public origin has an invalid shape.");
  } else {
    const url = new URL("https://connect.stripe.com/oauth/authorize");
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      scope: "read_write",
      redirect_uri: `${origin}/api/billing/oauth/callback`,
      state: "sandbox-verification-no-user-action",
    }).toString();
    const response = await fetch(url, { redirect: "manual" });
    const location = response.headers.get("location");
    const target = location ? new URL(location) : null;
    const expectedStripePage = response.status === 302
      && target?.hostname === "connect.stripe.com"
      && target.pathname.startsWith("/oauth/");
    check("Test Connect OAuth configuration", expectedStripePage,
      expectedStripePage
        ? `Stripe redirected to its expected OAuth authorize page (${target.pathname}); no query string, authorization, or terms action was logged.`
        : `Authorize request did not redirect to the expected Stripe OAuth page (HTTP ${response.status}).`);
  }

  await assertTestMode();
  const account = await stripe.accounts.create({
    country: "US",
    business_profile: { name: "THINNR Sandbox Verification" },
    controller: {
      stripe_dashboard: { type: "none" },
      fees: { payer: "account" },
      losses: { payments: "stripe" },
      requirement_collection: "stripe",
    },
    capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
    metadata: { thinnr_fixture: "sandbox_verification" },
  });
  created.account = account.id;
  const controllerOk = account.controller?.stripe_dashboard?.type === "none"
    && account.controller?.fees?.payer === "account"
    && account.controller?.losses?.payments === "stripe"
    && account.controller?.requirement_collection === "stripe";
  check("Connected account creation", controllerOk,
    controllerOk ? "Created with no dashboard, account-paid fees, Stripe payment-loss liability, and Stripe requirement collection." : "Created account did not return the requested controller settings.");

  await assertTestMode();
  const accountSession = await stripe.accountSessions.create({
    account: account.id,
    components: { account_onboarding: { enabled: true }, account_management: { enabled: true } },
  });
  check("Connected account session", Boolean(accountSession.client_secret),
    "Created onboarding/management session; client secret was not printed.");

  await assertTestMode();
  const intent = await stripe.paymentIntents.create({
    amount: 100,
    currency: "usd",
    payment_method: "pm_card_visa",
    confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    description: "THINNR sandbox verification (synthetic)",
    metadata: { thinnr_fixture: "sandbox_verification" },
  });
  created.paymentIntent = intent.id;
  const chargeId = typeof intent.latest_charge === "string" ? intent.latest_charge : intent.latest_charge?.id;
  if (!chargeId || intent.status !== "succeeded") throw new Error(`Synthetic test PaymentIntent did not succeed (status ${intent.status}).`);
  const refund = await stripe.refunds.create({ charge: chargeId });
  if (refund.status === "succeeded") created.paymentIntent = undefined;
  check("Test payment and refund", refund.status === "succeeded",
    `Synthetic $1.00 platform payment succeeded and full refund status=${refund.status}; no customer email was supplied.`);

  await assertTestMode();
  const customer = await stripe.customers.create({
    name: "THINNR Synthetic Verification",
    metadata: { thinnr_fixture: "sandbox_verification" },
  });
  created.customer = customer.id;
  const product = await stripe.products.create({
    name: "THINNR Synthetic Verification Subscription",
    metadata: { thinnr_fixture: "sandbox_verification" },
  });
  created.product = product.id;
  const price = await stripe.prices.create({
    product: product.id, currency: "usd", unit_amount: 100, recurring: { interval: "month" },
  });
  created.price = price.id;
  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: price.id }],
    payment_behavior: "default_incomplete",
    metadata: { thinnr_fixture: "sandbox_verification" },
  });
  created.subscription = subscription.id;
  const canceled = await stripe.subscriptions.cancel(subscription.id);
  created.subscription = undefined;
  check("Test subscription lifecycle", canceled.status === "canceled" || canceled.status === "incomplete_expired",
    `Created an incomplete synthetic monthly subscription without card charge or email, then cancellation returned status=${canceled.status}.`);
} catch (error) {
  check("Harness completion", false, safeError(error));
} finally {
  await cleanup();
}

console.log(JSON.stringify({
  mode: "test-only",
  checks,
  cleanup: residue.length === 0 ? "All removable fixtures cleaned; Stripe retains normal immutable test transaction history." : "Cleanup left residue.",
  residue,
  unverified,
}, null, 2));
process.exitCode = checks.some((item) => !item.ok) ? 1 : 0;