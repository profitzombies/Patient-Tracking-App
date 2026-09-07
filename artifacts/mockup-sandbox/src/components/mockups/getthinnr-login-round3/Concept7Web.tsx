import { useState, type FormEvent } from 'react';
import { ArrowRight, Check, ChevronDown, LockKeyhole } from 'lucide-react';
import './_thinnr-brand.css';

export function Concept7Web() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [demoOpen, setDemoOpen] = useState(false);
  const [notice, setNotice] = useState('');

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSent(true);
    setNotice(`A one-time sign-in code was sent to ${email || 'your work email'}.`);
  };

  return (
    <main className="thinnr-brand thinnr-brand-web c7-web">
      <style>{`
        .c7-web{width:100%;min-width:1000px;height:800px;min-height:100vh;overflow:hidden;background:#fdfdfb;color:#0a0a0a;font-family:Inter,system-ui,sans-serif;position:relative}
        .c7-web *{box-sizing:border-box}.c7-web button,.c7-web input{font-family:inherit}.c7-web button{cursor:pointer}.c7-web:after{content:"";position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(90deg,transparent 0,transparent calc(12.5% - 1px),rgba(10,10,10,.055) calc(12.5% - 1px),rgba(10,10,10,.055) 12.5%)}
        .c7-top{height:68px;border-bottom:1px solid #0a0a0a;display:flex;align-items:center;justify-content:space-between;padding:0 46px;position:relative;z-index:1;background:#fdfdfb}.c7-brand{font-family:"GT America Mono",ui-monospace,monospace;font-size:19px;letter-spacing:-.5px;font-weight:700}.c7-brand span{font-size:10px;letter-spacing:.1em;margin-left:12px;font-weight:600}.c7-index{font:10px "GT America Mono",ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase;color:#444}
        .c7-body{position:relative;z-index:1;height:692px;padding:0 10.2%;display:grid;grid-template-columns:minmax(420px,1fr) 380px;gap:12.5%;align-items:center}.c7-copy{align-self:center}.c7-code{font:10px "GT America Mono",ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;color:#4e4e4e;display:flex;align-items:center;gap:10px}.c7-code i{display:block;width:7px;height:7px;background:#4fb3b4;border-radius:50%}.c7-copy h1{font-family:"GT America Mono",ui-monospace,monospace;font-size:55px;line-height:.98;letter-spacing:-.04em;margin:19px 0 17px;text-transform:uppercase;max-width:590px}.c7-copy p{font-size:14px;line-height:1.6;max-width:395px;margin:0;color:#4b4b48}.c7-micro-index{display:flex;gap:25px;margin-top:55px;font:10px "GT America Mono",ui-monospace,monospace;color:#595959;letter-spacing:.05em}.c7-micro-index b{color:#0a0a0a;font-weight:700}.c7-auth{border:1px solid #0a0a0a;background:#fff;box-shadow:7px 7px 0 #8fd4d5;padding:0 26px 25px;position:relative}.c7-tabs{margin:0 -26px 23px;height:48px;border-bottom:1px solid #0a0a0a;display:flex}.c7-tab{height:48px;padding:0 15px;background:none;border:0;border-right:1px solid #0a0a0a;font:10px "GT America Mono",ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase}.c7-tab.active{background:#8fd4d5;font-weight:700}.c7-auth label{display:block;font:11px "GT America Mono",ui-monospace,monospace;letter-spacing:.04em;margin-bottom:8px}.c7-auth input{width:100%;height:47px;border:1px solid #0a0a0a;border-radius:0;padding:0 12px;font-size:14px;outline:none;background:#fdfdfb}.c7-auth input:focus{box-shadow:0 0 0 3px #8fd4d5}.c7-help{font-size:11.5px;line-height:1.45;color:#4a4a48;margin:9px 0 19px}.c7-submit{height:48px;border:1px solid #0a0a0a;background:#0a0a0a;color:#fff;width:100%;font:700 11px "GT America Mono",ui-monospace,monospace;text-transform:uppercase;letter-spacing:.09em;display:flex;align-items:center;justify-content:center;gap:9px;transition:transform .18s ease,background .18s ease}.c7-submit:hover{transform:translate(-2px,-2px);background:#222}.c7-submit:active{transform:none}.c7-status{font-size:11px;line-height:1.45;margin:14px 0 0;padding-left:11px;border-left:3px solid #8fd4d5;color:#242424}.c7-demo{width:100%;border:0;border-bottom:1px solid #0a0a0a;background:#fff;height:48px;margin-top:18px;padding:0;font:10px "GT America Mono",ui-monospace,monospace;text-transform:uppercase;letter-spacing:.09em;display:flex;align-items:center;justify-content:space-between}.c7-demo svg{transition:transform .2s ease}.c7-demo svg.open{transform:rotate(180deg)}.c7-options{display:grid;grid-template-columns:1fr 1fr;border:1px solid #0a0a0a;border-top:0}.c7-option{min-height:105px;background:#fdfdfb;border:0;padding:14px;text-align:left;font-size:11px;line-height:1.4}.c7-option+.c7-option{border-left:1px solid #0a0a0a}.c7-option strong{display:block;font:700 10px "GT America Mono",ui-monospace,monospace;text-transform:uppercase;letter-spacing:.05em;margin-bottom:7px}.c7-option:hover{background:#e7f7f7}.c7-foot{position:relative;z-index:1;height:40px;border-top:1px solid #0a0a0a;display:flex;align-items:center;justify-content:space-between;padding:0 46px;font:9px "GT America Mono",ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;color:#555}.c7-signal{display:flex;gap:6px}.c7-signal i{width:6px;height:6px;border-radius:50%;background:#8fd4d5}.c7-signal i:nth-child(2){background:#4fb3b4}.c7-signal i:nth-child(3){background:#0b0f0f}
      `}</style>
      <header className="c7-top">
        <div className="c7-brand th-brand"><img className="th-logo" src="/__mockup/images/getthinnr-login-round3-thinnr-logo.png" alt="THINNR" /><span>Operations</span></div>
        <div className="c7-index">Index / Staff Access / 01</div>
      </header>
      <section className="c7-body">
        <div className="c7-copy">
          <div className="c7-code"><i /> Protocol 01 — Staff sign in</div>
          <h1>Operations,<br />in order.</h1>
          <p>Access the operating desk for teams keeping each day clear, coordinated, and moving.</p>
          <div className="c7-micro-index"><span><b>01</b> Secure entry</span><span><b>02</b> One-time code</span><span><b>03</b> Begin work</span></div>
        </div>
        <section className="c7-auth" aria-label="Staff sign in">
          <div className="c7-tabs"><button type="button" className="c7-tab active">Staff access</button><button type="button" className="c7-tab" onClick={() => setNotice('Patient access is available in the THINNR mobile app.')}>Patient access</button></div>
          <form onSubmit={submit}>
            <label htmlFor="c7-work-email">Work email</label>
            <input id="c7-work-email" type="email" autoComplete="email" required placeholder="name@clinic.com" value={email} onChange={(event) => setEmail(event.target.value)} />
            <p className="c7-help"><LockKeyhole size={12} style={{ verticalAlign: 'text-bottom', marginRight: 5 }} />We’ll send a one-time code to confirm it’s you. No password required.</p>
            <button className="c7-submit" type="submit">{sent ? 'Send a fresh code' : 'Email me a code'} <ArrowRight size={15} /></button>
          </form>
          {notice && <p className="c7-status" role="status">{notice}</p>}
          <button className="c7-demo" type="button" aria-expanded={demoOpen} onClick={() => setDemoOpen(!demoOpen)}>Enter a guided demo <ChevronDown className={demoOpen ? 'open' : ''} size={15} /></button>
          {demoOpen && <div className="c7-options"><button type="button" className="c7-option" onClick={() => setNotice('Opening the office staff guided demo.')}><strong><Check size={11} style={{ marginRight: 4 }} /> Office staff</strong>See a working operations desk.</button><button type="button" className="c7-option" onClick={() => setNotice('Opening the administrator guided demo.')}><strong><Check size={11} style={{ marginRight: 4 }} /> Administrator</strong>Review the organization view.</button></div>}
        </section>
      </section>
      <footer className="c7-foot"><span>THINNR / Operational system</span><span className="c7-signal" aria-label="System operational"><i /><i /><i /></span><span>Secure staff portal</span></footer>
    </main>
  );
}