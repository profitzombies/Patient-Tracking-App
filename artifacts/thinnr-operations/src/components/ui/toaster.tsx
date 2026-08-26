import type { ComponentProps } from 'react';
import { CheckCircle2, CircleAlert } from 'lucide-react';
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from '@/components/ui/toast';
import { useToast, type ToastProgress } from '@/hooks/use-toast';

type ToastVariant = ComponentProps<typeof Toast>['variant'];

function ToastIcon({ variant }: { variant: ToastVariant }) {
  if (variant === 'success') {
    return (
      <span
        aria-hidden="true"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent text-primary"
      >
        <CheckCircle2 className="h-4 w-4" />
      </span>
    );
  }
  if (variant === 'destructive') {
    return (
      <span
        aria-hidden="true"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white/15 text-destructive-foreground"
      >
        <CircleAlert className="h-4 w-4" />
      </span>
    );
  }
  // Informational toasts stay plain — no icon, no sound.
  return null;
}

function ToastProgressBar({
  progress,
  label,
  destructive,
}: {
  progress: ToastProgress;
  label: string;
  destructive: boolean;
}) {
  const failed = progress.state === 'failed';
  const value = progress.state === 'done' ? 100 : progress.value;
  return (
    <div className="mt-1.5" data-testid="toast-progress">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-valuetext={failed ? `Stopped at ${value}%` : `${value}%`}
        aria-label={label}
        className={`h-1.5 w-full overflow-hidden rounded-full ${
          destructive ? 'bg-destructive-foreground/25' : 'bg-muted'
        }`}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-300 ease-out ${
            destructive ? 'bg-destructive-foreground/85' : 'bg-primary'
          }`}
          style={{ width: `${value}%` }}
        />
      </div>
      <p
        aria-hidden="true"
        className={`mt-1 text-[10px] font-bold uppercase tracking-[.08em] ${
          destructive ? 'text-destructive-foreground/85' : 'text-muted-foreground'
        }`}
      >
        {failed ? 'Failed' : progress.state === 'done' ? 'Finished' : `${value}%`}
      </p>
    </div>
  );
}

export function Toaster() {
  const { toasts, announcement } = useToast();

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, progress, variant, ...props }) {
        return (
          <Toast key={id} variant={variant} {...props}>
            <ToastIcon variant={variant} />
            <div className="grid min-w-0 flex-1 gap-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && (
                <ToastDescription>{description}</ToastDescription>
              )}
              {progress && (
                <ToastProgressBar
                  progress={progress}
                  label={typeof title === 'string' ? title : 'Progress'}
                  destructive={variant === 'destructive'}
                />
              )}
            </div>
            {action}
            <ToastClose />
          </Toast>
        );
      })}
      <ToastViewport />
      {/*
        Progress toasts morph in place when they settle, and Radix only
        announces a toast when it first opens — this quiet status line voices
        those end states exactly once. The alternating no-break space keeps a
        repeated message audible without double-speaking anything Radix
        already announced.
      */}
      <span className="sr-only" role="status" data-testid="toast-announcer">
        {announcement
          ? announcement.message + (announcement.serial % 2 === 1 ? '\u00A0' : '')
          : ''}
      </span>
    </ToastProvider>
  );
}
