import type { EmailTemplateDefinition, EmailVariables, RenderedEmail } from "./index";
import { button, escapeHtml, infoPanel, paragraph, parseLineItems, requireVariable, shell } from "./shell";

/**
 * Patient shop emails. Every template rides the shared THINNR shell and is
 * sent by THINNR itself (Stripe's own customer emails stay off), from the
 * server transitions the money flow already trusts.
 */
export const SHOP_EMAIL_TEMPLATE_IDS = [
  "order-confirmation",
  "subscription-started",
  "subscription-shipment-moved",
  "subscription-shipment-skipped",
  "subscription-paused",
  "subscription-resumed",
  "subscription-plan-changed",
  "subscription-address-changed",
  "subscription-renewal-reminder",
  "subscription-card-updated",
  "order-delivered",
] as const;

export type ShopEmailTemplateId = (typeof SHOP_EMAIL_TEMPLATE_IDS)[number];
type ShopDefinition = Omit<EmailTemplateDefinition, "id"> & { id: ShopEmailTemplateId };

const SAMPLE_MANAGE = "https://app.example.test/billing?subscription=sub_sample";
const SAMPLE_SKIP = "https://app.example.test/billing?subscription=sub_sample&action=skip";
const MANAGE_LABEL = "Manage subscription";
const AUDIENCE = "The patient who owns the subscription.";
const NAME = "Payer first name";
const OFFICE = "Office name";
const PRODUCT = "Product name";
const MANAGE = "Subscription screen link (optional)";

export const SHOP_EMAIL_TEMPLATE_CATALOG: readonly ShopDefinition[] = [
  {
    id: "order-confirmation",
    name: "Order confirmation",
    purpose: "Confirms everything a patient bought in one checkout: one-time items, any subscriptions that started, the total, and where it ships.",
    trigger: "Stripe confirms payment for the last order in a patient's in-app cart.",
    audience: "The patient who checked out.",
    sampleVariables: {
      name: "Riley",
      officeName: "Example Wellness Studio",
      placedAt: "Sep 14, 2026, 3:24 PM ET",
      orderNumbers: "TH-7K2Q9M, TH-7K2Q9N",
      items: "Balance · $59.99\nHydrate × 2 · $39.98",
      subscriptions: "Control every 4 weeks · $69.99",
      total: "$178.96",
      shipTo: "Riley Example, 12 Harbor Lane, Austin, TX 78701, US",
      manageLink: SAMPLE_MANAGE,
      contactEmail: "care@example.test",
    },
    variableLabels: {
      name: NAME, officeName: OFFICE, placedAt: "Payment date and time", orderNumbers: "Order numbers (comma separated)",
      items: "One-time items (one per line: name · amount)", subscriptions: "Subscriptions started (one per line: name every N weeks · amount; optional)",
      total: "Total charged today", shipTo: "Shipping address", manageLink: MANAGE, contactEmail: "Office contact email (optional)",
    },
  },
  {
    id: "subscription-started",
    name: "Subscription started",
    purpose: "Welcomes a patient to a recurring order and sets expectations for cadence, price, and the next shipment.",
    trigger: "Stripe confirms the first payment of a new subscription.",
    audience: AUDIENCE,
    sampleVariables: {
      name: "Riley", productName: "Control", officeName: "Example Wellness Studio", cadence: "every 4 weeks",
      amount: "$69.99", nextShipment: "Monday, October 12, 2026", shipTo: "Riley Example, 12 Harbor Lane, Austin, TX 78701, US",
      manageLink: SAMPLE_MANAGE,
    },
    variableLabels: {
      name: NAME, productName: PRODUCT, officeName: OFFICE, cadence: "Cadence (e.g. every 4 weeks)", amount: "Price per shipment",
      nextShipment: "Next shipment date", shipTo: "Shipping address", manageLink: MANAGE,
    },
  },
  {
    id: "subscription-shipment-moved",
    name: "Next shipment moved",
    purpose: "Confirms the new date a patient chose for their next shipment and charge.",
    trigger: "A patient (or staff on their behalf) moves the next shipment date.",
    audience: AUDIENCE,
    sampleVariables: {
      name: "Riley", productName: "Control", officeName: "Example Wellness Studio",
      previousDate: "Monday, October 12, 2026", nextShipment: "Monday, October 26, 2026", manageLink: SAMPLE_MANAGE,
    },
    variableLabels: { name: NAME, productName: PRODUCT, officeName: OFFICE, previousDate: "Previous shipment date", nextShipment: "New shipment date", manageLink: MANAGE },
  },
  {
    id: "subscription-shipment-skipped",
    name: "Shipment skipped",
    purpose: "Confirms that one shipment was skipped and when the following one arrives.",
    trigger: "A patient (or staff on their behalf) skips the next shipment.",
    audience: AUDIENCE,
    sampleVariables: {
      name: "Riley", productName: "Control", officeName: "Example Wellness Studio",
      skippedDate: "Monday, October 12, 2026", nextShipment: "Monday, November 9, 2026", manageLink: SAMPLE_MANAGE,
    },
    variableLabels: { name: NAME, productName: PRODUCT, officeName: OFFICE, skippedDate: "Skipped shipment date", nextShipment: "Next shipment date", manageLink: MANAGE },
  },
  {
    id: "subscription-paused",
    name: "Subscription paused",
    purpose: "Confirms that shipments and charges are on hold until the patient resumes.",
    trigger: "A patient (or staff on their behalf) pauses a subscription.",
    audience: AUDIENCE,
    sampleVariables: { name: "Riley", productName: "Control", officeName: "Example Wellness Studio", manageLink: SAMPLE_MANAGE },
    variableLabels: { name: NAME, productName: PRODUCT, officeName: OFFICE, manageLink: MANAGE },
  },
  {
    id: "subscription-resumed",
    name: "Subscription resumed",
    purpose: "Confirms that a paused subscription is active again and when the next shipment goes out.",
    trigger: "A patient (or staff on their behalf) resumes a paused subscription.",
    audience: AUDIENCE,
    sampleVariables: {
      name: "Riley", productName: "Control", officeName: "Example Wellness Studio",
      nextShipment: "Monday, October 12, 2026", manageLink: SAMPLE_MANAGE,
    },
    variableLabels: { name: NAME, productName: PRODUCT, officeName: OFFICE, nextShipment: "Next shipment date", manageLink: MANAGE },
  },
  {
    id: "subscription-plan-changed",
    name: "Plan changed",
    purpose: "Confirms a change of product, quantity, or cadence and when it takes effect.",
    trigger: "A patient (or staff on their behalf) changes a subscription's plan.",
    audience: AUDIENCE,
    sampleVariables: {
      name: "Riley", officeName: "Example Wellness Studio", previousPlan: "Control every 4 weeks",
      newPlan: "Control × 2 every 8 weeks", effective: "Monday, October 12, 2026", manageLink: SAMPLE_MANAGE,
    },
    variableLabels: { name: NAME, officeName: OFFICE, previousPlan: "Previous plan", newPlan: "New plan", effective: "Takes effect (next shipment date)", manageLink: MANAGE },
  },
  {
    id: "subscription-address-changed",
    name: "Shipping address changed",
    purpose: "Confirms where future shipments of a subscription will go.",
    trigger: "A patient (or staff on their behalf) changes a subscription's shipping address.",
    audience: AUDIENCE,
    sampleVariables: {
      name: "Riley", productName: "Control", officeName: "Example Wellness Studio",
      shipTo: "Riley Example, 88 Lakeside Drive, Austin, TX 78704, US", manageLink: SAMPLE_MANAGE,
    },
    variableLabels: { name: NAME, productName: PRODUCT, officeName: OFFICE, shipTo: "New shipping address", manageLink: MANAGE },
  },
  {
    id: "subscription-renewal-reminder",
    name: "Upcoming renewal reminder",
    purpose: "Warns a patient a few days before the next shipment is charged, with one-tap skip and manage links.",
    trigger: "The renewal reminder job finds a subscription whose next shipment is the configured number of days away.",
    audience: AUDIENCE,
    sampleVariables: {
      name: "Riley", productName: "Control", officeName: "Example Wellness Studio", nextShipment: "Monday, October 12, 2026",
      amount: "$69.99", cardLabel: "Visa ending in 4242", skipLink: SAMPLE_SKIP, manageLink: SAMPLE_MANAGE,
    },
    variableLabels: {
      name: NAME, productName: PRODUCT, officeName: OFFICE, nextShipment: "Next shipment date", amount: "Amount to be charged",
      cardLabel: "Card on file", skipLink: "Skip this shipment link", manageLink: "Subscription screen link",
    },
  },
  {
    id: "subscription-card-updated",
    name: "Card updated",
    purpose: "Confirms which card future subscription charges will use.",
    trigger: "A patient (or staff on their behalf) changes the card on a subscription.",
    audience: AUDIENCE,
    sampleVariables: { name: "Riley", productName: "Control", officeName: "Example Wellness Studio", cardLabel: "Visa ending in 4242", manageLink: SAMPLE_MANAGE },
    variableLabels: { name: NAME, productName: PRODUCT, officeName: OFFICE, cardLabel: "Card on file", manageLink: MANAGE },
  },
  {
    id: "order-delivered",
    name: "Order delivered",
    purpose: "Tells the patient their package was delivered and who to contact if it was not.",
    trigger: "Office staff, HQ, or a carrier update marks a shipment delivered.",
    audience: "The patient who paid.",
    sampleVariables: { name: "Riley", orderNumber: "TH-7K2Q9M", officeName: "Example Wellness Studio", deliveredAt: "Sep 18, 2026, 2:05 PM ET", contactEmail: "care@example.test" },
    variableLabels: { name: NAME, orderNumber: "Order number", officeName: OFFICE, deliveredAt: "Delivery date and time", contactEmail: "Office contact email (optional)" },
  },
] as const;

const optional = (variables: EmailVariables, key: string) => variables[key]?.trim() || "";
const strong = (value: string) => `<strong>${escapeHtml(value)}</strong>`;
const manageButton = (link: string) => (link ? button(link, MANAGE_LABEL, "#203b64") : "");
const manageText = (link: string) => (link ? ["", `${MANAGE_LABEL}: ${link}`] : []);
const contactLine = (officeName: string, email: string, about: string) =>
  email ? `Questions about this ${about}? Contact ${officeName} at ${email}.` : `Questions about this ${about}? Contact ${officeName}.`;

/** Shared shape: greeting, lead sentence, optional panel + extra copy, manage link, closing. */
function subscriptionEmail(input: {
  variables: EmailVariables; subject: string; previewText: string; eyebrow: string; heading: string;
  leadText: string; leadHtml: string; panel?: [string, string]; extraText?: string[]; extraHtml?: string; closing: string;
}): RenderedEmail {
  const name = optional(input.variables, "name");
  const manageLink = optional(input.variables, "manageLink");
  const text = [
    ...(name ? [`Hello ${name},`, ""] : []),
    input.leadText,
    ...(input.panel ? ["", `${input.panel[0]}: ${input.panel[1]}`] : []),
    ...(input.extraText?.length ? ["", ...input.extraText] : []),
    ...manageText(manageLink),
    "",
    input.closing,
  ].join("\n");
  return {
    subject: input.subject,
    previewText: input.previewText,
    text,
    html: shell({
      previewText: input.previewText,
      eyebrow: input.eyebrow,
      heading: input.heading,
      greeting: name || undefined,
      bodyHtml: `${paragraph(input.leadHtml)}
        ${input.panel ? infoPanel(input.panel[0], input.panel[1]) : ""}
        ${input.extraHtml ?? ""}
        ${manageButton(manageLink)}`,
      closing: input.closing,
    }),
  };
}

function renderOrderConfirmation(v: EmailVariables): RenderedEmail {
  const name = optional(v, "name");
  const officeName = requireVariable(v, "officeName");
  const placedAt = requireVariable(v, "placedAt");
  const orderNumbers = requireVariable(v, "orderNumbers");
  const items = parseLineItems(optional(v, "items"));
  const subscriptions = parseLineItems(optional(v, "subscriptions"));
  if (!items.length && !subscriptions.length) throw new Error("Missing email template variable: items");
  const total = requireVariable(v, "total");
  const shipTo = requireVariable(v, "shipTo");
  const manageLink = optional(v, "manageLink");
  const contactEmail = optional(v, "contactEmail");
  const subject = `Your THINNR order is confirmed (${orderNumbers})`;
  const previewText = `${officeName} received your order. Total ${total}.`;
  const contact = contactLine(officeName, contactEmail, "order");
  const lines = (rows: Array<{ label: string; amount: string }>) => rows.map((row) => (row.amount ? `${row.label} · ${row.amount}` : row.label));
  const text = [
    ...(name ? [`Hello ${name},`, ""] : []),
    `Thank you for your order from ${officeName}. Here is what you bought.`,
    `Order numbers: ${orderNumbers}`,
    `Paid: ${placedAt}`,
    ...(items.length ? ["", "One-time items", ...lines(items)] : []),
    ...(subscriptions.length ? ["", "Subscriptions started", ...lines(subscriptions), "Each subscription renews automatically until you pause or cancel it."] : []),
    "",
    `Total charged today: ${total}`,
    `Ship to: ${shipTo}`,
    ...manageText(manageLink),
    "",
    contact,
    "A separate receipt follows for each order.",
  ].join("\n");
  const row = (item: { label: string; amount: string }) =>
    `<tr><td style="padding:10px 0;font-size:15px;line-height:1.45;color:#26364b;border-bottom:1px solid #e3e8ee;">${escapeHtml(item.label)}</td>
      <td align="right" style="padding:10px 0;font-size:15px;color:#26364b;border-bottom:1px solid #e3e8ee;white-space:nowrap;">${escapeHtml(item.amount)}</td></tr>`;
  const section = (label: string, rows: Array<{ label: string; amount: string }>) => rows.length
    ? `<p style="margin:22px 0 4px;font-size:10px;font-weight:bold;letter-spacing:1.4px;text-transform:uppercase;color:#315eae;">${escapeHtml(label)}</p>
       <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-top:2px solid #203b64;">${rows.map(row).join("")}</table>`
    : "";
  const bodyHtml = `${paragraph(`Thank you for your order from ${strong(officeName)}. Here is what you bought.`)}
    ${infoPanel(orderNumbers.includes(",") ? "Order numbers" : "Order number", orderNumbers)}
    ${paragraph(`Paid ${escapeHtml(placedAt)}`)}
    ${section("One-time items", items)}
    ${section("Subscriptions started", subscriptions)}
    ${subscriptions.length ? paragraph("Each subscription renews automatically until you pause or cancel it.") : ""}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;">
      <tr><td style="padding:14px 0 0;font-size:16px;font-weight:bold;color:#203b64;">Total charged today</td>
      <td align="right" style="padding:14px 0 0;font-family:Georgia,'Times New Roman',serif;font-size:18px;font-weight:bold;color:#203b64;">${escapeHtml(total)}</td></tr>
    </table>
    <p style="margin:26px 0 6px;font-size:10px;font-weight:bold;letter-spacing:1.4px;text-transform:uppercase;color:#315eae;">Ship to</p>
    ${paragraph(escapeHtml(shipTo))}
    ${manageButton(manageLink)}
    ${paragraph(escapeHtml(contact))}`;
  return {
    subject, previewText, text,
    html: shell({
      previewText, eyebrow: "Order confirmed", heading: "We have your order", greeting: name || undefined, bodyHtml,
      closing: "A separate receipt follows for each order. THINNR Weight Loss processes payments on behalf of your provider office.",
    }),
  };
}

function renderOrderDelivered(v: EmailVariables): RenderedEmail {
  const name = optional(v, "name");
  const orderNumber = requireVariable(v, "orderNumber");
  const officeName = requireVariable(v, "officeName");
  const deliveredAt = requireVariable(v, "deliveredAt");
  const contactEmail = optional(v, "contactEmail");
  const previewText = `Order ${orderNumber} from ${officeName} was delivered.`;
  const contact = contactLine(officeName, contactEmail, "delivery");
  const text = [
    ...(name ? [`Hello ${name},`, ""] : []),
    `Your order ${orderNumber} from ${officeName} was delivered.`,
    `Delivered: ${deliveredAt}`,
    "",
    `If the package is not where you expected, check with neighbors and building staff first, then ${contact.charAt(0).toLowerCase()}${contact.slice(1)}`,
  ].join("\n");
  return {
    subject: `Your THINNR order ${orderNumber} was delivered`,
    previewText, text,
    html: shell({
      previewText, eyebrow: "Delivered", heading: "Your order has arrived", greeting: name || undefined,
      bodyHtml: `${paragraph(`Your order ${strong(orderNumber)} from ${strong(officeName)} was delivered.`)}
        ${infoPanel("Delivered", deliveredAt)}
        ${paragraph(`If the package is not where you expected, check with neighbors and building staff first, then ${escapeHtml(contact.charAt(0).toLowerCase() + contact.slice(1))}`)}`,
      closing: `Store your products as directed on the label. ${contact}`,
    }),
  };
}

export function renderShopEmail(id: string, v: EmailVariables): RenderedEmail | null {
  switch (id as ShopEmailTemplateId) {
    case "order-confirmation": return renderOrderConfirmation(v);
    case "order-delivered": return renderOrderDelivered(v);
    case "subscription-started": {
      const productName = requireVariable(v, "productName"); const officeName = requireVariable(v, "officeName");
      const cadence = requireVariable(v, "cadence"); const amount = requireVariable(v, "amount");
      const nextShipment = requireVariable(v, "nextShipment"); const shipTo = requireVariable(v, "shipTo");
      return subscriptionEmail({
        variables: v, subject: `Your ${productName} subscription has started`,
        previewText: `${amount} ${cadence}. Next shipment ${nextShipment}.`, eyebrow: "Subscription", heading: "Your subscription has started",
        leadText: `Your ${productName} subscription from ${officeName} is active. You will be charged ${amount} ${cadence}, and each shipment goes to: ${shipTo}.`,
        leadHtml: `Your ${strong(productName)} subscription from ${strong(officeName)} is active. You will be charged ${strong(amount)} ${escapeHtml(cadence)}, and each shipment goes to ${escapeHtml(shipTo)}.`,
        panel: ["Next shipment", nextShipment],
        extraText: ["We will email you a few days before each renewal so you can skip or move a shipment."],
        extraHtml: paragraph("We will email you a few days before each renewal so you can skip or move a shipment."),
        closing: `You can pause, skip, or cancel at any time from the app. Questions? Contact ${officeName}.`,
      });
    }
    case "subscription-shipment-moved": {
      const productName = requireVariable(v, "productName"); const officeName = requireVariable(v, "officeName");
      const previousDate = requireVariable(v, "previousDate"); const nextShipment = requireVariable(v, "nextShipment");
      return subscriptionEmail({
        variables: v, subject: `Your next ${productName} shipment moved to ${nextShipment}`,
        previewText: `Moved from ${previousDate}. Later shipments follow from the new date.`, eyebrow: "Subscription", heading: "Next shipment moved",
        leadText: `Your next ${productName} shipment from ${officeName} was moved from ${previousDate}. You will be charged on the new date, and later shipments follow from there.`,
        leadHtml: `Your next ${strong(productName)} shipment from ${strong(officeName)} was moved from ${escapeHtml(previousDate)}. You will be charged on the new date, and later shipments follow from there.`,
        panel: ["New shipment date", nextShipment],
        closing: `If you did not make this change, contact ${officeName} right away.`,
      });
    }
    case "subscription-shipment-skipped": {
      const productName = requireVariable(v, "productName"); const officeName = requireVariable(v, "officeName");
      const skippedDate = requireVariable(v, "skippedDate"); const nextShipment = requireVariable(v, "nextShipment");
      return subscriptionEmail({
        variables: v, subject: `Skipped: your ${productName} shipment on ${skippedDate}`,
        previewText: `Nothing ships or charges until ${nextShipment}.`, eyebrow: "Subscription", heading: "Shipment skipped",
        leadText: `The ${productName} shipment from ${officeName} due ${skippedDate} was skipped. You will not be charged for it.`,
        leadHtml: `The ${strong(productName)} shipment from ${strong(officeName)} due ${escapeHtml(skippedDate)} was skipped. You will not be charged for it.`,
        panel: ["Next shipment", nextShipment],
        closing: `If you did not make this change, contact ${officeName} right away.`,
      });
    }
    case "subscription-paused": {
      const productName = requireVariable(v, "productName"); const officeName = requireVariable(v, "officeName");
      return subscriptionEmail({
        variables: v, subject: `Your ${productName} subscription is paused`,
        previewText: "No shipments or charges until you resume.", eyebrow: "Subscription", heading: "Subscription paused",
        leadText: `Your ${productName} subscription from ${officeName} is paused. Nothing ships and nothing is charged until you resume it.`,
        leadHtml: `Your ${strong(productName)} subscription from ${strong(officeName)} is paused. Nothing ships and nothing is charged until you resume it.`,
        extraText: ["Resume any time from the app; your next shipment date is set when you do."],
        extraHtml: paragraph("Resume any time from the app; your next shipment date is set when you do."),
        closing: `If you did not make this change, contact ${officeName} right away.`,
      });
    }
    case "subscription-resumed": {
      const productName = requireVariable(v, "productName"); const officeName = requireVariable(v, "officeName");
      const nextShipment = requireVariable(v, "nextShipment");
      return subscriptionEmail({
        variables: v, subject: `Your ${productName} subscription is active again`,
        previewText: `Next shipment ${nextShipment}.`, eyebrow: "Subscription", heading: "Subscription resumed",
        leadText: `Your ${productName} subscription from ${officeName} is active again.`,
        leadHtml: `Your ${strong(productName)} subscription from ${strong(officeName)} is active again.`,
        panel: ["Next shipment", nextShipment],
        closing: `If you did not make this change, contact ${officeName} right away.`,
      });
    }
    case "subscription-plan-changed": {
      const officeName = requireVariable(v, "officeName"); const previousPlan = requireVariable(v, "previousPlan");
      const newPlan = requireVariable(v, "newPlan"); const effective = requireVariable(v, "effective");
      return subscriptionEmail({
        variables: v, subject: `Your subscription plan changed to ${newPlan}`,
        previewText: `Takes effect ${effective}.`, eyebrow: "Subscription", heading: "Plan changed",
        leadText: `Your subscription from ${officeName} changed from ${previousPlan} to ${newPlan}.`,
        leadHtml: `Your subscription from ${strong(officeName)} changed from ${escapeHtml(previousPlan)} to ${strong(newPlan)}.`,
        panel: ["Takes effect", effective],
        extraText: ["Anything already paid for ships as planned; the new plan applies from the date above."],
        extraHtml: paragraph("Anything already paid for ships as planned; the new plan applies from the date above."),
        closing: `If you did not make this change, contact ${officeName} right away.`,
      });
    }
    case "subscription-address-changed": {
      const productName = requireVariable(v, "productName"); const officeName = requireVariable(v, "officeName");
      const shipTo = requireVariable(v, "shipTo");
      return subscriptionEmail({
        variables: v, subject: `Shipping address updated for your ${productName} subscription`,
        previewText: `Future shipments go to ${shipTo}.`, eyebrow: "Subscription", heading: "Shipping address updated",
        leadText: `Future ${productName} shipments from ${officeName} will go to the address below. Anything already on its way keeps its original address.`,
        leadHtml: `Future ${strong(productName)} shipments from ${strong(officeName)} will go to the address below. Anything already on its way keeps its original address.`,
        panel: ["Ship to", shipTo],
        closing: `If you did not make this change, contact ${officeName} right away.`,
      });
    }
    case "subscription-card-updated": {
      const productName = requireVariable(v, "productName"); const officeName = requireVariable(v, "officeName");
      const cardLabel = requireVariable(v, "cardLabel");
      return subscriptionEmail({
        variables: v, subject: `Card updated for your ${productName} subscription`,
        previewText: `Future charges use ${cardLabel}.`, eyebrow: "Subscription", heading: "Card updated",
        leadText: `Future ${productName} charges from ${officeName} will use the card below.`,
        leadHtml: `Future ${strong(productName)} charges from ${strong(officeName)} will use the card below.`,
        panel: ["Card on file", cardLabel],
        closing: `If you did not make this change, contact ${officeName} right away.`,
      });
    }
    case "subscription-renewal-reminder": {
      const productName = requireVariable(v, "productName"); const officeName = requireVariable(v, "officeName");
      const nextShipment = requireVariable(v, "nextShipment"); const amount = requireVariable(v, "amount");
      const cardLabel = requireVariable(v, "cardLabel"); const skipLink = requireVariable(v, "skipLink");
      const manageLink = requireVariable(v, "manageLink");
      const name = optional(v, "name");
      const previewText = `${amount} will be charged to ${cardLabel} on ${nextShipment}.`;
      const text = [
        ...(name ? [`Hello ${name},`, ""] : []),
        `Your next ${productName} shipment from ${officeName} is coming up. On ${nextShipment} we will charge ${amount} to ${cardLabel} and ship your order.`,
        "",
        `Next shipment: ${nextShipment}`,
        "",
        `Skip this shipment: ${skipLink}`,
        `${MANAGE_LABEL}: ${manageLink}`,
        "",
        "Nothing to do if you want it as scheduled.",
      ].join("\n");
      return {
        subject: `Reminder: your ${productName} shipment renews ${nextShipment}`, previewText, text,
        html: shell({
          previewText, eyebrow: "Upcoming renewal", heading: "Your next shipment is coming up", greeting: name || undefined,
          bodyHtml: `${paragraph(`Your next ${strong(productName)} shipment from ${strong(officeName)} is coming up. On ${escapeHtml(nextShipment)} we will charge ${strong(amount)} to ${escapeHtml(cardLabel)} and ship your order.`)}
            ${infoPanel("Next shipment", nextShipment)}
            ${button(skipLink, "Skip this shipment")}
            ${button(manageLink, MANAGE_LABEL, "#203b64")}
            ${paragraph("Nothing to do if you want it as scheduled.")}`,
          closing: `Skipping moves the shipment out by one cycle; you can also move the date, change the plan, or pause from the app. Questions? Contact ${officeName}.`,
        }),
      };
    }
    default: return null;
  }
}
