import { format, isToday, isYesterday } from 'date-fns';
import { type ConversationEvent } from '@workspace/api-client-react';

export function InitialsAvatar({ name }: { name: string | undefined }) {
  const initials = (name || '')
    .split(' ')
    .filter(Boolean)
    .map((n) => n[0])
    .join('')
    .substring(0, 2)
    .toUpperCase();
  return (
    <span
      aria-hidden="true"
      className="grid h-10 w-10 shrink-0 place-items-center rounded-md border border-accent-border bg-accent text-[11px] font-bold text-primary"
    >
      {initials || '?'}
    </span>
  );
}

export function formatRelativeTime(dateString: string) {
  const d = new Date(dateString);
  if (isNaN(d.getTime())) return '';
  if (isToday(d)) return format(d, 'h:mm a');
  if (isYesterday(d)) return 'Yesterday';
  return format(d, 'MMM d, yyyy');
}

export function LiveMessageRow({ message }: { message: ConversationEvent }) {
  const isUser = message.role === 'user';
  const isStaff = message.role === 'staff';
  const timeLabel = format(new Date(message.createdAt), 'h:mm a');

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[88%] md:max-w-[72%] ${isUser ? 'items-end' : 'items-start'}`}>
        {isStaff && <p className="mb-1 text-[10px] font-bold uppercase tracking-[.1em] text-primary">{message.senderLabel ?? 'Care team'}</p>}
        <div
          className={
            isUser
              ? 'rounded-lg rounded-br-sm bg-primary px-3.5 py-2.5 text-primary-foreground shadow-xs'
              : isStaff
                ? 'rounded-lg rounded-bl-sm border border-primary/25 bg-accent px-3.5 py-2.5 shadow-soft'
                : 'rounded-lg rounded-bl-sm border border-card-border bg-card px-3.5 py-2.5 shadow-soft'
          }
        >
          {message.text.split('\n\n').map((block, index) => (
            <p
              key={index}
              className={`text-xs leading-relaxed ${index > 0 ? 'mt-2.5' : ''} ${isUser ? '' : 'text-foreground'}`}
            >
              {block}
            </p>
          ))}
          {message.stopped && (
            <p className="mt-2 text-[10px] italic text-destructive opacity-80">
              Message stopped by user
            </p>
          )}
        </div>
        <p className={`mt-1.5 text-[10px] text-muted-foreground ${isUser ? 'text-right' : ''}`}>{timeLabel}</p>
      </div>
    </div>
  );
}
