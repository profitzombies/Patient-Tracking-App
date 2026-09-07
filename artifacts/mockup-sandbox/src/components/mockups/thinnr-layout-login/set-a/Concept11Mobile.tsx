import { FormEvent, useState } from "react";
import "./_thinnr.css";

export default function Concept11Mobile() {
  const [mode, setMode] = useState("Phone"); const [visible, setVisible] = useState(false); const [status, setStatus] = useState("");
  const submit = (e: FormEvent) => {e.preventDefault();setStatus("Welcome back. Your care plan is ready.");};
  return <div className="thinnr-auth phone-pavilion">
    <header><button className="back-link" type="button" onClick={() => setStatus("Back to the welcome screen.")}>Back</button><img className="thinnr-logo" src="/__mockup/images/thinnr-logo-official.png" alt="THINNR" /></header>
    <main><p className="tiny">Your companion</p><h1 className="mono">Welcome<br />back.</h1><p className="intro">Your plan is personal. Your access should feel that way, too.</p>
      <div className="mode-switch"><button className={mode === "Phone" ? "active" : ""} type="button" onClick={() => setMode("Phone")}>Phone</button><button className={mode === "Email" ? "active" : ""} type="button" onClick={() => setMode("Email")}>Email</button></div>
      <form onSubmit={submit}><div className="field"><label htmlFor="c11-identity">{mode} number or email</label><input className="auth-input" id="c11-identity" required autoComplete="username" placeholder={mode === "Phone" ? "(555) 204–9812" : "you@email.com"} /></div><div className="field"><label htmlFor="c11-password">Password</label><div className="password-row"><input className="auth-input" id="c11-password" required autoComplete="current-password" type={visible ? "text" : "password"} /><button type="button" onClick={() => setVisible(!visible)}>{visible ? "Hide" : "Show"}</button></div></div><button className="auth-button" type="submit">Continue</button></form>
      <div className="under-actions"><button className="text-button" type="button" onClick={() => setStatus("Password reset instructions are on their way.")}>Forgot password?</button><button className="text-button" type="button" onClick={() => setStatus("Account creation selected.")}>Create account</button></div>{status && <p className="status" role="status">{status}</p>}
    </main><footer>Want a look around? <button className="text-button" type="button" onClick={() => setStatus("Explore demo selected.")}>Explore demo</button> &nbsp;·&nbsp; <button className="text-button" type="button" onClick={() => setStatus("Provider login selected.")}>Provider login</button></footer>
  </div>;
}