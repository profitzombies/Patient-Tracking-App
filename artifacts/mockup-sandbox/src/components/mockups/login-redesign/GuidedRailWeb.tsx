import { useState, type FormEvent } from 'react';
import './_group.css';

type Phase = 'email' | 'code';

function Mark() {
  return <span className="gr-mark" aria-label="THINNR">TH</span>;
}

function RailNode({ number, title, detail, active, children }: { number: string; title: string; detail: string; active?: boolean; children?: React.ReactNode }) {
  return (
    <article className={`gr-node ${active ? 'is-active' : ''}`}>
      <div className="gr-node-head"><span className="gr-num">{number}</span><div><p className="gr-node-title">{title}</p><p className="gr-node-detail">{detail}</p></div></div>
      {children}
    </article>
  );
}

export function GuidedRailWeb() {
  const [phase, setPhase] = useState<Phase>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [demoOpen, setDemoOpen] = useState(false);
  const submit = (event: FormEvent) => { event.preventDefault(); setPhase('code'); };
  return (
    <main className="thinnr-login guided-rail-web">
      <style>{`
        .guided-rail-web{--gr-pad:clamp(38px,6vw,88px); box-sizing:border-box; position:relative; overflow:hidden; width:100%; min-height:800px; padding:39px var(--gr-pad) 40px; background:var(--th-paper); color:var(--th-ink)}
        .guided-rail-web *{box-sizing:border-box}.guided-rail-web button,.guided-rail-web input{font:inherit}.guided-rail-web:before{content:"";position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,transparent 0,transparent 4px,rgba(32,59,100,.015) 5px)}
        .gr-top,.gr-content,.gr-footer{position:relative;z-index:1}.gr-top{display:flex;align-items:center;justify-content:space-between}.gr-brand{display:flex;align-items:center;gap:11px;color:var(--th-navy);font-size:14px;font-weight:700;letter-spacing:-.01em}.gr-mark{display:grid;place-items:center;width:38px;height:38px;border-radius:8px;background:var(--th-navy);box-shadow:var(--th-shadow-soft);font-family:var(--th-font-display);font-size:14px;font-weight:bold;letter-spacing:.07em;color:var(--th-brand-fg)}.gr-step-note{font-size:11px;color:var(--th-label);letter-spacing:.08em;text-transform:uppercase;font-weight:700}
        .gr-content{max-width:1104px;margin:72px auto 0}.gr-intro{max-width:560px}.gr-intro h1{font-family:var(--th-font-display);font-size:49px;line-height:1.06;letter-spacing:-.045em;color:var(--th-navy);margin:10px 0 12px}.gr-intro p{margin:0;color:var(--th-body);font-size:14px;line-height:1.65;max-width:480px}
        .gr-rail{position:relative;display:grid;grid-template-columns:1.42fr 1fr 1fr;gap:0;margin-top:48px}.gr-rail:before{content:"";position:absolute;left:37px;right:72px;top:21px;border-top:1px solid var(--th-accent-border)}.gr-node{position:relative;padding-right:40px;opacity:.52}.gr-node.is-active{opacity:1}.gr-node-head{position:relative;display:flex;align-items:flex-start;gap:13px;min-height:75px}.gr-num{display:grid;position:relative;z-index:1;place-items:center;flex:none;width:43px;height:43px;border:1px solid var(--th-accent-border);border-radius:50%;background:var(--th-paper);color:var(--th-cobalt);font-size:12px;font-weight:800}.is-active .gr-num{background:var(--th-cobalt);border-color:var(--th-cobalt);color:var(--th-card);box-shadow:0 0 0 6px var(--th-paper)}.gr-node-title{margin:3px 0 3px;color:var(--th-navy);font-size:14px;font-weight:750}.gr-node-detail{margin:0;max-width:185px;color:var(--th-body);font-size:11px;line-height:1.45}
        .gr-form{margin-left:56px;width:calc(100% - 56px);padding:22px;border:1px solid var(--th-hairline);border-radius:var(--th-radius-card);background:var(--th-card);box-shadow:var(--th-shadow-soft)}.gr-form label{display:block;color:var(--th-navy);font-size:12px;font-weight:700;margin-bottom:7px}.gr-form input{width:100%;height:44px;padding:0 12px;border:1px solid var(--th-hairline);border-radius:var(--th-radius-control);background:var(--th-paper-alt);color:var(--th-ink);outline:none;font-size:13px}.gr-form input:focus{border-color:var(--th-cobalt);box-shadow:0 0 0 3px var(--th-accent)}.gr-helper{margin:8px 0 17px;color:var(--th-label);font-size:11px;line-height:1.5}.gr-primary{height:42px;width:100%;border:0;border-radius:var(--th-radius-control);background:var(--th-cobalt);color:var(--th-card);cursor:pointer;font-weight:700;font-size:12px;transition:transform .2s,background .2s}.gr-primary:hover{background:var(--th-navy);transform:translateY(-1px)}
        .gr-ghost{margin-left:56px;width:calc(100% - 56px);height:142px;border:1px solid var(--th-hairline);border-radius:var(--th-radius-card);background:rgba(253,252,249,.58);padding:22px}.gr-code-boxes{display:flex;gap:6px;margin-top:19px}.gr-code-boxes i{display:block;width:24px;height:30px;border:1px solid var(--th-accent-border);border-radius:5px;background:rgba(227,236,247,.45)}.gr-desk{margin:0 0 0 56px;width:calc(100% - 56px);height:142px;border:1px solid var(--th-hairline);border-radius:var(--th-radius-card);background:rgba(227,236,247,.3);padding:16px}.gr-desk-top{height:7px;width:48%;background:var(--th-cobalt-muted);opacity:.55}.gr-desk-line{height:1px;background:var(--th-accent-border);margin:14px 0}.gr-desk-row{height:9px;background:var(--th-card);margin:8px 0}.gr-desk-row:nth-child(4){width:73%}.gr-desk-row:nth-child(5){width:82%}
        .gr-under{display:grid;grid-template-columns:1.42fr 2fr;margin-top:34px;padding-top:20px;border-top:1px solid var(--th-hairline)}.gr-demo-toggle{justify-self:start;border:0;padding:0;background:none;color:var(--th-cobalt);font-size:12px;font-weight:700;cursor:pointer}.gr-demo-toggle:focus-visible,.gr-text-button:focus-visible{outline:2px solid var(--th-cobalt);outline-offset:3px}.gr-note{margin:0;color:var(--th-label);font-size:10.5px;line-height:1.45;max-width:450px}.gr-demo{grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:18px}.gr-persona{padding:15px;border:1px solid var(--th-hairline);border-radius:var(--th-radius-card);background:var(--th-card)}.gr-persona strong{display:block;color:var(--th-navy);font-size:13px}.gr-persona p{min-height:32px;margin:5px 0 10px;color:var(--th-body);font-size:11px;line-height:1.4}.gr-text-button{border:0;padding:0;background:none;color:var(--th-cobalt);font-size:11px;font-weight:750;cursor:pointer}.gr-code-title{margin:0 0 4px;font-family:var(--th-font-display);font-size:21px;color:var(--th-navy)}.gr-code-actions{display:flex;gap:14px;margin-top:13px}.gr-footer{position:absolute;bottom:15px;left:var(--gr-pad);font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--th-label);font-weight:700}
        @media(max-width:760px){.guided-rail-web{min-height:800px;padding:28px}.gr-content{margin-top:45px}.gr-rail{grid-template-columns:1fr;gap:20px}.gr-rail:before{left:21px;top:21px;bottom:21px;right:auto;border-top:0;border-left:1px solid var(--th-accent-border)}.gr-node{padding:0}.gr-form,.gr-ghost,.gr-desk{margin-left:56px;width:calc(100% - 56px)}.gr-under{grid-template-columns:1fr;gap:15px}.gr-demo{grid-template-columns:1fr}.gr-footer{position:relative;left:auto;bottom:auto;margin-top:35px}}
      `}</style>
      <header className="gr-top"><div className="gr-brand"><Mark /> <span>THINNR Operations</span></div><span className="gr-step-note">Secure staff access</span></header>
      <section className="gr-content">
        <div className="gr-intro"><span className="th-kicker">A short way to your desk</span><h1>Three quick things.<br />Then you’re in.</h1><p>Your workday begins with one private email. We’ll show you the whole path before you take the first step.</p></div>
        <div className="gr-rail">
          <RailNode number="01" title="Work email" detail="Tell us where to send your sign-in code." active={phase === 'email'}>
            {phase === 'email' ? <form className="gr-form" onSubmit={submit}><label htmlFor="guided-email">Work email</label><input id="guided-email" autoComplete="email" type="email" placeholder="you@yourclinic.com" value={email} onChange={(e) => setEmail(e.target.value)} /><p className="gr-helper">We’ll email you a 6-digit sign-in code. No password needed.</p><button className="gr-primary" type="submit">Email me a code</button></form> : <div className="gr-ghost"><div className="gr-desk-top" /><div className="gr-desk-line" /><div className="gr-desk-row" /><div className="gr-desk-row" /></div>}
          </RailNode>
          <RailNode number="02" title="Code from your inbox" detail="One short code confirms it’s you." active={phase === 'code'}>
            {phase === 'code' ? <form className="gr-form" onSubmit={(e) => e.preventDefault()}><h2 className="gr-code-title">Enter the code we emailed</h2><label htmlFor="guided-code">6-digit sign-in code</label><input id="guided-code" inputMode="numeric" maxLength={6} placeholder="— — — — — —" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g,''))}/><div className="gr-code-actions"><button type="button" className="gr-text-button">Send a fresh code</button><button type="button" className="gr-text-button" onClick={() => setPhase('email')}>Use a different email</button></div></form> : <div className="gr-ghost"><div className="gr-code-boxes">{Array.from({length:6}).map((_,i)=><i key={i}/>)}</div></div>}
          </RailNode>
          <RailNode number="03" title="Your desk" detail="The right view for your role, ready for today."><div className="gr-desk"><div className="gr-desk-top" /><div className="gr-desk-line" /><div className="gr-desk-row" /><div className="gr-desk-row" /><div className="gr-desk-row" /></div></RailNode>
        </div>
        <div className="gr-under"><button className="gr-demo-toggle" onClick={() => setDemoOpen(!demoOpen)} aria-expanded={demoOpen}>Browse the guided demo without an account {demoOpen ? '−' : '+'}</button><p className="gr-note">Staff sign in with a one-time email code. Patients sign in with their cell phone in the THINNR mobile app.</p>{demoOpen && <div className="gr-demo"><section className="gr-persona"><strong>THINNR HQ admin</strong><p>The umbrella above every office: rollups, provider accounts, and org tools.</p><button className="gr-text-button">Enter HQ admin →</button></section><section className="gr-persona"><strong>Office staff</strong><p>Today’s operations desk for the med spa team, exactly as it runs day to day.</p><button className="gr-text-button">Enter the office →</button></section></div>}</div>
      </section>
      <footer className="gr-footer">Synthetic Demo Data • Not Medical Advice</footer>
    </main>
  );
}