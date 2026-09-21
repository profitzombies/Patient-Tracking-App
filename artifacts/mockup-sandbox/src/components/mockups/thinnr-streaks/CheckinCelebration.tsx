import { useState } from "react";
import "./_group.css";
import "./CheckinCelebration.css";

function Spark({ className }: { className: string }) {
  return <span aria-hidden="true" className={`check-spark ${className}`} />;
}

function CheckinCharacter() {
  return (
    <div className="check-character" aria-hidden="true">
      <div className="check-arm check-arm-left" />
      <div className="check-arm check-arm-right" />
      <div className="check-body">
        <span className="check-cheek check-cheek-left" />
        <span className="check-cheek check-cheek-right" />
        <span className="check-eye check-eye-left" />
        <span className="check-eye check-eye-right" />
        <span className="check-smile" />
        <span className="check-shine" />
      </div>
      <div className="check-foot check-foot-left" />
      <div className="check-foot check-foot-right" />
    </div>
  );
}

function TabBar() {
  const items = [
    ["Today", <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>],
    ["Diary", <><path d="M5 4.5c2.3-1 4.6-.6 7 1.1v14c-2.4-1.7-4.7-2.1-7-1.1zM19 4.5c-2.3-1-4.6-.6-7 1.1v14c2.4-1.7 4.7-2.1 7-1.1z" /></>],
    ["Progress", <><path d="M4 18l5-5 3 3 7-8M15 8h4v4" /></>],
    ["Coach", <><path d="M5 5.5h14v10H9l-4 3z" /></>],
  ];
  return <nav className="heritage-tabbar" aria-label="Patient navigation">{items.map(([label, paths]) => <button className={label === "Today" ? "active" : ""} key={label} aria-label={label} aria-current={label === "Today" ? "page" : undefined}><svg viewBox="0 0 24 24" aria-hidden="true">{paths}</svg>{label}</button>)}</nav>;
}

export function CheckinCelebration() {
  const [replaying, setReplaying] = useState(false);
  const [continued, setContinued] = useState(false);
  const replay = () => {
    setReplaying(false);
    requestAnimationFrame(() => setReplaying(true));
  };

  return (
    <main className={`thinnr-play checkin-screen ${replaying ? "is-replaying" : ""}`}>
      <span className="tiny-label">Concept preview</span>
      <span className="brand">Thinnr</span>
      <div className="check-sky" />
      <div className="check-confetti" aria-hidden="true">
        <Spark className="spark-one" /><Spark className="spark-two" /><Spark className="spark-three" />
        <Spark className="spark-four" /><Spark className="spark-five" /><Spark className="spark-six" />
      </div>
      <section className="check-content" aria-live="polite">
        <div className="check-day-row" aria-label="Seven day check-in streak">
          {["M", "T", "W", "T", "F", "S", "S"].map((day, i) => (
            <div className={`check-day ${i === 6 ? "today" : "done"}`} key={`${day}-${i}`}>
              <span>{i === 6 ? "7" : "✓"}</span><small>{day}</small>
            </div>
          ))}
        </div>
        <p className="check-kicker">Check-in rhythm</p>
        <h1>Seven days of<br />checking in.</h1>
        <p className="check-copy">A steady pattern is taking shape. Your care team can use these small notes to support you.</p>
        <CheckinCharacter />
      </section>
      <div className="check-actions">
        {continued ? (
          <div className="check-done" role="status">Saved. We’ll be here tomorrow.</div>
        ) : (
          <>
            <button className="check-primary" onClick={() => setContinued(true)} aria-label="Continue after celebrating your seven-day check-in streak">
              Return to today <span aria-hidden="true">→</span>
            </button>
            <button className="check-replay" onClick={replay} aria-label="Replay celebration">See that again</button>
          </>
        )}
      </div>
      <TabBar />
    </main>
  );
}

export default CheckinCelebration;