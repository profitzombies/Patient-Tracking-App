import { useState, type FormEvent } from 'react';
import { ArrowRight, Check, ChevronDown, Mail, ShieldCheck } from 'lucide-react';
import './_thinnr-brand.css';

export function Concept1Web() {
  const [email, setEmail] = useState('');
  const [phase, setPhase] = useState<'email' | 'code'>('email');
  const [code, setCode] = useState('');
  const [demo, setDemo] = useState(false);
  const [notice, setNotice] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (phase === 'email') {
      setPhase('code');
      setNotice(`A one-time code has been sent to ${email || 'your work email'}.`);
    } else {
      setNotice('Code received. Preparing your operations desk.');
    }
  };

  return (
    <main className="thinnr-brand thinnr-brand-web ps-web">
      <style>{`
        .ps-web{--ink:#0a0a0a;--paper:#fbfbf8;--aqua:#8fd4d5;--coral:#4fb3b4;--lime:#8fd4d5;--rule:#d9dfdc;--muted:#606967;width:1280px;height:800px;overflow:hidden;background:var(--paper);color:var(--ink);font-family:Inter,system-ui,sans-serif;position:relative}
        .ps-web *{box-sizing:border-box}.ps-web button,.ps-web input{font-family:inherit}.ps-web button{cursor:pointer}.ps-web:after{content:"";position:absolute;inset:0;pointer-events:none;opacity:.17;background-image:radial-gradient(#0a0a0a .55px,transparent .7px);background-size:5px 5px;mix-blend-mode:multiply}
        .ps-top{height:80px;border-bottom:1px solid var(--ink);display:flex;align-items:center;justify-content:space-between;padding:0 46px;position:relative;z-index:1;background:rgba(251,251,248,.94)}
        .ps-brand{font-family:"GT America Mono",ui-monospace,monospace;font-weight:700;font-size:21px;letter-spacing:-.04em;line-height:1}.ps-brand span{letter-spacing:.13em;font-size:10px;margin-left:16px;vertical-align:2px}.ps-session{font:700 10px "GT America Mono",ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;display:flex;align-items:center;gap:8px}.ps-session i{width:8px;height:8px;background:var(--lime);border-radius:50%;display:block}
        .ps-grid{height:720px;display:grid;grid-template-columns:55.5% 44.5%;position:relative;z-index:1}.ps-world{position:relative;background:var(--ink);color:#f8faf8;overflow:hidden;padding:62px 0 0 66px}.ps-world:before{content:"";position:absolute;width:590px;height:590px;border:1px solid rgba(143,212,213,.52);border-radius:50%;left:-165px;top:136px}.ps-world:after{content:"";position:absolute;width:380px;height:380px;border:60px solid var(--aqua);border-radius:50%;right:-198px;bottom:-195px;opacity:.95}
        .world-index{font:700 10px "GT America Mono",ui-monospace,monospace;letter-spacing:.18em;color:var(--aqua);text-transform:uppercase;position:relative}.world-index:before{content:"";display:inline-block;width:28px;height:1px;background:var(--aqua);margin:0 10px 3px 0}.ps-world h1{position:relative;font:700 65px/.88 "GT America Mono",ui-monospace,monospace;letter-spacing:-.04em;text-transform:uppercase;margin:42px 0 25px;max-width:510px}.ps-world h1 em{font-style:normal;color:var(--aqua)}.ps-world p{position:relative;margin:0;max-width:377px;color:#bdc7c5;font-size:14px;line-height:1.55}.protocol-stack{position:absolute;left:66px;bottom:58px;display:flex;gap:9px;align-items:center}.protocol{height:42px;min-width:148px;border:1px solid rgba(255,255,255,.28);background:rgba(255,255,255,.05);display:flex;align-items:center;padding:0 12px;gap:9px;font:700 9px "GT America Mono",ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase}.protocol b{height:8px;width:8px;border-radius:50%;background:var(--coral)}.protocol:nth-child(2) b{background:var(--lime)}
        .ps-access{padding:61px 68px 0 56px;background:rgba(251,251,248,.87)}.access-tag{font:700 10px "GT America Mono",ui-monospace,monospace;letter-spacing:.13em;text-transform:uppercase;color:#56625f;display:flex;align-items:center;gap:8px}.access-tag i{width:8px;height:8px;border-radius:50%;background:var(--coral)}.ps-access h2{font:700 38px/.95 "GT America Mono",ui-monospace,monospace;letter-spacing:-.04em;text-transform:uppercase;margin:19px 0 11px}.access-copy{color:var(--muted);font-size:13px;line-height:1.5;margin:0 0 27px;max-width:370px}.access-form{border-top:1px solid var(--ink);padding-top:20px;max-width:402px}.field-label{font:700 11px "GT America Mono",ui-monospace,monospace;letter-spacing:.04em;display:block;margin-bottom:8px}.access-form input{width:100%;height:48px;border:1px solid #9aa5a1;background:#fff;padding:0 14px;outline:none;font-size:14px;color:var(--ink);border-radius:7px}.access-form input:focus{border:2px solid var(--ink);padding-left:13px}.access-form input::placeholder{color:#89928f}.code{letter-spacing:.37em;text-align:center;font-weight:700}.email-note{margin:9px 0 16px;color:var(--muted);font-size:11px;line-height:1.45}.send{height:48px;width:100%;border:1px solid var(--ink);border-radius:7px;background:var(--aqua);color:var(--ink);font:700 12px "GT America Mono",ui-monospace,monospace;text-transform:uppercase;letter-spacing:.06em;display:flex;align-items:center;justify-content:center;gap:9px;transition:transform .18s ease,background .18s ease}.send:hover{transform:translateY(-2px);background:#b5e8e7}.notice{font-size:11px;line-height:1.45;margin:12px 0 0;color:#44504d;display:flex;gap:6px;align-items:flex-start}.notice svg{color:#158083;flex:none;margin-top:1px}.demo{max-width:402px;margin-top:20px;border-top:1px solid var(--rule);padding-top:16px}.demo button{border:0;background:none;padding:0;color:var(--ink);font:700 11px "GT America Mono",ui-monospace,monospace;letter-spacing:.03em;display:flex;align-items:center;justify-content:space-between;width:100%}.demo-options{margin-top:13px;display:grid;grid-template-columns:1fr 1fr;gap:8px}.demo-options button{border:1px solid #b8c2be;background:#fff;min-height:63px;padding:10px;text-align:left;display:block;font:700 10px/1.35 "GT America Mono",ui-monospace,monospace;letter-spacing:.03em}.demo-options button strong{display:block;font-size:10px;margin-bottom:4px}.demo-options button:hover{border-color:var(--ink);background:#f1fbfa}.access-footer{font:700 9px "GT America Mono",ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;margin-top:21px;color:#78827f}
      `}</style>
      <header className="ps-top">
        <div className="ps-brand th-brand"><img className="th-logo" src="/__mockup/images/getthinnr-login-round3-thinnr-logo.png" alt="THINNR" /><span>OPERATIONS</span></div>
        <div className="ps-session"><i /> Secure staff access</div>
      </header>
      <div className="ps-grid">
        <section className="ps-world" aria-label="Operations protocol introduction">
          <div className="world-index">Protocol / 01</div>
          <h1>The provider side of <em>every day.</em></h1>
          <p>Enter the operational layer designed for teams who keep patient journeys moving with care and clarity.</p>
          <div className="protocol-stack" aria-label="Protocol status">
            <div className="protocol"><b /> Team access</div>
            <div className="protocol"><b /> Daily desk</div>
          </div>
        </section>
        <section className="ps-access">
          <div className="access-tag"><i /> Staff sign in</div>
          <h2>{phase === 'email' ? <>Enter the<br />protocol.</> : <>Check your<br />inbox.</>}</h2>
          <p className="access-copy">{phase === 'email' ? 'Use your work address to open THINNR Operations.' : 'Use the six-digit code from your work email to continue.'}</p>
          <form className="access-form" onSubmit={submit}>
            {phase === 'email' ? <>
              <label className="field-label" htmlFor="protocol-email">Work email</label>
              <input id="protocol-email" type="email" autoComplete="email" placeholder="you@clinic.com" value={email} onChange={(event) => setEmail(event.target.value)} required />
              <p className="email-note">We’ll email a one-time code. It expires shortly and replaces a password.</p>
              <button className="send" type="submit">Email a code <Mail size={15} /></button>
            </> : <>
              <label className="field-label" htmlFor="protocol-code">One-time code</label>
              <input className="code" id="protocol-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="000000" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} required />
              <p className="email-note">The code was sent to {email || 'your work email'}.</p>
              <button className="send" type="submit">Verify and enter <ArrowRight size={15} /></button>
            </>}
          </form>
          {notice && <p className="notice" role="status"><ShieldCheck size={14} /> {notice}</p>}
          <div className="demo">
            <button type="button" onClick={() => setDemo(!demo)} aria-expanded={demo}>Open a guided demo <ChevronDown size={15} style={{ transform: demo ? 'rotate(180deg)' : undefined }} /></button>
            {demo && <div className="demo-options"><button type="button" onClick={() => setNotice('Opening the HQ admin demonstration.')}><strong>HQ ADMIN</strong> Organization view</button><button type="button" onClick={() => setNotice('Opening the office staff demonstration.')}><strong>OFFICE STAFF</strong> Today’s desk</button></div>}
          </div>
          <div className="access-footer">THINNR Operations · secure code entry</div>
        </section>
      </div>
    </main>
  );
}