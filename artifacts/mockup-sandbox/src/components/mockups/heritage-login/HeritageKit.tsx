/**
 * Heritage login kit — shared primitives for the heritage-login concept
 * frames. Mirrors the real apps' Heritage foundation: cream paper cards on
 * soft paper, cobalt actions, navy display type (Playfair Display), Inter
 * body, 9/7/5 soft geometry, orange reserved for tiny accents.
 */
import type { ButtonHTMLAttributes, CSSProperties, InputHTMLAttributes, ReactNode } from 'react';
import { ArrowRight, ChevronLeft } from 'lucide-react';

export const H = {
  paper: '#f2f3f4',
  paperAlt: '#f9faf8',
  card: '#fdfcf9',
  line: '#d8e0e9',
  divider: '#e8e8e5',
  track: '#e5e8eb',
  cobalt: '#315eae',
  cobaltHover: '#2b539b',
  cobaltLight: '#5878b9',
  cobaltMuted: '#9db1d4',
  navy: '#203b64',
  ink: '#26364b',
  body: '#56708e',
  muted: '#7e8994',
  subtle: '#858d95',
  chip: '#e3ecf7',
  chipLine: '#b7cbe8',
  rail: '#e5edf7',
  orange: '#df772c',
  warn: '#b65c22',
  warnBg: '#fff4e6',
  warnLine: '#e8b47c',
  risk: '#a04646',
  riskBg: '#fff0f0',
  riskLine: '#d5a7a7',
  brandFg: '#dce6fa',
} as const;

export const SERIF = "'Playfair Display', Georgia, serif";
export const SANS = "'Inter', ui-sans-serif, system-ui, sans-serif";
export const SOFT = '0 1px 2px rgba(32,59,100,.05), 0 10px 28px -20px rgba(32,59,100,.28)';
export const LIFTED = '0 2px 4px rgba(32,59,100,.06), 0 18px 44px -22px rgba(32,59,100,.4)';
export const LOGO = '/__mockup/images/thinnr-logo-official.png';
export const HERO = '/__mockup/images/home-hero.jpg';

/* ─── Shells ─────────────────────────────────────────────────────────── */

export function WebPage({ children, className = '', style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={`relative flex min-h-[100dvh] w-full flex-col antialiased ${className}`} style={{ background: H.paper, color: H.ink, fontFamily: SANS, ...style }}>
      {children}
    </div>
  );
}

export function PhonePage({ children, className = '', style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <main className={`relative mx-auto flex min-h-[100dvh] w-full max-w-[390px] flex-col overflow-x-hidden antialiased ${className}`} style={{ background: H.paper, color: H.ink, fontFamily: SANS, ...style }}>
      {children}
    </main>
  );
}

/* ─── Brand ──────────────────────────────────────────────────────────── */

export function Mark({ size = 48, tone = 'navy', className = '' }: { size?: number; tone?: 'navy' | 'outline' | 'cream'; className?: string }) {
  const tones: Record<string, CSSProperties> = {
    navy: { background: H.navy, color: H.brandFg, boxShadow: SOFT },
    outline: { background: H.card, color: H.navy, border: `1px solid ${H.line}` },
    cream: { background: H.card, color: H.navy },
  };
  return (
    <span aria-label="THINNR" className={`grid shrink-0 place-items-center rounded-[7px] font-bold tracking-[.04em] ${className}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.29), fontFamily: SANS, ...tones[tone] }}>
      TH
    </span>
  );
}

/** Official serif wordmark, recoloured through a CSS mask (the PNG is black artwork). */
export function Wordmark({ height = 22, color = H.navy, className = '' }: { height?: number; color?: string; className?: string }) {
  const mask: CSSProperties = {
    width: Math.round(height * (1280 / 294)),
    height,
    backgroundColor: color,
    WebkitMaskImage: `url(${LOGO})`,
    maskImage: `url(${LOGO})`,
    WebkitMaskSize: 'contain',
    maskSize: 'contain',
    WebkitMaskRepeat: 'no-repeat',
    maskRepeat: 'no-repeat',
    WebkitMaskPosition: 'center',
    maskPosition: 'center',
  };
  return <span role="img" aria-label="THINNR" className={`inline-block shrink-0 ${className}`} style={mask} />;
}

export function SerifWordmark({ size = 25, color = H.navy, className = '' }: { size?: number; color?: string; className?: string }) {
  return (
    <span className={`inline-block font-bold leading-none tracking-[.15em] ${className}`} style={{ fontFamily: SERIF, fontSize: size, color }}>
      THINNR
    </span>
  );
}

/* ─── Type ───────────────────────────────────────────────────────────── */

export function Kicker({ children, className = '', color = H.muted }: { children: ReactNode; className?: string; color?: string }) {
  return (
    <p className={`text-[10px] font-bold uppercase tracking-[.14em] ${className}`} style={{ color, fontFamily: SANS }}>
      {children}
    </p>
  );
}

export function Serif({ as: Tag = 'h1', size = 32, weight = 700, color = H.navy, italic = false, children, className = '', style }: { as?: 'h1' | 'h2' | 'h3' | 'p' | 'span'; size?: number; weight?: 400 | 600 | 700; color?: string; italic?: boolean; children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <Tag className={`leading-[1.08] tracking-[-.015em] ${className}`} style={{ fontFamily: SERIF, fontSize: size, fontWeight: weight, color, fontStyle: italic ? 'italic' : 'normal', ...style }}>
      {children}
    </Tag>
  );
}

/* ─── Controls ───────────────────────────────────────────────────────── */

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: ReactNode;
  trailing?: ReactNode;
  variant?: 'web' | 'mobile' | 'underline';
  wrapClassName?: string;
};

export function Field({ label, hint, trailing, variant = 'web', wrapClassName = '', id, className = '', ...input }: FieldProps) {
  const inputId = id ?? `field-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const labelClass = variant === 'web' ? 'text-[12px] font-semibold' : 'text-[10.5px] font-bold uppercase tracking-[.13em]';
  const labelColor = variant === 'web' ? H.navy : H.muted;
  const inputClass =
    variant === 'underline'
      ? 'h-11 rounded-none border-0 border-b bg-transparent px-0 text-[16px] focus:border-b-2 focus:border-[#315eae]'
      : variant === 'mobile'
        ? 'h-12 rounded-[7px] border bg-[#fdfcf9] px-3.5 text-[15px] focus:border-[#315eae] focus:ring-2 focus:ring-[#315eae]/15'
        : 'h-10 rounded-[7px] border bg-[#fdfcf9] px-3 text-[14px] focus:border-[#315eae] focus:ring-2 focus:ring-[#315eae]/15';
  return (
    <div className={wrapClassName}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={inputId} className={labelClass} style={{ color: labelColor }}>
          {label}
        </label>
        {trailing}
      </div>
      <input
        id={inputId}
        {...input}
        className={`mt-1.5 w-full border-[#d8e0e9] text-[#26364b] outline-none transition placeholder:text-[#98a3ad] ${inputClass} ${className}`}
        style={{ fontFamily: SANS }}
      />
      {hint ? (
        <p className="mt-1.5 text-[11px] leading-relaxed" style={{ color: H.muted }}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function PrimaryButton({ children, className = '', arrow = false, size = 'md', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { arrow?: boolean; size?: 'md' | 'lg' }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex w-full items-center justify-center gap-2 rounded-[7px] bg-[#315eae] font-semibold text-white transition hover:bg-[#2b539b] active:bg-[#254a8c] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#315eae] focus-visible:ring-offset-2 disabled:opacity-60 ${size === 'lg' ? 'h-12 text-[15px]' : 'h-10 text-[13.5px]'} ${className}`}
    >
      {children}
      {arrow ? <ArrowRight size={15} aria-hidden="true" /> : null}
    </button>
  );
}

export function OutlineButton({ children, className = '', arrow = false, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { arrow?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex h-9 w-full items-center justify-center gap-2 rounded-[7px] border border-[#d8e0e9] bg-[#f2f3f4] px-4 text-xs font-semibold text-[#26364b] transition hover:bg-[#e3ecf7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#315eae] focus-visible:ring-offset-2 ${className}`}
    >
      {children}
      {arrow ? <ArrowRight size={14} aria-hidden="true" /> : null}
    </button>
  );
}

export function TextLink({ children, tone = 'cobalt', size = 12.5, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'cobalt' | 'muted'; size?: number }) {
  return (
    <button type="button" {...props} className={`font-semibold underline-offset-2 transition hover:underline ${className}`} style={{ color: tone === 'cobalt' ? H.cobalt : H.subtle, fontSize: size }}>
      {children}
    </button>
  );
}

export function Notice({ tone = 'warn', children, className = '' }: { tone?: 'warn' | 'info' | 'error' | 'ok'; children: ReactNode; className?: string }) {
  const tones = {
    warn: { border: H.warnLine, bg: H.warnBg, color: H.warn },
    info: { border: H.line, bg: H.chip, color: H.ink },
    error: { border: H.riskLine, bg: H.riskBg, color: H.risk },
    ok: { border: H.chipLine, bg: '#e9f1fa', color: H.cobalt },
  }[tone];
  return (
    <p role={tone === 'error' ? 'alert' : undefined} className={`rounded-[7px] border px-3 py-2 text-xs font-medium leading-relaxed ${className}`} style={{ borderColor: tones.border, background: tones.bg, color: tones.color }}>
      {children}
    </p>
  );
}

export function OtpCells({ value = '', count = 6, focusIndex, size = 'md', className = '' }: { value?: string; count?: number; focusIndex?: number; size?: 'md' | 'lg'; className?: string }) {
  const digits = value.replace(/\D/g, '').slice(0, count).split('');
  const active = focusIndex ?? Math.min(digits.length, count - 1);
  return (
    <div className={`flex justify-between gap-2 ${className}`} role="group" aria-label={`${count}-digit code`}>
      {Array.from({ length: count }, (_, index) => {
        const focused = index === active;
        return (
          <span
            key={index}
            className={`relative grid flex-1 place-items-center rounded-[7px] border bg-[#fdfcf9] font-semibold text-[#203b64] ${size === 'lg' ? 'h-14 text-[22px]' : 'h-12 text-[19px]'} ${focused ? 'border-[#315eae] ring-2 ring-[#315eae]/15' : 'border-[#d8e0e9]'}`}
            style={{ fontFamily: SANS }}
          >
            {digits[index] ?? (focused ? <i className="h-5 w-px animate-pulse bg-[#315eae]" /> : '')}
          </span>
        );
      })}
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, className = '' }: { value: T; onChange: (next: T) => void; options: Array<[T, string]>; className?: string }) {
  return (
    <div className={`grid rounded-[7px] border border-[#d8e0e9] bg-[#eaedef] p-1 ${className}`} style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }} role="tablist">
      {options.map(([key, label]) => {
        const on = key === value;
        return (
          <button key={key} type="button" role="tab" aria-selected={on} onClick={() => onChange(key)} className={`h-8 rounded-[5px] text-[12.5px] font-semibold transition ${on ? 'bg-[#fdfcf9] text-[#203b64]' : 'text-[#7e8994] hover:text-[#26364b]'}`} style={on ? { boxShadow: SOFT } : undefined}>
            {label}
          </button>
        );
      })}
    </div>
  );
}

export function IconTile({ children, size = 36, tone = 'chip', className = '' }: { children: ReactNode; size?: number; tone?: 'chip' | 'card' | 'navy' | 'warm'; className?: string }) {
  const tones: Record<string, CSSProperties> = {
    chip: { background: H.chip, color: H.cobalt },
    card: { background: H.card, color: H.cobalt, border: `1px solid ${H.line}` },
    navy: { background: H.navy, color: H.brandFg },
    warm: { background: H.warnBg, color: H.warn, border: `1px solid ${H.warnLine}` },
  };
  return (
    <span aria-hidden="true" className={`grid shrink-0 place-items-center rounded-[7px] ${className}`} style={{ width: size, height: size, ...tones[tone] }}>
      {children}
    </span>
  );
}

export function BackTile({ tone = 'card', className = '' }: { tone?: 'card' | 'navy'; className?: string }) {
  return (
    <button type="button" aria-label="Go back" className={`grid h-11 w-11 place-items-center rounded-[7px] border transition ${tone === 'navy' ? 'border-white/15 bg-white/10 text-[#dce6fa] hover:bg-white/15' : 'border-[#d8e0e9] bg-[#fdfcf9] text-[#203b64] hover:bg-[#e3ecf7]'} ${className}`}>
      <ChevronLeft size={18} />
    </button>
  );
}

export function Card({ children, className = '', accentTop = false, lifted = false, style }: { children: ReactNode; className?: string; accentTop?: boolean; lifted?: boolean; style?: CSSProperties }) {
  return (
    <section className={`overflow-hidden rounded-[9px] border border-[#d8e0e9] bg-[#fdfcf9] ${className}`} style={{ boxShadow: lifted ? LIFTED : SOFT, ...style }}>
      {accentTop ? <div className="h-[3px] bg-[#315eae]" /> : null}
      {children}
    </section>
  );
}

/* ─── Recurring copy blocks ──────────────────────────────────────────── */

export function DemoFooter({ className = '', tone = 'rail' }: { className?: string; tone?: 'rail' | 'paper' | 'navy' }) {
  const bg = tone === 'navy' ? H.navy : tone === 'paper' ? H.paper : H.rail;
  const color = tone === 'navy' ? H.cobaltMuted : H.muted;
  return (
    <footer className={`border-t px-5 py-2 text-center ${className}`} style={{ background: bg, borderColor: tone === 'navy' ? 'rgba(255,255,255,.12)' : H.line }}>
      <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color }}>
        Synthetic Demo Data • Not Medical Advice
      </p>
    </footer>
  );
}

export function PatientFooter({ className = '', phase = 'login' }: { className?: string; phase?: 'login' | 'other' }) {
  if (phase === 'other') {
    return (
      <div className={`flex flex-col items-center gap-3 ${className}`}>
        <TextLink size={13.5} className="font-bold">
          Back to sign in
        </TextLink>
      </div>
    );
  }
  return (
    <div className={`flex flex-col items-center gap-3 ${className}`}>
      <TextLink size={13.5} className="font-bold">
        Create new account
      </TextLink>
      <div className="flex items-center gap-2.5">
        <TextLink tone="muted">Explore demo</TextLink>
        <span className="text-[13px] font-bold" style={{ color: H.muted }}>
          ·
        </span>
        <TextLink tone="muted">Provider login</TextLink>
      </div>
      <p className="text-center text-[12px] leading-5" style={{ color: H.subtle }}>
        Your health journey, supported by your care team.
      </p>
    </div>
  );
}

export function StaffFootnote({ className = '' }: { className?: string }) {
  return (
    <p className={`text-center text-[11px] leading-relaxed ${className}`} style={{ color: H.muted }}>
      Staff sign in with a one-time email code. Patients sign in with their cell phone in the THINNR mobile app.
    </p>
  );
}

export function PhoneStatusBar({ tone = 'dark' }: { tone?: 'dark' | 'light' }) {
  const color = tone === 'dark' ? H.navy : H.brandFg;
  return (
    <div className="flex h-11 items-end justify-between px-6 pb-1.5 text-[12px] font-semibold" style={{ color }} aria-hidden="true">
      <span>9:41</span>
      <span className="flex items-center gap-1.5">
        <span className="flex items-end gap-[2px]">
          <i className="h-[5px] w-[3px] rounded-[1px]" style={{ background: color }} />
          <i className="h-[7px] w-[3px] rounded-[1px]" style={{ background: color }} />
          <i className="h-[9px] w-[3px] rounded-[1px]" style={{ background: color }} />
          <i className="h-[11px] w-[3px] rounded-[1px]" style={{ background: color, opacity: 0.35 }} />
        </span>
        <span className="ml-1 flex h-[11px] w-[22px] items-center rounded-[3px] border p-[1.5px]" style={{ borderColor: color }}>
          <i className="h-full w-[78%] rounded-[1px]" style={{ background: color }} />
        </span>
      </span>
    </div>
  );
}
