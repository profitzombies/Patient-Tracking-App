import { useState, type FormEvent } from 'react';
import { ArrowRight, Building2, ChevronDown, Stethoscope } from 'lucide-react';
import './_group.css';

type Phase = 'email' | 'code';

function Mark({ large = false }: { large?: boolean }) {
  return (
    <div
      aria-label="THINNR"
      style={{
        width: large ? 122 : 48,
        height: large ? 122 : 48,
        display: 'grid',
        placeItems: 'center',
        borderRadius: large ? 27 : 12,
        border: large ? '1px solid rgba(220,230,250,.25)' : '1px solid rgba(220,230,250,.2)',
        color: 'var(--th-brand-fg)',
        background: 'var(--th-navy)',
        fontFamily: 'var(--th-font-display)',
        fontWeight: 700,
        fontSize: large ? 37 : 16,
        letterSpacing: '.02em',
        boxShadow: large ? '0 18px 44px rgba(11,30,62,.18)' : 'none',
      }}
    >
      TH
    </div>
  );
}

export function CobaltFieldWeb() {
  const [phase, setPhase] = useState<Phase>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [showDemo, setShowDemo] = useState(false);
  const [message, setMessage] = useState('');

  const sendCode = (event: FormEvent) => {
    event.preventDefault();
    setMessage(email.includes('@') ? 'A sign-in code is on its way if this email belongs to your organization.' : 'Enter your work email address.');
    if (email.includes('@')) setPhase('code');
  };

  const paper = {
    background: 'var(--th-card)',
    border: '1px solid rgba(208,218,228,.9)',
    boxShadow: '0 22px 60px rgba(11,30,62,.26), var(--th-shadow-soft)',
  };

  return (
    <main
      className="thinnr-login"
      style={{
        width: '100%',
        minHeight: 800,
        overflow: 'hidden',
        position: 'relative',
        background: 'linear-gradient(125deg, var(--th-navy) 0%, #254b88 54%, var(--th-cobalt) 100%)',
      }}
    >
      <style>{`
        .cobalt-web * { box-sizing: border-box; }
        .cobalt-web:before { content:""; position:absolute; inset:0; opacity:.22; pointer-events:none;
          background-image: linear-gradient(rgba(220,230,250,.18) 1px, transparent 1px), linear-gradient(90deg, rgba(220,230,250,.18) 1px, transparent 1px);
          background-size: 44px 44px; mask-image: linear-gradient(115deg, transparent 5%, black 42%, transparent 88%); }
        .cobalt-web input { font: 500 14px var(--th-font-body); color:var(--th-ink); outline:none; }
        .cobalt-web input:focus { border-color:var(--th-cobalt)!important; box-shadow:0 0 0 3px rgba(49,94,174,.18); }
        .cobalt-web button { font-family:var(--th-font-body); cursor:pointer; }
        .cobalt-web button:focus-visible { outline:3px solid var(--th-cobalt-light); outline-offset:3px; }
        .cobalt-web .demo-card:hover { transform:translateY(-2px); border-color:var(--th-accent-border)!important; }
      `}</style>
      <div className="cobalt-web" style={{ position: 'relative', minHeight: 800, display: 'grid', gridTemplateColumns: 'minmax(360px, .88fr) minmax(590px, 1.12fr)' }}>
        <section style={{ padding: '64px 52px 42px 76px', color: 'var(--th-brand-fg)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div>
            <Mark large />
            <div className="th-kicker" style={{ color: '#b9c9e7', marginTop: 38 }}>THE OPERATIONS DESK</div>
            <h1 style={{ margin: '10px 0 0', maxWidth: 330, font: '700 51px/1.02 var(--th-font-display)', letterSpacing: '-.045em', color: '#f1f4fb' }}>
              The day, held in hand.
            </h1>
            <p style={{ margin: '21px 0 0', maxWidth: 330, fontSize: 14, lineHeight: 1.75, color: '#d4def0' }}>
              A considered working desk for the teams supporting every THINNR patient.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 13, fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: '#bac9e4' }}>
            <span style={{ width: 25, height: 1, background: 'var(--th-warm)' }} />
            THINNR / EST. 2024
          </div>
        </section>

        <section style={{ padding: '48px 74px 42px 38px', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <div style={{ width: 'min(100%, 560px)' }}>
            <div style={{ ...paper, borderRadius: 'var(--th-radius-card)', padding: '38px 42px 32px' }}>
              <header style={{ display: 'flex', alignItems: 'center', gap: 13, marginBottom: 33 }}>
                <Mark />
                <div>
                  <div style={{ fontSize: 21, fontWeight: 700, color: 'var(--th-navy)', letterSpacing: '-.03em' }}>THINNR Operations</div>
                  <div className="th-kicker" style={{ marginTop: 4, fontSize: 9 }}>Staff sign in</div>
                </div>
              </header>
              {phase === 'email' ? (
                <form onSubmit={sendCode}>
                  <label htmlFor="cobalt-work-email" style={{ display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--th-navy)', marginBottom: 8 }}>Work email</label>
                  <input id="cobalt-work-email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@yourclinic.com" style={{ width: '100%', height: 46, borderRadius: 'var(--th-radius-control)', border: '1px solid var(--th-hairline)', padding: '0 13px', background: 'var(--th-paper-alt)' }} />
                  <p style={{ color: 'var(--th-body)', fontSize: 12, lineHeight: 1.55, margin: '9px 0 20px' }}>We&apos;ll email you a 6-digit sign-in code. No password needed.</p>
                  <button type="submit" style={{ width: '100%', height: 46, border: 0, borderRadius: 'var(--th-radius-control)', background: 'var(--th-cobalt)', color: 'var(--th-card)', fontWeight: 700, fontSize: 13, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}>Email me a code <ArrowRight size={15} aria-hidden="true" /></button>
                  {message && <p aria-live="polite" style={{ margin: '13px 0 0', color: 'var(--th-body)', fontSize: 11.5, lineHeight: 1.5 }}>{message}</p>}
                </form>
              ) : (
                <form onSubmit={(event) => { event.preventDefault(); setMessage(code.length === 6 ? 'Code received. Signing you in…' : 'Enter the 6-digit code from your email.'); }}>
                  <h2 className="th-display" style={{ fontSize: 27, margin: 0 }}>Enter the code we emailed</h2>
                  <p style={{ color: 'var(--th-body)', fontSize: 12, lineHeight: 1.55, margin: '8px 0 19px' }}>If that address has an account, a 6-digit code is on its way.</p>
                  <label htmlFor="cobalt-code" className="th-kicker" style={{ display: 'block', marginBottom: 8 }}>6-digit sign-in code</label>
                  <input id="cobalt-code" inputMode="numeric" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} style={{ width: '100%', height: 48, textAlign: 'center', letterSpacing: '.48em', fontSize: 19, borderRadius: 'var(--th-radius-control)', border: '1px solid var(--th-hairline)', background: 'var(--th-paper-alt)' }} />
                  <button type="submit" style={{ marginTop: 18, width: '100%', height: 46, border: 0, borderRadius: 'var(--th-radius-control)', background: 'var(--th-cobalt)', color: 'var(--th-card)', fontWeight: 700, fontSize: 13 }}>Verify and sign in</button>
                  <div style={{ display: 'flex', justifyContent: 'center', gap: 22, marginTop: 15 }}>
                    <button type="button" onClick={() => setMessage('A fresh code is on its way if this email belongs to your organization.')} style={{ border: 0, background: 'none', color: 'var(--th-cobalt)', fontSize: 11.5, fontWeight: 700 }}>Send a fresh code</button>
                    <button type="button" onClick={() => { setPhase('email'); setMessage(''); }} style={{ border: 0, background: 'none', color: 'var(--th-body)', fontSize: 11.5, fontWeight: 700 }}>Use a different email</button>
                  </div>
                  {message && <p aria-live="polite" style={{ margin: '12px 0 0', textAlign: 'center', color: 'var(--th-body)', fontSize: 11.5 }}>{message}</p>}
                </form>
              )}
            </div>
            <button type="button" onClick={() => setShowDemo((open) => !open)} aria-expanded={showDemo} style={{ margin: '19px 0 0', width: '100%', border: 0, background: 'transparent', color: '#dbe5f6', fontSize: 12, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
              Browse the guided demo without an account <ChevronDown size={14} aria-hidden="true" style={{ transform: showDemo ? 'rotate(180deg)' : undefined }} />
            </button>
            {showDemo && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 11, marginTop: 13 }}>
              {[
                [Building2, 'THINNR HQ admin', 'The umbrella above every office: rollups, provider accounts, and org tools.', 'Enter HQ admin'],
                [Stethoscope, 'Office staff', 'Today’s operations desk for the med spa team, exactly as it runs day to day.', 'Enter the office'],
              ].map(([Icon, title, description, action]) => {
                const DemoIcon = Icon as typeof Building2;
                return <div className="demo-card" key={title as string} style={{ ...paper, transition: 'transform .2s ease', borderRadius: 'var(--th-radius-card)', padding: '16px 15px' }}>
                  <DemoIcon size={17} color="var(--th-cobalt)" />
                  <div style={{ marginTop: 8, fontSize: 13, fontWeight: 750, color: 'var(--th-navy)' }}>{title as string}</div>
                  <p style={{ fontSize: 10.5, lineHeight: 1.5, color: 'var(--th-body)', margin: '6px 0 13px' }}>{description as string}</p>
                  <button type="button" onClick={() => setMessage(`${action} demo selected.`)} style={{ border: 0, padding: 0, background: 'none', color: 'var(--th-cobalt)', fontWeight: 800, fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 4 }}>{action as string} <ArrowRight size={12} aria-hidden="true" /></button>
                </div>;
              })}
            </div>}
            <p style={{ margin: '20px auto 0', maxWidth: 460, textAlign: 'center', color: '#cdd9ee', fontSize: 10.5, lineHeight: 1.5 }}>Staff sign in with a one-time email code. Patients sign in with their cell phone in the THINNR mobile app.</p>
          </div>
        </section>
      </div>
      <footer style={{ position: 'absolute', left: 0, bottom: 0, width: '100%', padding: '12px 28px', borderTop: '1px solid rgba(220,230,250,.13)', color: '#b8c7e1', fontSize: 9.5, fontWeight: 700, letterSpacing: '.13em', textTransform: 'uppercase' }}>Synthetic Demo Data • Not Medical Advice</footer>
    </main>
  );
}