/**
 * WarehouseCraft state for one paid order, shared by the HQ and office
 * fulfillment queues and the transaction detail: the submission outcome, and
 * once the status feed has matched the order, the raw warehouse status, a
 * and a back-order badge. Orders that predate automatic
 * submission (no `warehouse` payload) render nothing rather than a misleading
 * "not sent".
 */
import type { ReactNode } from 'react';
import { StatusPill } from '@/components/billing/primitives';
import { WAREHOUSE_STATE_LABEL, warehouseDetail, warehouseFeedDetail, warehouseTone } from '@/lib/billing-format';
import type { OrderShipmentState, WarehouseSubmission } from '@/lib/billing-types';

export function WarehouseStatus({ orderId, warehouse, shipment, action }: { orderId: string; warehouse: WarehouseSubmission | null | undefined; shipment?: OrderShipmentState | null; action?: ReactNode }) {
  if (!warehouse) return null;
  const feed = warehouseFeedDetail(shipment);
  return (
    <div className="flex flex-wrap items-start justify-between gap-2 border-t px-4 py-3 text-xs" data-testid={`warehouse-status-${orderId}`}>
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusPill tone={warehouseTone(warehouse.state)} testId={`pill-warehouse-${orderId}`}>
            {WAREHOUSE_STATE_LABEL[warehouse.state]}
          </StatusPill>
          {shipment?.back_ordered && (
            <StatusPill tone="warn" testId={`pill-back-ordered-${orderId}`}>
              Back-ordered
            </StatusPill>
          )}
        </div>
        <p className={warehouse.state === 'needs_attention' ? 'text-[#b02a1f]' : 'text-muted-foreground'} data-testid={`text-warehouse-detail-${orderId}`}>
          {warehouseDetail(warehouse)}
        </p>
        {feed && (
          <p className="text-muted-foreground" data-testid={`text-warehouse-feed-${orderId}`}>
            {feed}
            {shipment?.back_ordered ? ' · The warehouse is waiting on stock; the patient still sees "Preparing your order".' : ''}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}
