import { FormEvent, useState } from "react";
import "./_thinnr.css";

export default function Concept11Web() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const submit = (e: FormEvent) => { e.preventDefault(); setMessage(email ? `Code sent to ${email}` : "Enter your work email to continue."); };
  return <div className="thinnr-auth pavilion">
    <header className="pavilion-top"><img className="thinnr-logo" src="/__mockup/images/thinnr-logo-official.png" alt="THINNR" /><span className="tiny">Operations / secure access</span></header>
    <span className="pavilion-orbit" />
    <main className="pavilion-center">
      <div className="pavilion-kicker tiny">Staff entry</div>
      <h1 className="mono">THINNR<br />Operations</h1>
      <p className="pavilion-intro">A considered workspace for the people guiding every patient forward.</p>
      <form className="pavilion-form" onSubmit={submit}>
        <label htmlFor="c11-email">Work email</label>
        <input className="auth-input" id="c11-email" type="email" required autoComplete="email" placeholder="you@thinnr.com" value={email} onChange={e => setEmail(e.target.value)} />
        <button className="auth-button" type="submit">Email me a code</button>
        <p className="pavilion-code">We’ll send a one-time code to verify it’s you. No password to remember.</p>
        {message && <p className="status" role="status">{message}</p>}
        <div className="pavilion-demo"><span>Exploring THINNR?</span><button className="text-button" type="button" onClick={() => setMessage("Guided demo ready — choose your workspace.")}>Launch guided demo</button></div>
      </form>
    </main>
    <footer className="pavilion-footer tiny"><span>Clinical systems, thoughtfully connected</span><span>v. 02.11</span></footer>
  </div>;
}