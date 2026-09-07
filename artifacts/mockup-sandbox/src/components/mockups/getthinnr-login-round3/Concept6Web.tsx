import { useState, type FormEvent } from 'react';
import { ArrowRight, ChevronDown, ShieldCheck } from 'lucide-react';
import './_thinnr-brand.css';

export function Concept6Web() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [demo, setDemo] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSent(true);
  };

  return (
    <main className="thinnr-brand thinnr-brand-web manifest-web">
      <style>{`
        .manifest-web{--ink:#0a0a0a;--paper:#fcfcfa;--aqua:#8fd4d5;--coral:#4fb3b4;--lime:#8fd4d5;--rule:#d9d9d4;width:100%;height:800px;min-width:960px;overflow:hidden;background:var(--paper);color:var(--ink);font-family:Inter,system-ui,sans-serif;position:relative}
        .manifest-web *{box-sizing:border-box}.manifest-web button,.manifest-web input{font-family:inherit}.manifest-web button{cursor:pointer}.manifest-web:before{content:"";position:absolute;inset:0;background:repeating-linear-gradient(90deg,transparent 0,transparent calc(25% - 1px),rgba(10,10,10,.055) calc(25% - 1px),rgba(10,10,10,.055) 25%);pointer-events:none}
        .mw-head{height:78px;border-bottom:1px solid var(--ink);display:flex;align-items:center;justify-content:space-between;padding:0 43px;position:relative;z-index:1}.mw-logo{width:auto;height:42px}.mw-meta,.mw-kicker,.mw-foot{font-family:"GT America Mono",ui-monospace,monospace;text-transform:uppercase;letter-spacing:.11em;font-size:10px}.mw-meta{display:flex;align-items:center;gap:9px}.signal{width:7px;height:7px;border-radius:50%;background:var(--coral);display:inline-block}
        .mw-body{height:678px;display:grid;grid-template-columns:51% 49%;position:relative;z-index:1}.mw-manifest{border-right:1px solid var(--ink);padding:55px 43px 36px;position:relative;overflow:hidden}.mw-kicker{display:flex;align-items:center;gap:9px}.mw-kicker b{width:26px;height:1px;background:var(--ink);display:block}.mw-manifest h1{font-family:"GT America Mono",ui-monospace,monospace;font-weight:700;font-size:clamp(54px,6.05vw,84px);line-height:.96;letter-spacing:-.04em;text-transform:uppercase;margin:29px 0 0;max-width:580px}.mw-manifest h1 em{font-style:normal;background:var(--aqua);padding:0 .06em;box-decoration-break:clone;-webkit-box-decoration-break:clone}.mw-index{position:absolute;left:43px;bottom:42px;display:flex;gap:29px;align-items:flex-end}.mw-index strong{font-family:"GT America Mono",ui-monospace,monospace;font-size:10px;letter-spacing:.09em}.mw-index p{margin:0;width:210px;font-size:12px;line-height:1.45}.mw-stamp{position:absolute;right:32px;bottom:41px;width:92px;height:92px;border:1px solid var(--ink);border-radius:50%;display:grid;place-items:center;font-family:"GT America Mono",ui-monospace,monospace;font-size:9px;text-align:center;line-height:1.35;transform:rotate(-14deg)}.mw-stamp:after{content:"";position:absolute;inset:7px;border:1px solid var(--ink);border-radius:50%}
        .mw-access{padding:56px 58px 20px;max-width:580px}.mw-access h2{font-family:"GT America Mono",ui-monospace,monospace;font-size:14px;letter-spacing:-.03em;margin:0 0 32px;text-transform:uppercase}.mw-form label{display:block;font-family:"GT America Mono",ui-monospace,monospace;font-size:10px;letter-spacing:.1em;text-transform:uppercase;margin-bottom:9px}.mw-form input{height:52px;border:1px solid var(--ink);border-radius:7px;background:transparent;width:100%;padding:0 14px;font-size:15px;outline:none}.mw-form input:focus{box-shadow:0 0 0 3px var(--aqua)}.mw-form input::placeholder{color:#787873}.mw-helper{font-size:12px;line-height:1.45;margin:9px 0 19px;color:#3e3e3a;max-width:410px}.mw-primary{border:1px solid var(--ink);height:52px;padding:0 18px;border-radius:7px;background:var(--ink);color:var(--paper);font-weight:700;font-size:13px;width:100%;display:flex;align-items:center;justify-content:space-between;transition:transform .2s ease,background .2s ease}.mw-primary:hover{background:#222;transform:translateY(-2px)}.mw-message{border-left:3px solid var(--lime);padding-left:10px;font-size:12px;margin:15px 0 0;line-height:1.4}.mw-demo{margin-top:18px;border:0;border-bottom:1px solid var(--ink);background:none;padding:0 0 8px;display:flex;align-items:center;justify-content:space-between;width:100%;font-family:"GT America Mono",ui-monospace,monospace;font-size:10px;letter-spacing:.07em;text-transform:uppercase}.mw-demo svg{transition:transform .2s ease}.mw-demo[aria-expanded="true"] svg{transform:rotate(180deg)}.mw-options{display:grid;grid-template-columns:1fr 1fr;border:1px solid var(--ink);border-radius:7px;margin-top:12px}.mw-option{padding:13px;border-right:1px solid var(--ink);font-size:11px;line-height:1.35}.mw-option:last-child{border:0}.mw-option span{display:block;font-family:"GT America Mono",ui-monospace,monospace;font-size:9px;letter-spacing:.08em;margin-bottom:9px;text-transform:uppercase}.mw-option button{margin-top:9px;border:0;padding:0;background:none;font-weight:700;font-size:11px;text-decoration:underline;text-underline-offset:3px}.mw-foot{height:44px;border-top:1px solid var(--ink);position:relative;z-index:1;display:flex;align-items:center;justify-content:space-between;padding:0 43px;color:#555550}.mw-foot span:last-child{color:var(--ink)}
      `}</style>
      <header className="mw-head">
        <img className="mw-logo" src="/__mockup/images/getthinnr-logo.png" alt="THINNR" />
        <span className="mw-meta"><i className="signal" /> Operations access / 01</span>
      </header>
      <section className="mw-body">
        <div className="mw-manifest">
          <div className="mw-kicker"><b />The operations desk</div>
          <h1>Care<br />moves<br /><em>better</em><br />together.</h1>
          <div className="mw-index"><strong>THINNR<br />Operations</strong><p>The organized starting point for staff who keep daily care in motion.</p></div>
          <div className="mw-stamp">AUTHORIZED<br />STAFF ACCESS<br />THINNR / 2025</div>
        </div>
        <section className="mw-access" aria-labelledby="staff-access">
          <h2 id="staff-access">Sign in to your workspace</h2>
          <form className="mw-form" onSubmit={submit}>
            <label htmlFor="manifest-email">Work email</label>
            <input id="manifest-email" type="email" autoComplete="email" placeholder="name@clinic.com" value={email} onChange={(event) => setEmail(event.target.value)} required />
            <p className="mw-helper">We’ll send a one-time sign-in code to this address. No password needed.</p>
            <button className="mw-primary" type="submit">Email me a code <ArrowRight size={17} /></button>
          </form>
          {sent && <p className="mw-message" role="status"><ShieldCheck size={14} style={{verticalAlign:'middle',marginRight:6}} />If that address is registered, a code is on its way.</p>}
          <button className="mw-demo" type="button" onClick={() => setDemo(!demo)} aria-expanded={demo}>Open a guided demo <ChevronDown size={15} /></button>
          {demo && <div className="mw-options"><div className="mw-option"><span>01 / Admin</span>Explore organization controls.<button type="button" onClick={() => setSent(true)}>Enter demo</button></div><div className="mw-option"><span>02 / Staff</span>See a day at the front desk.<button type="button" onClick={() => setSent(true)}>Enter demo</button></div></div>}
        </section>
      </section>
      <footer className="mw-foot"><span>Secure, practical, ready when you are.</span><span>THINNR / OPERATIONS</span></footer>
    </main>
  );
}