/**
 * WarehouseCraft submission state for one paid order, shared by the HQ and
 * office fulfillment queues and the transaction detail. Orders that predate
 * automatic submission (no `warehouse` payload) render nothing rather than a
 * misleading "not sent".
 */
import type { ReactNode } from 'react';
import { StatusPill } from '@/components/billing/primitives';
import { WAREHOUSE_STATE_LABEL, warehouseDetail, warehouseTone } from '@/lib/billing-format';
import type { WarehouseSubmission } from '@/lib/billing-types';

export function WarehouseStatus({ orderId, warehouse, action }: { orderId: string; warehouse: WarehouseSubmission | null | undefined; action?: ReactNode }) {
  if (!warehouse) return null;
  return (
    <div className="flex flex-wrap items-start justify-between gap-2 border-t px-4 py-3 text-xs" data-testid={`warehouse-status-${orderId}`}>
      <div className="min-w-0 space-y-1">
        <StatusPill tone={warehouseTone(warehouse.state)} testId={`pill-warehouse-${orderId}`}>
          {WAREHOUSE_STATE_LABEL[warehouse.state]}
        </StatusPill>
        <p className={warehouse.state === 'needs_attention' ? 'text-[#b02a1f]' : 'text-muted-foreground'} data-testid={`text-warehouse-detail-${orderId}`}>
          {warehouseDetail(warehouse)}
        </p>
      </div>
      {action}
    </div>
  );
}
