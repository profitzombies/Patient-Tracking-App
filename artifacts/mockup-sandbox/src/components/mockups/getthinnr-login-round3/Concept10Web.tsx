import { useState, type FormEvent } from 'react';
import { ArrowRight, Check, ChevronDown, ShieldCheck } from 'lucide-react';

export function Concept10Web() {
  const [email, setEmail] = useState('');
  const [notice, setNotice] = useState('');
  const [demo, setDemo] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setNotice('A one-time code is headed to your work inbox.');
  };

  return (
    <main className="c10-web">
      <style>{`
        .c10-web{--ink:#0a0a0a;--paper:#f7f8f7;--aqua:#8fd4d5;--rule:#d9dedc;--muted:#69716f;--coral:#f47d61;--green:#65ad87;--sun:#e6bd5e;min-width:1080px;width:100%;height:800px;overflow:hidden;background:var(--paper);color:var(--ink);font-family:ui-sans-serif,system-ui,sans-serif;position:relative}.c10-web *{box-sizing:border-box}.c10-web button,.c10-web input{font-family:inherit}.c10-web button{cursor:pointer}.c10-web:after{content:"";position:absolute;inset:0;pointer-events:none;opacity:.3;background-image:linear-gradient(90deg,transparent 49.96%,var(--rule) 50%,transparent 50.04%);background-size:80px 80px}
        .c10-top{height:76px;border-bottom:1px solid var(--ink);display:flex;align-items:center;justify-content:space-between;padding:0 52px;position:relative;z-index:1}.c10-logo{width:146px;height:auto;filter:invert(1);display:block}.c10-word{font-family:ui-monospace,SFMono-Regular,monospace;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;display:flex;gap:10px;align-items:center}.c10-word i{height:7px;width:7px;border-radius:50%;background:var(--coral)}.c10-status{font-family:ui-monospace,SFMono-Regular,monospace;font-size:10px;letter-spacing:.08em;color:var(--muted);text-transform:uppercase}.c10-status b{color:var(--ink);font-weight:700}
        .c10-grid{height:674px;display:grid;grid-template-columns:1.08fr .92fr;position:relative;z-index:1}.c10-intro{padding:91px 0 0 114px;position:relative}.c10-kicker{font-family:ui-monospace,SFMono-Regular,monospace;font-size:10px;letter-spacing:.15em;text-transform:uppercase;display:flex;align-items:center;gap:9px}.c10-kicker i{width:7px;height:7px;background:var(--green);border-radius:50%}.c10-intro h1{font-family:ui-monospace,SFMono-Regular,monospace;font-size:58px;line-height:.94;letter-spacing:-.075em;text-transform:uppercase;margin:24px 0 25px;max-width:545px}.c10-intro p{max-width:460px;color:#4e5855;font-size:15px;line-height:1.55;margin:0}.c10-ledger{position:absolute;bottom:76px;display:flex;gap:27px;border-top:1px solid var(--ink);padding-top:13px;width:462px}.c10-ledger span{font-family:ui-monospace,SFMono-Regular,monospace;font-size:9px;line-height:1.4;letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}.c10-ledger b{display:block;color:var(--ink);font-size:11px;margin-top:3px;letter-spacing:.03em}
        .c10-entry{border-left:1px solid var(--ink);display:flex;align-items:center;padding-left:80px;background:rgba(255,255,255,.36)}.c10-card{width:382px}.c10-cardhead{display:flex;justify-content:space-between;align-items:center;margin-bottom:21px}.c10-cardhead span{font-family:ui-monospace,SFMono-Regular,monospace;font-size:10px;font-weight:700;letter-spacing:.13em;text-transform:uppercase}.c10-cardhead b{font-size:11px;font-weight:500;color:var(--muted)}.c10-field label{display:block;font-family:ui-monospace,SFMono-Regular,monospace;text-transform:uppercase;font-size:10px;letter-spacing:.09em;font-weight:700;margin-bottom:8px}.c10-field input{width:100%;height:49px;border:1px solid var(--ink);border-radius:7px;background:#fff;padding:0 13px;font-size:14px;outline:none}.c10-field input:focus{box-shadow:0 0 0 3px rgba(143,212,213,.65)}.c10-help{font-size:11px;color:var(--muted);line-height:1.45;margin:9px 0 18px}.c10-primary{height:50px;width:100%;border:1px solid var(--ink);border-radius:7px;background:var(--aqua);font-weight:800;font-size:13px;display:flex;align-items:center;justify-content:center;gap:9px;transition:transform .18s ease,background .18s ease}.c10-primary:hover{background:#aee4e3;transform:translateY(-2px)}.c10-notice{font-size:11px;line-height:1.45;margin:11px 0 0;padding:8px 10px;background:#e8f6f4;border-left:3px solid var(--green)}.c10-demo{margin-top:22px;border-top:1px solid var(--rule);padding-top:14px}.c10-demo button{border:0;background:transparent;padding:0;color:var(--ink);font-size:11px;font-weight:700;display:flex;align-items:center;gap:6px}.c10-demo button:hover{text-decoration:underline;text-underline-offset:4px}.c10-demo article{display:flex;gap:10px;margin-top:12px;padding:10px;border:1px solid var(--rule);background:#fff;font-size:11px;line-height:1.35}.c10-demo article svg{color:#2c8c8c;flex:none}.c10-demo strong{display:block;font-size:11px}.c10-demo small{display:block;color:var(--muted);margin-top:2px}.c10-demo a{margin-left:auto;align-self:center;color:var(--ink);font-weight:700}
        .c10-foot{height:50px;border-top:1px solid var(--ink);position:relative;z-index:1;display:flex;align-items:center;justify-content:space-between;padding:0 52px;font-family:ui-monospace,SFMono-Regular,monospace;font-size:9px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted)}.c10-signals{display:flex;gap:10px}.c10-signals i{display:block;width:6px;height:6px;border-radius:50%}.c10-signals i:nth-child(1){background:var(--coral)}.c10-signals i:nth-child(2){background:var(--sun)}.c10-signals i:nth-child(3){background:var(--green)}
      `}</style>
      <header className="c10-top">
        <div className="c10-word"><img className="c10-logo" src="/__mockup/images/getthinnr-logo.png" alt="THINNR" /><i /> Operations</div>
        <div className="c10-status"><b>Secure staff access</b> / v.01</div>
      </header>
      <section className="c10-grid">
        <div className="c10-intro">
          <div className="c10-kicker"><i /> Provider Portal</div>
          <h1>Operations<br />start here.</h1>
          <p>Your clear desk for today’s care operations. Sign in with your work email to receive a one-time access code.</p>
          <div className="c10-ledger"><span>Access protocol<b>Email-verified</b></span><span>Audience<b>Care teams</b></span><span>Portal state<b>Ready</b></span></div>
        </div>
        <div className="c10-entry"><div className="c10-card">
          <div className="c10-cardhead"><span>Staff sign in</span><b>01 / 01</b></div>
          <form onSubmit={submit}>
            <div className="c10-field"><label htmlFor="c10-email">Work email</label><input id="c10-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@practice.com" required /></div>
            <p className="c10-help">We’ll send a one-time code to verify this device. No password required.</p>
            <button className="c10-primary" type="submit">Email me a code <ArrowRight size={16} /></button>
          </form>
          {notice && <p className="c10-notice" role="status">{notice}</p>}
          <div className="c10-demo"><button type="button" onClick={() => setDemo(!demo)} aria-expanded={demo}>Open a guided demo <ChevronDown size={14} style={{transform:demo?'rotate(180deg)':undefined}} /></button>{demo && <article><ShieldCheck size={18}/><div><strong>Practice workspace preview</strong><small>Explore a guided, sample operations desk.</small></div><a href="#demo" onClick={(e)=>e.preventDefault()}>Open</a></article>}</div>
        </div></div>
      </section>
      <footer className="c10-foot"><span>THINNR / provider protocol / 2025</span><span className="c10-signals"><i /><i /><i /></span><span>Protected staff workspace</span></footer>
    </main>
  );
}