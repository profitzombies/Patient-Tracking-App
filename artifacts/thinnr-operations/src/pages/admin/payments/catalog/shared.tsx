/**
 * Pieces shared by the catalog list, the product editor and the history page:
 * the fee math preview (mirrors the server's break-even rule), status labels
 * and the product thumbnail.
 */
import { Package } from 'lucide-react';
import { StatusPill } from '@/components/billing/primitives';
import type { PillTone } from '@/lib/billing-format';
import type { CatalogChangeKind, ProductStatus } from '@/lib/billing-types';

export interface FeeSettings {
  shipping_charge_cents: number;
  shipping_cost_cents: number;
  card_fee_bps: number;
  card_fee_fixed_cents: number;
}

/** THINNR share (60% of floor), the office's break-even minimum, and HQ profit per unit. */
export function productMath(floor: number, hard: number | null, settings: FeeSettings) {
  const { shipping_charge_cents: shippingCharge, card_fee_bps: bps, card_fee_fixed_cents: fixed } = settings;
  const share = Math.floor((floor * 60) / 100);
  const stripe = (sell: number) => Math.round(((sell + shippingCharge) * bps) / 10000) + fixed;
  let minimum = Math.max(0, Math.floor((share + fixed) / (1 - bps / 10000)));
  while (minimum - share - stripe(minimum) < 0) minimum += 1;
  while (minimum > 0 && minimum - 1 - share - stripe(minimum - 1) >= 0) minimum -= 1;
  return { share, minimum, profit: hard === null ? null : share - hard };
}

export const PRODUCT_STATUS_LABEL: Record<ProductStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  retired: 'Retired',
  archived: 'Archived',
};

export const PRODUCT_STATUS_HELP: Record<ProductStatus, string> = {
  draft: 'Not visible to offices yet. Finish the details and publish when ready.',
  active: 'Offices can price and sell this product.',
  retired: 'Hidden from new sales; existing subscriptions keep renewing.',
  archived: 'Out of the working catalog. Reactivate to bring it back.',
};

export function productStatusTone(status: ProductStatus): PillTone {
  return status === 'active' ? 'good' : status === 'draft' ? 'info' : status === 'retired' ? 'warn' : 'neutral';
}

export function ProductStatusPill({ status, testId }: { status: ProductStatus; testId?: string }) {
  return (
    <StatusPill tone={productStatusTone(status)} testId={testId}>
      {PRODUCT_STATUS_LABEL[status]}
    </StatusPill>
  );
}

export const CHANGE_KIND_LABEL: Record<CatalogChangeKind, string> = {
  product_created: 'Product added',
  product_updated: 'Product edited',
  product_retired: 'Product retired',
  product_reactivated: 'Product reactivated',
  product_published: 'Product published',
  product_archived: 'Product archived',
  product_unarchived: 'Product restored',
  product_image_added: 'Image added',
  product_image_removed: 'Image removed',
  product_default_image: 'Default image changed',
  products_reordered: 'Catalog reordered',
  office_price_updated: 'Office price changed',
  settings_updated: 'Program settings changed',
};

const SIZE_CLASS = { sm: 'h-10 w-10', md: 'h-14 w-14', lg: 'aspect-[4/3] w-full' } as const;

/** Product picture with a quiet placeholder when none is uploaded yet. */
export function ProductThumb({
  src,
  name,
  size = 'sm',
  className,
}: {
  src: string | null;
  name: string;
  size?: keyof typeof SIZE_CLASS;
  className?: string;
}) {
  return (
    <span
      className={`grid shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-secondary ${SIZE_CLASS[size]} ${className ?? ''}`}
    >
      {src ? (
        <img src={src} alt={size === 'lg' ? `${name} product photo` : ''} className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <Package size={size === 'lg' ? 28 : 16} aria-hidden="true" className="text-muted-foreground" />
      )}
    </span>
  );
}

export const FIELD_LABEL = 'mb-1.5 block text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground';
