import { useState, type FormEvent } from 'react';
import { ArrowRight, ChevronDown, LockKeyhole, Monitor, Stethoscope } from 'lucide-react';
import './_thinnr-brand.css';

export function Concept8Web() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [mode, setMode] = useState<'email' | 'code'>('email');
  const [demoOpen, setDemoOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mode === 'email') {
      setMode('code');
      setNotice(`A one-time code has been sent${email ? ` to ${email}` : ''}.`);
    } else setNotice('Code received. Opening your operations desk.');
  };

  return (
    <main className="thinnr-brand thinnr-brand-web c8w">
      <style>{`
        .c8w{--ink:#0a0a0a;--paper:#f8f8f5;--aqua:#8fd4d5;--coral:#4fb3b4;--leaf:#8fd4d5;--line:#d9ddda;min-width:1000px;width:100%;height:800px;overflow:hidden;background:var(--paper);color:var(--ink);font-family:Inter,system-ui,sans-serif;position:relative}.c8w *{box-sizing:border-box}.c8w button,.c8w input{font-family:inherit}.c8w button{cursor:pointer}.c8w:after{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(90deg,transparent 0 49.95%,rgba(10,10,10,.08) 50%,transparent 50.1%);opacity:.55}
        .c8w-header{height:72px;border-bottom:1px solid var(--ink);display:flex;align-items:center;justify-content:space-between;padding:0 48px;position:relative;z-index:1}.c8w-brand{display:flex;align-items:center;gap:17px}.c8w-brand img{width:auto;height:42px}.c8w-brand span,.c8w-header p,.c8w-kicker,.c8w-foot{font-family:"GT America Mono",ui-monospace,monospace;text-transform:uppercase;letter-spacing:.12em;font-size:10px;font-weight:700}.c8w-brand span{padding-left:17px;border-left:1px solid var(--ink)}.c8w-header p{margin:0;color:#565b58}
        .c8w-grid{height:688px;display:grid;grid-template-columns:1fr 1fr;position:relative;z-index:1}.c8w-formside{padding:95px 0 0 max(48px,calc((100% - 510px)/2));}.c8w-kicker{display:flex;align-items:center;gap:8px;color:#545b57}.c8w-kicker i{height:8px;width:8px;background:var(--coral);display:block}.c8w-title{font-family:"GT America Mono",ui-monospace,monospace;text-transform:uppercase;font-size:52px;line-height:.91;letter-spacing:-.04em;margin:18px 0 16px;font-weight:700}.c8w-intro{font-size:14px;line-height:1.55;width:360px;margin:0 0 27px;color:#464b48}.c8w-card{width:395px;border:1px solid var(--ink);background:#fff;padding:19px 20px 18px;box-shadow:8px 8px 0 var(--aqua)}.c8w-card label{font-family:"GT America Mono",ui-monospace,monospace;text-transform:uppercase;letter-spacing:.1em;font-size:10px;font-weight:700;display:block;margin-bottom:9px}.c8w-card input{width:100%;height:44px;border:1px solid #aeb5b0;border-radius:7px;padding:0 12px;font-size:14px;background:#fcfcfa;outline:none}.c8w-card input:focus{border-color:var(--ink);box-shadow:0 0 0 3px var(--aqua)}.c8w-helper{font-size:11.5px;line-height:1.45;color:#5b625e;margin:9px 0 15px}.c8w-action{height:45px;border:0;border-radius:8px;background:var(--ink);color:#fff;width:100%;font-weight:750;font-size:13px;display:flex;align-items:center;justify-content:center;gap:8px;transition:transform .18s ease}.c8w-action:hover{transform:translateY(-2px)}.c8w-under{margin-top:13px;display:flex;gap:17px}.c8w-under button,.c8w-demo-toggle,.c8w-demo-item button{border:0;background:none;padding:0;text-decoration:underline;text-underline-offset:3px;color:var(--ink);font-size:11px;font-weight:700}.c8w-notice{font-size:11px;line-height:1.4;border-left:3px solid var(--coral);padding-left:8px;margin:13px 0 0}.c8w-demo-toggle{display:flex;align-items:center;gap:7px;margin-top:26px;text-decoration:none}.c8w-demo-toggle span{text-decoration:underline;text-underline-offset:3px}.c8w-demo-list{width:395px;display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.c8w-demo-item{border:1px solid var(--line);padding:12px;background:#fff}.c8w-demo-item svg{margin-bottom:7px}.c8w-demo-item strong{display:block;font-size:11px;margin-bottom:5px}.c8w-demo-item button{font-size:10px}
        .c8w-window{background:var(--ink);position:relative;overflow:hidden;color:#fff;padding:0 58px}.c8w-window:before{content:"";position:absolute;width:470px;height:470px;border:1px solid rgba(143,212,213,.4);border-radius:50%;right:-195px;top:105px}.c8w-window:after{content:"";position:absolute;width:290px;height:290px;background:var(--aqua);border-radius:50%;right:-34px;top:195px}.c8w-window-nav{height:72px;border-bottom:1px solid rgba(255,255,255,.3);display:flex;align-items:center;justify-content:space-between;position:relative;z-index:1;font:700 10px "GT America Mono",ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase}.c8w-window-nav b{color:var(--aqua)}.c8w-window-content{position:relative;z-index:1;padding-top:113px;width:430px}.c8w-window-content h2{font-family:"GT America Mono",ui-monospace,monospace;text-transform:uppercase;font-weight:700;font-size:56px;line-height:.88;letter-spacing:-.04em;margin:0 0 22px}.c8w-window-content p{font-size:15px;line-height:1.55;margin:0;color:#e7ecea;max-width:300px}.c8w-chips{display:flex;gap:8px;margin-top:42px;flex-wrap:wrap}.c8w-chip{background:#fff;color:var(--ink);padding:9px 11px;border-radius:7px;font:700 10px "GT America Mono",ui-monospace,monospace;letter-spacing:.04em;display:flex;align-items:center;gap:7px}.c8w-dot{width:7px;height:7px;border-radius:50%;background:var(--coral)}.c8w-dot.green{background:var(--leaf)}.c8w-foot{height:40px;border-top:1px solid var(--ink);position:absolute;bottom:0;left:0;right:0;z-index:2;display:flex;align-items:center;justify-content:center;color:#59615c}
      `}</style>
      <header className="c8w-header">
        <div className="c8w-brand"><img src="/__mockup/images/getthinnr-logo.png" alt="THINNR" /><span>Operations</span></div>
        <p>Staff access / secure sign-in</p>
      </header>
      <section className="c8w-grid">
        <div className="c8w-formside">
          <div className="c8w-kicker"><i /> Care team portal</div>
          <h1 className="c8w-title">Welcome<br />to the desk.</h1>
          <p className="c8w-intro">A direct line into the practical work of supporting every patient day to day.</p>
          <div className="c8w-card">
            <form onSubmit={submit}>
               {mode === 'email' ? <><label htmlFor="c8-work-email">Work email</label><input id="c8-work-email" type="email" autoComplete="email" placeholder="you@yourpractice.com" value={email} onChange={(event) => setEmail(event.target.value)} required /><p className="c8w-helper">We’ll email a one-time sign-in code. No password needed.</p><button className="c8w-action" type="submit">Email me a code <ArrowRight size={15} /></button></> : <><label htmlFor="c8-code">One-time code</label><input id="c8-code" autoComplete="one-time-code" inputMode="numeric" maxLength={6} pattern="[0-9]{6}" placeholder="6-digit code" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} required /><p className="c8w-helper">Use the 6-digit code from your email to open Operations.</p><button className="c8w-action" type="submit">Verify and sign in <LockKeyhole size={14} /></button><div className="c8w-under"><button type="button" onClick={() => setNotice('A fresh code is on its way.')}>Send another code</button><button type="button" onClick={() => setMode('email')}>Use another email</button></div></>}
            </form>{notice && <p className="c8w-notice" role="status">{notice}</p>}
          </div>
          <button className="c8w-demo-toggle" type="button" onClick={() => setDemoOpen(!demoOpen)} aria-expanded={demoOpen}><span>Open a guided demo</span><ChevronDown size={15} style={{ transform: demoOpen ? 'rotate(180deg)' : undefined }} /></button>
          {demoOpen && <div className="c8w-demo-list"><div className="c8w-demo-item"><Monitor size={16} /><strong>Practice overview</strong><button type="button" onClick={() => setNotice('Practice overview demo selected.')}>View demo</button></div><div className="c8w-demo-item"><Stethoscope size={16} /><strong>Care team day</strong><button type="button" onClick={() => setNotice('Care team demo selected.')}>View demo</button></div></div>}
        </div>
        <aside className="c8w-window">
          <div className="c8w-window-nav"><span>Companion window</span><b>Today / 09:40</b></div>
          <div className="c8w-window-content"><h2>Clear<br />next steps.</h2><p>Information that meets people where the day is actually happening.</p><div className="c8w-chips"><span className="c8w-chip"><i className="c8w-dot" /> Patient check-in</span><span className="c8w-chip"><i className="c8w-dot green" /> Plan updated</span></div></div>
        </aside>
      </section>
      <footer className="c8w-foot">THINNR Operations / sign-in is protected with an email code</footer>
    </main>
  );
}