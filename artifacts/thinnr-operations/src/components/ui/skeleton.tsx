import { cn } from '@/lib/utils';

function Skeleton({
  className,
  'aria-hidden': ariaHidden = true,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden={ariaHidden}
      className={cn('motion-safe:animate-pulse motion-reduce:animate-none rounded-md bg-primary/10', className)}
      {...props}
    />
  );
}

type LoadingShapeProps = {
  label?: string;
  className?: string;
  testId?: string;
};

type ChartSkeletonProps = LoadingShapeProps & {
  /** Total visual height reserved for the chart placeholder, in pixels. */
  height?: number;
};

type RowsSkeletonProps = LoadingShapeProps & {
  /** Number of rows to reserve. */
  rows?: number;
  /** Uses a shorter row for compact lists and summary panels. */
  compact?: boolean;
};

type LoadingRegionProps = LoadingShapeProps & {
  label: string;
  children: React.ReactNode;
};

function LoadingRegion({ label, children, className, testId }: LoadingRegionProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={className}
      data-testid={testId}
    >
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}

function ChartSkeleton({
  label = 'Loading chart',
  className,
  testId,
  height = 240,
}: ChartSkeletonProps) {
  return (
    <LoadingRegion label={label} className={className} testId={testId}>
      <div
        className="flex min-h-0 flex-col rounded-md border border-border bg-card p-4"
        style={{ height }}
      >
        <div className="mb-4 flex shrink-0 items-center justify-between">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-3 w-16" />
        </div>
        <div className="flex min-h-0 flex-1 items-end gap-2">
          {[38, 62, 48, 76, 57, 88, 70, 94, 66, 82, 72, 91].map((height, index) => (
            <Skeleton key={index} className="min-w-0 flex-1 rounded-sm" style={{ height: `${height}%` }} />
          ))}
        </div>
      </div>
    </LoadingRegion>
  );
}

function RowsSkeleton({
  label = 'Loading rows',
  className,
  testId,
  rows = 5,
  compact = false,
}: RowsSkeletonProps) {
  const safeRows = Math.max(1, Math.floor(rows));
  return (
    <LoadingRegion label={label} className={className} testId={testId}>
      <div className="divide-y divide-border rounded-md border border-border bg-card">
        {Array.from({ length: safeRows }, (_, index) => (
          <div key={index} className={cn('flex items-center gap-3', compact ? 'p-2.5' : 'p-4')}>
            <Skeleton className={cn('shrink-0', compact ? 'h-7 w-7' : 'h-9 w-9')} />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-3 w-2/5" />
              <Skeleton className="h-2.5 w-3/5" />
            </div>
            <Skeleton className={cn('w-20 shrink-0', compact ? 'h-5' : 'h-6')} />
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}

export { Skeleton, LoadingRegion, ChartSkeleton, RowsSkeleton };
