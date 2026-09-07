import { useState, type FormEvent } from 'react';
import { ArrowRight, ChevronDown } from 'lucide-react';
import './_group.css';

type Phase = 'email' | 'code';

function BrandMark({ large = false }: { large?: boolean }) {
  return <span className={`monogram-mark ${large ? 'monogram-mark-large' : ''}`} aria-label="THINNR">TH</span>;
}

export function MonogramWeb() {
  const [phase, setPhase] = useState<Phase>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [demoOpen, setDemoOpen] = useState(false);

  const submitEmail = (event: FormEvent) => {
    event.preventDefault();
    setPhase('code');
  };

  const submitCode = (event: FormEvent) => {
    event.preventDefault();
  };

  return (
    <div className="thinnr-login monogram-web">
      <style>{`
        .monogram-web{min-height:800px;height:100vh;min-width:980px;overflow:hidden;position:relative;background:var(--th-paper);color:var(--th-ink);font-family:var(--th-font-body)}
        .monogram-web *{box-sizing:border-box}.monogram-web button,.monogram-web input{font:inherit}
        .monogram-web:before{content:"TH";position:absolute;left:-75px;bottom:-255px;font:700 650px/.75 var(--th-font-display);letter-spacing:-.12em;color:transparent;-webkit-text-stroke:1px rgba(32,59,100,.14);pointer-events:none}
        .monogram-web:after{content:"";position:absolute;inset:22px;border:1px solid rgba(32,59,100,.12);border-radius:var(--th-radius-card);pointer-events:none}
        .monogram-web .topline{position:absolute;top:42px;left:64px;right:64px;z-index:2;display:flex;align-items:center;justify-content:space-between}
        .monogram-web .identity{display:flex;align-items:center;gap:12px;font-size:13px;font-weight:650;color:var(--th-navy);letter-spacing:.01em}
        .monogram-web .monogram-mark{display:grid;place-items:center;width:38px;height:38px;border-radius:9px;background:var(--th-navy);color:var(--th-brand-fg);font:700 14px var(--th-font-display);letter-spacing:-.08em;box-shadow:var(--th-shadow-soft)}
        .monogram-web .top-meta{font-size:10px;font-weight:700;color:var(--th-label);letter-spacing:.14em;text-transform:uppercase}
        .monogram-web main{position:relative;z-index:1;width:100%;height:100%;display:flex;align-items:center;justify-content:center;padding:124px 64px 96px}
        .monogram-web .entry{width:402px;margin-left:260px;animation:monogram-rise .7s cubic-bezier(.2,.8,.2,1) both}
        .monogram-web .eyebrow{display:flex;align-items:center;gap:10px;margin-bottom:16px}.monogram-web .line{width:22px;height:1px;background:var(--th-warm)}
        .monogram-web h1{font:600 41px/1.05 var(--th-font-display);letter-spacing:-.045em;color:var(--th-navy);margin:0 0 32px}
        .monogram-web .form-card{background:rgba(253,252,249,.84);border:1px solid var(--th-hairline);border-radius:var(--th-radius-card);padding:24px;box-shadow:var(--th-shadow-soft);backdrop-filter:blur(8px)}
        .monogram-web label{display:block;color:var(--th-ink);font-size:12px;font-weight:700;margin-bottom:8px}.monogram-web input{display:block;width:100%;height:46px;border:1px solid var(--th-hairline);border-radius:var(--th-radius-control);background:var(--th-paper-alt);padding:0 13px;color:var(--th-ink);font-size:14px;outline:none}
        .monogram-web input::placeholder{color:var(--th-label)}.monogram-web input:focus{border-color:var(--th-cobalt);box-shadow:0 0 0 3px rgba(49,94,174,.18)}
        .monogram-web .helper{margin:9px 0 19px;color:var(--th-body);font-size:11.5px;line-height:1.5}
        .monogram-web .primary{height:46px;width:100%;border:0;border-radius:var(--th-radius-control);background:var(--th-cobalt);color:#f7f9fd;cursor:pointer;font-size:13px;font-weight:700;transition:transform .2s,background .2s}.monogram-web .primary:hover{background:var(--th-navy);transform:translateY(-1px)}.monogram-web button:focus-visible{outline:3px solid rgba(49,94,174,.4);outline-offset:2px}
        .monogram-web .code-title{font:600 25px/1.15 var(--th-font-display);letter-spacing:-.03em;color:var(--th-navy);margin:0 0 8px}.monogram-web .code-copy{font-size:12px;line-height:1.55;color:var(--th-body);margin:0 0 20px}.monogram-web .code-input{text-align:center;letter-spacing:.43em;font-weight:700;font-size:17px}
        .monogram-web .quiet-actions{display:flex;justify-content:center;gap:18px;margin-top:16px}.monogram-web .quiet-actions button,.monogram-web .demo-toggle,.monogram-web .demo-cta{border:0;background:none;color:var(--th-cobalt);cursor:pointer;font-size:11.5px;font-weight:700;padding:3px}.monogram-web .quiet-actions button:last-child{color:var(--th-body)}
        .monogram-web .demo-toggle{display:flex;align-items:center;gap:7px;margin:19px auto 0;color:var(--th-label);font-weight:600}.monogram-web .demo-toggle svg{transition:transform .2s}.monogram-web .demo-toggle.open svg{transform:rotate(180deg)}
        .monogram-web .demos{margin-top:12px;display:grid;gap:8px}.monogram-web .demo-option{position:relative;border-top:1px solid var(--th-hairline);padding:12px 0 0}.monogram-web .demo-option h3{margin:0;color:var(--th-navy);font:600 16px var(--th-font-display)}.monogram-web .demo-option p{max-width:305px;margin:5px 0 0;color:var(--th-body);font-size:10.5px;line-height:1.45}.monogram-web .demo-cta{position:absolute;right:0;top:13px;font-size:10.5px;display:flex;align-items:center;gap:4px}
        .monogram-web .note{width:366px;margin:27px auto 0;color:var(--th-label);font-size:10.5px;line-height:1.5;text-align:center}.monogram-web footer{position:absolute;bottom:37px;right:64px;z-index:2;color:var(--th-label);font-size:9.5px;font-weight:700;letter-spacing:.13em;text-transform:uppercase}
        @keyframes monogram-rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
      `}</style>
      <header className="topline">
        <div className="identity"><BrandMark /> <span>THINNR Operations</span></div>
        <span className="top-meta">Staff sign-in</span>
      </header>
      <main>
        <section className="entry" aria-label="Staff sign in">
          <div className="eyebrow"><span className="line" /><span className="th-kicker">A considered access point</span></div>
          <h1 className="th-display">Your desk,<br />in good order.</h1>
          <div className="form-card">
            {phase === 'email' ? <form onSubmit={submitEmail}>
              <label htmlFor="work-email">Work email</label>
              <input id="work-email" type="email" autoComplete="email" placeholder="you@yourclinic.com" value={email} onChange={(event) => setEmail(event.target.value)} />
              <p className="helper">We'll email you a 6-digit sign-in code. No password needed.</p>
              <button className="primary" type="submit">Email me a code</button>
            </form> : <form onSubmit={submitCode}>
              <h2 className="code-title">Enter the code we emailed</h2>
              <p className="code-copy">A 6-digit code is on its way to {email || 'your work email'}.</p>
              <label htmlFor="staff-code">6-digit sign-in code</label>
              <input className="code-input" id="staff-code" inputMode="numeric" maxLength={6} autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} placeholder="000000" />
              <button className="primary" type="submit" style={{ marginTop: 18 }}>Verify and sign in</button>
              <div className="quiet-actions"><button type="button" onClick={() => setCode('')}>Send a fresh code</button><button type="button" onClick={() => setPhase('email')}>Use a different email</button></div>
            </form>}
          </div>
          {phase === 'email' && <>
            <button type="button" className={`demo-toggle ${demoOpen ? 'open' : ''}`} onClick={() => setDemoOpen(!demoOpen)} aria-expanded={demoOpen}>Browse the guided demo without an account <ChevronDown size={13} /></button>
            {demoOpen && <div className="demos">
              <article className="demo-option"><h3>THINNR HQ admin</h3><p>The umbrella above every office: rollups, provider accounts, and org tools.</p><button className="demo-cta" type="button">Enter HQ admin <ArrowRight size={12} /></button></article>
              <article className="demo-option"><h3>Office staff</h3><p>Today's operations desk for the med spa team, exactly as it runs day to day.</p><button className="demo-cta" type="button">Enter the office <ArrowRight size={12} /></button></article>
            </div>}
          </>}
          <p className="note">Staff sign in with a one-time email code. Patients sign in with their cell phone in the THINNR mobile app.</p>
        </section>
      </main>
      <footer>Synthetic Demo Data • Not Medical Advice</footer>
    </div>
  );
}