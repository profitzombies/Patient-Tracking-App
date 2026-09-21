import { useState } from "react";
import "./_group.css";

function SproutPal() {
  return <svg viewBox="0 0 160 154" aria-label="A friendly blue trail guide carrying a tiny flag" role="img" className="da-pal">
    <path d="M44 105C20 91 22 61 42 48c7-5 14-7 22-7C69 20 92 14 107 30c11 12 9 28 4 36 21 7 28 32 11 49-18 18-61 19-78-10Z" fill="#315eae"/>
    <path d="M58 38c-5-15 7-26 20-22 8 3 11 11 9 18-12-4-20 3-29 4Z" fill="#e3ecf7"/>
    <path d="M93 39c6-15 23-15 29-3 4 9-1 16-8 20-4-11-13-15-21-17Z" fill="#fff4e6"/>
    <circle cx="57" cy="71" r="6" fill="#fdfcf9"/><circle cx="103" cy="71" r="6" fill="#fdfcf9"/>
    <circle cx="59" cy="72" r="2" fill="#26364b"/><circle cx="101" cy="72" r="2" fill="#26364b"/>
    <path d="M69 89c8 8 18 8 26 0" fill="none" stroke="#fdfcf9" strokeWidth="4" strokeLinecap="round"/>
    <path d="M43 106c-14 9-21 21-21 31M115 109c13 8 20 18 20 30" stroke="#315eae" strokeWidth="12" strokeLinecap="round"/>
    <path d="M132 35v72" stroke="#203b64" strokeWidth="5" strokeLinecap="round"/><path d="M134 37l20 7-20 9Z" fill="#df772c"/>
  </svg>;
}

export function DailyAdventure() {
  const [water, setWater] = useState(2);
  const [checkIn, setCheckIn] = useState(false);
  const [celebrate, setCelebrate] = useState(false);
  return <main className="ta-phone">
    <span className="ta-label">Concept preview · living trail</span>
    <header className="ta-top"><div className="ta-brand">Thinnr</div><div className="ta-avatar" aria-label="Maya profile">M</div></header>
    {celebrate ? <section className="da-overlay" aria-live="polite">
      <div className="da-burst" aria-hidden="true"><b></b><b></b><b></b><b></b><b></b></div>
      <SproutPal /><p className="da-kicker">Trail note added</p><h1 className="ta-h1">You checked in<br/>with yourself.</h1>
      <p className="da-quiet">Your Lantern Grove is a little brighter today. No streak to protect — just a moment you made for you.</p>
      <button className="ta-primary" onClick={() => setCelebrate(false)} aria-label="Return to today's trail">See today’s trail</button>
    </section> : <>
      <section className="da-hello"><div><p className="da-kicker">Tuesday, your pace</p><h1 className="ta-h1">Good morning,<br/>Maya.</h1><p className="ta-small">Your next small step is ready.</p></div><SproutPal /></section>
      <section className="da-trail" aria-label="Your personal wellness trail"><div className="da-trail-top"><span>YOUR TRAIL</span><span>2 of 4 moments</span></div><div className="da-path"><span className="done"></span><span className="done"></span><span className="now"></span><span></span></div><div className="da-milestone"><div className="da-flag">↗</div><div><b>Lantern Grove</b><p>One check-in opens the next path.</p></div></div></section>
      <section className="da-focus ta-card"><div><p className="da-kicker">A gentle check-in</p><h2>How are you arriving today?</h2><p>There’s no right answer. Your care team reads the pattern, not a single day.</p></div><button className="da-check" onClick={() => { setCheckIn(true); setCelebrate(true); }} aria-label="Complete today's check-in">{checkIn ? "Checked in" : "Check in"}<span>→</span></button></section>
      <section className="da-actions"><button onClick={() => setWater(Math.min(3, water + 1))} aria-label="Log a glass of water"><span className="da-icon water"></span><div><b>Water, your way</b><small>{water} glasses logged today</small></div><i>+</i></button><button onClick={() => setCelebrate(true)} aria-label="Log a meal"><span className="da-icon bowl"></span><div><b>Log something nourishing</b><small>A note, a photo, or just the name</small></div><i>+</i></button></section>
    </>}
    <nav className="ta-nav" aria-label="Patient navigation"><button className="active" aria-current="page"><i className="home-icon"></i>Today</button><button><i className="book-icon"></i>Diary</button><button><i className="spark-icon"></i>Progress</button><button><i className="person-icon"></i>Coach</button></nav>
  </main>;
}