/**
 * Simulated sign-in chooser — the front door of the operations demo.
 *
 * No accounts, passwords, or servers: picking a workspace just sets the
 * session persona. Office staff land on today's dashboard exactly as it
 * works standalone; THINNR HQ admins land on the umbrella overview. Route
 * gating in App.tsx keeps each persona inside its own area.
 */
import { useLocation } from 'wouter';
import { ArrowRight, Building2, Stethoscope } from 'lucide-react';
import { useSession, type Persona } from '@/contexts/session';

interface PersonaOption {
  persona: Persona;
  icon: React.ReactNode;
  title: string;
  description: string;
  bullets: string[];
  cta: string;
  testId: string;
}

const OPTIONS: PersonaOption[] = [
  {
    persona: 'hq-admin',
    icon: <Building2 size={20} />,
    title: 'THINNR HQ admin',
    description: 'The umbrella above every office: aggregate numbers, provider sub-accounts, and org tools.',
    bullets: [
      'Rollups across all provider accounts',
      'Drill into any office\u2019s dashboard',
      'Coach conversations, team, and settings',
    ],
    cta: 'Enter HQ admin',
    testId: 'button-signin-admin',
  },
  {
    persona: 'office',
    icon: <Stethoscope size={20} />,
    title: 'Office staff',
    description: 'Today\u2019s operations desk for the med spa team, exactly as it runs day to day.',
    bullets: [
      'Patient roster and check-ins',
      'Revenue, outcomes, and leaderboard',
      'Subscriptions and deliveries',
    ],
    cta: 'Enter the office',
    testId: 'button-signin-office',
  },
];

export default function SignIn() {
  const { signIn } = useSession();
  const [, navigate] = useLocation();

  const choose = (persona: Persona) => {
    signIn(persona);
    navigate(persona === 'hq-admin' ? '/admin' : '/', { replace: true });
  };

  return (
    <div className="flex min-h-[100dvh] flex-col bg-background font-sans text-foreground">
      <main className="mx-auto flex w-full max-w-[880px] flex-1 flex-col justify-center px-5 py-10">
        <header className="mb-8 text-center">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-md bg-navy text-brand-foreground shadow-soft">
            <span className="text-sm font-bold tracking-[.04em]">TH</span>
          </span>
          <h1 className="mt-4 font-serif text-[34px] font-bold leading-tight tracking-[-.02em] text-navy">
            THINNR Operations
          </h1>
          <p className="mx-auto mt-2 max-w-[52ch] text-sm leading-relaxed text-muted-foreground">
            Choose a workspace to explore. Sign-in is simulated for this demo — no real accounts, roles, or passwords.
          </p>
        </header>

        <div className="grid gap-4 md:grid-cols-2">
          {OPTIONS.map((option) => (
            <section
              key={option.persona}
              className="flex flex-col rounded-lg border border-card-border bg-card p-6 shadow-soft transition hover:-translate-y-0.5 hover:shadow-lifted"
            >
              <span className="grid h-10 w-10 place-items-center rounded-md bg-accent text-primary" aria-hidden="true">
                {option.icon}
              </span>
              <h2 className="mt-4 font-serif text-lg font-bold tracking-[-.01em] text-navy">{option.title}</h2>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{option.description}</p>
              <ul className="mt-4 space-y-2 border-t border-border pt-4 text-xs text-foreground">
                {option.bullets.map((bullet) => (
                  <li key={bullet} className="flex items-start gap-2">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                    {bullet}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                data-testid={option.testId}
                onClick={() => choose(option.persona)}
                className="mt-6 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-primary-border bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-xs transition hover:bg-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {option.cta}
                <ArrowRight size={15} aria-hidden="true" />
              </button>
            </section>
          ))}
        </div>

        <p className="mt-6 text-center text-[11px] text-muted-foreground">
          Office staff and patients never see the HQ area — it exists only behind this admin persona.
        </p>
      </main>

      <footer className="border-t border-border bg-sidebar px-5 py-2 text-center">
        <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          Synthetic Demo Data • Not Medical Advice
        </p>
      </footer>
    </div>
  );
}
