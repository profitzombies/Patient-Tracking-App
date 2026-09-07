import { useState, type FormEvent } from 'react';
import { ArrowRight, ChevronDown, KeyRound, Play, X } from 'lucide-react';

export function Concept2Web() {
  const [email, setEmail] = useState('');
  const [codeMode, setCodeMode] = useState(false);
  const [demoOpen, setDemoOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setCodeMode(true);
    setNotice(`A one-time code is ready for ${email || 'your work inbox'}.`);
  };

  return (
    <main className="c2w">
      <style>{`
        .c2w{--ink:#0a0a0a;--paper:#fbfcfa;--aqua:#8fd4d5;--coral:#f08369;--lime:#9acb88;--line:#d7dcda;--muted:#5e6564;width:1280px;height:800px;overflow:hidden;position:relative;background:var(--paper);color:var(--ink);font-family:ui-sans-serif,system-ui,sans-serif}
        .c2w *{box-sizing:border-box}.c2w button,.c2w input{font-family:inherit}.c2w button{cursor:pointer}.c2w:before{content:"";position:absolute;inset:0;background-image:linear-gradient(rgba(10,10,10,.026) 1px,transparent 1px),linear-gradient(90deg,rgba(10,10,10,.026) 1px,transparent 1px);background-size:32px 32px;mask-image:linear-gradient(90deg,transparent,black 26%,black 74%,transparent);pointer-events:none}
        .c2w header{height:82px;border-bottom:1px solid var(--ink);display:flex;align-items:center;justify-content:space-between;padding:0 43px;position:relative;z-index:2}.c2w-brand{display:flex;align-items:center;gap:13px;font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;font-weight:700;letter-spacing:.045em;text-transform:uppercase}.c2w-logo{font-family:ui-monospace,SFMono-Regular,monospace;font-size:27px;font-weight:900;letter-spacing:-.12em;line-height:1}.c2w-status{font:10px ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;display:flex;gap:7px;align-items:center}.c2w-dot{width:7px;height:7px;background:var(--lime);border-radius:50%}
        .c2w-card{width:416px;position:absolute;left:50%;top:50%;transform:translate(-50%,-44%);z-index:3;background:#fff;border:1px solid var(--ink);box-shadow:9px 9px 0 var(--aqua);padding:31px 32px 29px}.c2w-eyebrow{font:10px ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;margin:0 0 14px}.c2w h1{font-family:ui-monospace,SFMono-Regular,monospace;font-size:40px;font-weight:800;letter-spacing:-.08em;text-transform:uppercase;line-height:.98;margin:0 0 13px}.c2w-lede{font-size:13px;line-height:1.5;color:var(--muted);margin:0 0 25px;max-width:308px}.c2w label{display:block;font:700 11px ui-monospace,monospace;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px}.c2w input{height:48px;width:100%;border:1px solid var(--ink);border-radius:7px;background:#fff;padding:0 13px;font-size:14px;outline:none}.c2w input:focus{box-shadow:0 0 0 3px var(--aqua)}.c2w-input-code{letter-spacing:.45em;text-align:center;font-weight:700}.c2w-help{font-size:11px;line-height:1.5;color:var(--muted);margin:9px 0 17px}.c2w-primary{height:48px;border:1px solid var(--ink);background:var(--ink);color:#fff;width:100%;border-radius:7px;font:700 12px ui-monospace,monospace;text-transform:uppercase;letter-spacing:.06em;display:flex;align-items:center;justify-content:center;gap:10px;transition:transform .18s ease}.c2w-primary:hover{transform:translate(-2px,-2px);box-shadow:3px 3px 0 var(--coral)}.c2w-notice{font-size:11px;margin:15px 0 0;line-height:1.4;border-left:3px solid var(--aqua);padding-left:8px}.c2w-demo{margin-top:21px;width:100%;border:0;background:none;padding:0;font:700 11px ui-monospace,monospace;letter-spacing:.025em;display:flex;justify-content:space-between;align-items:center;text-decoration:underline;text-underline-offset:4px}.c2w-demo svg{transition:transform .2s}.c2w-demo svg.open{transform:rotate(180deg)}.c2w-demo-panel{margin-top:13px;border-top:1px solid var(--line);padding-top:12px;font-size:11px;line-height:1.45}.c2w-demo-panel button{border:0;background:none;padding:0;color:var(--ink);font-weight:700;text-decoration:underline;text-underline-offset:3px}.c2w-foot{position:absolute;bottom:28px;left:43px;font:10px ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
        .c2w-chip{position:absolute;z-index:1;background:#fff;border:1px solid var(--line);border-radius:99px;padding:8px 12px 8px 9px;font:10px ui-monospace,monospace;letter-spacing:.05em;text-transform:uppercase;display:flex;align-items:center;gap:7px;box-shadow:0 5px 13px rgba(10,10,10,.05);animation:c2w-float 5s ease-in-out infinite}.c2w-chip i{width:7px;height:7px;border-radius:50%;background:var(--aqua)}.c2w-chip.coral i{background:var(--coral)}.c2w-chip.lime i{background:var(--lime)}.c2w-chip.one{left:133px;top:181px}.c2w-chip.two{left:238px;top:492px;animation-delay:-1.6s}.c2w-chip.three{right:165px;top:183px;animation-delay:-2.4s}.c2w-chip.four{right:133px;top:510px;animation-delay:-.8s}.c2w-chip.five{right:283px;top:638px;animation-delay:-3s}.c2w-tick{position:absolute;width:52px;height:52px;border:1px solid var(--ink);border-radius:50%;right:284px;top:297px;z-index:1}.c2w-tick:before,.c2w-tick:after{content:"";position:absolute;background:var(--ink);left:25px;top:6px;width:1px;height:39px}.c2w-tick:after{transform:rotate(90deg)}@keyframes c2w-float{50%{transform:translateY(-7px)}}
      `}</style>
      <header><div className="c2w-brand"><span className="c2w-logo">THINNR</span><span>/ Operations</span></div><span className="c2w-status"><i className="c2w-dot" /> secure staff access</span></header>
      <span className="c2w-chip one"><i />protocol ready</span><span className="c2w-chip coral two"><i />team access</span><span className="c2w-chip lime three"><i />code sign-in</span><span className="c2w-chip four"><i />patient-first</span><span className="c2w-chip coral five"><i />guided demo</span><span className="c2w-tick" />
      <section className="c2w-card" aria-label="Staff sign in">
        <p className="c2w-eyebrow">Staff access / 01</p>
        <h1>{codeMode ? 'Check your inbox' : 'Sign in to the work.'}</h1>
        <p className="c2w-lede">{codeMode ? 'Enter the six-digit code from your email to continue.' : 'A clear starting point for your practice operations.'}</p>
        <form onSubmit={submit}>
          {codeMode ? <><label htmlFor="c2w-code">One-time code</label><input className="c2w-input-code" id="c2w-code" inputMode="numeric" maxLength={6} pattern="[0-9]{6}" autoComplete="one-time-code" placeholder="000000" required /><p className="c2w-help">This code is short-lived and keeps your staff access password-free.</p><button className="c2w-primary" type="submit"><KeyRound size={15} /> Verify code</button></> : <><label htmlFor="c2w-email">Work email</label><input id="c2w-email" type="email" autoComplete="email" placeholder="you@yourpractice.com" value={email} onChange={(event) => setEmail(event.target.value)} required /><p className="c2w-help">We’ll email a one-time code. It’s a password-free way to verify it’s you.</p><button className="c2w-primary" type="submit">Email me a code <ArrowRight size={15} /></button></>}
        </form>
        {notice && <p className="c2w-notice" role="status">{notice}</p>}
        <button className="c2w-demo" type="button" aria-expanded={demoOpen} onClick={() => setDemoOpen(!demoOpen)}>Try the guided demo <ChevronDown className={demoOpen ? 'open' : ''} size={15} /></button>
        {demoOpen && <div className="c2w-demo-panel">Preview a prepared operations workspace with sample practice data. <button type="button" onClick={() => setNotice('The guided demo is ready to explore.')}>Open demo <Play size={10} /></button></div>}
      </section>
      <p className="c2w-foot">THINNR Operations <X size={10} style={{verticalAlign:'middle'}} /> Staff workspace</p>
    </main>
  );
}