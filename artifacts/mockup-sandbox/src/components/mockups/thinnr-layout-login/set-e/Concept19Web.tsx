import { FormEvent, useState } from "react";

export default function Concept19Web() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const submit = (e: FormEvent) => { e.preventDefault(); setMessage(`A one-time code is on its way to ${email || "your work email"}.`); };
  return <main className="c19w">
    <style>{css}</style>
    <section className="outer">
      <header><img src="/__mockup/images/thinnr-logo-official.png" alt="THINNR" /><span>OPERATIONS / ACCESS</span><b>01—24</b></header>
      <div className="canvas">
        <div className="note top">MEDICALLY GUIDED<br />WEIGHT LOSS</div>
        <div className="aquaBlock"><div className="ring" /><p>PROGRAM<br />OPERATIONS</p></div>
        <section className="access">
          <div className="eyebrow">STAFF ENTRY</div><h1>Clear care<br />starts here.</h1>
          <p className="intro">Secure access for the people shaping every patient’s next step.</p>
          <form onSubmit={submit}>
            <label htmlFor="c19-email">Work email</label>
            <input id="c19-email" required type="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="name@thinnr.com" />
            <button type="submit">Email me a code <span>→</span></button>
          </form>
          <p className="hint">We’ll send a one-time code to your verified work email.</p>
          {message && <p className="feedback" role="status">{message}</p>}
        </section>
        <aside className="demo"><span>GUIDED DEMO</span><strong>Tour Operations with a demo workspace.</strong><button onClick={()=>setMessage("Guided demo opened — choose a workspace to begin.")}>Open demo <i>→</i></button></aside>
        <div className="note bottom">PRECISE,<br />PERSONAL,<br />PROGRESSIVE.</div>
      </div>
      <footer><span>THINNR OPERATIONS</span><span>PROTOCOL ACCESS</span><span>SECURE STAFF ENVIRONMENT</span></footer>
    </section>
  </main>;
}
const css = `@font-face{font-family:GT;src:url('/__mockup/fonts/gt-america-mono-bold.otf')} .c19w{min-height:100vh;background:#111;color:#111;padding:22px;font-family:Inter,Arial,sans-serif;box-sizing:border-box}.c19w *{box-sizing:border-box}.outer{min-height:calc(100vh - 44px);background:#f8f8f3;border:1px solid #8fd4d5;display:flex;flex-direction:column}header,footer{height:62px;background:#111;color:#f8f8f3;display:flex;align-items:center;padding:0 34px;gap:25px;font:11px GT,monospace;letter-spacing:.08em}header img{width:147px;height:auto}header b{margin-left:auto;color:#8fd4d5;font-weight:normal}.canvas{position:relative;display:grid;grid-template-columns:1.05fr 1.5fr 1fr;grid-template-rows:1fr 1.1fr;min-height:590px;padding:42px}.aquaBlock{background:#8fd4d5;grid-row:1/3;position:relative;padding:29px;border:1px solid #111;overflow:hidden}.aquaBlock p{position:absolute;bottom:26px;font:16px GT;line-height:1.4}.ring{width:310px;height:310px;border:1px solid #111;border-radius:50%;position:absolute;left:50%;top:45%;transform:translate(-50%,-50%)}.ring:after{content:"";position:absolute;width:165px;height:165px;border:1px solid #111;border-radius:50%;top:72px;left:72px}.access{grid-column:2;grid-row:1/3;align-self:center;justify-self:center;width:min(400px,85%);padding:35px}.eyebrow,.demo span{font:10px GT;letter-spacing:.14em}.access h1{font:43px/1.02 GT;margin:17px 0}.intro{font-size:15px;line-height:1.5;color:#555;max-width:300px;margin-bottom:31px}.access label{display:block;font-size:12px;font-weight:700;margin-bottom:8px}.access input{width:100%;border:1px solid #222;background:transparent;padding:15px;font:14px Inter;outline-offset:3px}.access input:focus{outline:2px solid #8fd4d5}.access button{margin-top:11px;width:100%;border:0;background:#111;color:#fff;padding:15px;text-align:left;font:13px GT;cursor:pointer}.access button span{float:right;color:#8fd4d5}.hint{font-size:11px;color:#666;line-height:1.4}.feedback{font-size:12px;background:#d9f2f1;padding:10px}.demo{grid-column:3;grid-row:2;align-self:end;border-top:1px solid #111;padding:18px 0 0 18px}.demo strong{display:block;font:16px/1.25 GT;margin:10px 0 16px}.demo button{background:none;border:0;padding:0;font:12px GT;text-decoration:underline;cursor:pointer}.demo i{font-style:normal;color:#2d8d91}.note{font:10px/1.4 GT;position:absolute;right:43px;top:43px}.note.bottom{top:auto;bottom:44px;right:44px;color:#2d8d91}footer{height:42px;justify-content:space-between;font-size:9px;color:#8fd4d5}@media(max-width:700px){.c19w{padding:10px}.canvas{grid-template-columns:1fr;min-height:700px;padding:24px}.aquaBlock{grid-row:auto;min-height:150px}.access{grid-column:1;grid-row:auto;width:100%;padding:35px 0}.demo{grid-column:1;grid-row:auto}.note{display:none}header{padding:0 18px}header span{display:none}}`;