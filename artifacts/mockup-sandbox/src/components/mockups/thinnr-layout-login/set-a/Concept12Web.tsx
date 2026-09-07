import { FormEvent, useState } from "react";
import "./_thinnr.css";

export default function Concept12Web() {
  const [email, setEmail] = useState(""); const [message, setMessage] = useState("");
  const submit = (e: FormEvent) => { e.preventDefault(); setMessage(email ? "One-time code dispatched. Check your inbox." : "Add a work email first."); };
  return <div className="thinnr-auth aqua-field">
    <header className="aqua-head"><img className="thinnr-logo" src="/__mockup/images/thinnr-logo-official.png" alt="THINNR" /><span className="aqua-index">OPS / 01</span></header>
    <main className="aqua-core">
      <section className="aqua-statement"><p className="tiny">A better way to hold the details</p><h1 className="mono">Good care<br />has a rhythm.</h1><p>Enter the operating room for a patient experience that stays personal at every scale.</p><div className="aqua-tags"><span>Precision</span><span>Presence</span><span>Progress</span></div></section>
      <form className="aqua-card" onSubmit={submit}><p className="tiny">THINNR Operations</p><h2 className="mono" style={{fontSize:26,margin:"12px 0 22px"}}>Sign in</h2><label htmlFor="c12-email">Work email</label><input className="auth-input" id="c12-email" type="email" required autoComplete="email" placeholder="name@clinic.com" value={email} onChange={e => setEmail(e.target.value)} /><button className="auth-button" type="submit">Email me a code</button><small>We’ll email a one-time code. It’s the simplest way to keep every care team secure.</small>{message && <p className="status" role="status">{message}</p>}<div className="demo-row"><button type="button" onClick={() => setMessage("HQ admin guided demo opened.")}>HQ demo</button><button type="button" onClick={() => setMessage("Office staff guided demo opened.")}>Office demo</button></div></form>
    </main>
    <footer className="aqua-foot"><span>Guided care platform</span><span>Secure access</span><span>US / 2025</span></footer>
  </div>;
}