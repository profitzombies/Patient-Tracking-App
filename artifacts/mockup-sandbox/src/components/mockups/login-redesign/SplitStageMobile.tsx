import { useState } from 'react';
import './_group.css';

export function SplitStageMobile() {
  const [emailMode, setEmailMode] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  return (
    <main className="thinnr-login split-mobile">
      <style>{`
        .split-mobile{width:393px;height:852px;position:relative;overflow:hidden;background:var(--th-paper);color:var(--th-ink);font-family:var(--th-font-body)}
        .split-mobile *{box-sizing:border-box}.sm-visual{height:286px;position:absolute;top:0;inset-inline:0;overflow:hidden;background:var(--th-navy)}.sm-visual:after{content:"";position:absolute;inset:0;background:linear-gradient(0deg,rgba(29,53,87,.68),transparent 64%)}.sm-visual img{width:100%;height:100%;object-fit:cover;object-position:54% 47%;filter:saturate(.72) contrast(.97)}
        .sm-top{height:54px;display:flex;align-items:center;justify-content:space-between;padding:8px 20px;position:relative;z-index:2}.sm-back{display:grid;place-items:center;width:35px;height:35px;border:1px solid rgba(253,252,249,.66);border-radius:7px;background:rgba(32,59,100,.25);color:var(--th-card);font-size:24px;line-height:1;cursor:pointer}.sm-mark{display:grid;place-items:center;width:34px;height:34px;background:var(--th-card);border-radius:8px;color:var(--th-navy);font:700 13px var(--th-font-display);letter-spacing:.08em;box-shadow:var(--th-shadow-soft)}.sm-spacer{width:35px}
        .sm-caption{position:absolute;z-index:2;top:216px;left:26px;color:var(--th-card);font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase}.sm-caption:before{content:"";display:inline-block;width:20px;height:2px;background:var(--th-warm);vertical-align:middle;margin-right:8px}
        .sm-sheet{position:absolute;z-index:3;top:251px;left:0;width:100%;bottom:0;background:var(--th-card);border-radius:17px 17px 0 0;padding:27px 25px 20px;box-shadow:0 -8px 22px rgba(32,59,100,.1)}.sm-sheet:before{content:"";position:absolute;top:10px;left:calc(50% - 17px);width:34px;height:3px;border-radius:2px;background:var(--th-hairline)}
        .sm-kicker{margin:8px 0 8px}.sm-title{margin:0 0 21px;color:var(--th-navy);font:500 33px/1.05 var(--th-font-display);letter-spacing:-.035em}.sm-label{display:block;color:var(--th-ink);font-size:12px;font-weight:700;margin:0 0 7px}.sm-input{width:100%;height:46px;border-radius:var(--th-radius-control);border:1px solid var(--th-hairline);background:var(--th-paper-alt);padding:0 12px;color:var(--th-ink);font-size:14px;outline:none}.sm-input:focus{border-color:var(--th-cobalt);box-shadow:0 0 0 3px rgba(49,94,174,.16)}.sm-input::placeholder{color:var(--th-label)}.sm-link-row{display:flex;justify-content:flex-end;min-height:26px;align-items:center}.sm-link{border:0;background:none;padding:5px 0;color:var(--th-cobalt);font-size:12px;font-weight:700;cursor:pointer}.sm-password-wrap{position:relative}.sm-password-wrap .sm-input{padding-right:64px}.sm-reveal{position:absolute;right:10px;top:9px;border:0;background:none;color:var(--th-cobalt);font-size:11px;font-weight:750;padding:6px;cursor:pointer}.sm-continue{height:46px;width:100%;border:0;border-radius:var(--th-radius-control);background:var(--th-cobalt);color:#fff;font-size:14px;font-weight:750;cursor:pointer;margin-top:4px;box-shadow:0 2px 4px rgba(32,59,100,.13)}.sm-continue:focus-visible,.sm-link:focus-visible,.sm-back:focus-visible{outline:2px solid var(--th-cobalt);outline-offset:2px}.sm-code-hint{font-size:10.5px;line-height:1.4;color:var(--th-body);text-align:center;margin:9px 0 0}.sm-bottom{margin-top:17px;text-align:center}.sm-create{font-size:13px;font-weight:750;color:var(--th-cobalt);border:0;background:none;padding:5px;cursor:pointer}.sm-quiet{margin:8px 0 0;font-size:11px;color:var(--th-label)}.sm-quiet button{border:0;background:none;padding:0;color:var(--th-body);font-size:11px;font-weight:650;cursor:pointer}.sm-closing{font:italic 12.5px/1.5 var(--th-font-display);color:var(--th-body);text-align:center;margin:15px auto 0;max-width:260px}.sm-home{position:absolute;z-index:5;bottom:8px;left:calc(50% - 53px);height:4px;width:106px;border-radius:4px;background:var(--th-navy);opacity:.72}
      `}</style>
      <div className="sm-visual"><img src="/__mockup/images/login-split-stage-hero.png" alt="" /></div>
      <header className="sm-top"><button className="sm-back" aria-label="Go back">‹</button><span className="sm-mark">TH</span><span className="sm-spacer" /></header>
      <div className="sm-caption">The room is ready</div>
      <section className="sm-sheet">
        <p className="th-kicker sm-kicker">Patient access</p>
        <h1 className="sm-title">Welcome back</h1>
        <label className="sm-label" htmlFor="patient-id">{emailMode ? 'Email address' : 'Cell phone number'}</label>
        <input id="patient-id" className="sm-input" type={emailMode ? 'email' : 'tel'} autoComplete={emailMode ? 'email' : 'tel'} placeholder={emailMode ? 'Your email' : 'Your cell number'} />
        <div className="sm-link-row"><button className="sm-link" onClick={() => setEmailMode(!emailMode)}>{emailMode ? 'Use cell phone instead' : 'Use email instead'}</button></div>
        <label className="sm-label" htmlFor="patient-password">Password</label>
        <div className="sm-password-wrap"><input id="patient-password" className="sm-input" type={passwordVisible ? 'text' : 'password'} autoComplete="current-password" placeholder="Your password" /><button className="sm-reveal" onClick={() => setPasswordVisible(!passwordVisible)}>{passwordVisible ? 'Hide' : 'Show'}</button></div>
        <div className="sm-link-row"><button className="sm-link">Forgot password?</button></div>
        <button className="sm-continue">Continue</button><p className="sm-code-hint">We'll then send a 6-digit code by text.</p>
        <div className="sm-bottom"><button className="sm-create">Create new account</button><p className="sm-quiet"><button>Explore demo</button> <span>·</span> <button>Provider login</button></p><p className="sm-closing">Your health journey, supported by your care team.</p></div>
      </section><div className="sm-home" />
    </main>
  );
}