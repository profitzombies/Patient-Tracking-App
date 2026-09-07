import { useState, type FormEvent } from 'react';
import { ArrowLeft, Eye, EyeOff } from 'lucide-react';
import './_group.css';

export function MorningBriefMobile() {
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState('');
  const submit = (event: FormEvent) => { event.preventDefault(); setMessage('A 6-digit verification code will be sent by text.'); };
  return (
    <main className="thinnr-login mbm">
      <style>{`
        .mbm{height:852px;width:393px;overflow:hidden;background:var(--th-paper);color:var(--th-ink);padding:54px 22px 34px;position:relative}.mbm *{box-sizing:border-box}.mbm button,.mbm input{font:inherit}.mbm button{cursor:pointer}.mbm-head{height:45px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--th-hairline)}.mbm-back{height:36px;width:36px;border:1px solid var(--th-hairline);border-radius:7px;background:var(--th-card);color:var(--th-navy);display:grid;place-items:center}.mbm-mark{height:31px;width:31px;border-radius:7px;background:var(--th-navy);color:var(--th-brand-fg);display:grid;place-items:center;font:700 13px var(--th-font-display);letter-spacing:.03em}.mbm-blank{width:36px}.mbm-date{font:700 10px var(--th-font-body);letter-spacing:.15em;text-transform:uppercase;color:var(--th-label);margin:26px 0 8px}.mbm-date b{font-weight:700;color:var(--th-warm);margin-right:7px}.mbm-title{font:700 35px/1 var(--th-font-display);letter-spacing:-.04em;color:var(--th-navy);margin:0}.mbm-rule{height:3px;width:34px;background:var(--th-warm);margin:18px 0}.mbm-kicker{font-size:10px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--th-label);margin:0 0 14px}.mbm-entry{background:var(--th-card);border:1px solid var(--th-hairline);border-radius:var(--th-radius-card);box-shadow:var(--th-shadow-soft);padding:18px}.mbm-entryhead{font:700 17px var(--th-font-display);color:var(--th-navy);margin:0 0 17px}.mbm-label{display:block;color:var(--th-navy);font-weight:700;font-size:11px}.mbm-input{margin:7px 0 0;width:100%;height:45px;border:1px solid var(--th-hairline);border-radius:7px;background:var(--th-paper-alt);outline:0;color:var(--th-ink);font-size:13px;padding:0 12px}.mbm-input:focus{border-color:var(--th-cobalt);box-shadow:0 0 0 3px rgba(49,94,174,.18)}.mbm-linkline{text-align:right;margin:6px 0 16px}.mbm-link{color:var(--th-cobalt);font-size:11px;font-weight:650;border:0;background:none;padding:0;text-decoration:underline;text-underline-offset:3px}.mbm-password{position:relative}.mbm-password .mbm-input{padding-right:43px}.mbm-eye{position:absolute;right:2px;bottom:2px;height:41px;width:39px;border:0;background:transparent;color:var(--th-cobalt);display:grid;place-items:center}.mbm-continue{height:46px;width:100%;border:0;border-radius:7px;background:var(--th-cobalt);color:var(--th-card);font-size:13px;font-weight:700}.mbm-continue:hover{background:var(--th-navy)}.mbm-msg{font-size:11px;line-height:1.45;color:var(--th-navy);background:var(--th-accent);padding:9px;border-radius:6px;margin:0 0 12px}.mbm-footer{text-align:center}.mbm-create{border:0;background:none;color:var(--th-cobalt);font-size:13px;font-weight:700;padding:19px 8px 13px}.mbm-quiet{font-size:11px;color:var(--th-label);display:flex;justify-content:center;gap:8px}.mbm-quiet button{padding:0;border:0;background:none;color:var(--th-body);font-size:11px;font-weight:600}.mbm-note{border-top:1px solid var(--th-hairline);margin-top:19px;padding-top:14px;font:italic 14px/1.35 var(--th-font-display);color:var(--th-navy)}.mbm-home{position:absolute;bottom:11px;left:calc(50% - 58px);height:4px;width:116px;border-radius:5px;background:var(--th-navy);opacity:.25}
      `}</style>
      <header className="mbm-head"><button className="mbm-back" type="button" aria-label="Go back"><ArrowLeft size={17} /></button><div className="mbm-mark">TH</div><div className="mbm-blank" /></header>
      <p className="mbm-date"><b>Monday</b> September 7, 2026</p>
      <h1 className="mbm-title">Welcome back</h1><div className="mbm-rule" />
      <p className="mbm-kicker">Patient access · today’s first entry</p>
      <form className="mbm-entry" onSubmit={submit}>
        <h2 className="mbm-entryhead">Sign in to your care plan</h2>
        {message && <p className="mbm-msg">{message}</p>}
        <label className="mbm-label" htmlFor="mobile-phone">Cell phone number</label><input id="mobile-phone" className="mbm-input" type="tel" inputMode="tel" autoComplete="tel" placeholder="Your cell number" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <div className="mbm-linkline"><button className="mbm-link" type="button">Use email instead</button></div>
        <label className="mbm-label" htmlFor="mobile-password">Password</label><div className="mbm-password"><input id="mobile-password" className="mbm-input" type={showPassword ? 'text' : 'password'} autoComplete="current-password" placeholder="Your password" value={password} onChange={(e) => setPassword(e.target.value)} /><button className="mbm-eye" type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
        <div className="mbm-linkline"><button className="mbm-link" type="button">Forgot password?</button></div><button className="mbm-continue" type="submit">Continue</button>
      </form>
      <footer className="mbm-footer"><button className="mbm-create" type="button">Create new account</button><div className="mbm-quiet"><button type="button">Explore demo</button><span>·</span><button type="button">Provider login</button></div><div className="mbm-note">Your health journey, supported by your care team.</div></footer><div className="mbm-home" />
    </main>
  );
}