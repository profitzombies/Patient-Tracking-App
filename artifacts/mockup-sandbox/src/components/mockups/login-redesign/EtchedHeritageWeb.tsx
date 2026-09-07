import { useState, type FormEvent } from 'react';
import './_group.css';

type Phase = 'email' | 'code';

function Mark() {
  return <span className="eh-mark" aria-label="THINNR">TH</span>;
}

function Etching({ className = '' }: { className?: string }) {
  return <svg className={`eh-etching ${className}`} viewBox="0 0 620 560" fill="none" aria-hidden="true">
    <g stroke="currentColor" strokeWidth="1.25">
      <path d="M66 82c54-37 111-52 173-49M554 82c-54-37-111-52-173-49M66 478c54 37 111 52 173 49M554 478c-54 37-111 52-173 49" />
      <path d="M68 92c62-23 113-19 155-6M552 92c-62-23-113-19-155-6M68 468c62 23 113 19 155 6M552 468c-62 23-113 19-155 6" />
      <path d="M310 154v211M235 180h150l-18 185H253l-18-185Z" />
      <path d="M245 210h130M249 245h122M252 280h116M255 315h110M231 180l25-39h108l25 39" />
      <path d="M301 140c-21-27-10-48 9-67 20 19 30 40 9 67M273 139c-30-9-39-30-37-54 29 6 45 23 37 54M347 139c30-9 39-30 37-54-29 6-45 23-37 54" />
      <path d="M185 175c-37 29-46 78-32 114 14 36 42 55 65 63M435 175c37 29 46 78 32 114-14 36-42 55-65 63" />
      <path d="M177 205c-7 44 20 92 59 114M443 205c7 44-20 92-59 114M161 230c12 12 25 20 42 25M459 230c-12 12-25 20-42 25M163 283c17 0 33 5 48 15M457 283c-17 0-33 5-48 15" />
      <path d="M177 363c20 30 42 49 73 59M443 363c-20 30-42 49-73 59M204 384l-17 31 35-7M416 384l17 31-35-7" />
      <path d="M126 300h72M422 300h72M132 294v12M488 294v12" />
      <circle cx="310" cy="420" r="36" /><circle cx="310" cy="420" r="25" />
      <path d="M289 420h42M310 399v42M296 406l28 28M324 406l-28 28" />
      <path d="M95 128h104M421 128h104M95 432h104M421 432h104" strokeDasharray="2 5" />
    </g>
  </svg>;
}

export function EtchedHeritageWeb() {
  const [phase, setPhase] = useState<Phase>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [showDemo, setShowDemo] = useState(false);
  const submit = (event: FormEvent) => { event.preventDefault(); setPhase('code'); };

  return <main className="thinnr-login eh-web">
    <style>{`
      .eh-web{--line:var(--th-hairline); position:relative; box-sizing:border-box;width:100%;min-height:800px;height:100vh;overflow:hidden;background:var(--th-paper);color:var(--th-ink);padding:27px 34px 43px;font-family:var(--th-font-body)}
      .eh-web *{box-sizing:border-box}.eh-web:before,.eh-web:after{content:"";position:absolute;inset:17px;border:1px solid var(--th-hairline);pointer-events:none}.eh-web:after{inset:22px;border-color:rgba(49,94,174,.24)}
      .eh-web .eh-etching{position:absolute;color:var(--th-cobalt);opacity:.095;pointer-events:none}.eh-web>.eh-etching{width:665px;height:600px;right:-25px;top:100px}
      .eh-head{height:58px;border-bottom:1px solid var(--th-hairline);position:relative;z-index:1;display:flex;align-items:center;justify-content:space-between;padding:0 16px}
      .eh-brand{display:flex;align-items:center;gap:11px;color:var(--th-navy);font-family:var(--th-font-display);font-size:19px;font-weight:700}.eh-mark{display:grid;place-items:center;width:35px;height:35px;border-radius:8px;background:var(--th-navy);color:var(--th-brand-fg);font:700 13px var(--th-font-display);letter-spacing:.08em}
      .eh-headnote{font-size:10px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:var(--th-label)}
      .eh-stage{position:relative;z-index:1;width:100%;max-width:1110px;height:647px;margin:auto;display:grid;grid-template-columns:1.14fr .86fr;align-items:center;gap:75px}
      .eh-plate{height:467px;position:relative;display:flex;align-items:center;justify-content:center;border:1px solid rgba(49,94,174,.22);border-radius:var(--th-radius-card);background:rgba(253,252,249,.42)}.eh-plate:before,.eh-plate:after{content:"";position:absolute;inset:11px;border:1px solid rgba(49,94,174,.23);border-radius:4px}.eh-plate:after{inset:auto;bottom:25px;width:160px;height:1px;background:var(--th-warm);border:0}
      .eh-plate .eh-etching{width:490px;height:440px;color:var(--th-navy);opacity:.56;position:relative;z-index:1}.eh-platecopy{position:absolute;z-index:2;text-align:center;top:35px;background:var(--th-card);padding:8px 15px}.eh-platecopy small{display:block;color:var(--th-label);font-weight:700;letter-spacing:.17em;font-size:9px}.eh-platecopy strong{font-family:var(--th-font-display);font-size:18px;color:var(--th-navy)}
      .eh-panel{width:408px;justify-self:center;background:var(--th-card);border:1px solid var(--th-hairline);border-radius:var(--th-radius-card);box-shadow:var(--th-shadow-soft);padding:34px 35px 27px;position:relative}.eh-panel:before{content:"";display:block;height:4px;margin:-34px -35px 28px;border-radius:9px 9px 0 0;background:var(--th-navy)}
      .eh-panel h1{font:700 34px/1.05 var(--th-font-display);letter-spacing:-.025em;color:var(--th-navy);margin:6px 0 7px}.eh-panel .lead{font-size:13px;line-height:1.55;color:var(--th-body);margin:0 0 25px}.eh-web label{display:block;font-size:10px;font-weight:750;letter-spacing:.13em;text-transform:uppercase;color:var(--th-label);margin-bottom:8px}.eh-web input{width:100%;height:46px;border:1px solid var(--th-hairline);border-radius:var(--th-radius-control);background:var(--th-paper-alt);padding:0 13px;color:var(--th-ink);font:14px var(--th-font-body);outline:none}.eh-web input:focus{border-color:var(--th-cobalt);box-shadow:0 0 0 3px rgba(49,94,174,.16)}.eh-web input::placeholder{color:#8b99aa}.eh-helper{font-size:11px;line-height:1.45;color:var(--th-body);margin:8px 0 18px}.eh-primary{width:100%;min-height:44px;border:0;border-radius:var(--th-radius-control);background:var(--th-cobalt);color:var(--th-card);font:700 13px var(--th-font-body);cursor:pointer}.eh-primary:hover{background:var(--th-navy)}.eh-code{letter-spacing:.35em;text-align:center;font-size:18px!important}.eh-panel .quiet{text-align:center;font-size:11px;color:var(--th-body);line-height:1.45}.eh-textbutton{border:0;background:none;color:var(--th-cobalt);font:700 12px var(--th-font-body);cursor:pointer;padding:5px}.eh-actions{display:flex;justify-content:center;gap:13px;margin-top:13px}
      .eh-demo{margin-top:22px;border-top:1px solid var(--th-hairline);padding-top:16px}.eh-demo-toggle{border:0;background:none;width:100%;color:var(--th-body);font:600 11px var(--th-font-body);cursor:pointer}.eh-demo-cards{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:13px}.eh-demo-card{border:1px solid var(--th-hairline);background:var(--th-secondary);border-radius:7px;padding:11px}.eh-demo-card b{font:700 13px var(--th-font-display);color:var(--th-navy)}.eh-demo-card p{font-size:10px;line-height:1.35;color:var(--th-body);margin:5px 0 9px}.eh-demo-card button{border:0;background:none;color:var(--th-cobalt);font:700 10px var(--th-font-body);padding:0;cursor:pointer}
      .eh-footer{position:absolute;z-index:2;bottom:15px;left:0;right:0;text-align:center;font-size:9px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--th-label)}
    `}</style>
    <Etching />
    <header className="eh-head"><div className="eh-brand"><Mark /> <span>THINNR Operations</span></div><span className="eh-headnote">Operations access · est. 2026</span></header>
    <section className="eh-stage">
      <div className="eh-plate"><div className="eh-platecopy"><small>Physician-supervised care</small><strong>Order in every measure</strong></div><Etching /></div>
      <section className="eh-panel" aria-label="Staff sign in">
        {phase === 'email' ? <><p className="th-kicker">Staff sign in</p><h1>Welcome to the ledger.</h1><p className="lead">A private operations desk for the work behind better care.</p><form onSubmit={submit}><label htmlFor="eh-email">Work email</label><input id="eh-email" type="email" placeholder="you@yourclinic.com" value={email} onChange={e => setEmail(e.target.value)} required /><p className="eh-helper">We'll email you a 6-digit sign-in code. No password needed.</p><button className="eh-primary" type="submit">Email me a code</button></form></> : <><p className="th-kicker">One-time code</p><h1>Enter the code we emailed</h1><p className="lead">If this email belongs to an account, a 6-digit code is on its way.</p><form onSubmit={e => e.preventDefault()}><label htmlFor="eh-code">6-digit sign-in code</label><input className="eh-code" id="eh-code" inputMode="numeric" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} /><button className="eh-primary" type="submit" style={{ marginTop: 18 }}>Verify and sign in</button></form><div className="eh-actions"><button className="eh-textbutton">Send a fresh code</button><button className="eh-textbutton" onClick={() => setPhase('email')}>Use a different email</button></div></>}
        <div className="eh-demo"><button className="eh-demo-toggle" onClick={() => setShowDemo(!showDemo)} aria-expanded={showDemo}>Browse the guided demo without an account {showDemo ? '−' : '+'}</button>{showDemo && <div className="eh-demo-cards"><div className="eh-demo-card"><b>THINNR HQ admin</b><p>The umbrella above every office: rollups, provider accounts, and org tools.</p><button>Enter HQ admin →</button></div><div className="eh-demo-card"><b>Office staff</b><p>Today's operations desk for the med spa team, exactly as it runs day to day.</p><button>Enter the office →</button></div></div>}</div>
        <p className="quiet">Staff sign in with a one-time email code. Patients sign in with their cell phone in the THINNR mobile app.</p>
      </section>
    </section>
    <footer className="eh-footer">Synthetic Demo Data • Not Medical Advice</footer>
  </main>;
}