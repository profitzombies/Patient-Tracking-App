import { useState } from "react";
import "./_group.css";

export function HydrationGarden() {
  const [grown, setGrown] = useState(false);
  return <main className="tg-phone" aria-label="Thinnr hydration garden achievement">
    <span className="tg-sprout" style={{left: 25, top: 112}} /><span className="tg-sprout" style={{right: 22, top: 155, transform:"rotate(40deg)"}} />
    <header className="tg-top"><div className="tg-brand">Thinnr</div><div className="tg-pill">Small Concept</div></header>
    <section className="garden-wrap">
      <div className="garden-head"><div className="tg-small">YOUR CARE PLAN · HYDRATION</div><h1 className="tg-h1">Five days, well cared for.</h1><p className="tg-small">You met your personal 64 oz goal on 5 days.</p></div>
      <div className="garden-art" aria-label={grown ? "A flourishing flower garden" : "A flower ready to bloom"}>
        <div className="garden-sun" /><div className="garden-hill one" /><div className="garden-hill two" /><div className="water-can" />
        <div className={`garden-plant ${grown ? "grown" : ""}`}><div className="stem" /><div className="leaf a" /><div className="leaf b" /><div className="leaf c" /><div className="bloom"><div className="petal"/><div className="petal"/><div className="petal"/><div className="petal"/><div className="petal"/><div className="face"/></div></div>
        <i className="spark s1"/><i className="spark s2"/><i className="spark s3"/>
      </div>
      <div className="garden-copy"><div className="care-dot"/><div><strong>Personal goal, personal rhythm</strong><p>Your plan stays at 64 oz. No need to chase more.</p></div></div>
      {grown && <div className="garden-done">Your bloom is now part of your collection.</div>}
      <button className="tg-btn" onClick={() => setGrown(true)} aria-label="Reveal your hydration garden growth">{grown ? "Keep growing at your pace" : "Reveal my garden growth"}</button>
    </section>
  </main>;
}