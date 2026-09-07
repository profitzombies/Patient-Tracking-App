import { useState, type FormEvent } from 'react';
import { ArrowRight, ChevronDown, LockKeyhole, Sparkles } from 'lucide-react';

export function Concept3Web() {
  const [email, setEmail] = useState('');
  const [codeMode, setCodeMode] = useState(false);
  const [demoOpen, setDemoOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setCodeMode(true);
    setNotice(`A one-time code was sent to ${email || 'your work email'}.`);
  };

  return (
    <main className="aqua-web">
      <style>{`
        .aqua-web{--ink:#0a0a0a;--paper:#f7f8f4;--aqua:#8fd4d5;--coral:#fa795a;--lime:#a7dc66;--line:rgba(10,10,10,.24);width:1280px;height:800px;overflow:hidden;background:var(--paper);color:var(--ink);font-family:Arial,sans-serif;position:relative}.aqua-web *{box-sizing:border-box}.aqua-web button,.aqua-web input{font-family:inherit}.aqua-web button{cursor:pointer}.aqua-web:before{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent 0 52.6%,rgba(10,10,10,.12) 52.6% 52.7%,transparent 52.7%);pointer-events:none}
        .aw-head{height:82px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 45px;position:relative;z-index:1}.aw-brand{display:flex;align-items:center;gap:16px;font:700 11px/1 "Courier New",monospace;letter-spacing:.11em;text-transform:uppercase}.aw-logo{width:117px;height:auto;filter:invert(1)}.aw-sys{font:700 10px/1 "Courier New",monospace;letter-spacing:.1em;text-transform:uppercase}.aw-sys i{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--coral);margin-right:8px}
        .aw-shell{height:718px;display:grid;grid-template-columns:52.7% 47.3%;position:relative}.aw-formside{padding:87px 0 0 132px;position:relative}.aw-formside:after{content:"001 / ACCESS";position:absolute;left:45px;bottom:32px;font:700 9px "Courier New",monospace;letter-spacing:.12em;color:#6b6b66;writing-mode:vertical-rl;transform:rotate(180deg)}.aw-kicker{font:700 10px/1 "Courier New",monospace;letter-spacing:.15em;text-transform:uppercase;margin:0 0 19px}.aw-kicker span{display:inline-block;width:8px;height:8px;background:var(--coral);margin-right:10px}.aw-formside h1{font-family:"Arial Narrow",Arial,sans-serif;font-weight:900;font-size:55px;letter-spacing:-.075em;line-height:.87;text-transform:uppercase;margin:0 0 20px;max-width:430px}.aw-intro{font-size:14px;line-height:1.45;margin:0 0 29px;max-width:350px}.aw-card{width:365px;border-top:2px solid var(--ink);padding-top:16px}.aw-card label{font:700 10px/1 "Courier New",monospace;letter-spacing:.1em;text-transform:uppercase;display:block;margin-bottom:9px}.aw-card input{width:100%;height:49px;background:transparent;border:1px solid var(--ink);border-radius:7px;padding:0 13px;font-size:14px;outline:none}.aw-card input:focus{box-shadow:0 0 0 3px rgba(143,212,213,.72)}.aw-card input::placeholder{color:#74746e}.aw-helper{font-size:11px;line-height:1.4;margin:9px 0 15px;color:#4d4d49}.aw-primary{width:100%;height:48px;background:var(--ink);color:var(--paper);border:1px solid var(--ink);border-radius:7px;font:700 11px "Courier New",monospace;letter-spacing:.06em;text-transform:uppercase;transition:transform .16s ease}.aw-primary:hover{transform:translateY(-2px);background:#202020}.aw-code{font-size:13px;line-height:1.42;margin:0 0 15px}.aw-message{font-size:11px;line-height:1.4;margin:12px 0 0;padding-left:10px;border-left:3px solid var(--coral)}.aw-demo{margin-top:19px;background:none;border:0;padding:0;font:700 10px "Courier New",monospace;letter-spacing:.06em;text-transform:uppercase;display:flex;gap:8px;align-items:center}.aw-demo svg{transition:transform .18s ease}.aw-demo:hover{text-decoration:underline}.aw-demoitems{display:flex;gap:8px;margin-top:12px}.aw-demoitem{width:178px;border:1px solid var(--ink);border-radius:7px;background:#fff;padding:10px;text-align:left;font-size:11px;line-height:1.3}.aw-demoitem b{font:700 9px "Courier New",monospace;letter-spacing:.06em;text-transform:uppercase;display:block;margin-bottom:4px}.aw-demoitem:hover{background:var(--aqua)}
        .aw-plane{background:var(--aqua);position:relative;padding:66px 50px;overflow:hidden}.aw-plane:before,.aw-plane:after{content:"";position:absolute;border:1px solid rgba(10,10,10,.22);border-radius:50%}.aw-plane:before{width:630px;height:630px;right:-230px;top:71px}.aw-plane:after{width:400px;height:400px;right:-115px;top:186px}.aw-plane h2{position:relative;z-index:1;margin:0;font-family:"Arial Narrow",Arial,sans-serif;font-size:82px;letter-spacing:-.08em;line-height:.82;text-transform:uppercase;max-width:430px}.aw-plane h2 em{font-style:normal;color:#f7f8f4}.aw-ledger{position:absolute;z-index:1;left:50px;right:50px;bottom:57px;border-top:1px solid var(--ink);border-bottom:1px solid var(--ink);display:grid;grid-template-columns:1fr 1fr;padding:15px 0}.aw-ledger div{font:700 10px/1.3 "Courier New",monospace;letter-spacing:.06em;text-transform:uppercase}.aw-ledger div+div{border-left:1px solid var(--ink);padding-left:18px}.aw-chip{position:absolute;z-index:2;right:42px;top:47px;background:var(--paper);border-radius:18px;padding:8px 12px;font:700 9px "Courier New",monospace;letter-spacing:.07em;text-transform:uppercase;box-shadow:0 2px 0 var(--ink)}.aw-chip i{width:7px;height:7px;border-radius:50%;background:var(--lime);display:inline-block;margin-right:6px}.aw-footnote{font:700 9px "Courier New",monospace;letter-spacing:.1em;text-transform:uppercase;position:absolute;bottom:24px;left:132px;color:#555550}
        .aw-formside h1,.aw-plane h2{font-family:ui-monospace,SFMono-Regular,monospace;font-weight:900;letter-spacing:-.09em}.aw-plane h2{font-size:72px;line-height:.84}
       `}</style>
      <header className="aw-head">
        <div className="aw-brand"><img className="aw-logo" src="/__mockup/images/getthinnr-logo.png" alt="THINNR" /><span>Operations</span></div>
        <div className="aw-sys"><i />Secure staff access</div>
      </header>
      <section className="aw-shell">
        <div className="aw-formside">
          <p className="aw-kicker"><span />Staff sign in</p>
          <h1>Begin<br />with order.</h1>
          <p className="aw-intro">A precise point of entry for the teams holding the day together.</p>
          <div className="aw-card">
            {!codeMode ? <form onSubmit={submit}>
              <label htmlFor="thinnr-work-email">Work email</label>
              <input id="thinnr-work-email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@clinic.com" required />
              <p className="aw-helper">We’ll send a one-time code to this address. No password required.</p>
              <button className="aw-primary" type="submit">Email me a code <ArrowRight size={14} style={{ verticalAlign: 'middle', marginLeft: 7 }} /></button>
            </form> : <form onSubmit={(event) => { event.preventDefault(); setNotice('Code received. Signing you in.'); }}>
              <p className="aw-code"><b>Code sent.</b><br />Enter the 6-digit code from your email.</p>
              <label htmlFor="thinnr-code">One-time code</label>
              <input id="thinnr-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="000000" required />
              <button className="aw-primary" style={{ marginTop: 15 }} type="submit">Verify and sign in</button>
            </form>}
            {notice && <p className="aw-message" role="status">{notice}</p>}
          </div>
          <button className="aw-demo" type="button" aria-expanded={demoOpen} onClick={() => setDemoOpen(!demoOpen)}>Open guided demo <ChevronDown size={14} style={{ transform: demoOpen ? 'rotate(180deg)' : undefined }} /></button>
          {demoOpen && <div className="aw-demoitems"><button className="aw-demoitem" type="button" onClick={() => setNotice('Opening the operations demonstration.')}><b>01 / Operations</b>See the staff workspace</button><button className="aw-demoitem" type="button" onClick={() => setNotice('Opening the admin demonstration.')}><b>02 / Admin</b>See the organization view</button></div>}
          <p className="aw-footnote">THINNR / SYSTEM ACCESS</p>
        </div>
        <aside className="aw-plane">
          <div className="aw-chip"><i />Protocol clear</div>
          <h2>Care<br />has a<br /><em>rhythm.</em></h2>
          <div className="aw-ledger"><div><Sparkles size={13} style={{ marginBottom: 7 }} /><br />Prepared for<br />the day ahead</div><div><LockKeyhole size={13} style={{ marginBottom: 7 }} /><br />Private access,<br />one code at a time</div></div>
        </aside>
      </section>
    </main>
  );
}