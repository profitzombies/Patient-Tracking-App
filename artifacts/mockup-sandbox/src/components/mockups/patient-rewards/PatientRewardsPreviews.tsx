import { useState } from "react";
import { Award, ChevronRight, Droplet, Flame, LockKeyhole, X } from "lucide-react";

type View = "rewards" | "earned" | "next" | "celebration";

const awards = [
  { name: "Food rhythm", detail: "Log food on 3 consecutive days", progress: "3 / 3", earned: true, icon: Flame },
  { name: "Check-in steady week", detail: "Complete check-ins on 7 consecutive days", progress: "5 / 7", earned: false, icon: Award },
  { name: "Hydration rhythm", detail: "Meet your hydration target on 3 consecutive days", progress: "2 / 3", earned: false, icon: Droplet },
];

const css = `
  .pr-shell{min-height:100dvh;background:#f7f2e9;color:#17365f;font-family:Inter,ui-sans-serif,system-ui,sans-serif;padding:24px 18px 30px}
  .pr-phone{max-width:393px;margin:auto}
  .pr-demo{font-size:9px;letter-spacing:.15em;text-transform:uppercase;color:#cf713e;font-weight:800}
  .pr-head{display:flex;justify-content:space-between;align-items:center;margin:22px 0 17px}
  .pr-head h1{font-family:Georgia,serif;font-size:31px;line-height:1;margin:5px 0 0;font-weight:700}
  .pr-card{background:#fffdf8;border:1px solid #d8d4ca;border-radius:9px;padding:16px;box-shadow:0 8px 24px #17365f0b}
  .pr-level{display:flex;justify-content:space-between;align-items:center}
  .pr-level strong{font-family:Georgia,serif;font-size:25px;display:block;margin-top:5px}
  .pr-medal{width:52px;height:52px;border-radius:50%;border:1px solid #df9d72;background:#fff0e5;display:grid;place-items:center;color:#cf713e}
  .pr-track{height:8px;background:#e7e6e0;margin-top:18px;overflow:hidden}
  .pr-track i{display:block;height:100%;width:64%;background:#1f62a8}
  .pr-meta{font-size:11px;color:#697586;margin-top:8px}
  .pr-section{display:flex;justify-content:space-between;align-items:end;margin:24px 0 9px}
  .pr-section h2{font:700 19px/1.1 Georgia,serif;margin:0}
  .pr-link{font-size:11px;color:#1f62a8;font-weight:800}
  .pr-row{display:flex;align-items:center;gap:11px;padding:13px 0;border-bottom:1px solid #e4e1da}
  .pr-row:last-child{border-bottom:0;padding-bottom:0}
  .pr-row:first-child{padding-top:0}
  .pr-icon{width:39px;height:39px;border-radius:50%;display:grid;place-items:center;background:#eef4f8;color:#1f62a8;flex:none}
  .pr-row b{font-size:13px;display:block}.pr-row small{color:#697586;font-size:11px;line-height:1.4;display:block;margin-top:3px}
  .pr-progress{font-size:10px;color:#697586;margin-top:7px}
  .pr-tabs{display:flex;gap:7px;margin-bottom:18px;overflow:auto}
  .pr-tabs button{border:1px solid #d8d4ca;border-radius:7px;background:#fffdf8;padding:9px 11px;color:#17365f;font-size:11px;font-weight:700;white-space:nowrap}
  .pr-tabs button.active{background:#17365f;color:#fffdf8}
  .pr-note{font-size:12px;line-height:1.55;color:#697586;margin:0 0 17px}
  .pr-award-grid{display:grid;gap:10px}
  .pr-award{display:flex;align-items:center;gap:11px;border:1px solid #d8d4ca;border-radius:9px;background:#fffdf8;padding:13px;text-align:left}
  .pr-award.locked{opacity:.72}.pr-award p{margin:0;font-size:12px;font-weight:800}.pr-award small{display:block;color:#697586;font-size:10px;margin-top:4px}
  .pr-locked{margin-left:auto;color:#697586}.pr-button{width:100%;border:0;border-radius:7px;background:#17365f;color:#fffdf8;padding:12px;font-weight:800;margin-top:17px}
  .pr-celebrate{position:relative}.pr-dismiss{position:absolute;right:0;top:0;border:1px solid #d8d4ca;background:#fffdf8;color:#17365f;border-radius:7px;padding:6px}
  .pr-celebrate .pr-card{text-align:center;padding:32px 22px;margin-top:36px}.pr-celebrate .pr-medal{margin:auto;width:74px;height:74px}.pr-celebrate h2{font:700 28px/1 Georgia,serif;margin:17px 0 8px}.pr-celebrate p{font-size:13px;line-height:1.55;color:#697586;margin:0}
`;

function Medal({ icon: Icon = Award, locked = false }: { icon?: typeof Award; locked?: boolean }) {
  return <span className={`pr-icon ${locked ? "locked" : ""}`}><Icon size={18} /></span>;
}

export function PatientRewardsPreviews() {
  const [view, setView] = useState<View>("rewards");
  const openAwards = (next: View) => setView(next);
  return (
    <main className="pr-shell">
      <style>{css}</style>
      <section className="pr-phone" aria-label="THINNR patient rewards demo preview">
        <span className="pr-demo">Demo preview · no live writes</span>
        {view === "celebration" ? (
          <div className="pr-celebrate">
            <button className="pr-dismiss" type="button" aria-label="Dismiss celebration" onClick={() => setView("rewards")}><X size={15} /></button>
            <div className="pr-card">
              <span className="pr-medal"><Award size={31} /></span>
              <span className="pr-demo">Added to your collection</span>
              <h2>Food rhythm</h2>
              <p>Three consecutive days of food notes. A quiet marker for steady work.</p>
              <button className="pr-button" type="button" onClick={() => setView("earned")}>View my awards</button>
            </div>
          </div>
        ) : (
          <>
            <header className="pr-head"><div><span className="pr-demo">Milestones that belong to you</span><h1>{view === "rewards" ? "Rewards" : view === "earned" ? "My awards" : "Next awards"}</h1></div><span className="pr-medal"><Award size={21} /></span></header>
            <nav className="pr-tabs" aria-label="Demo reward views">
              {([["rewards", "Rewards"], ["earned", "My awards"], ["next", "Next awards"], ["celebration", "Celebration"]] as const).map(([key, label]) => <button key={key} type="button" className={view === key ? "active" : ""} onClick={() => openAwards(key)}>{label}</button>)}
            </nav>
            {view === "rewards" ? (
              <>
                <div className="pr-card">
                  <div className="pr-level"><div><span className="pr-demo">Current level</span><strong>Level 8</strong></div><span className="pr-medal"><Award size={22} /></span></div>
                  <div className="pr-track"><i /></div><div className="pr-meta">2,160 XP · 240 XP to level 9</div>
                </div>
                <div className="pr-section"><h2>Keep your eye on the next marker</h2><button className="pr-link" type="button" onClick={() => setView("next")}>See all</button></div>
                <div className="pr-card">{awards.slice(0, 2).map(({ name, detail, progress, icon: Icon, earned }) => <div className="pr-row" key={name}><Medal icon={Icon} /><div><b>{name}</b><small>{detail}</small>{!earned && <span className="pr-progress">{progress}</span>}</div><ChevronRight size={16} /></div>)}</div>
              </>
            ) : (
              <>
                <p className="pr-note">{view === "earned" ? "These markers stay with you. Open one to pause on what it represents." : "Nothing here asks for perfection. Each marker is simply a clear next step."}</p>
                <div className="pr-award-grid">{awards.map(({ name, detail, progress, icon: Icon, earned }) => <div className={`pr-award ${earned ? "" : "locked"}`} key={name}><Medal icon={Icon} locked={!earned} /><div><p>{name}</p><small>{earned ? "Earned · 21 Sep 2026" : `${detail} · ${progress}`}</small></div>{!earned && <span className="pr-locked"><LockKeyhole size={15} /></span>}</div>)}</div>
              </>
            )}
          </>
        )}
      </section>
    </main>
  );
}
