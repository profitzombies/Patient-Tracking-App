import { useState } from "react";
import "./_group.css";

function FireflyJar() {
  return <svg className="wm-jar" viewBox="0 0 260 286" role="img" aria-label="A glass jar holding a glowing friendly firefly collectible">
    <path d="M84 31h92l9 28H75Z" fill="#203b64"/><path d="M66 58h128" stroke="#e3ecf7" strokeWidth="11" strokeLinecap="round"/>
    <path d="M61 73c-2 42 2 142 23 171 21 30 74 31 95 0 22-31 25-128 22-171Z" fill="#fdfcf9" stroke="#315eae" strokeWidth="8"/>
    <path d="M72 168c12 51 89 74 116 14" fill="#e3ecf7" opacity=".8"/>
    <ellipse cx="130" cy="157" rx="48" ry="52" fill="#fff4e6"/><ellipse cx="89" cy="145" rx="24" ry="32" fill="#b7cbe8"/><ellipse cx="171" cy="145" rx="24" ry="32" fill="#b7cbe8"/>
    <circle cx="113" cy="151" r="5" fill="#26364b"/><circle cx="147" cy="151" r="5" fill="#26364b"/><path d="M117 174c8 7 18 7 27 0" fill="none" stroke="#26364b" strokeWidth="5" strokeLinecap="round"/>
    <path d="M118 107c-10-14-5-29 4-36M142 107c10-14 5-29-4-36" fill="none" stroke="#26364b" strokeWidth="5" strokeLinecap="round"/>
    <path d="M89 188l-18 17m92-17 18 17m-37-113v-21" stroke="#315eae" strokeWidth="4" strokeLinecap="round"/>
    <circle cx="43" cy="105" r="6" fill="#df772c"/><circle cx="207" cy="111" r="6" fill="#b7cbe8"/><circle cx="49" cy="219" r="5" fill="#e3ecf7"/>
  </svg>;
}

export function WeightMilestone() {
  const [claimed, setClaimed] = useState(false);
  return <main className="ta-phone wm">
    <span className="ta-label">Concept preview · private discovery</span>
    <header className="ta-top"><div className="ta-brand">Thinnr</div><button className="wm-close" aria-label="Close celebration" onClick={() => setClaimed(true)}>×</button></header>
    <section className="wm-content" aria-live="polite">
      <p className="da-kicker">{claimed ? "Now living in your collection" : "A tiny light appeared"}</p>
      <h1 className="ta-h1">{claimed ? <>Glowbug is<br/>with you.</> : <>Five pounds<br/>of change.</>}</h1>
      <p className="wm-copy">{claimed ? "A reminder of the care you kept choosing. Your path stays personal." : "Your care plan is becoming part of your life. We made this little companion to mark the moment."}</p>
      <div className="wm-stage"><div className="wm-spark s1"></div><div className="wm-spark s2"></div><div className="wm-spark s3"></div><FireflyJar /></div>
      <div className="wm-name"><div><b>{claimed ? "Glowbug joined your shelf" : "Meet Glowbug"}</b><span>Lantern Grove collectible</span></div><div className="wm-tag">01</div></div>
      {!claimed ? <button className="ta-primary" onClick={() => setClaimed(true)} aria-label="Keep Glowbug in your collection">Keep Glowbug</button> : <button className="ta-primary" onClick={() => setClaimed(false)} aria-label="View today's trail">Continue to today</button>}
      <button className="wm-link" onClick={() => setClaimed(true)} aria-label="Read what this milestone means">What does this mark?</button>
    </section>
  </main>;
}