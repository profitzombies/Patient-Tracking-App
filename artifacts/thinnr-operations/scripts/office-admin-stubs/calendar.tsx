/**
 * DOM-free stand-in for '@/components/ui/calendar' (react-day-picker). Renders
 * a grid element that exposes the picker props so suites can drive
 * `onSelect` directly: `find(el => el.props['data-calendar']).props.onSelect(...)`.
 */
import * as React from 'react';

export function Calendar(props: Record<string, unknown>) {
  return <div role="grid" data-calendar data-mode={props.mode as string} {...({ pickerProps: props } as Record<string, unknown>)} />;
}
