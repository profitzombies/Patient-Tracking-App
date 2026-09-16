/**
 * Manual drag-and-drop ordering for the HQ drive.
 *
 * Native HTML5 drag events (no library): a folder drag and a file drag carry
 * different data types so one cannot be dropped among the other, and neither
 * carries the "Files" type the page-level upload drop zone listens for.
 * Every reorderable item also offers Move up / Move down actions so keyboard
 * and touch users get the same result without dragging.
 */
import { useState, type DragEvent } from 'react';

export type ReorderKind = 'folder' | 'file';

export const DRAG_TYPES: Record<ReorderKind, string> = {
  folder: 'application/x-thinnr-hq-folder',
  file: 'application/x-thinnr-hq-file',
};

/** Move `fromId` so it sits right before (or after) `toId`. */
export function reorderIds(ids: string[], fromId: string, toId: string, after: boolean): string[] {
  if (fromId === toId) return ids;
  const without = ids.filter((id) => id !== fromId);
  const index = without.indexOf(toId);
  if (index < 0 || !ids.includes(fromId)) return ids;
  without.splice(after ? index + 1 : index, 0, fromId);
  return without;
}

/** Move `id` one slot earlier (delta -1) or later (delta +1). */
export function stepIds(ids: string[], id: string, delta: -1 | 1): string[] {
  const index = ids.indexOf(id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= ids.length) return ids;
  const next = [...ids];
  next.splice(index, 1);
  next.splice(target, 0, id);
  return next;
}

/** Sort `items` by the given id order; ids not listed keep their place at the end. */
export function orderBy<T extends { id: string }>(items: T[], ids: string[]): T[] {
  const rank = new Map(ids.map((id, index) => [id, index]));
  return [...items].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

export type DropMarker = { id: string; after: boolean };

export interface DragReorder {
  /** Id being dragged, when a drag is in flight. */
  dragging: string | null;
  /** Item the pointer is over and whether the drop lands after it. */
  over: DropMarker | null;
  /** Spread onto each draggable item element. */
  itemProps(id: string): {
    draggable: true;
    onDragStart(event: DragEvent<HTMLElement>): void;
    onDragEnd(): void;
    onDragOver(event: DragEvent<HTMLElement>): void;
    onDrop(event: DragEvent<HTMLElement>): void;
  };
  /** Move one slot earlier or later (menu fallback). */
  step(id: string, delta: -1 | 1): void;
  canStep(id: string, delta: -1 | 1): boolean;
}

/**
 * `axis` decides which half of the hovered item means "after": the right
 * half in a card grid (reading order), the bottom half in a list.
 */
export function useDragReorder(kind: ReorderKind, ids: string[], onReorder: (ids: string[], movedId: string) => void, axis: 'grid' | 'list'): DragReorder {
  const type = DRAG_TYPES[kind];
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<DropMarker | null>(null);
  const carries = (event: DragEvent<HTMLElement>) => Array.from(event.dataTransfer?.types ?? []).includes(type);
  return {
    dragging,
    over,
    itemProps: (id) => ({
      draggable: true,
      onDragStart: (event) => {
        event.dataTransfer.setData(type, id);
        event.dataTransfer.effectAllowed = 'move';
        setDragging(id);
      },
      onDragEnd: () => { setDragging(null); setOver(null); },
      onDragOver: (event) => {
        if (!carries(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const rect = event.currentTarget.getBoundingClientRect();
        const after = axis === 'grid' ? event.clientX > rect.left + rect.width / 2 : event.clientY > rect.top + rect.height / 2;
        if (over?.id !== id || over.after !== after) setOver({ id, after });
      },
      onDrop: (event) => {
        if (!carries(event)) return;
        event.preventDefault();
        const fromId = event.dataTransfer.getData(type) || dragging;
        const marker = over?.id === id ? over : { id, after: false };
        setDragging(null);
        setOver(null);
        if (!fromId || fromId === id) return;
        const next = reorderIds(ids, fromId, id, marker.after);
        if (next !== ids) onReorder(next, fromId);
      },
    }),
    step: (id, delta) => {
      const next = stepIds(ids, id, delta);
      if (next !== ids) onReorder(next, id);
    },
    canStep: (id, delta) => stepIds(ids, id, delta) !== ids,
  };
}
