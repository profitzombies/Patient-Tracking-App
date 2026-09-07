import { useState, type FormEvent } from 'react';
import './_group.css';

function Mark() {
  return <span className="ss-mark" aria-label="THINNR">TH</span>;
}

export function SplitStageWeb() {
  const [phase, setPhase] = useState<'email' | 'code'>('email');
  const [demoOpen, setDemoOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const submit = (event: FormEvent) => { event.preventDefault(); setPhase('code'); };

  return (
    <main className="thinnr-login split-web">
      <style>{`
        .split-web{min-height:800px;height:100vh;min-height:100dvh;display:grid;grid-template-columns:51.4% 48.6%;background:var(--th-paper);overflow:hidden}
        .split-web *{box-sizing:border-box}.split-web button,.split-web input{font:inherit}.ss-stage{position:relative;overflow:hidden;background:var(--th-navy);isolation:isolate}
        .ss-stage:after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(18,43,76,.32),transparent 54%),linear-gradient(0deg,rgba(21,48,84,.48),transparent 46%);z-index:1}
        .ss-stage img{width:100%;height:100%;display:block;object-fit:cover;object-position:53% center;filter:saturate(.77) contrast(.96)}
        .ss-stage-copy{position:absolute;z-index:2;left:68px;bottom:63px;color:var(--th-card);max-width:366px}.ss-stage-copy:before{content:"";display:block;width:38px;height:3px;background:var(--th-warm);margin-bottom:19px}
        .ss-stage-copy p{font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;margin:0 0 13px;color:#d9e5f4}.ss-stage-copy h2{margin:0;font:400 39px/1.1 var(--th-font-display);letter-spacing:-.026em}.ss-stage-copy small{display:block;margin-top:16px;font-size:13px;line-height:1.6;color:#e5ebf3;max-width:315px}
        .ss-sheet{background:var(--th-paper-alt);display:flex;min-width:0;position:relative}.ss-sheet:before{content:"";position:absolute;top:0;left:0;height:100%;width:1px;background:rgba(255,255,255,.36)}
        .ss-inner{width:100%;max-width:450px;margin:auto;padding:42px 0 28px}.ss-brand{display:flex;align-items:center;gap:11px;margin-bottom:51px;color:var(--th-navy);font-size:14px;font-weight:650;letter-spacing:.01em}.ss-mark{display:grid;place-items:center;width:37px;height:37px;border-radius:8px;background:var(--th-navy);color:var(--th-brand-fg);font:700 13px var(--th-font-display);letter-spacing:.07em;box-shadow:var(--th-shadow-soft)}
        .ss-inner .th-kicker{margin:0 0 11px}.ss-inner h1{font:500 36px/1.1 var(--th-font-display);margin:0 0 28px;letter-spacing:-.034em}.ss-form{width:100%}.ss-field{display:block;font-size:12px;font-weight:700;color:var(--th-ink);margin-bottom:7px}.ss-input{width:100%;height:46px;border:1px solid var(--th-hairline);border-radius:var(--th-radius-control);background:var(--th-card);padding:0 13px;color:var(--th-ink);outline:none;font-size:14px;transition:border .16s,box-shadow .16s}.ss-input::placeholder{color:var(--th-label)}.ss-input:focus{border-color:var(--th-cobalt);box-shadow:0 0 0 3px rgba(49,94,174,.17)}.ss-helper{font-size:12px;line-height:1.5;color:var(--th-body);margin:9px 0 19px}.ss-primary{border:0;border-radius:var(--th-radius-control);background:var(--th-cobalt);color:#fff;width:100%;height:45px;font-size:13px;font-weight:700;cursor:pointer;transition:transform .16s,background .16s}.ss-primary:hover{background:var(--th-navy);transform:translateY(-1px)}.ss-primary:focus-visible,.ss-text:focus-visible{outline:2px solid var(--th-cobalt);outline-offset:3px}
        .ss-code-title{font:500 27px/1.16 var(--th-font-display);margin:0 0 8px;color:var(--th-navy);letter-spacing:-.02em}.ss-code-copy{font-size:12px;color:var(--th-body);line-height:1.5;margin:0 0 19px}.ss-otp{letter-spacing:.45em;text-align:center;font-weight:700;font-size:18px;padding-left:.45em}.ss-code-actions{display:flex;justify-content:center;gap:19px;margin-top:16px}.ss-text{background:none;border:0;padding:0;color:var(--th-cobalt);font-size:12px;font-weight:700;cursor:pointer}.ss-text.muted{color:var(--th-body)}
        .ss-demo{margin-top:30px;border-top:1px solid var(--th-hairline);padding-top:17px}.ss-demo-toggle{background:none;border:0;color:var(--th-body);font-size:12px;font-weight:650;padding:0;cursor:pointer;text-align:left}.ss-demo-toggle b{color:var(--th-cobalt);margin-left:7px;font-size:15px}.ss-demo-options{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:13px}.ss-persona{border:1px solid var(--th-hairline);background:var(--th-card);border-radius:var(--th-radius-card);padding:12px;min-height:130px}.ss-persona strong{font:600 14px var(--th-font-display);color:var(--th-navy)}.ss-persona p{font-size:10.5px;line-height:1.45;color:var(--th-body);margin:7px 0 10px}.ss-persona button{border:0;padding:0;background:none;color:var(--th-cobalt);font-size:11px;font-weight:750;cursor:pointer}.ss-note{font-size:10.5px;color:var(--th-label);line-height:1.5;margin:22px 0 0;max-width:385px}.ss-footer{position:absolute;bottom:23px;right:35px;font-size:9px;letter-spacing:.14em;text-transform:uppercase;font-weight:750;color:var(--th-label)}
        @media(max-width:800px){.split-web{grid-template-columns:1fr;overflow:auto}.ss-stage{height:280px}.ss-stage-copy{left:28px;bottom:28px}.ss-stage-copy h2{font-size:30px}.ss-sheet{min-height:600px}.ss-inner{padding:35px 26px}.ss-footer{position:static;margin:20px 0;text-align:center}.ss-brand{margin-bottom:35px}}
      `}</style>
      <section className="ss-stage" aria-label="A quiet THINNR practice">
        <img src="/__mockup/images/login-split-stage-hero.png" alt="Morning light in a quiet cream consultation room with a ledger on the desk." />
        <div className="ss-stage-copy"><p>Before the first appointment</p><h2>A practice keeps its own kind of calm.</h2><small>Operations, arranged with the same care patients feel when they arrive.</small></div>
      </section>
      <section className="ss-sheet">
        <div className="ss-inner">
          <div className="ss-brand"><Mark /> <span>THINNR Operations</span></div>
          {phase === 'email' ? <>
            <p className="th-kicker">Staff access</p><h1 className="th-display">Sign in to your desk.</h1>
            <form className="ss-form" onSubmit={submit}>
              <label className="ss-field" htmlFor="staff-email">Work email</label>
              <input className="ss-input" id="staff-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@yourclinic.com" />
              <p className="ss-helper">We'll email you a 6-digit sign-in code. No password needed.</p>
              <button className="ss-primary" type="submit">Email me a code</button>
            </form>
          </> : <>
            <p className="th-kicker">Check your inbox</p><h1 className="ss-code-title">Enter the code we emailed</h1><p className="ss-code-copy">If the address is recognised, a 6-digit code is on its way.</p>
            <form onSubmit={(e) => e.preventDefault()}><label className="ss-field" htmlFor="staff-code">6-digit sign-in code</label><input className="ss-input ss-otp" id="staff-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="000000" /><button className="ss-primary" style={{marginTop:19}} type="submit">Verify and sign in</button></form>
            <div className="ss-code-actions"><button className="ss-text" onClick={() => setCode('')}>Send a fresh code</button><button className="ss-text muted" onClick={() => setPhase('email')}>Use a different email</button></div>
          </>}
          <div className="ss-demo">
            <button className="ss-demo-toggle" onClick={() => setDemoOpen(!demoOpen)} aria-expanded={demoOpen}>Browse the guided demo without an account <b>{demoOpen ? '−' : '+'}</b></button>
            {demoOpen && <div className="ss-demo-options">
              <article className="ss-persona"><strong>THINNR HQ admin</strong><p>The umbrella above every office: rollups, provider accounts, and org tools.</p><button>Enter HQ admin →</button></article>
              <article className="ss-persona"><strong>Office staff</strong><p>Today's operations desk for the med spa team, exactly as it runs day to day.</p><button>Enter the office →</button></article>
            </div>}
          </div>
          <p className="ss-note">Staff sign in with a one-time email code. Patients sign in with their cell phone in the THINNR mobile app.</p>
        </div>
        <div className="ss-footer">Synthetic Demo Data • Not Medical Advice</div>
      </section>
    </main>
  );
}