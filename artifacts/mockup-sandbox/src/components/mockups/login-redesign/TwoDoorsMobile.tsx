import { useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, ChevronDown, Eye, LockKeyhole, UserRound } from 'lucide-react';
import './_group.css';

export function TwoDoorsMobile() {
  const [patientOpen, setPatientOpen] = useState(true);
  const [providerOpen, setProviderOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setNotice(phone && password ? 'A 6-digit code will be sent by text next.' : 'Enter your cell number and password to continue.');
  };

  return (
    <main className="thinnr-login td-mobile">
      <style>{`
        .td-mobile { width:393px; height:852px; overflow:hidden; position:relative; background:var(--th-paper); color:var(--th-ink); font-family:var(--th-font-body); }
        .td-mobile * { box-sizing:border-box; }.td-mobile button,.td-mobile input { font:inherit; }.td-mobile:before { content:""; position:absolute; inset:0; pointer-events:none; opacity:.3; background-image:radial-gradient(rgba(32,59,100,.13) .4px,transparent .6px);background-size:7px 7px;}
        .tdm-wrap { height:100%; position:relative; z-index:1; padding:54px 20px 34px; display:flex; flex-direction:column; }
        .tdm-header { display:flex; align-items:center; justify-content:space-between; }.tdm-back { width:38px;height:38px;display:grid;place-items:center;border:1px solid var(--th-hairline);border-radius:7px;background:var(--th-card);color:var(--th-navy);cursor:pointer;}.tdm-mark { width:35px;height:35px;display:grid;place-items:center;border-radius:8px;background:var(--th-navy);color:var(--th-brand-fg);font-family:var(--th-font-display);font-weight:700;font-size:14px;letter-spacing:.04em; }.tdm-spacer {width:38px}
        .tdm-intro { margin:30px 4px 19px; }.tdm-intro .th-kicker { color:var(--th-cobalt); }.tdm-intro h1 { margin:8px 0 0; font-family:var(--th-font-display);font-size:34px;line-height:1;letter-spacing:-.04em;color:var(--th-navy); }
        .tdm-doors { display:flex; flex-direction:column; gap:10px; }.tdm-door { border:1px solid var(--th-hairline);border-radius:var(--th-radius-card);background:var(--th-card);overflow:hidden;box-shadow:0 1px 2px rgba(32,59,100,.03); }.tdm-door[data-open="true"] { border-color:var(--th-accent-border); box-shadow:var(--th-shadow-soft); }
        .tdm-door-top { width:100%;border:0;background:transparent;padding:14px 14px;display:flex;align-items:center;text-align:left;color:var(--th-ink);cursor:pointer; }.tdm-tile {height:35px;width:35px;display:grid;place-items:center;border-radius:7px;background:var(--th-accent);color:var(--th-cobalt);flex:none}.tdm-title { margin-left:11px;font-family:var(--th-font-display);font-size:18px;letter-spacing:-.025em;color:var(--th-navy);}.tdm-door-sub {margin-left:auto;color:var(--th-label);font-size:10.5px}.tdm-chevron {margin-left:9px;color:var(--th-cobalt);transition:transform .2s ease}.tdm-door[data-open="true"] .tdm-chevron{transform:rotate(180deg)}
        .tdm-form { border-top:1px solid var(--th-hairline);padding:14px 14px 15px; animation:tdm-drop .2s ease both; } @keyframes tdm-drop {from{opacity:0;transform:translateY(-5px)}to{opacity:1;transform:translateY(0)}}.tdm-label {display:block;color:var(--th-navy);font-size:11.5px;font-weight:700;margin-bottom:6px}.tdm-input {height:44px;width:100%;border:1px solid var(--th-hairline);border-radius:var(--th-radius-control);background:var(--th-paper-alt);color:var(--th-ink);padding:0 11px;outline:0;font-size:13px}.tdm-input:focus{border-color:var(--th-cobalt);box-shadow:0 0 0 3px var(--th-accent)}.tdm-input::placeholder{color:var(--th-label)}.tdm-link-row{display:flex;justify-content:flex-end;margin:5px 0 10px}.tdm-link{background:none;border:0;padding:1px 0;color:var(--th-cobalt);font-size:11px;font-weight:700;cursor:pointer;text-decoration:underline;text-underline-offset:3px}.tdm-password{position:relative}.tdm-password .tdm-input{padding-right:39px}.tdm-eye{position:absolute;right:7px;top:5px;width:34px;height:34px;border:0;background:none;color:var(--th-label);display:grid;place-items:center;cursor:pointer}.tdm-continue{height:45px;width:100%;border:0;border-radius:var(--th-radius-control);background:var(--th-cobalt);color:#fff;font-size:13px;font-weight:700;cursor:pointer}.tdm-continue:hover{background:var(--th-navy)}.tdm-notice{margin:8px 0 0;color:var(--th-warn);font-size:10.5px;line-height:1.4}
        .tdm-provider-copy {border-top:1px solid var(--th-hairline);padding:0 14px 14px;color:var(--th-body);font-size:11px;line-height:1.55}.tdm-provider-copy p{margin:11px 0 9px}.tdm-provider-link{display:inline-flex;gap:5px;align-items:center;color:var(--th-cobalt);font-size:11px;font-weight:700;text-decoration:none}
        .tdm-bottom { margin-top:auto;text-align:center; }.tdm-create{border:0;background:none;color:var(--th-cobalt);font-size:12.5px;font-weight:700;padding:8px;cursor:pointer}.tdm-quiet{display:flex;justify-content:center;gap:8px;color:var(--th-label);font-size:10.5px;margin:8px 0 16px}.tdm-quiet button{border:0;background:none;color:var(--th-label);font-size:10.5px;padding:0;cursor:pointer}.tdm-note{color:var(--th-body);font-family:var(--th-font-display);font-size:15px;line-height:1.25;margin:0 auto;max-width:265px}.tdm-note:before{content:"";display:block;width:22px;height:2px;background:var(--th-warm);margin:0 auto 10px}
      `}</style>
      <div className="tdm-wrap">
        <header className="tdm-header"><button className="tdm-back" aria-label="Go back"><ArrowLeft size={17} /></button><span className="tdm-mark">TH</span><span className="tdm-spacer" /></header>
        <section className="tdm-intro"><p className="th-kicker">Patient access</p><h1>Welcome back</h1></section>
        <section className="tdm-doors" aria-label="Choose your entrance">
          <article className="tdm-door" data-open={patientOpen}>
            <button className="tdm-door-top" onClick={() => { setPatientOpen(!patientOpen); setProviderOpen(false); }} aria-expanded={patientOpen}><span className="tdm-tile"><UserRound size={17} /></span><span className="tdm-title">Patient</span><span className="tdm-door-sub">Your care</span><ChevronDown className="tdm-chevron" size={15} /></button>
            {patientOpen && <form className="tdm-form" onSubmit={submit}>
              <label className="tdm-label" htmlFor="tdm-phone">Cell phone number</label><input className="tdm-input" id="tdm-phone" type="tel" inputMode="tel" placeholder="Your cell number" value={phone} onChange={(e) => setPhone(e.target.value)} />
              <div className="tdm-link-row"><button type="button" className="tdm-link" onClick={() => setNotice('Email sign-in is ready when you are.')}>Use email instead</button></div>
              <label className="tdm-label" htmlFor="tdm-password">Password</label><div className="tdm-password"><input className="tdm-input" id="tdm-password" type="password" placeholder="Your password" value={password} onChange={(e) => setPassword(e.target.value)} /><button type="button" className="tdm-eye" aria-label="Show password"><Eye size={16} /></button></div>
              <div className="tdm-link-row"><button type="button" className="tdm-link" onClick={() => setNotice('Password recovery will guide you safely.')}>Forgot password?</button></div>
              <button className="tdm-continue" type="submit">Continue</button>{notice && <p className="tdm-notice" role="status">{notice}</p>}
            </form>}
          </article>
          <article className="tdm-door" data-open={providerOpen}>
            <button className="tdm-door-top" onClick={() => { setProviderOpen(!providerOpen); setPatientOpen(false); }} aria-expanded={providerOpen}><span className="tdm-tile"><LockKeyhole size={17} /></span><span className="tdm-title">Provider</span><span className="tdm-door-sub">Office desk</span><ChevronDown className="tdm-chevron" size={15} /></button>
            {providerOpen && <div className="tdm-provider-copy"><p>For office teams and care providers who manage today&apos;s operations.</p><a href="#provider" className="tdm-provider-link">Go to provider sign in <ArrowRight size={12} /></a></div>}
          </article>
        </section>
        <footer className="tdm-bottom"><button className="tdm-create" onClick={() => setNotice('Account creation begins with your care office.')}>Create new account</button><div className="tdm-quiet"><button onClick={() => setNotice('The patient demo is ready to explore.')}>Explore demo</button><span>·</span><button onClick={() => { setProviderOpen(true); setPatientOpen(false); }}>Provider login</button></div><p className="tdm-note">Your health journey, supported by your care team.</p></footer>
      </div>
    </main>
  );
}