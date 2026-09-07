import { useState, type FormEvent } from 'react';
import { ArrowRight, Building2, ChevronDown, Stethoscope } from 'lucide-react';
import './_group.css';

function Mark() {
  return <span className="pantry-mark" aria-label="THINNR">TH</span>;
}

export function PantryShelfWeb() {
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
    <main className="thinnr-login pantry-web">
      <style>{`
        .pantry-web{--line:var(--th-hairline);min-width:960px;min-height:800px;height:100vh;overflow:hidden;position:relative;background:var(--th-paper);color:var(--th-ink)}
        .pantry-web *{box-sizing:border-box}.pantry-web button,.pantry-web input{font-family:inherit}.pantry-web button{cursor:pointer}
        .pantry-wash{position:absolute;inset:88px 0 40px 52%;overflow:hidden;pointer-events:none}.pantry-wash:before{content:"";position:absolute;right:-160px;top:42px;width:720px;height:620px;border-radius:50%;background:var(--th-accent);opacity:.4}.pantry-wash img{position:absolute;right:-150px;top:3px;width:700px;height:700px;object-fit:cover;opacity:.2;filter:saturate(.9);transform:rotate(-3deg)}
        .pantry-head{height:88px;padding:0 58px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);position:relative;z-index:1}.pantry-brand{display:flex;align-items:center;gap:12px;font-size:14px;font-weight:650;color:var(--th-navy);letter-spacing:-.01em}.pantry-mark{display:grid;place-items:center;width:37px;height:37px;border-radius:8px;background:var(--th-navy);color:var(--th-brand-fg);font-family:var(--th-font-display);font-size:14px;font-weight:bold;letter-spacing:.04em;box-shadow:var(--th-shadow-soft)}.pantry-note{font-size:11px;color:var(--th-label);letter-spacing:.04em}
        .pantry-stage{height:calc(100% - 128px);position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;padding-top:53px}.pantry-copy{text-align:center;width:430px}.pantry-eyebrow{display:flex;justify-content:center;align-items:center;gap:10px;margin-bottom:16px}.pantry-eyebrow i{display:block;width:24px;height:1px;background:var(--th-warm)}.pantry-copy h1{font-family:var(--th-font-display);font-size:39px;line-height:1.08;letter-spacing:-.035em;color:var(--th-navy);margin:0}.pantry-copy>p{color:var(--th-body);font-size:13.5px;line-height:1.6;margin:12px auto 21px;max-width:390px}
        .pantry-card{width:430px;background:var(--th-card);border:1px solid var(--line);border-radius:var(--th-radius-card);padding:25px;box-shadow:var(--th-shadow-soft);text-align:left}.pantry-card label{display:block;font-size:12px;font-weight:700;color:var(--th-navy);margin-bottom:8px}.pantry-card input{width:100%;height:45px;border:1px solid var(--th-hairline);border-radius:var(--th-radius-control);padding:0 12px;background:var(--th-paper-alt);color:var(--th-ink);outline:none;font-size:14px}.pantry-card input:focus{border-color:var(--th-cobalt);box-shadow:0 0 0 3px var(--th-accent)}.pantry-card input::placeholder{color:var(--th-label)}.pantry-helper{font-size:11.5px;line-height:1.55;color:var(--th-label);margin:8px 0 18px}.pantry-primary{height:44px;width:100%;border:0;border-radius:var(--th-radius-control);background:var(--th-cobalt);color:#f8fafc;font-size:13px;font-weight:700;transition:transform .18s ease,background .18s ease}.pantry-primary:hover{background:var(--th-navy);transform:translateY(-1px)}
        .pantry-code-title{font-family:var(--th-font-display);font-size:23px;color:var(--th-navy);line-height:1.15;margin:0 0 7px}.pantry-code-copy{font-size:12px;line-height:1.55;color:var(--th-body);margin:0 0 17px}.pantry-code-input{letter-spacing:.42em;text-align:center;font-weight:700;font-size:17px}.pantry-actions{display:flex;gap:16px;margin-top:15px}.pantry-link{border:0;background:none;color:var(--th-cobalt);padding:0;font-size:11.5px;font-weight:700;text-decoration:underline;text-underline-offset:3px}.pantry-message{margin:14px 0 0;border-left:2px solid var(--th-warm);padding-left:9px;font-size:11px;color:var(--th-body);line-height:1.45}
        .pantry-demo{width:430px;text-align:left}.pantry-toggle{margin:17px 0 0;border:0;background:none;padding:0;color:var(--th-label);font-size:11.5px;font-weight:650;display:flex;align-items:center;gap:7px}.pantry-toggle:hover{color:var(--th-navy)}.pantry-options{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:11px}.pantry-option{border:1px solid var(--line);border-radius:7px;background:rgba(253,252,249,.83);padding:12px}.pantry-option svg{color:var(--th-cobalt);margin-bottom:8px}.pantry-option strong{display:block;font-size:12px;color:var(--th-navy)}.pantry-option p{font-size:10.5px;line-height:1.45;color:var(--th-label);margin:5px 0 9px}.pantry-option button{border:0;background:none;padding:0;color:var(--th-cobalt);font-weight:700;font-size:10.5px;display:flex;align-items:center;gap:4px}.pantry-staff-note{width:430px;font-size:11.5px;line-height:1.55;color:var(--th-label);margin:16px 0 0;text-align:left}.pantry-foot{height:40px;display:flex;align-items:center;justify-content:center;border-top:1px solid var(--line);font-size:9.5px;font-weight:700;letter-spacing:.13em;color:var(--th-label);text-transform:uppercase;position:relative;z-index:1}
      `}</style>
      <div className="pantry-wash" aria-hidden="true"><img src="/__mockup/images/login-pantry-shelf-plate.png" alt="" /></div>
      <header className="pantry-head"><div className="pantry-brand"><Mark /><span>THINNR Operations</span></div><span className="pantry-note">A considered desk for care teams</span></header>
      <section className="pantry-stage">
        <div className="pantry-copy"><div className="pantry-eyebrow"><i /><span className="th-kicker">Staff sign in</span></div><h1>Everything in its<br />right place.</h1><p>A quiet entrance for the people keeping every patient journey in good order.</p></div>
        <div className="pantry-card">
          {phase === 'email' ? <form onSubmit={submit}><label htmlFor="pantry-work-email">Work email</label><input id="pantry-work-email" type="email" autoComplete="email" placeholder="you@yourclinic.com" value={email} onChange={(event) => setEmail(event.target.value)} /><p className="pantry-helper">We'll email you a 6-digit sign-in code. No password needed.</p><button className="pantry-primary" type="submit">Email me a code</button></form> : <form onSubmit={submit}><h2 className="pantry-code-title">Enter the code we emailed</h2><p className="pantry-code-copy">If that address has an account, a 6-digit code is on its way.</p><label htmlFor="pantry-staff-code">6-digit sign-in code</label><input className="pantry-code-input" id="pantry-staff-code" inputMode="numeric" maxLength={6} autoComplete="one-time-code" placeholder="000000" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} /><button className="pantry-primary" style={{ marginTop: 18 }} type="submit">Verify and sign in</button><div className="pantry-actions"><button type="button" className="pantry-link" onClick={() => setMessage('A fresh code is on its way.')}>Send a fresh code</button><button type="button" className="pantry-link" onClick={() => { setPhase('email'); setMessage(''); }}>Use a different email</button></div></form>}
          {message && <p className="pantry-message" role="status">{message}</p>}
        </div>
        <div className="pantry-demo"><button className="pantry-toggle" onClick={() => setDemoOpen(!demoOpen)} aria-expanded={demoOpen}>Browse the guided demo without an account <ChevronDown size={14} style={{ transform: demoOpen ? 'rotate(180deg)' : undefined }} /></button>{demoOpen && <div className="pantry-options"><article className="pantry-option"><Building2 size={16} /><strong>THINNR HQ admin</strong><p>The umbrella above every office: rollups, provider accounts, and org tools.</p><button onClick={() => setMessage('The HQ admin demo is ready to enter.')}>Enter HQ admin <ArrowRight size={12} /></button></article><article className="pantry-option"><Stethoscope size={16} /><strong>Office staff</strong><p>Today's operations desk for the med spa team, exactly as it runs day to day.</p><button onClick={() => setMessage('The office demo is ready to enter.')}>Enter the office <ArrowRight size={12} /></button></article></div>}</div>
        <p className="pantry-staff-note">Staff sign in with a one-time email code. Patients sign in with their cell phone in the THINNR mobile app.</p>
      </section>
      <footer className="pantry-foot">Synthetic Demo Data • Not Medical Advice</footer>
    </main>
  );
}