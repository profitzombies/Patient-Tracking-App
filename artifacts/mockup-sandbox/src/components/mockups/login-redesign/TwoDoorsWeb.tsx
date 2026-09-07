import { useState, type FormEvent } from 'react';
import { ArrowRight, Building2, ChevronLeft, KeyRound, Mail, Stethoscope } from 'lucide-react';
import './_group.css';

type Door = 'hq' | 'office';
type Phase = 'email' | 'code';

const doors: Record<Door, { title: string; detail: string; action: string; icon: typeof Building2 }> = {
  hq: {
    title: 'THINNR HQ admin',
    detail: 'The umbrella above every office: rollups, provider accounts, and org tools.',
    action: 'Enter HQ admin',
    icon: Building2,
  },
  office: {
    title: 'Office staff',
    detail: 'Today’s operations desk for the med spa team, exactly as it runs day to day.',
    action: 'Enter the office',
    icon: Stethoscope,
  },
};

export function TwoDoorsWeb() {
  const [selected, setSelected] = useState<Door | null>(null);
  const [phase, setPhase] = useState<Phase>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState('');

  const submitEmail = (event: FormEvent) => {
    event.preventDefault();
    if (!email.trim()) {
      setNotice('Enter your work email to continue.');
      return;
    }
    setNotice('');
    setPhase('code');
  };

  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    setNotice(code.length === 6 ? 'Code accepted. Opening your desk…' : 'Enter the 6-digit code from your email.');
  };

  const chooseDoor = (door: Door) => {
    setSelected(door);
    setPhase('email');
    setNotice('');
  };

  const current = selected ? doors[selected] : null;

  return (
    <main className="thinnr-login td-web">
      <style>{`
        .td-web { width: 100%; min-height: 800px; height: 100vh; min-height: 100dvh; overflow: hidden; background: var(--th-paper); color: var(--th-ink); position: relative; }
        .td-web * { box-sizing: border-box; }
        .td-web button, .td-web input { font: inherit; }
        .td-web:before { content:""; position:absolute; inset:0; pointer-events:none; opacity:.34; background-image: radial-gradient(rgba(32,59,100,.14) .45px, transparent .6px); background-size:7px 7px; }
        .td-web-shell { position:relative; z-index:1; height:100%; min-height:800px; display:grid; grid-template-columns: 43.2% 56.8%; }
        .td-web-intro { padding:42px 54px 31px 66px; background:var(--th-paper-alt); border-right:1px solid var(--th-hairline); display:flex; flex-direction:column; }
        .td-brand { display:flex; align-items:center; gap:11px; color:var(--th-navy); font-size:14px; font-weight:650; letter-spacing:-.01em; }
        .td-mark { width:38px; height:38px; display:grid; place-items:center; flex:none; border-radius:8px; background:var(--th-navy); color:var(--th-brand-fg); box-shadow:var(--th-shadow-soft); font-family:var(--th-font-display); font-size:15px; font-weight:700; letter-spacing:.04em; }
        .td-web-intro h1 { font-family:var(--th-font-display); color:var(--th-navy); font-size:48px; line-height:.99; letter-spacing:-.045em; max-width:360px; margin:94px 0 17px; }
        .td-web-intro p { margin:0; max-width:330px; color:var(--th-body); font-size:14px; line-height:1.65; }
        .td-quiet-note { margin-top:auto !important; padding-top:42px; color:var(--th-label)!important; max-width:355px!important; font-size:11.5px!important; line-height:1.6!important; }
        .td-quiet-note:before { content:""; display:block; width:28px; height:2px; margin-bottom:13px; background:var(--th-warm); }
        .td-web-footer { margin-top:21px; color:var(--th-label); font-size:9.5px; font-weight:700; letter-spacing:.13em; text-transform:uppercase; }
        .td-web-stage { padding:54px 65px 39px 58px; display:flex; flex-direction:column; }
        .td-stage-top { display:flex; justify-content:space-between; align-items:center; min-height:38px; }
        .td-stage-top .th-kicker { color:var(--th-cobalt); }
        .td-stage-top span:last-child { color:var(--th-label); font-size:11px; }
        .td-doors { display:grid; grid-template-columns:1fr 1fr; gap:15px; margin-top:31px; }
        .td-door { min-height:286px; text-align:left; border:1px solid var(--th-hairline); border-radius:var(--th-radius-card); background:var(--th-card); padding:21px 20px 18px; cursor:pointer; color:var(--th-ink); box-shadow:none; transition:transform .2s ease, border-color .2s ease, box-shadow .2s ease; position:relative; overflow:hidden; }
        .td-door:hover { transform:translateY(-3px); border-color:var(--th-accent-border); box-shadow:var(--th-shadow-soft); }
        .td-door[data-selected="true"] { border:2px solid var(--th-cobalt); padding:20px 19px 17px; background:#fbfcfe; }
        .td-door:after { content:""; height:4px; width:35px; background:var(--th-warm); display:block; position:absolute; left:20px; bottom:0; transform:translateY(4px); transition:transform .2s ease; }
        .td-door[data-selected="true"]:after { transform:translateY(0); }
        .td-door-icon { width:39px; height:39px; display:grid; place-items:center; border-radius:7px; color:var(--th-cobalt); background:var(--th-accent); }
        .td-door h2 { font-family:var(--th-font-display); color:var(--th-navy); font-size:22px; letter-spacing:-.025em; margin:23px 0 8px; }
        .td-door p { color:var(--th-body); font-size:12.2px; line-height:1.55; margin:0; max-width:238px; }
        .td-door-handle { position:absolute; right:18px; bottom:17px; width:24px; height:24px; display:grid; place-items:center; border:1px solid var(--th-accent-border); border-radius:50%; color:var(--th-cobalt); }
        .td-door-demo { position:absolute; bottom:20px; left:20px; color:var(--th-cobalt); font-size:10.5px; font-weight:700; }
        .td-signin { align-self:center; width:min(100%, 500px); margin-top:24px; border:1px solid var(--th-hairline); border-radius:var(--th-radius-card); background:var(--th-card); padding:20px 22px 18px; box-shadow:var(--th-shadow-soft); animation:td-rise .28s ease both; }
        @keyframes td-rise { from { opacity:0; transform:translateY(7px) } to { opacity:1; transform:translateY(0) } }
        .td-signin-heading { display:flex; align-items:center; gap:9px; color:var(--th-navy); font-size:14px; font-weight:700; margin:0 0 16px; }
        .td-signin-heading svg { color:var(--th-cobalt); }
        .td-field-label { display:block; color:var(--th-navy); font-size:12px; font-weight:700; margin-bottom:7px; }
        .td-input { width:100%; height:42px; border:1px solid var(--th-hairline); border-radius:var(--th-radius-control); padding:0 12px; background:var(--th-paper-alt); color:var(--th-ink); outline:none; font-size:13px; }
        .td-input::placeholder { color:var(--th-label); }
        .td-input:focus { border-color:var(--th-cobalt); box-shadow:0 0 0 3px var(--th-accent); }
        .td-helper { color:var(--th-label); font-size:11px; line-height:1.5; margin:7px 0 14px; }
        .td-primary { width:100%; height:42px; border:0; border-radius:var(--th-radius-control); background:var(--th-cobalt); color:#fff; font-size:12.5px; font-weight:700; cursor:pointer; transition:transform .18s ease, background .18s ease; }
        .td-primary:hover { background:var(--th-navy); transform:translateY(-1px); }
        .td-subrow { display:flex; justify-content:space-between; align-items:center; margin-top:13px; }
        .td-text-button { padding:0; border:0; background:transparent; color:var(--th-cobalt); font-size:11px; font-weight:700; cursor:pointer; text-decoration:underline; text-underline-offset:3px; }
        .td-back { color:var(--th-label); display:inline-flex; align-items:center; gap:3px; }
        .td-notice { color:var(--th-warn); font-size:11px; margin:10px 0 0; }
        .td-demo-line { width:min(100%,500px); align-self:center; margin-top:17px; display:flex; justify-content:space-between; align-items:center; color:var(--th-label); font-size:10.5px; }
        .td-demo-link { border:0; padding:0; background:transparent; color:var(--th-cobalt); cursor:pointer; font-size:10.5px; font-weight:700; text-decoration:underline; text-underline-offset:3px; }
        .td-demo-cta { display:flex; align-items:center; gap:5px; }
        @media(max-width:850px) { .td-web { min-height:800px; overflow:auto; } .td-web-shell { grid-template-columns:1fr; min-height:800px; height:auto; } .td-web-intro { padding:28px 34px; border-right:0; border-bottom:1px solid var(--th-hairline); } .td-web-intro h1 { margin:35px 0 14px; font-size:42px; } .td-quiet-note { display:none; } .td-web-stage { padding:30px 34px; } }
      `}</style>
      <div className="td-web-shell">
        <aside className="td-web-intro">
          <div className="td-brand"><span className="td-mark">TH</span><span>THINNR Operations</span></div>
          <h1>Choose the door that knows your day.</h1>
          <p>A private entrance for the people who keep care moving — from the office floor to the whole organization.</p>
          <p className="td-quiet-note">Staff sign in with a one-time email code. Patients sign in with their cell phone in the THINNR mobile app.</p>
          <footer className="td-web-footer">Synthetic Demo Data • Not Medical Advice</footer>
        </aside>
        <section className="td-web-stage" aria-label="Staff sign in">
          <div className="td-stage-top"><span className="th-kicker">Staff entrance</span><span>{selected ? 'Your desk is one step away' : 'Select your workspace'}</span></div>
          <div className="td-doors">
            {(Object.keys(doors) as Door[]).map((door) => {
              const item = doors[door];
              const Icon = item.icon;
              return <button key={door} className="td-door" data-selected={selected === door} onClick={() => chooseDoor(door)} aria-pressed={selected === door}>
                <span className="td-door-icon"><Icon size={19} strokeWidth={1.7} /></span>
                <h2>{item.title}</h2><p>{item.detail}</p><span className="td-door-demo">Just looking · {item.action}</span><span className="td-door-handle"><ArrowRight size={13} /></span>
              </button>;
            })}
          </div>
          {selected && <section className="td-signin">
            {phase === 'email' ? <form onSubmit={submitEmail}>
              <p className="td-signin-heading"><Mail size={16} />Sign in to {current?.title}</p>
              <label className="td-field-label" htmlFor="two-doors-email">Work email</label>
              <input className="td-input" id="two-doors-email" type="email" placeholder="you@yourclinic.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              <p className="td-helper">We&apos;ll email you a 6-digit sign-in code. No password needed.</p>
              <button className="td-primary" type="submit">Email me a code</button>
            </form> : <form onSubmit={submitCode}>
              <p className="td-signin-heading"><KeyRound size={16} />Enter the code we emailed</p>
              <label className="td-field-label" htmlFor="two-doors-code">6-digit sign-in code</label>
              <input className="td-input" id="two-doors-code" inputMode="numeric" maxLength={6} placeholder="— — — — — —" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              <p className="td-helper">A code is on its way to {email || 'your work email'}.</p>
              <button className="td-primary" type="submit">Verify and sign in</button>
              <div className="td-subrow"><button type="button" className="td-text-button" onClick={() => setNotice('A fresh code is on its way.')}>Send a fresh code</button><button type="button" className="td-text-button td-back" onClick={() => setPhase('email')}><ChevronLeft size={13} />Use a different email</button></div>
            </form>}
            {notice && <p className="td-notice" role="status">{notice}</p>}
          </section>}
          <div className="td-demo-line"><span>Just looking?</span>{selected && <button className="td-demo-link td-demo-cta" onClick={() => setNotice(`${current?.action} demo opened.`)}>{current?.action}<ArrowRight size={12} /></button>} {!selected && <span>Choose a door to browse its guided demo.</span>}</div>
        </section>
      </div>
    </main>
  );
}