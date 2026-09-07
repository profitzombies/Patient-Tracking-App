import { useState, type FormEvent } from 'react';
import { ArrowRight, Building2, ChevronDown, Stethoscope } from 'lucide-react';
import './_group.css';

function Mark() {
  return <span className="mark" aria-label="THINNR">TH</span>;
}

export function IllustratedStoryWeb() {
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
    <main className="thinnr-login story-web">
      <style>{`
        .story-web{--line:var(--th-hairline);min-height:800px;height:100vh;min-width:960px;overflow:hidden;background:var(--th-paper);position:relative;color:var(--th-ink)}
        .story-web *{box-sizing:border-box}.story-web button,.story-web input{font-family:inherit}.story-web button{cursor:pointer}.story-web:before{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent 0 62%,rgba(227,236,247,.45) 62% 100%);pointer-events:none}
        .web-head{height:88px;padding:0 58px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);position:relative;z-index:1}
        .brand{display:flex;align-items:center;gap:12px;font-size:14px;font-weight:650;color:var(--th-navy);letter-spacing:-.01em}.mark{display:grid;place-items:center;width:37px;height:37px;border-radius:8px;background:var(--th-navy);color:var(--th-brand-fg);font-family:var(--th-font-display);font-size:14px;font-weight:bold;letter-spacing:.04em;box-shadow:var(--th-shadow-soft)}
        .head-note{font-size:11px;color:var(--th-label);letter-spacing:.04em}.web-layout{height:calc(100% - 128px);max-width:1090px;margin:0 auto;display:grid;grid-template-columns:430px 1fr;gap:132px;align-items:center;position:relative;z-index:1;padding:35px 0 18px}
        .form-eyebrow{display:flex;align-items:center;gap:10px;margin-bottom:17px}.form-eyebrow i{display:block;width:24px;height:1px;background:var(--th-warm)}.form-copy h1{font-family:var(--th-font-display);font-size:39px;line-height:1.08;letter-spacing:-.035em;color:var(--th-navy);margin:0}.form-copy>p{color:var(--th-body);font-size:13.5px;line-height:1.6;margin:12px 0 25px;max-width:370px}
        .signin-card{background:var(--th-card);border:1px solid var(--line);border-radius:var(--th-radius-card);padding:25px;box-shadow:var(--th-shadow-soft)}.signin-card label{display:block;font-size:12px;font-weight:700;color:var(--th-navy);margin-bottom:8px}.signin-card input{width:100%;height:45px;border:1px solid var(--th-hairline);border-radius:var(--th-radius-control);padding:0 12px;background:var(--th-paper-alt);color:var(--th-ink);outline:none;font-size:14px}.signin-card input:focus{border-color:var(--th-cobalt);box-shadow:0 0 0 3px var(--th-accent)}.signin-card input::placeholder{color:var(--th-label)}
        .helper{font-size:11.5px;line-height:1.55;color:var(--th-label);margin:8px 0 18px}.primary{height:44px;width:100%;border:0;border-radius:var(--th-radius-control);background:var(--th-cobalt);color:#f8fafc;font-size:13px;font-weight:700;transition:transform .18s ease,background .18s ease}.primary:hover{background:var(--th-navy);transform:translateY(-1px)}.code-title{font-family:var(--th-font-display);font-size:23px;color:var(--th-navy);line-height:1.15;margin:0 0 7px}.code-copy{font-size:12px;line-height:1.55;color:var(--th-body);margin:0 0 17px}.code-input{letter-spacing:.42em;text-align:center;font-weight:700;font-size:17px}.under-actions{display:flex;gap:16px;margin-top:15px}.text-link{border:0;background:none;color:var(--th-cobalt);padding:0;font-size:11.5px;font-weight:700;text-decoration:underline;text-underline-offset:3px}.message{margin:14px 0 0;border-left:2px solid var(--th-warm);padding-left:9px;font-size:11px;color:var(--th-body);line-height:1.45}
        .demo-toggle{margin:20px 0 0;border:0;background:none;padding:0;color:var(--th-label);font-size:11.5px;font-weight:650;display:flex;align-items:center;gap:7px}.demo-toggle:hover{color:var(--th-navy)}.demo-options{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:12px}.demo-option{border:1px solid var(--line);border-radius:7px;background:rgba(253,252,249,.7);padding:12px}.demo-option svg{color:var(--th-cobalt);margin-bottom:8px}.demo-option strong{display:block;font-size:12px;color:var(--th-navy)}.demo-option p{font-size:10.5px;line-height:1.45;color:var(--th-label);margin:5px 0 9px}.demo-option button{border:0;background:none;padding:0;color:var(--th-cobalt);font-weight:700;font-size:10.5px;display:flex;align-items:center;gap:4px}
        .plate{position:relative;align-self:center}.plate-frame{width:425px;background:var(--th-card);padding:13px;border:1px solid var(--th-hairline);border-radius:var(--th-radius-card);box-shadow:var(--th-shadow-soft);transform:rotate(1.2deg)}.plate-frame img{display:block;width:100%;height:404px;object-fit:cover;border-radius:5px;background:var(--th-accent)}.caption{font-family:var(--th-font-display);color:var(--th-navy);font-size:17px;line-height:1.3;margin:15px 7px 4px}.plate small{display:block;color:var(--th-label);font-size:10px;letter-spacing:.08em;text-transform:uppercase;margin:0 7px 2px}.orange-mark{position:absolute;width:12px;height:12px;border-radius:50%;background:var(--th-warm);right:-17px;top:65px}.web-foot{height:40px;display:flex;align-items:center;justify-content:center;border-top:1px solid var(--line);font-size:9.5px;font-weight:700;letter-spacing:.13em;color:var(--th-label);text-transform:uppercase;position:relative;z-index:1}
      `}</style>
      <header className="web-head"><div className="brand"><Mark /> <span>THINNR Operations</span></div><span className="head-note">A considered desk for care teams</span></header>
      <section className="web-layout">
        <div className="form-copy">
          <div className="form-eyebrow"><i /><span className="th-kicker">Staff sign in</span></div>
          <h1>Start at the<br />careful beginning.</h1>
          <p>A quiet entrance for the people keeping every patient journey in good order.</p>
          <div className="signin-card">
            {phase === 'email' ? <form onSubmit={submit}>
              <label htmlFor="work-email">Work email</label><input id="work-email" type="email" autoComplete="email" placeholder="you@yourclinic.com" value={email} onChange={(event) => setEmail(event.target.value)} />
              <p className="helper">We'll email you a 6-digit sign-in code. No password needed.</p><button className="primary" type="submit">Email me a code</button>
            </form> : <form onSubmit={submit}>
              <h2 className="code-title">Enter the code we emailed</h2><p className="code-copy">If that address has an account, a 6-digit code is on its way.</p>
              <label htmlFor="staff-code">6-digit sign-in code</label><input className="code-input" id="staff-code" inputMode="numeric" maxLength={6} autoComplete="one-time-code" placeholder="000000" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} />
              <button className="primary" style={{ marginTop: 18 }} type="submit">Verify and sign in</button><div className="under-actions"><button type="button" className="text-link" onClick={() => setMessage('A fresh code is on its way.')}>Send a fresh code</button><button type="button" className="text-link" onClick={() => { setPhase('email'); setMessage(''); }}>Use a different email</button></div>
            </form>}
            {message && <p className="message" role="status">{message}</p>}
          </div>
          <button className="demo-toggle" onClick={() => setDemoOpen(!demoOpen)} aria-expanded={demoOpen}>Browse the guided demo without an account <ChevronDown size={14} style={{ transform: demoOpen ? 'rotate(180deg)' : undefined }} /></button>
          {demoOpen && <div className="demo-options"><article className="demo-option"><Building2 size={16}/><strong>THINNR HQ admin</strong><p>The umbrella above every office: rollups, provider accounts, and org tools.</p><button>Enter HQ admin <ArrowRight size={12}/></button></article><article className="demo-option"><Stethoscope size={16}/><strong>Office staff</strong><p>Today's operations desk for the med spa team, exactly as it runs day to day.</p><button>Enter the office <ArrowRight size={12}/></button></article></div>}
          <p className="helper" style={{ marginTop: 18, marginBottom: 0 }}>Staff sign in with a one-time email code. Patients sign in with their cell phone in the THINNR mobile app.</p>
        </div>
        <aside className="plate"><span className="orange-mark" /><div className="plate-frame"><img src="/__mockup/images/login-illustrated-story-plate.png" alt="Illustration of a glass, notebook, leafy plate, walking shoe and calendar" /><p className="caption">Small objects, steady rituals, a path made yours.</p><small>Field notes for a supported journey</small></div></aside>
      </section>
      <footer className="web-foot">Synthetic Demo Data • Not Medical Advice</footer>
    </main>
  );
}