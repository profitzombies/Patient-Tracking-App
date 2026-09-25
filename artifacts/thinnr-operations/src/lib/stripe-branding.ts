import { loadStripe, type Appearance, type StripeConstructorOptions, type StripeElementStyle } from '@stripe/stripe-js';

/**
 * THINNR look for every Stripe surface on the operations site, and the one
 * place Stripe.js is initialised.
 *
 * `developerTools.assistant` is Stripe.js's floating test-mode helper (the
 * round Stripe icon pinned to the bottom-right corner in sandbox mode). It is
 * a developer tool, not part of any payment flow, so every Stripe instance we
 * create turns it off.
 */
export const STRIPE_NO_FLOATING_TOOLS: Pick<StripeConstructorOptions, 'developerTools'> = {
  developerTools: { assistant: { enabled: false } },
};

export function loadBrandedStripe(publishableKey: string, options: StripeConstructorOptions = {}) {
  return loadStripe(publishableKey, { ...options, ...STRIPE_NO_FLOATING_TOOLS });
}

export const THINNR_COLORS = {
  primary: '#315eae',
  background: '#fdfcf9',
  text: '#26364b',
  muted: '#6b7688',
  border: '#dcd6ca',
  danger: '#a04646',
} as const;

export const THINNR_FONT_CSS = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
export const THINNR_FONT_STACK = 'Inter, ui-sans-serif, system-ui, sans-serif';

/** Stripe Elements (Payment Element, bank flow) in THINNR colours and type. */
export const THINNR_ELEMENTS_APPEARANCE: Appearance = {
  theme: 'stripe',
  variables: {
    colorPrimary: THINNR_COLORS.primary,
    colorBackground: '#ffffff',
    colorText: THINNR_COLORS.text,
    colorTextSecondary: THINNR_COLORS.muted,
    colorDanger: THINNR_COLORS.danger,
    borderRadius: '7px',
    fontFamily: THINNR_FONT_STACK,
    spacingUnit: '4px',
  },
  rules: {
    '.Input': { borderColor: THINNR_COLORS.border, boxShadow: 'none' },
    '.Input:focus': { borderColor: THINNR_COLORS.primary, boxShadow: `0 0 0 3px rgba(49, 94, 174, 0.15)` },
    '.Label': { fontWeight: '600' },
  },
};

export const THINNR_ELEMENTS_FONTS = [{ cssSrc: THINNR_FONT_CSS }];

/** Card-only fields (number, expiry, CVC) styled to sit inside THINNR inputs. */
export const THINNR_CARD_STYLE: StripeElementStyle = {
    base: {
      color: THINNR_COLORS.text,
      fontFamily: THINNR_FONT_STACK,
      fontSize: '15px',
      fontSmoothing: 'antialiased',
      '::placeholder': { color: '#9aa3b2' },
      iconColor: THINNR_COLORS.primary,
    },
    invalid: { color: THINNR_COLORS.danger, iconColor: THINNR_COLORS.danger },
};

/** Connect embedded components (Stripe account onboarding) in THINNR look. */
export const THINNR_CONNECT_APPEARANCE = {
  overlays: 'dialog' as const,
  variables: {
    colorPrimary: THINNR_COLORS.primary,
    colorBackground: THINNR_COLORS.background,
    colorText: THINNR_COLORS.text,
    colorSecondaryText: THINNR_COLORS.muted,
    colorBorder: THINNR_COLORS.border,
    colorDanger: THINNR_COLORS.danger,
    borderRadius: '7px',
    buttonBorderRadius: '7px',
    formBorderRadius: '7px',
    fontFamily: THINNR_FONT_STACK,
  },
};
export const THINNR_CONNECT_FONTS = [{ cssSrc: THINNR_FONT_CSS }];
