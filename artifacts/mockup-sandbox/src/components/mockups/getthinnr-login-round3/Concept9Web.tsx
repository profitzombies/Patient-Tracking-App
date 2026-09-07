import { useState, type FormEvent } from 'react';
import { ArrowRight, Check, ChevronDown, KeyRound } from 'lucide-react';

export function Concept9Web() {
  const [email, setEmail] = useState('');
  const [demoOpen, setDemoOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSent(true);
  };

  return (
    <main className="signal-web">
      <style>{`
        .signal-web{--ink:#0a0a0a;--paper:#f8faf9;--aqua:#8fd4d5;--orange:#f3a25b;--coral:#ee806b;--green:#87b986;--line:#d7dddd;--soft:#eff5f4;width:100%;height:800px;min-width:960px;overflow:hidden;background:var(--paper);color:var(--ink);font-family:Arial,sans-serif;position:relative}
        .signal-web *{box-sizing:border-box}.signal-web button,.signal-web input{font-family:inherit}.signal-web button{cursor:pointer}.signal-web:before{content:"";position:absolute;inset:0;background:repeating-linear-gradient(90deg,transparent 0,transparent calc(25% - 1px),rgba(10,10,10,.055) calc(25% - 1px),rgba(10,10,10,.055) 25%);pointer-events:none}
        .sw-header{height:74px;border-bottom:1px solid var(--ink);padding:0 46px;display:flex;align-items:center;justify-content:space-between;position:relative}.sw-brand{font-family:"Courier New",monospace;font-weight:800;font-size:21px;letter-spacing:-1.4px}.sw-brand span{font:700 10px Arial,sans-serif;letter-spacing:.12em;margin-left:16px;vertical-align:middle}.sw-meta{font:700 10px "Courier New",monospace;letter-spacing:.13em;text-transform:uppercase;color:#555}
        .sw-body{height:682px;display:grid;grid-template-columns:44% 56%;position:relative}.sw-intro{padding:63px 0 0 92px;position:relative}.sw-kicker,.sw-small{font:700 10px "Courier New",monospace;letter-spacing:.15em;text-transform:uppercase}.sw-kicker{display:flex;align-items:center;gap:9px}.signal{width:8px;height:8px;border-radius:50%;display:inline-block}.aqua{background:var(--aqua)}.orange{background:var(--orange)}.coral{background:var(--coral)}.green{background:var(--green)}
        .sw-intro h1{font-family:"Courier New",monospace;font-size:52px;line-height:.95;letter-spacing:-3.5px;text-transform:uppercase;margin:24px 0 22px;max-width:410px}.sw-intro p{font-size:14px;line-height:1.5;max-width:330px;margin:0;color:#424747}.signal-index{position:absolute;bottom:59px;left:92px;display:flex;gap:21px}.signal-item{display:flex;align-items:center;gap:7px;font:700 10px "Courier New",monospace;letter-spacing:.08em;text-transform:uppercase}
        .sw-panel{border-left:1px solid var(--ink);padding:57px 88px 0 80px;position:relative;background:rgba(255,255,255,.42)}.panel-top{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);padding-bottom:15px}.panel-top strong{font:700 10px "Courier New",monospace;letter-spacing:.14em;text-transform:uppercase}.step{font:700 10px "Courier New",monospace;letter-spacing:.08em;color:#636a6a}
        .sw-form{margin-top:31px;max-width:398px}.sw-form label{display:block;font-size:12px;font-weight:700;margin-bottom:9px}.email-wrap{position:relative}.sw-form input{width:100%;height:50px;border:1px solid var(--ink);border-radius:8px;background:#fff;padding:0 14px;font-size:15px;outline:none;transition:box-shadow .16s,transform .16s}.sw-form input:focus{box-shadow:4px 4px 0 var(--aqua);transform:translate(-2px,-2px)}.hint{font-size:11px;line-height:1.45;color:#5b6262;margin:9px 0 20px}.send{height:50px;width:100%;border:1px solid var(--ink);border-radius:8px;background:var(--ink);color:#fff;font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:10px;transition:transform .16s,box-shadow .16s}.send:hover{transform:translate(-3px,-3px);box-shadow:4px 4px 0 var(--coral)}.status{font-size:11px;margin:14px 0 0;display:flex;gap:7px;align-items:center;color:#245c54}.demo{margin-top:25px;border-top:1px solid var(--line);padding-top:17px;max-width:398px}.demo-toggle{border:0;background:transparent;padding:0;color:var(--ink);font:700 11px "Courier New",monospace;letter-spacing:.06em;display:flex;align-items:center;gap:8px}.demo-toggle svg{transition:transform .2s}.demo-menu{display:flex;gap:10px;margin-top:13px}.demo-option{flex:1;border:1px solid var(--ink);border-radius:8px;background:#fff;padding:12px;text-align:left}.demo-option b{display:block;font-size:11px}.demo-option span{display:block;font-size:10px;color:#5a6262;margin-top:5px}.demo-option:hover{background:var(--soft)}.protocol{position:absolute;right:22px;bottom:23px;border:1px solid var(--ink);border-radius:20px;padding:8px 12px;background:#fff;font:700 9px "Courier New",monospace;letter-spacing:.08em;display:flex;gap:7px;align-items:center}
        .sw-footer{height:44px;border-top:1px solid var(--ink);display:flex;align-items:center;justify-content:space-between;padding:0 46px;position:relative;font:700 9px "Courier New",monospace;letter-spacing:.12em;text-transform:uppercase;color:#555}
      `}</style>
      <header className="sw-header"><div className="sw-brand">THINNR<span>OPERATIONS</span></div><div className="sw-meta">secure staff access / v03</div></header>
      <section className="sw-body">
        <aside className="sw-intro">
          <div className="sw-kicker"><i className="signal aqua" /> Staff sign in</div>
          <h1>Start with<br />the signal.</h1>
          <p>One deliberate entry point for the teams keeping the day in motion.</p>
          <div className="signal-index"><div className="signal-item"><i className="signal aqua" /> Access</div><div className="signal-item"><i className="signal orange" /> Review</div><div className="signal-item"><i className="signal green" /> Act</div></div>
        </aside>
        <section className="sw-panel" aria-label="Staff sign in">
          <div className="panel-top"><strong>Identify your desk</strong><span className="step">01 / 02</span></div>
          <form className="sw-form" onSubmit={submit}>
            <label htmlFor="signal-work-email">Work email</label>
            <div className="email-wrap"><input id="signal-work-email" type="email" autoComplete="email" placeholder="you@practice.com" value={email} onChange={(event) => setEmail(event.target.value)} required /></div>
            <p className="hint">We’ll send a one-time code to this address. It expires after a short while and keeps your account password-free.</p>
            <button className="send" type="submit">Email me a code <ArrowRight size={16} /></button>
            {sent && <p className="status" role="status"><Check size={14} /> Check your inbox for the one-time code.</p>}
          </form>
          <div className="demo">
            <button className="demo-toggle" type="button" onClick={() => setDemoOpen(!demoOpen)} aria-expanded={demoOpen}>Open a guided demo <ChevronDown size={15} style={{ transform: demoOpen ? 'rotate(180deg)' : undefined }} /></button>
            {demoOpen && <div className="demo-menu"><button type="button" className="demo-option" onClick={() => setSent(true)}><b>Operations desk</b><span>See a working day in context.</span></button><button type="button" className="demo-option" onClick={() => setSent(true)}><b>Organization view</b><span>Explore the wider practice picture.</span></button></div>}
          </div>
          <div className="protocol"><i className="signal coral" /> CODE-BASED ENTRY</div>
        </section>
      </section>
      <footer className="sw-footer"><span>THINNR / Operations protocol</span><span>Staff only · one-time code sign-in</span></footer>
    </main>
  );
}