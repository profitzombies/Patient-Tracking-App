import { useMemo, useState, type CSSProperties } from "react";
import "./goal-achievements.css";

type Badge = {
  level: number;
  title: string;
  note: string;
  detail: string;
  motif: "medallion" | "ribbon" | "layers" | "laurels" | "crest";
};

const badges: Badge[] = [
  { level: 10, title: "First Marker", note: "A beginning worth noticing", detail: "You chose a personal direction and started showing up for it.", motif: "medallion" },
  { level: 25, title: "Steady Ground", note: "A quarter of your goal", detail: "Your small choices are beginning to make a dependable rhythm.", motif: "ribbon" },
  { level: 50, title: "Halfway Home", note: "The middle is meaningful", detail: "You are halfway to the goal you set. Pause here and let that land.", motif: "layers" },
  { level: 75, title: "Quiet Momentum", note: "Progress with staying power", detail: "Your plan has held through real life. That is a strength you can keep.", motif: "laurels" },
  { level: 100, title: "Your Landmark", note: "A goal met on your terms", detail: "This crest marks a personal landmark—not an ending, just proof of what you can build.", motif: "crest" },
];

function Medal({ badge, earned, selected }: { badge: Badge; earned: boolean; selected: boolean }) {
  return (
    <div className={`th-medal th-${badge.motif} ${earned ? "is-earned" : "is-locked"} ${selected ? "is-selected" : ""}`} aria-hidden="true">
      {badge.motif !== "medallion" && <span className="th-ribbon-left" />}
      {badge.motif !== "medallion" && <span className="th-ribbon-right" />}
      {badge.motif === "layers" && <><span className="th-ray th-ray-a" /><span className="th-ray th-ray-b" /></>}
      {badge.motif === "laurels" && <><span className="th-laurel th-laurel-left" /><span className="th-laurel th-laurel-right" /></>}
      {badge.motif === "crest" && <><span className="th-crown" /><span className="th-crest-wing th-wing-left" /><span className="th-crest-wing th-wing-right" /></>}
      <span className="th-medal-rim">
        <span className="th-medal-core">
          <span className="th-monogram">TH</span>
          <span className="th-medal-level">{badge.level}%</span>
        </span>
      </span>
    </div>
  );
}

export function GoalAchievements() {
  const [progress, setProgress] = useState(50);
  const [selectedLevel, setSelectedLevel] = useState(50);
  const selected = useMemo(() => badges.find((badge) => badge.level === selectedLevel) ?? badges[2], [selectedLevel]);
  const earned = progress >= selected.level;
  const next = badges.find((badge) => badge.level > progress);

  return (
    <main className="th-goals-shell">
      <section className="th-goals-card" aria-labelledby="goal-title">
        <header className="th-header">
          <div>
            <p className="th-kicker"><span className="th-wordmark">TH</span> Personal milestones</p>
            <h1 id="goal-title">Your progress, made tangible.</h1>
            <p className="th-intro">A private collection of markers for the goal you chose. There is no race here—just your next meaningful step.</p>
          </div>
          <div className="th-goal-chip">
            <span>Personal goal</span>
            <strong>28 lb</strong>
          </div>
        </header>

        <section className="th-preview" aria-label="Demo milestone preview">
          <div className="th-preview-topline">
            <div>
              <span className="th-eyebrow">Demo preview</span>
              <strong>{progress}% of your personal goal</strong>
            </div>
            <span className="th-status-copy">{next ? `${next.level - progress}% to ${next.title}` : "Your landmark is complete"}</span>
          </div>
          <div className="th-range-wrap">
            <input
              aria-label="Demo preview progress; this does not edit health progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuetext={`${progress}% of personal goal`}
              className="th-range"
              type="range"
              min="0"
              max="100"
              step="1"
              value={progress}
              onChange={(event) => setProgress(Number(event.target.value))}
              style={{ "--progress": `${progress}%` } as CSSProperties}
            />
            <div className="th-stops" aria-hidden="true">
              {badges.map((badge) => <span key={badge.level} className={progress >= badge.level ? "passed" : ""} style={{ left: `${badge.level}%` }} />)}
            </div>
          </div>
          <p className="th-demo-note">Preview only. Moving this control will not change your health record.</p>
        </section>

        <section className="th-collection" aria-labelledby="collection-title">
          <div className="th-section-heading">
            <div>
              <span className="th-eyebrow">The collection</span>
              <h2 id="collection-title">Five ways to recognize the work.</h2>
            </div>
            <span className="th-earned-count">{badges.filter((badge) => progress >= badge.level).length} of 5 earned</span>
          </div>
          <div className="th-badge-grid">
            {badges.map((badge) => {
              const isEarned = progress >= badge.level;
              const isSelected = selected.level === badge.level;
              return (
                <button
                  type="button"
                  key={badge.level}
                  className={`th-badge-card ${isSelected ? "selected" : ""} ${isEarned ? "earned" : "locked"}`}
                  onClick={() => setSelectedLevel(badge.level)}
                  aria-pressed={isSelected}
                  aria-label={`${badge.title}, ${badge.level}% milestone, ${isEarned ? "earned" : "upcoming"}. Show details.`}
                >
                  <Medal badge={badge} earned={isEarned} selected={isSelected} />
                  <span className="th-badge-copy">
                    <span className="th-badge-meta">{badge.level}% <i /> {isEarned ? "Earned" : "Upcoming"}</span>
                    <strong>{badge.title}</strong>
                    <small>{badge.note}</small>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section className={`th-detail ${earned ? "detail-earned" : "detail-upcoming"}`} aria-live="polite">
          <div className="th-detail-medal"><Medal badge={selected} earned={earned} selected /></div>
          <div className="th-detail-copy">
            <span className="th-eyebrow">{earned ? "In your collection" : "Looking ahead"} · {selected.level}% milestone</span>
            <h2>{selected.title}</h2>
            <p>{selected.detail}</p>
          </div>
          <div className="th-detail-seal">
            <span>{earned ? "Recognized" : `${Math.max(0, selected.level - progress)}% away`}</span>
            <strong>{earned ? "Kept" : "Next"}</strong>
          </div>
        </section>
      </section>
    </main>
  );
}