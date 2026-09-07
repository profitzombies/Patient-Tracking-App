import { FormEvent, useState } from 'react';
import { ArrowRight, Building2, ChevronDown, Stethoscope } from 'lucide-react';
import './_group.css';

type Stage = 'email' | 'code';

function Mark() {
  return <span className="ledger-mark" aria-label="THINNR">TH</span>;
}

export function LedgerSheetWeb() {
  const [stage, setStage] = useState<Stage>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [demoOpen, setDemoOpen] = useState(false);
  const submitEmail = (event: FormEvent) => { event.preventDefault(); setStage('code'); };
  const submitCode = (event: FormEvent) => { event.preventDefault(); };

  return (
    <main className="thinnr-login ledger-web">
      <style>{`
        .ledger-web { --line: rgba(49,94,174,.14); min-height:800px; height:100vh; overflow:hidden; background:var(--th-paper); position:relative; display:grid; grid-template-columns:minmax(250px,1fr) 576px minmax(250px,1fr); color:var(--th-ink); }
        .ledger-web:before { content:""; position:absolute; inset:0; pointer-events:none; background:repeating-linear-gradient(to bottom, transparent 0, transparent 31px, var(--line) 32px); opacity:.7; }
        .ledger-web:after { content:""; position:absolute; left:calc(50% - 288px + 76px); top:0; bottom:0; width:1px; background:rgba(223,119,44,.34); pointer-events:none; }
        .ledger-web * { box-sizing:border-box; } .ledger-web button,.ledger-web input { font:inherit; }
        .ledger-web .edge-note { position:relative; z-index:1; align-self:end; margin:0 0 42px 42px; max-width:180px; font-size:11px; line-height:1.65; color:var(--th-label); }
        .ledger-web .edge-note strong { color:var(--th-navy); font-weight:650; }
        .ledger-web .page { position:relative; z-index:2; background:var(--th-card); border-inline:1px solid var(--th-hairline); box-shadow:var(--th-shadow-soft); padding:54px 58px 20px 76px; display:flex; flex-direction:column; min-height:800px; }
        .ledger-web .index-tab { position:absolute; right:-1px; top:124px; transform:translateX(100%); background:var(--th-cobalt); color:var(--th-brand-fg); font-size:9px; letter-spacing:.16em; font-weight:700; writing-mode:vertical-rl; padding:13px 7px; border-radius:0 6px 6px 0; }
        .ledger-web .folio { position:absolute; top:22px; right:28px; font-size:10px; color:var(--th-label); letter-spacing:.12em; }
        .ledger-web .brand-row { display:flex; align-items:center; gap:12px; padding-bottom:26px; border-bottom:1px solid var(--th-hairline); }
        .ledger-mark { width:42px; height:42px; display:grid; place-items:center; flex:none; background:var(--th-navy); color:var(--th-brand-fg); border-radius:9px; font-family:var(--th-font-display); font-weight:700; font-size:16px; letter-spacing:-.04em; box-shadow:0 2px 0 rgba(32,59,100,.12); }
        .ledger-web .product { font-weight:650; font-size:15px; letter-spacing:.01em; color:var(--th-navy); }
        .ledger-web .record { margin-top:50px; }
        .ledger-web .record-top { display:flex; align-items:end; justify-content:space-between; border-bottom:2px solid var(--th-navy); padding-bottom:9px; }
        .ledger-web .record-top .th-kicker { margin:0 0 4px; } .ledger-web .folio-small { color:var(--th-label); font-size:10px; letter-spacing:.1em; }
        .ledger-web h1 { margin:10px 0 0; font-size:42px; line-height:1.04; font-weight:700; }
        .ledger-web .intro { max-width:42ch; font-size:13px; line-height:1.65; margin:13px 0 25px; color:var(--th-body); }
        .ledger-web form { position:relative; }
        .ledger-web label { display:block; font-size:10px; font-weight:750; letter-spacing:.14em; text-transform:uppercase; color:var(--th-label); margin-bottom:7px; }
        .ledger-web .rule-input { width:100%; border:0; border-bottom:1.5px solid var(--th-cobalt-muted); outline:0; border-radius:0; background:transparent; padding:7px 0 10px; color:var(--th-navy); font-size:17px; letter-spacing:-.01em; transition:border-color .2s, box-shadow .2s; }
        .ledger-web .rule-input::placeholder { color:#94a2b2; } .ledger-web .rule-input:focus { border-color:var(--th-cobalt); box-shadow:0 3px 0 -1px var(--th-cobalt); }
        .ledger-web .helper { color:var(--th-label); font-size:11px; line-height:1.55; margin:8px 0 18px; }
        .ledger-web .primary { min-height:42px; border:1px solid var(--th-cobalt); border-radius:var(--th-radius-control); background:var(--th-cobalt); padding:0 16px; color:var(--th-card); font-size:13px; font-weight:700; cursor:pointer; transition:transform .18s, background .18s; }
        .ledger-web .primary:hover { background:var(--th-navy); transform:translateY(-1px); } .ledger-web .primary:focus-visible,.ledger-web .text-button:focus-visible,.ledger-web .demo-card button:focus-visible { outline:2px solid var(--th-cobalt); outline-offset:3px; }
        .ledger-web .code-note { font-size:12px; line-height:1.55; color:var(--th-body); margin:0 0 20px; } .ledger-web .code-note b { color:var(--th-navy); }
        .ledger-web .code { font-family:ui-monospace,SFMono-Regular,monospace; font-size:22px; text-align:center; letter-spacing:.4em; }
        .ledger-web .link-row { display:flex; gap:18px; margin-top:16px; } .ledger-web .text-button { border:0; padding:0; background:transparent; color:var(--th-cobalt); font-size:12px; font-weight:650; cursor:pointer; text-decoration:underline; text-underline-offset:3px; }
        .ledger-web .demo-toggle { margin-top:32px; border:0; border-top:1px solid var(--th-hairline); background:transparent; width:100%; padding:16px 0 0; display:flex; align-items:center; justify-content:space-between; color:var(--th-body); font-size:12px; text-align:left; cursor:pointer; }
        .ledger-web .demo-toggle span { display:flex; align-items:center; gap:7px; } .ledger-web .demo-toggle svg { transition:transform .2s; } .ledger-web .demo-toggle.open svg { transform:rotate(180deg); }
        .ledger-web .demo-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:12px; }
        .ledger-web .demo-card { border:1px solid var(--th-hairline); border-radius:var(--th-radius-card); background:var(--th-paper-alt); padding:13px; min-height:125px; display:flex; flex-direction:column; }
        .ledger-web .demo-head { display:flex; align-items:center; gap:8px; color:var(--th-navy); font-size:12px; font-weight:750; } .ledger-web .demo-head svg { color:var(--th-cobalt); }
        .ledger-web .demo-card p { margin:8px 0; color:var(--th-body); font-size:10.5px; line-height:1.45; } .ledger-web .demo-card button { display:inline-flex; align-items:center; gap:4px; padding:0; margin-top:auto; border:0; background:none; color:var(--th-cobalt); text-align:left; font-size:11px; font-weight:750; cursor:pointer; }
        .ledger-web .bottom { margin-top:auto; padding-top:24px; border-top:1px solid var(--th-hairline); color:var(--th-label); font-size:10.5px; line-height:1.5; }
        .ledger-web footer { position:absolute; z-index:3; bottom:18px; left:24px; right:24px; text-align:center; font-size:9px; font-weight:750; letter-spacing:.13em; color:var(--th-label); }
        @media(max-width:800px){ .ledger-web { grid-template-columns:1fr; } .ledger-web .page{max-width:576px;width:100%;justify-self:center;} .ledger-web .edge-note{display:none;} }
      `}</style>
      <aside className="edge-note"><strong>OPERATIONS LEDGER</strong><br />Daily access is recorded here, for the people keeping every office moving.</aside>
      <section className="page" aria-label="THINNR Operations sign in">
        <span className="folio">FOLIO 01 / 04</span><span className="index-tab">ACCESS</span>
        <header className="brand-row"><Mark /><span className="product">THINNR Operations</span></header>
        <div className="record">
          <div className="record-top"><div className="th-kicker">Staff access record</div><span className="folio-small">ENTRY / 2025</span></div>
          {stage === 'email' ? <>
            <h1 className="th-display">Sign in to today’s desk.</h1>
            <p className="intro">Your practice’s work is already in motion. Start with the email your office knows.</p>
            <form onSubmit={submitEmail}>
              <label htmlFor="ledger-email">Work email</label>
              <input id="ledger-email" className="rule-input" type="email" autoComplete="email" placeholder="you@yourclinic.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
              <p className="helper">We’ll email you a 6-digit sign-in code. No password needed.</p>
              <button className="primary" type="submit">Email me a code</button>
            </form>
          </> : <>
            <h1 className="th-display">Enter the code we emailed.</h1>
            <p className="code-note">If <b>{email || 'your work email'}</b> has an account, a 6-digit code is on its way.</p>
            <form onSubmit={submitCode}>
              <label htmlFor="ledger-code">6-digit sign-in code</label>
              <input id="ledger-code" className="rule-input code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="— — — — — —" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
              <button className="primary" type="submit" style={{ marginTop: 22 }}>Verify and sign in</button>
              <div className="link-row"><button type="button" className="text-button">Send a fresh code</button><button type="button" className="text-button" onClick={() => setStage('email')}>Use a different email</button></div>
            </form>
          </>}
          <button type="button" className={`demo-toggle ${demoOpen ? 'open' : ''}`} onClick={() => setDemoOpen(!demoOpen)} aria-expanded={demoOpen}><span>Browse the guided demo without an account</span><ChevronDown size={15} /></button>
          {demoOpen && <div className="demo-grid">
            <article className="demo-card"><div className="demo-head"><Building2 size={15} />THINNR HQ admin</div><p>The umbrella above every office: rollups, provider accounts, and org tools.</p><button type="button">Enter HQ admin <ArrowRight size={12} aria-hidden="true" /></button></article>
            <article className="demo-card"><div className="demo-head"><Stethoscope size={15} />Office staff</div><p>Today’s operations desk for the med spa team, exactly as it runs day to day.</p><button type="button">Enter the office <ArrowRight size={12} aria-hidden="true" /></button></article>
          </div>}
        </div>
        <p className="bottom">Staff sign in with a one-time email code. Patients sign in with their cell phone in the THINNR mobile app.</p>
      </section>
      <div />
      <footer>SYNTHETIC DEMO DATA &nbsp;•&nbsp; NOT MEDICAL ADVICE</footer>
    </main>
  );
}