import { useState, type FormEvent } from 'react';
import { ArrowRight, Building2, ChevronDown, Mail, Stethoscope } from 'lucide-react';
import './_group.css';

type Phase = 'email' | 'code';

export function GlassAtriumWeb() {
  const [phase, setPhase] = useState<Phase>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [showDemo, setShowDemo] = useState(false);
  const [message, setMessage] = useState('');
  const submitEmail = (event: FormEvent) => {
    event.preventDefault();
    setMessage('');
    if (!email.includes('@')) { setMessage('Enter your work email address.'); return; }
    setPhase('code');
  };
  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    setMessage(code.length === 6 ? 'Demo sign-in confirmed.' : 'Enter the 6-digit code from the email.');
  };
  const demoCards = [
    { icon: <Building2 size={16} />, title: 'THINNR HQ admin', copy: 'The umbrella above every office: rollups, provider accounts, and org tools.', cta: 'Enter HQ admin' },
    { icon: <Stethoscope size={16} />, title: 'Office staff', copy: 'Today’s operations desk for the med spa team, exactly as it runs day to day.', cta: 'Enter the office' },
  ];
  return (
    <main className="thinnr-login" style={{ width: '100%', minHeight: '100vh', overflow: 'hidden', position: 'relative', background: 'var(--th-paper)' }}>
      <style>{`
        .ga-web-bg{position:absolute;inset:0;background-image:linear-gradient(90deg,rgba(28,51,84,.1),rgba(255,255,255,0) 46%),url('/__mockup/images/login-glass-atrium-interior.png');background-size:cover;background-position:center}
        .ga-web-vignette{position:absolute;inset:0;background:linear-gradient(90deg,rgba(244,243,240,.64) 0%,rgba(244,243,240,.13) 56%,rgba(32,59,100,.10) 100%)}
        .ga-web-panel{position:relative;margin:68px 0 0 12.5%;width:440px;min-height:612px;padding:34px 36px 25px;background:rgba(253,252,249,.79);border:1px solid rgba(255,255,255,.83);border-radius:var(--th-radius-card);box-shadow:0 20px 55px rgba(32,59,100,.16),var(--th-shadow-soft);backdrop-filter:blur(17px);-webkit-backdrop-filter:blur(17px)}
        .ga-mark{display:grid;place-items:center;width:39px;height:39px;border-radius:9px;background:var(--th-navy);color:var(--th-brand-fg);font-family:var(--th-font-display);font-size:14px;font-weight:700;letter-spacing:.07em}
        .ga-web-product{font-size:13px;font-weight:650;color:var(--th-navy);letter-spacing:.01em}
        .ga-input{width:100%;box-sizing:border-box;height:45px;margin-top:8px;padding:0 13px;border:1px solid var(--th-hairline);border-radius:var(--th-radius-control);background:rgba(253,252,249,.86);color:var(--th-ink);font:14px var(--th-font-body);outline:none}
        .ga-input:focus{border-color:var(--th-cobalt);box-shadow:0 0 0 3px rgba(49,94,174,.2)}
        .ga-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;width:100%;height:46px;border:0;border-radius:var(--th-radius-control);background:var(--th-cobalt);color:var(--th-card);font:650 14px var(--th-font-body);cursor:pointer;transition:transform .18s ease,background .18s ease}
        .ga-button:hover{background:var(--th-navy);transform:translateY(-1px)} .ga-text-link{border:0;background:none;padding:0;color:var(--th-cobalt);font:650 12px var(--th-font-body);cursor:pointer}.ga-text-link:hover{text-decoration:underline}
        .ga-demo-card{flex:1;min-height:130px;padding:13px;border:1px solid rgba(183,203,232,.85);border-radius:7px;background:rgba(249,250,248,.56)} .ga-demo-card button{margin-top:10px}
        @media(max-width:700px){.ga-web-panel{margin:28px auto;width:calc(100% - 42px);padding:28px 23px}.ga-web-bg{background-position:62% center}}
      `}</style>
      <div className="ga-web-bg" aria-hidden="true" />
      <div className="ga-web-vignette" aria-hidden="true" />
      <section className="ga-web-panel" aria-label="THINNR Operations sign in">
        <header style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 35 }}>
          <div className="ga-mark">TH</div><span className="ga-web-product">THINNR Operations</span>
        </header>
        {phase === 'email' ? (
          <form onSubmit={submitEmail} noValidate>
            <p className="th-kicker" style={{ margin: 0 }}>Operations access</p>
            <h1 className="th-display" style={{ margin: '8px 0 9px', fontSize: 35, lineHeight: 1.07 }}>A calm start<br />to the day.</h1>
            <p style={{ margin: '0 0 25px', fontSize: 13, color: 'var(--th-body)', lineHeight: 1.55 }}>Your office desk is ready when you are.</p>
            <label htmlFor="ga-work-email" style={{ display: 'block', fontSize: 12, fontWeight: 650, color: 'var(--th-navy)' }}>Work email</label>
            <input id="ga-work-email" className="ga-input" type="email" autoComplete="email" placeholder="you@yourclinic.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <p style={{ margin: '8px 0 18px', fontSize: 11.5, lineHeight: 1.45, color: 'var(--th-body)' }}>We&apos;ll email you a 6-digit sign-in code. No password needed.</p>
            {message && <p role="alert" style={{ margin: '0 0 14px', color: 'var(--th-warn)', fontSize: 12 }}>{message}</p>}
            <button className="ga-button" type="submit">Email me a code <Mail size={14} aria-hidden="true" /></button>
          </form>
        ) : (
          <form onSubmit={submitCode}>
            <p className="th-kicker" style={{ margin: 0 }}>One more detail</p>
            <h1 className="th-display" style={{ margin: '8px 0 11px', fontSize: 30, lineHeight: 1.1 }}>Enter the code<br />we emailed</h1>
            <p style={{ margin: '0 0 23px', color: 'var(--th-body)', fontSize: 12.5, lineHeight: 1.5 }}>If that address has an account, a 6-digit code is on its way.</p>
            <label htmlFor="ga-code" style={{ display: 'block', fontSize: 12, fontWeight: 650, color: 'var(--th-navy)' }}>6-digit sign-in code</label>
            <input id="ga-code" className="ga-input" inputMode="numeric" maxLength={6} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} style={{ fontSize: 20, letterSpacing: '.36em', textAlign: 'center' }} />
            {message && <p role="alert" style={{ color: 'var(--th-warn)', fontSize: 12 }}>{message}</p>}
            <button className="ga-button" type="submit" style={{ marginTop: 19 }}>Verify and sign in</button>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 17 }}><button className="ga-text-link" type="button" onClick={() => setCode('')}>Send a fresh code</button><button className="ga-text-link" type="button" onClick={() => { setPhase('email'); setMessage(''); }}>Use a different email</button></div>
          </form>
        )}
        <div style={{ marginTop: 24, borderTop: '1px solid rgba(216,224,233,.8)', paddingTop: 18 }}>
          <button type="button" onClick={() => setShowDemo(!showDemo)} aria-expanded={showDemo} style={{ border: 0, background: 'none', padding: 0, color: 'var(--th-body)', font: '650 11.5px var(--th-font-body)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 7 }}>Browse the guided demo without an account <ChevronDown size={14} style={{ transform: showDemo ? 'rotate(180deg)' : undefined, transition: 'transform .2s' }} /></button>
          {showDemo && <div style={{ display: 'flex', gap: 9, marginTop: 13 }}>{demoCards.map((card) => <article className="ga-demo-card" key={card.title}><div style={{ color: 'var(--th-cobalt)' }}>{card.icon}</div><h2 className="th-display" style={{ fontSize: 15, margin: '7px 0 5px' }}>{card.title}</h2><p style={{ color: 'var(--th-body)', fontSize: 10.5, lineHeight: 1.35, margin: 0 }}>{card.copy}</p><button className="ga-text-link" type="button" onClick={() => setMessage(`${card.cta} selected.`)}>{card.cta} <ArrowRight size={12} style={{ verticalAlign: -2 }} /></button></article>)}</div>}
        </div>
        <p style={{ margin: '19px 0 0', fontSize: 10.5, lineHeight: 1.4, color: 'var(--th-label)' }}>Staff sign in with a one-time email code. Patients sign in with their cell phone in the THINNR mobile app.</p>
      </section>
      <footer style={{ position: 'absolute', bottom: 18, right: 28, color: 'rgba(32,59,100,.66)', fontSize: 9.5, fontWeight: 700, letterSpacing: '.13em', textTransform: 'uppercase' }}>Synthetic Demo Data • Not Medical Advice</footer>
    </main>
  );
}