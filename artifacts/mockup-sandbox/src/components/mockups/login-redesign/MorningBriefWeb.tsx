import { useState, type FormEvent } from 'react';
import { ArrowRight, ChevronDown, Mail } from 'lucide-react';
import './_group.css';

type Phase = 'email' | 'code';

const BrandMark = () => <span className="mb-mark" aria-label="THINNR">TH</span>;

export function MorningBriefWeb() {
  const [phase, setPhase] = useState<Phase>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [showDemo, setShowDemo] = useState(false);
  const [notice, setNotice] = useState('');
  const submitEmail = (event: FormEvent) => {
    event.preventDefault();
    setNotice('If that address has an account, a sign-in code is on its way.');
    setPhase('code');
  };
  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    setNotice('This is a design preview. Your sign-in would continue here.');
  };

  return (
    <main className="thinnr-login mb-web">
      <style>{`
        .mb-web{box-sizing:border-box;min-height:800px;height:100vh;min-width:980px;background:var(--th-paper);color:var(--th-ink);padding:29px 48px 0;display:flex;flex-direction:column;overflow:hidden}
        .mb-web *{box-sizing:border-box}.mb-web button,.mb-web input{font:inherit}.mb-web button{cursor:pointer}
        .mb-top{height:64px;border-bottom:1px solid var(--th-hairline);display:flex;align-items:flex-start;justify-content:space-between}
        .mb-brand{display:flex;align-items:center;gap:12px;color:var(--th-navy);font-size:14px;font-weight:650;letter-spacing:-.01em}.mb-mark{height:36px;width:36px;border-radius:8px;background:var(--th-navy);color:var(--th-brand-fg);display:grid;place-items:center;font-family:var(--th-font-display);font-size:15px;font-weight:700;letter-spacing:.03em;box-shadow:var(--th-shadow-soft)}
        .mb-edition{font-size:10px;letter-spacing:.13em;font-weight:700;text-transform:uppercase;color:var(--th-label);padding-top:11px}.mb-edition i{font-style:normal;color:var(--th-warm);font-size:13px;padding:0 8px}
        .mb-grid{width:100%;max-width:1184px;margin:0 auto;display:grid;grid-template-columns:1.03fr 1.45fr .92fr;column-gap:34px;flex:1;padding-top:35px;align-items:start}.mb-rail{padding-top:47px}.mb-folio{font:700 10px var(--th-font-body);letter-spacing:.15em;color:var(--th-label);text-transform:uppercase;border-bottom:3px solid var(--th-navy);padding-bottom:10px}
        .mb-date{font-family:var(--th-font-display);font-size:47px;line-height:.96;letter-spacing:-.045em;color:var(--th-navy);margin:19px 0 20px;max-width:285px}.mb-column{font-size:12px;line-height:1.65;color:var(--th-body);max-width:278px}.mb-column:first-letter{color:var(--th-navy);font-family:var(--th-font-display);font-size:38px;line-height:.7;float:left;margin:8px 5px 0 0}
        .mb-stamp{margin-top:29px;border-top:1px solid var(--th-hairline);border-bottom:1px solid var(--th-hairline);padding:12px 0;color:var(--th-navy);font-size:11px;font-weight:650;line-height:1.5}.mb-stamp b{display:block;color:var(--th-warm);font-size:9px;letter-spacing:.14em;text-transform:uppercase;margin-bottom:3px}
        .mb-lead{border-left:1px solid var(--th-hairline);border-right:1px solid var(--th-hairline);padding:0 34px}.mb-mast{font:700 10px var(--th-font-body);letter-spacing:.18em;text-transform:uppercase;color:var(--th-cobalt);margin:0 0 7px}.mb-title{font-family:var(--th-font-display);font-size:43px;line-height:1;letter-spacing:-.04em;color:var(--th-navy);margin:0}.mb-deck{font-size:13px;line-height:1.55;color:var(--th-body);margin:13px 0 22px;max-width:480px}
        .mb-card{background:var(--th-card);border:1px solid var(--th-hairline);border-radius:var(--th-radius-card);box-shadow:var(--th-shadow-soft);padding:22px}.mb-card-head{display:flex;gap:10px;align-items:center;padding-bottom:16px;border-bottom:1px solid var(--th-hairline);margin-bottom:17px}.mb-mail{height:28px;width:28px;border-radius:7px;background:var(--th-accent);display:grid;place-items:center;color:var(--th-cobalt)}.mb-card-head strong{font-family:var(--th-font-display);color:var(--th-navy);font-size:18px}.mb-card-head span{display:block;font-size:10px;color:var(--th-label);letter-spacing:.1em;text-transform:uppercase;margin-top:2px}
        .mb-field{display:block;font-size:11px;font-weight:700;color:var(--th-navy);letter-spacing:.02em}.mb-input{margin-top:7px;width:100%;height:42px;border:1px solid var(--th-hairline);border-radius:var(--th-radius-control);background:var(--th-paper-alt);padding:0 12px;color:var(--th-ink);outline:none;font-size:13px}.mb-input:focus{border-color:var(--th-cobalt);box-shadow:0 0 0 3px rgba(49,94,174,.18)}.mb-helper{font-size:11px;line-height:1.5;color:var(--th-label);margin:8px 0 16px}.mb-btn{height:42px;width:100%;border:0;border-radius:var(--th-radius-control);background:var(--th-cobalt);color:var(--th-card);font-size:12px;font-weight:700;letter-spacing:.01em}.mb-btn:hover{background:var(--th-navy)}.mb-links{display:flex;justify-content:center;gap:17px;margin-top:14px}.mb-textbtn{border:0;background:none;color:var(--th-cobalt);font-size:11px;font-weight:650;padding:2px;text-decoration:underline;text-underline-offset:3px}
        .mb-notice{background:var(--th-accent);color:var(--th-navy);font-size:11px;line-height:1.45;padding:9px 10px;border-radius:6px;margin:0 0 13px}.mb-right{padding-top:47px}.mb-side-head{font:700 10px var(--th-font-body);letter-spacing:.15em;color:var(--th-label);text-transform:uppercase;padding-bottom:10px;border-bottom:1px solid var(--th-hairline);margin-bottom:4px}.mb-desk{padding:18px 0;border-bottom:1px solid var(--th-hairline)}.mb-desk-no{color:var(--th-warm);font-size:10px;font-weight:700;letter-spacing:.13em}.mb-desk h2{font:700 18px var(--th-font-display);color:var(--th-navy);letter-spacing:-.02em;margin:5px 0 7px}.mb-desk p{font-size:11px;line-height:1.55;color:var(--th-body);margin:0}.mb-enter{border:0;background:none;padding:8px 0 0;color:var(--th-cobalt);font-size:11px;font-weight:700;display:flex;align-items:center;gap:6px}.mb-demo{margin-top:20px;border:1px solid var(--th-hairline);border-radius:var(--th-radius-card);background:transparent;padding:10px;width:100%;display:flex;justify-content:space-between;align-items:center;color:var(--th-body);font-size:11px;text-align:left}.mb-demo:hover{background:var(--th-card)}.mb-demo svg{transition:transform .2s}.mb-demo.open svg{transform:rotate(180deg)}.mb-side-demos{margin-top:9px}.mb-bottom{height:54px;border-top:1px solid var(--th-hairline);display:flex;align-items:center;justify-content:space-between;font-size:10px;color:var(--th-label)}.mb-bottom strong{font-size:9px;letter-spacing:.13em;text-transform:uppercase}.mb-bottom span:last-child{max-width:480px;text-align:right}
      `}</style>
      <header className="mb-top">
        <div className="mb-brand"><BrandMark /> <span>THINNR Operations</span></div>
        <div className="mb-edition">The operations daily <i>•</i> Monday edition</div>
      </header>
      <div className="mb-grid">
        <aside className="mb-rail">
          <div className="mb-folio">Today’s brief / 09.07.26</div>
          <div className="mb-date">Monday,<br />September 7<br />2026</div>
          <p className="mb-column">The work of care begins before the first appointment. This is the quiet front desk for the teams keeping every program clear, personal, and on time.</p>
          <div className="mb-stamp"><b>Office note</b>18 patient check-ins expected before noon</div>
        </aside>
        <section className="mb-lead" aria-label="Sign in">
          <p className="mb-mast">THINNR / a morning brief for the care team</p>
          <h1 className="mb-title">Open today’s<br />operations desk.</h1>
          <p className="mb-deck">Your schedule, your patients, and the work in front of you—kept in one considered place.</p>
          <div className="mb-card">
            {phase === 'email' ? <form onSubmit={submitEmail}>
              <div className="mb-card-head"><div className="mb-mail"><Mail size={14} /></div><div><strong>Staff sign in</strong><span>One-time email code</span></div></div>
              <label className="mb-field" htmlFor="morning-email">Work email</label>
              <input id="morning-email" className="mb-input" type="email" placeholder="you@yourclinic.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              <p className="mb-helper">We'll email you a 6-digit sign-in code. No password needed.</p>
              <button className="mb-btn" type="submit">Email me a code</button>
            </form> : <form onSubmit={submitCode}>
              <div className="mb-card-head"><div className="mb-mail"><Mail size={14} /></div><div><strong>Enter the code we emailed</strong><span>Sign-in verification</span></div></div>
              {notice && <p className="mb-notice">{notice}</p>}
              <label className="mb-field" htmlFor="morning-code">6-digit sign-in code</label>
              <input id="morning-code" className="mb-input" inputMode="numeric" maxLength={6} placeholder="— — — — — —" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              <p className="mb-helper">If that address has an account, a code is on its way.</p>
              <button className="mb-btn" type="submit">Verify and sign in</button>
              <div className="mb-links"><button type="button" className="mb-textbtn" onClick={() => setNotice('A fresh code is on its way.')}>Send a fresh code</button><button type="button" className="mb-textbtn" onClick={() => { setPhase('email'); setNotice(''); }}>Use a different email</button></div>
            </form>}
          </div>
        </section>
        <aside className="mb-right">
          <div className="mb-side-head">The guided edition</div>
          {showDemo && <div className="mb-side-demos">
            <article className="mb-desk"><span className="mb-desk-no">DESK 01</span><h2>THINNR HQ admin</h2><p>The umbrella above every office: rollups, provider accounts, and org tools.</p><button className="mb-enter" type="button">Enter HQ admin <ArrowRight size={13} /></button></article>
            <article className="mb-desk"><span className="mb-desk-no">DESK 02</span><h2>Office staff</h2><p>Today's operations desk for the med spa team, exactly as it runs day to day.</p><button className="mb-enter" type="button">Enter the office <ArrowRight size={13} /></button></article>
          </div>}
          <button type="button" className={`mb-demo ${showDemo ? 'open' : ''}`} onClick={() => setShowDemo(!showDemo)} aria-expanded={showDemo}><span>Browse the guided demo<br />without an account</span><ChevronDown size={16} /></button>
        </aside>
      </div>
      <footer className="mb-bottom"><strong>Synthetic Demo Data • Not Medical Advice</strong><span>Staff sign in with a one-time email code. Patients sign in with their cell phone in the THINNR mobile app.</span></footer>
    </main>
  );
}