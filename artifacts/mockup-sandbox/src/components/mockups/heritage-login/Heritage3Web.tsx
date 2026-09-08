import { ClipboardList, LayoutGrid, MessageCircle, Truck, Users } from 'lucide-react';
import { Card, DemoFooter, Field, H, IconTile, Kicker, Mark, PrimaryButton, SERIF, SerifWordmark, StaffFootnote, TextLink, WebPage } from './HeritageKit';

const landings = [
  [LayoutGrid, 'Overview', 'Today’s numbers and signals'],
  [Users, 'Roster', '128 active patients across 3 phases'],
  [Truck, 'Deliveries', '6 shipments waiting on review'],
  [ClipboardList, 'Check-ins', '41 logged since midnight'],
  [MessageCircle, 'Messages', '3 unread from patients'],
] as const;

/** 3 · Tinted Rail — the app's pale-cobalt sidebar becomes the sign-in's left rail. */
export function Heritage3Web() {
  return (
    <WebPage>
      <div className="grid flex-1 lg:grid-cols-[300px_1fr]">
        <aside className="hidden flex-col border-r border-[#d8e0e9] px-6 py-7 lg:flex" style={{ background: H.rail }}>
          <div className="flex items-center gap-3">
            <Mark size={40} />
            <div className="leading-tight">
              <SerifWordmark size={17} />
              <p className="text-[10px] font-bold uppercase tracking-[.14em]" style={{ color: H.muted }}>
                Operations
              </p>
            </div>
          </div>
          <div className="mt-10">
            <Kicker>Where you’ll land</Kicker>
            <ul className="mt-3 space-y-1.5">
              {landings.map(([Icon, title, detail], index) => (
                <li key={title} className={`flex items-center gap-3 rounded-[7px] px-2 py-2 ${index === 0 ? 'bg-[#fdfcf9]' : ''}`} style={index === 0 ? { boxShadow: '0 1px 2px rgba(32,59,100,.05)', border: `1px solid ${H.line}` } : undefined}>
                  <IconTile size={32} tone={index === 0 ? 'chip' : 'card'}>
                    <Icon size={15} />
                  </IconTile>
                  <div className="min-w-0">
                    <p className="text-[12.5px] font-semibold" style={{ color: H.navy }}>
                      {title}
                    </p>
                    <p className="truncate text-[11px]" style={{ color: H.muted }}>
                      {detail}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-auto rounded-[7px] border border-[#d8e0e9] bg-[#fdfcf9]/80 px-3 py-2.5">
            <p className="text-[10px] font-bold uppercase tracking-[.12em]" style={{ color: H.muted }}>
              Signed out
            </p>
            <p className="mt-0.5 text-[11.5px]" style={{ color: H.body }}>
              Willow &amp; Vale Med Spa · Build 2026.08
            </p>
          </div>
        </aside>

        <section className="flex flex-col">
          <div className="flex items-center justify-end px-8 py-5">
            <TextLink tone="muted">Need access? Ask your office admin</TextLink>
          </div>
          <main className="mx-auto flex w-full max-w-[460px] flex-1 flex-col justify-center px-6 pb-16">
            <Kicker>Staff sign-in</Kicker>
            <h1 className="mt-2 text-[36px] font-bold leading-tight tracking-[-.02em]" style={{ fontFamily: SERIF, color: H.navy }}>
              Good morning.
            </h1>
            <p className="mt-2 text-sm leading-relaxed" style={{ color: H.muted }}>
              Sign in with your work email — we’ll send a one-time code.
            </p>
            <Card accentTop className="mt-6">
              <div className="p-6">
                <Field label="Work email" type="email" inputMode="email" autoComplete="email" placeholder="you@yourclinic.com" hint="We’ll email you a 6-digit sign-in code. No password needed." />
                <PrimaryButton className="mt-4" arrow>
                  Email me a code
                </PrimaryButton>
              </div>
              <div className="flex items-center justify-between border-t border-[#e8e8e5] bg-[#f9faf8] px-6 py-3">
                <span className="text-[11px]" style={{ color: H.muted }}>
                  Exploring without an account?
                </span>
                <TextLink>Open the guided demo</TextLink>
              </div>
            </Card>
            <StaffFootnote className="mt-6" />
          </main>
        </section>
      </div>
      <DemoFooter />
    </WebPage>
  );
}
