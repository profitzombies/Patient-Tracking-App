import { useState } from "react";
import { BookOpen, MessageCircle, Sun, TrendingDown } from "lucide-react";
import "./_group.css";

type Filter = "Earned" | "Next up";
export function YourCollection() {
  const [filter, setFilter] = useState<Filter>("Earned");
  const [detail, setDetail] = useState<string | null>(null);
  const earned = [{name:"5 lb", cls:"jar", detail:"A bright little jar for reaching your personal five-pound milestone."},{name:"7 check-ins", cls:"calendar", detail:"Seven moments of showing up and noticing how you feel."},{name:"3 meal logs", cls:"book", detail:"Three honest meal notes — useful, not perfect."},{name:"5 hydration", cls:"boot", detail:"Five days of meeting your own hydration plan."}];
  return <main className="tg-phone" aria-label="Thinnr patient collection">
    <header className="tg-top"><div className="tg-brand">Thinnr</div><div className="tg-pill">Small Concept</div></header>
    <section className="collection">
      <div className="collection-intro"><div className="tg-small">YOUR LITTLE WINS</div><h1 className="tg-h1">Collection shelf</h1><p className="tg-small">Objects from the care you return to.</p></div>
      <div className="filter-row" role="tablist" aria-label="Collection filter">
        {(["Earned","Next up"] as Filter[]).map(item => <button key={item} role="tab" aria-selected={filter===item} className={`tg-filter ${filter===item?"active":""}`} onClick={() => setFilter(item)}>{item}</button>)}
      </div>
      <div className="shelf" aria-label={filter === "Earned" ? "Earned collectible shelf" : "Next collectible shelf"}>
        <div className="shelf-label">{filter === "Earned" ? "CHAPTER ONE · EARNED" : "GENTLY AHEAD"}</div>
        <div className="objects">
          {filter === "Earned" ? earned.map(x => <button className="object" key={x.name} onClick={() => setDetail(x.detail)} aria-label={`View ${x.name} collectible`} style={{border:0,background:"transparent",padding:0,cursor:"pointer"}}><div className={`object-shape ${x.cls}`}/><span className="object-name">{x.name}</span></button>) : <><div className="object lock"><div className="object-shape"/><span className="object-name">10 check-ins</span></div><div className="object lock"><div className="object-shape"/><span className="object-name">7 meal logs</span></div><div className="object lock"><div className="object-shape"/><span className="object-name">Your next note</span></div><div className="object lock"><div className="object-shape"/><span className="object-name">6 care days</span></div></>}
        </div>
      </div>
      <div className="next-card"><div className="next-orb"/><div><strong>Next: your gentle lantern</strong><p>One more check-in adds a new glow.</p></div><button className="details" onClick={() => setDetail("Your lantern is waiting for one more check-in. There is no race — it will be here whenever you are.")}>Details</button></div>
      {detail && <div className="detail-sheet" role="dialog" aria-label="Collectible details"><h3>A little marker of care</h3><p>{detail}</p><button onClick={() => setDetail(null)}>Back to shelf</button></div>}
    </section>
    <nav className="tg-nav" aria-label="Primary"><button><Sun/><span>Today</span></button><button><BookOpen/><span>Diary</span></button><button className="active"><TrendingDown/><span>Progress</span></button><button><MessageCircle/><span>Coach</span></button></nav>
  </main>;
}