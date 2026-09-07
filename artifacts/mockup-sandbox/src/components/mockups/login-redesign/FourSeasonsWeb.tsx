import { useState, type FormEvent } from 'react';
import { ArrowRight, Building2, ChevronDown, Stethoscope } from 'lucide-react';
import './_group.css';
import './_thinnr-brand.css';

function Mark() {
  return <img className="th-logo" src="/__mockup/images/login-redesign-thinnr-logo.png" alt="THINNR" />;
}

function SeasonStrip() {
  const seasons = [
    ['Spring', '0% 0%'],
    ['Summer', '100% 0%'],
    ['Autumn', '0% 100%'],
    ['Winter', '100% 100%'],
  ];
  return <div className="fs-strip" aria-label="Four seasonal field note illustrations">{seasons.map(([season, position]) => <figure className="fs-season" key={season}><div className="fs-image" role="img" aria-label={`${season} seasonal still life`} style={{ backgroundPosition: position }} /><figcaption>{season}</figcaption></figure>)}</div>;
}

export function FourSeasonsWeb() {
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
  return <main className="thinnr-login thinnr-brand thinnr-brand-web fs-web">
    <style>{`
      .fs-web{min-width:960px;height:100vh;min-height:800px;overflow:hidden;background:var(--th-paper);color:var(--th-ink);position:relative}.fs-web *{box-sizing:border-box}.fs-web button,.fs-web input{font-family:inherit}.fs-web button{cursor:pointer}.fs-web:before{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent 0 67%,rgba(191,231,231,.5) 67% 100%);pointer-events:none}
      .fs-head{height:88px;padding:0 58px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--th-hairline);position:relative;z-index:1}.fs-brand{display:flex;align-items:center;gap:12px;font-size:14px;font-weight:650;color:var(--th-navy);letter-spacing:-.01em}.fs-mark{width:37px;height:37px;display:grid;place-items:center;border-radius:8px;background:var(--th-navy);color:var(--th-brand-fg);font-family:var(--th-font-display);font-size:14px;font-weight:bold;letter-spacing:.04em;box-shadow:var(--th-shadow-soft)}.fs-head-note{font-size:11px;color:var(--th-label);letter-spacing:.04em}
      .fs-layout{height:calc(100% - 128px);max-width:1080px;margin:0 auto;display:grid;grid-template-columns:650px 250px;gap:105px;align-items:center;padding:20px 0;position:relative;z-index:1}.fs-copy{align-self:center}.fs-eyebrow{display:flex;align-items:center;gap:10px;margin-bottom:14px}.fs-eyebrow i{display:block;width:24px;height:1px;background:var(--th-warm)}.fs-copy h1{font-family:var(--th-font-display);font-size:39px;line-height:1.08;letter-spacing:-.035em;color:var(--th-navy);margin:0}.fs-lede{color:var(--th-body);font-size:13.5px;line-height:1.6;margin:10px 0 16px;max-width:450px}
      .fs-strip{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:0 0 18px}.fs-season{margin:0;background:var(--th-card);border:1px solid var(--th-hairline);border-radius:9px;padding:8px 8px 6px;box-shadow:var(--th-shadow-soft)}.fs-image{height:91px;border-radius:5px;background-image:url('/__mockup/images/login-redesign-four-seasons.png');background-size:200% 200%;background-repeat:no-repeat;background-color:var(--th-accent)}.fs-season figcaption{font-size:9px;color:var(--th-label);letter-spacing:.12em;text-transform:uppercase;text-align:center;padding-top:6px;font-weight:700}
      .fs-card{width:430px;background:var(--th-card);border:1px solid var(--th-hairline);border-radius:9px;padding:20px 25px;box-shadow:var(--th-shadow-soft)}.fs-card label{display:block;font-size:12px;font-weight:700;color:var(--th-navy);margin-bottom:8px}.fs-card input{width:100%;height:45px;border:1px solid var(--th-hairline);border-radius:7px;padding:0 12px;background:var(--th-paper-alt);color:var(--th-ink);outline:none;font-size:14px}.fs-card input:focus{border-color:var(--th-cobalt);box-shadow:0 0 0 3px var(--th-accent)}.fs-card input::placeholder{color:var(--th-label)}.fs-helper{font-size:11.5px;line-height:1.55;color:var(--th-label);margin:8px 0 18px}.fs-primary{height:44px;width:100%;border:0;border-radius:7px;background:var(--th-aqua);color:var(--th-ink);font-size:13px;font-weight:700;transition:transform .18s ease,background .18s ease}.fs-primary:hover{background:var(--th-aqua-deep);transform:translateY(-1px)}.fs-code-title{font-family:var(--th-font-display);font-size:23px;color:var(--th-navy);line-height:1.15;margin:0 0 7px}.fs-code-copy{font-size:12px;line-height:1.55;color:var(--th-body);margin:0 0 17px}.fs-code-input{letter-spacing:.42em;text-align:center;font-weight:700;font-size:17px}.fs-under{display:flex;gap:16px;margin-top:15px}.fs-link{border:0;background:none;color:var(--th-cobalt);padding:0;font-size:11.5px;font-weight:700;text-decoration:underline;text-underline-offset:3px}.fs-message{margin:14px 0 0;border-left:2px solid var(--th-warm);padding-left:9px;font-size:11px;color:var(--th-body);line-height:1.45}
      .fs-demo-toggle{margin:15px 0 0;border:0;background:none;padding:0;color:var(--th-label);font-size:11.5px;font-weight:650;display:flex;align-items:center;gap:7px}.fs-demo-toggle:hover{color:var(--th-navy)}.fs-demos{display:grid;grid-template-columns:210px 210px;gap:9px;margin-top:10px}.fs-demo{border:1px solid var(--th-hairline);border-radius:7px;background:rgba(255,255,255,.7);padding:10px}.fs-demo svg{color:var(--th-cobalt);margin-bottom:5px}.fs-demo strong{display:block;font-size:12px;color:var(--th-navy)}.fs-demo p{font-size:10.5px;line-height:1.38;color:var(--th-label);margin:4px 0 7px}.fs-demo button{border:0;background:none;padding:0;color:var(--th-cobalt);font-weight:700;font-size:10.5px;display:flex;align-items:center;gap:4px}.fs-note{font-size:10.5px;line-height:1.45;color:var(--th-label);margin:13px 0 0;max-width:430px}
      .fs-aside{position:relative;align-self:center;padding-left:24px;border-left:1px solid var(--th-hairline)}.fs-aside:before{content:"";position:absolute;width:10px;height:10px;border-radius:50%;background:var(--th-warm);left:-6px;top:-19px}.fs-aside p{font-family:var(--th-font-display);font-size:25px;line-height:1.17;color:var(--th-navy);letter-spacing:-.025em;margin:0}.fs-aside small{display:block;margin-top:18px;font-size:10px;line-height:1.55;letter-spacing:.09em;text-transform:uppercase;color:var(--th-label)}.fs-foot{height:40px;display:flex;align-items:center;justify-content:center;border-top:1px solid var(--th-hairline);font-size:9.5px;font-weight:700;letter-spacing:.13em;color:var(--th-label);text-transform:uppercase;position:relative;z-index:1}
    `}</style>
    <header className="fs-head"><div className="fs-brand"><Mark /><span className="th-logo-sub">Operations</span></div><span className="fs-head-note">A considered desk for care teams</span></header>
    <section className="fs-layout">
      <div className="fs-copy"><div className="fs-eyebrow"><i /><span className="th-kicker">Staff sign in</span></div><h1>Care has a season.<br />So does the work.</h1><p className="fs-lede">Four quiet reminders that steady routines make room for change.</p><SeasonStrip />
        <div className="fs-card">{phase === 'email' ? <form onSubmit={submit}><label htmlFor="four-work-email">Work email</label><input id="four-work-email" type="email" autoComplete="email" placeholder="you@yourclinic.com" value={email} onChange={(event) => setEmail(event.target.value)} /><p className="fs-helper">We'll email you a 6-digit sign-in code. No password needed.</p><button className="fs-primary" type="submit">Email me a code</button></form> : <form onSubmit={submit}><h2 className="fs-code-title">Enter the code we emailed</h2><p className="fs-code-copy">If that address has an account, a 6-digit code is on its way.</p><label htmlFor="four-staff-code">6-digit sign-in code</label><input className="fs-code-input" id="four-staff-code" inputMode="numeric" maxLength={6} autoComplete="one-time-code" placeholder="000000" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} /><button className="fs-primary" style={{ marginTop: 18 }} type="submit">Verify and sign in</button><div className="fs-under"><button type="button" className="fs-link" onClick={() => setMessage('A fresh code is on its way.')}>Send a fresh code</button><button type="button" className="fs-link" onClick={() => { setPhase('email'); setMessage(''); }}>Use a different email</button></div></form>}{message && <p className="fs-message" role="status">{message}</p>}</div>
        <button className="fs-demo-toggle" onClick={() => setDemoOpen(!demoOpen)} aria-expanded={demoOpen}>Browse the guided demo without an account <ChevronDown size={14} style={{ transform: demoOpen ? 'rotate(180deg)' : undefined }} /></button>
        {demoOpen && <div className="fs-demos"><article className="fs-demo"><Building2 size={16} /><strong>THINNR HQ admin</strong><p>The umbrella above every office: rollups, provider accounts, and org tools.</p><button onClick={() => setMessage('Opening the HQ admin guided demo.')}>Enter HQ admin <ArrowRight size={12} /></button></article><article className="fs-demo"><Stethoscope size={16} /><strong>Office staff</strong><p>Today's operations desk for the med spa team, exactly as it runs day to day.</p><button onClick={() => setMessage('Opening the office guided demo.')}>Enter the office <ArrowRight size={12} /></button></article></div>}
        <p className="fs-note">Staff sign in with a one-time email code. Patients sign in with their cell phone in the THINNR mobile app.</p>
      </div>
      <aside className="fs-aside"><p>A small collection<br />for every point<br />in the year.</p><small>Four seasons<br />Field notes</small></aside>
    </section><footer className="fs-foot">Synthetic Demo Data • Not Medical Advice</footer>
  </main>;
}