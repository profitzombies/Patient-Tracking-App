import { useState } from "react";
import "./_group.css";
import "./LoggingLevelUp.css";

function SproutSticker({ opened }: { opened: boolean }) {
  return (
    <div className={`sprout-sticker ${opened ? "opened" : ""}`} aria-hidden="true">
      <div className="sprout-ray ray-a" /><div className="sprout-ray ray-b" /><div className="sprout-ray ray-c" />
      <div className="sprout-pot">
        <div className="sprout-dirt" />
        <div className="sprout-leaf leaf-left" /><div className="sprout-leaf leaf-right" />
        <div className="sprout-face"><i /><i /><b /></div>
      </div>
    </div>
  );
}

export function LoggingLevelUp() {
  const [opened, setOpened] = useState(false);
  const [added, setAdded] = useState(false);
  return (
    <main className="thinnr-play logging-screen">
      <span className="tiny-label">Concept preview</span>
      <span className="brand">Thinnr</span>
      <div className="log-top-blob" aria-hidden="true" />
      <section className="log-copy">
        <div className="log-chip">3-day logging rhythm</div>
        <h1>Noticing is<br />a superpower.</h1>
        <p>You recorded meals for three days. No score, no “perfect” plate — just useful notes for you and your care team.</p>
      </section>
      <section className="log-unlock" aria-live="polite">
        <div className="unlock-header">
          <span className="unlock-eyebrow">New in your garden</span>
          <span className="unlock-count">01 / 12</span>
        </div>
        <div className="unlock-art"><SproutSticker opened={opened} /></div>
        <h2>Curious Sprout</h2>
        <p>Grows when you make room to notice.</p>
        {!opened ? (
          <button className="log-reveal" onClick={() => setOpened(true)} aria-label="Reveal your Curious Sprout collectible">
            Tap to welcome it <span aria-hidden="true">↗</span>
          </button>
        ) : (
          <div className="log-revealed" role="status">It’s rooting for your next note.</div>
        )}
      </section>
      <div className="log-progress" aria-label="Your collection now has one of twelve collectibles">
        <div className="progress-dots">{Array.from({ length: 12 }, (_, i) => <i key={i} className={i === 0 ? "filled" : ""} />)}</div>
        <span>Your collection has begun</span>
      </div>
      <button className={`log-primary ${added ? "is-added" : ""}`} onClick={() => setAdded(true)} aria-label="Add Curious Sprout to your collection">
        {added ? "Added to your collection" : "Add to my collection"} <span aria-hidden="true">→</span>
      </button>
    </main>
  );
}

export default LoggingLevelUp;