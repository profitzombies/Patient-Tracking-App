import { useState, type FormEvent } from 'react';
import { ArrowRight, Building2, ChevronDown, Stethoscope } from 'lucide-react';
import './_group.css';

function Mark() {
  return <span className="bb-mark" aria-label="THINNR">TH</span>;
}

export function BotanicalBorderWeb() {
  const [phase, setPhase] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [demoOpen, setDemoOpen] = useState(false);
  const [message, setMessage] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (phase === 'email') {
      setMessage('If that address has an account, a sign-in code is on its way.');
      setPhase('code');
    } else setMessage('Thank you. Your code is being checked.');
  };

  return (
    <main className="thinnr-login botanical-border-web">
      <style>{`
        .botanical-border-web{min-width:960px;min-height:800px;height:100vh;overflow:hidden;position:relative;background:var(--th-paper);color:var(--th-ink)}
        .botanical-border-web *{box-sizing:border-box}.botanical-border-web button,.botanical-border-web input{font-family:inherit}.botanical-border-web button{cursor:pointer}
        .bb-border{position:absolute;inset:88px 0 40px;background-color:#faf9e9;background-image:url("/__mockup/images/login-botanical-border-plate.png");background-size:auto 150%;background-repeat:no-repeat;background-position:center 50%;opacity:.72;pointer-events:none}
        .bb-border:after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(242,243,244,.04),transparent 25% 75%,rgba(242,243,244,.04))}
        .bb-head{height:88px;padding:0 58px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--th-hairline);position:relative;z-index:1;background:rgba(242,243,244,.75)}
        .bb-brand{display:flex;align-items:center;gap:12px;font-size:14px;font-weight:650;color:var(--th-navy);letter-spacing:-.01em}.bb-mark{display:grid;place-items:center;width:37px;height:37px;border-radius:8px;background:var(--th-navy);color:var(--th-brand-fg);font-family:var(--th-font-display);font-size:14px;font-weight:bold;letter-spacing:.04em;box-shadow:var(--th-shadow-soft)}.bb-head-note{font-size:11px;color:var(--th-label);letter-spacing:.04em}
        .bb-stage{height:calc(100% - 128px);display:grid;place-items:center;position:relative;z-index:1;padding:18px 0}
        .bb-copy{width:430px;text-align:center}.bb-eyebrow{display:flex;justify-content:center;align-items:center;gap:10px;margin-bottom:17px}.bb-eyebrow i{display:block;width:24px;height:1px;background:var(--th-warm)}.bb-copy h1{font-family:var(--th-font-display);font-size:39px;line-height:1.08;letter-spacing:-.035em;color:var(--th-navy);margin:0}.bb-copy>p{color:var(--th-body);font-size:13.5px;line-height:1.6;margin:12px auto 25px;max-width:370px}
        .bb-card{background:var(--th-card);border:1px solid var(--th-hairline);border-radius:var(--th-radius-card);padding:25px;box-shadow:var(--th-shadow-soft);text-align:left}.bb-card label{display:block;font-size:12px;font-weight:700;color:var(--th-navy);margin-bottom:8px}.bb-card input{width:100%;height:45px;border:1px solid var(--th-hairline);border-radius:var(--th-radius-control);padding:0 12px;background:var(--th-paper-alt);color:var(--th-ink);outline:none;font-size:14px}.bb-card input:focus{border-color:var(--th-cobalt);box-shadow:0 0 0 3px var(--th-accent)}.bb-card input::placeholder{color:var(--th-label)}.bb-helper{font-size:11.5px;line-height:1.55;color:var(--th-label);margin:8px 0 18px}.bb-primary{height:44px;width:100%;border:0;border-radius:var(--th-radius-control);background:var(--th-cobalt);color:#f8fafc;font-size:13px;font-weight:700;transition:transform .18s ease,background .18s ease}.bb-primary:hover{background:var(--th-navy);transform:translateY(-1px)}.bb-code-title{font-family:var(--th-font-display);font-size:23px;color:var(--th-navy);line-height:1.15;margin:0 0 7px}.bb-code-copy{font-size:12px;line-height:1.55;color:var(--th-body);margin:0 0 17px}.bb-code-input{letter-spacing:.42em;text-align:center;font-weight:700;font-size:17px}.bb-under-actions{display:flex;gap:16px;margin-top:15px}.bb-text-link{border:0;background:none;color:var(--th-cobalt);padding:0;font-size:11.5px;font-weight:700;text-decoration:underline;text-underline-offset:3px}.bb-message{margin:14px 0 0;border-left:2px solid var(--th-warm);padding-left:9px;font-size:11px;color:var(--th-body);line-height:1.45}
        .bb-demo-toggle{margin:20px auto 0;border:0;background:none;padding:0;color:var(--th-label);font-size:11.5px;font-weight:650;display:flex;align-items:center;gap:7px}.bb-demo-toggle:hover{color:var(--th-navy)}.bb-demo-options{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:12px;text-align:left}.bb-demo-option{border:1px solid var(--th-hairline);border-radius:7px;background:rgba(253,252,249,.88);padding:12px}.bb-demo-option svg{color:var(--th-cobalt);margin-bottom:8px}.bb-demo-option strong{display:block;font-size:12px;color:var(--th-navy)}.bb-demo-option p{font-size:10.5px;line-height:1.45;color:var(--th-label);margin:5px 0 9px}.bb-demo-option button{border:0;background:none;padding:0;color:var(--th-cobalt);font-weight:700;font-size:10.5px;display:flex;align-items:center;gap:4px}.bb-note{font-size:11.5px;line-height:1.55;color:var(--th-label);margin:18px auto 0;max-width:380px}
        .bb-foot{height:40px;display:flex;align-items:center;justify-content:center;border-top:1px solid var(--th-hairline);font-size:9.5px;font-weight:700;letter-spacing:.13em;color:var(--th-label);text-transform:uppercase;position:relative;z-index:1;background:rgba(242,243,244,.75)}
      `}</style>
      <div className="bb-border" aria-hidden="true" />
      <header className="bb-head"><div className="bb-brand"><Mark /><span>THINNR Operations</span></div><span className="bb-head-note">A considered desk for care teams</span></header>
      <section className="bb-stage"><div className="bb-copy">
        <div className="bb-eyebrow"><i /><span className="th-kicker">Staff sign in</span></div>
        <h1>Find your place<br />in the garden.</h1><p>Start where the care team’s daily work is kept clear, considered, and in good order.</p>
        <div className="bb-card">{phase === 'email' ? <form onSubmit={submit}>
          <label htmlFor="bb-work-email">Work email</label><input id="bb-work-email" type="email" autoComplete="email" placeholder="you@yourclinic.com" value={email} onChange={(event) => setEmail(event.target.value)} />
          <p className="bb-helper">We'll email you a 6-digit sign-in code. No password needed.</p><button className="bb-primary" type="submit">Email me a code</button>
        </form> : <form onSubmit={submit}>
          <h2 className="bb-code-title">Enter the code we emailed</h2><p className="bb-code-copy">If that address has an account, a 6-digit code is on its way.</p><label htmlFor="bb-code">6-digit sign-in code</label><input className="bb-code-input" id="bb-code" inputMode="numeric" maxLength={6} autoComplete="one-time-code" placeholder="000000" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} />
          <button className="bb-primary" style={{ marginTop: 18 }} type="submit">Verify and sign in</button><div className="bb-under-actions"><button type="button" className="bb-text-link" onClick={() => setMessage('A fresh code is on its way.')}>Send a fresh code</button><button type="button" className="bb-text-link" onClick={() => { setPhase('email'); setMessage(''); }}>Use a different email</button></div>
        </form>}{message && <p className="bb-message" role="status">{message}</p>}</div>
        <button className="bb-demo-toggle" onClick={() => setDemoOpen(!demoOpen)} aria-expanded={demoOpen}>Browse the guided demo without an account <ChevronDown size={14} style={{ transform: demoOpen ? 'rotate(180deg)' : undefined }} /></button>
        {demoOpen && <div className="bb-demo-options"><article className="bb-demo-option"><Building2 size={16}/><strong>THINNR HQ admin</strong><p>The umbrella above every office: rollups, provider accounts, and org tools.</p><button onClick={() => setMessage('HQ admin demo selected.')}>Enter HQ admin <ArrowRight size={12}/></button></article><article className="bb-demo-option"><Stethoscope size={16}/><strong>Office staff</strong><p>Today's operations desk for the med spa team, exactly as it runs day to day.</p><button onClick={() => setMessage('Office demo selected.')}>Enter the office <ArrowRight size={12}/></button></article></div>}
        <p className="bb-note">Staff sign in with a one-time email code. Patients sign in with their cell phone in the THINNR mobile app.</p>
      </div></section>
      <footer className="bb-foot">Synthetic Demo Data • Not Medical Advice</footer>
    </main>
  );
}