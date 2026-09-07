import { useState, type FormEvent } from 'react';
import { ArrowLeft, Eye, EyeOff } from 'lucide-react';
import './_group.css';

export function MonogramMobile() {
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [usingEmail, setUsingEmail] = useState(false);
  const submit = (event: FormEvent) => event.preventDefault();

  return (
    <div className="thinnr-login monogram-mobile">
      <style>{`
        .monogram-mobile{width:393px;height:852px;overflow:hidden;position:relative;background:var(--th-paper);font-family:var(--th-font-body);color:var(--th-ink)}
        .monogram-mobile *{box-sizing:border-box}.monogram-mobile button,.monogram-mobile input{font:inherit}.monogram-mobile:before{content:"TH";position:absolute;top:25px;left:-19px;color:transparent;-webkit-text-stroke:1px rgba(32,59,100,.2);font:700 322px/.75 var(--th-font-display);letter-spacing:-.13em;pointer-events:none}.monogram-mobile:after{content:"";position:absolute;inset:10px;border:1px solid rgba(32,59,100,.12);border-radius:9px;pointer-events:none}
        .monogram-mobile .safe{position:relative;z-index:1;height:100%;padding:54px 25px 34px;display:flex;flex-direction:column}.monogram-mobile .nav{height:44px;display:flex;align-items:center;justify-content:space-between}.monogram-mobile .back{width:38px;height:38px;border:1px solid var(--th-hairline);border-radius:7px;color:var(--th-navy);background:rgba(253,252,249,.72);display:grid;place-items:center;cursor:pointer}.monogram-mobile .mark{display:grid;place-items:center;width:35px;height:35px;border-radius:8px;background:var(--th-navy);color:var(--th-brand-fg);font:700 13px var(--th-font-display);letter-spacing:-.08em;box-shadow:var(--th-shadow-soft)}.monogram-mobile .nav-spacer{width:38px}
        .monogram-mobile .headline{margin-top:112px;animation:mobile-in .65s ease-out both}.monogram-mobile h1{margin:8px 0 0;font:600 38px/1 var(--th-font-display);letter-spacing:-.05em;color:var(--th-navy)}.monogram-mobile .form{margin-top:27px;padding:18px;background:rgba(253,252,249,.88);border:1px solid var(--th-hairline);border-radius:9px;box-shadow:var(--th-shadow-soft);backdrop-filter:blur(8px)}.monogram-mobile label{display:block;font-size:11.5px;font-weight:700;color:var(--th-ink);margin-bottom:7px}.monogram-mobile input{display:block;width:100%;height:44px;border:1px solid var(--th-hairline);border-radius:7px;background:var(--th-paper-alt);outline:none;color:var(--th-ink);font-size:13px;padding:0 12px}.monogram-mobile input::placeholder{color:var(--th-label)}.monogram-mobile input:focus{border-color:var(--th-cobalt);box-shadow:0 0 0 3px rgba(49,94,174,.18)}.monogram-mobile .field-row{display:flex;justify-content:space-between;align-items:center;margin:7px 0 16px}.monogram-mobile .text-link{background:none;border:0;padding:3px 0;color:var(--th-cobalt);font-size:11px;font-weight:700;cursor:pointer}.monogram-mobile .password-wrap{position:relative}.monogram-mobile .password-wrap input{padding-right:42px}.monogram-mobile .reveal{position:absolute;right:4px;top:3px;width:37px;height:37px;border:0;background:none;color:var(--th-body);display:grid;place-items:center;cursor:pointer}.monogram-mobile .primary{width:100%;height:46px;border:0;border-radius:7px;background:var(--th-cobalt);color:#f8faff;font-size:13px;font-weight:700;cursor:pointer;transition:transform .2s,background .2s}.monogram-mobile .primary:hover{background:var(--th-navy);transform:translateY(-1px)}.monogram-mobile button:focus-visible{outline:3px solid rgba(49,94,174,.42);outline-offset:2px}
        .monogram-mobile .journey{margin-top:auto;text-align:center}.monogram-mobile .create{border:0;background:none;color:var(--th-cobalt);font-size:13px;font-weight:750;padding:9px;cursor:pointer}.monogram-mobile .quiet{display:flex;gap:9px;justify-content:center;align-items:center;color:var(--th-label);font-size:11.5px;margin-top:7px}.monogram-mobile .quiet button{border:0;background:none;padding:3px;color:var(--th-body);font-size:11.5px;font-weight:600;cursor:pointer}.monogram-mobile .support{max-width:245px;margin:18px auto 0;color:var(--th-label);font-size:10.5px;line-height:1.45}.monogram-mobile .warm-rule{width:18px;height:1px;background:var(--th-warm);margin:0 0 12px}@keyframes mobile-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
      `}</style>
      <div className="safe">
        <nav className="nav" aria-label="Login navigation"><button className="back" aria-label="Go back"><ArrowLeft size={18} /></button><span className="mark" aria-label="THINNR">TH</span><span className="nav-spacer" /></nav>
        <header className="headline"><span className="th-kicker">Patient access</span><h1 className="th-display">Welcome back</h1></header>
        <form className="form" onSubmit={submit}>
          <label htmlFor="patient-identifier">{usingEmail ? 'Email address' : 'Cell phone number'}</label>
          <input id="patient-identifier" type={usingEmail ? 'email' : 'tel'} autoComplete={usingEmail ? 'email' : 'tel'} placeholder={usingEmail ? 'you@example.com' : 'Your cell number'} value={phone} onChange={(event) => setPhone(event.target.value)} />
          <div className="field-row"><span /><button className="text-link" type="button" onClick={() => setUsingEmail(!usingEmail)}>{usingEmail ? 'Use phone instead' : 'Use email instead'}</button></div>
          <label htmlFor="patient-password">Password</label>
          <div className="password-wrap"><input id="patient-password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" placeholder="Your password" value={password} onChange={(event) => setPassword(event.target.value)} /><button className="reveal" type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
          <div className="field-row"><span /><button className="text-link" type="button">Forgot password?</button></div>
          <button className="primary" type="submit">Continue</button>
        </form>
        <section className="journey"><button type="button" className="create">Create new account</button><div className="quiet"><button type="button">Explore demo</button><span>·</span><button type="button">Provider login</button></div><p className="support">Your health journey, supported by your care team.</p></section>
      </div>
    </div>
  );
}