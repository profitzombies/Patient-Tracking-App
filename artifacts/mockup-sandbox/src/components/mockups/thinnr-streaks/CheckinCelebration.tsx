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
        <p className="check-kicker">A whole week of showing up</p>
        <h1>Your check-in<br />made a little<br />more room for you.</h1>
        <p className="check-copy">Seven kind moments with yourself. Your care crew can see the pattern taking shape.</p>
        <CheckinCharacter />
      </section>
      <div className="check-actions">
        {continued ? (
          <div className="check-done" role="status">Saved. We’ll be here tomorrow.</div>
        ) : (
          <>
            <button className="check-primary" onClick={() => setContinued(true)} aria-label="Continue after celebrating your seven-day check-in streak">
              Keep the good going <span aria-hidden="true">→</span>
            </button>
            <button className="check-replay" onClick={replay} aria-label="Replay celebration">See that again</button>
          </>
        )}
      </div>
    </main>
  );
}

export default CheckinCelebration;