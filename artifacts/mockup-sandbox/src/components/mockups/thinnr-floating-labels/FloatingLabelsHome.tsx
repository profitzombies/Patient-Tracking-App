import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  BookOpen,
  Camera,
  Check,
  ChevronRight,
  ClipboardCheck,
  Droplet,
  Images,
  Library,
  ListChecks,
  MessageCircle,
  Minus,
  Plus,
  ScanBarcode,
  Sparkles,
  Sun,
  User,
  Utensils,
  X,
} from 'lucide-react';
import './_fl-base.css';
import './FloatingLabelsHome.css';

/*
 * THINNR patient app — the real Today screen (app/(patient)/today.tsx)
 * restyled in the Floating Labels language. Section order mirrors the live
 * screen: wordmark + avatar, day strip, greeting, quick-link chips, floating
 * focus bar, day at a glance, program instructions, calories + macros,
 * meals & hydration, daily check-in, weight snapshot, disclaimer, and the
 * floating pill bar + corner launcher. Demo patient: Emma Smith (pat_100).
 */

const ANCHOR = Date.UTC(2026, 7, 12); // the app's synthetic "today"
const DAY_MS = 86_400_000;
const GOAL = 1500;
const TARGETS = { protein: 120, carbs: 130, fat: 50 };
const WATER_TARGET_OZ = 64;
const CUP_OZ = 8;
const CUPS = 8;

type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snacks';
const MEAL_ORDER: MealSlot[] = ['breakfast', 'lunch', 'dinner', 'snacks'];
const MEAL_LABELS: Record<MealSlot, string> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snacks: 'Snacks' };

type DayLog = {
  meals: Record<MealSlot, { count: number; calories: number; protein: number; carbs: number; fat: number }>;
  checkIn: { mood: string; weight: number; sideEffects: string } | null;
};

const EMPTY = { count: 0, calories: 0, protein: 0, carbs: 0, fat: 0 };
const DAYS: Record<number, DayLog> = {
  0: {
    meals: {
      breakfast: { count: 2, calories: 318, protein: 27, carbs: 34, fat: 9 },
      lunch: { count: 3, calories: 612, protein: 51, carbs: 37, fat: 22 },
      dinner: EMPTY,
      snacks: EMPTY,
    },
    checkIn: null,
  },
  1: {
    meals: {
      breakfast: { count: 1, calories: 296, protein: 24, carbs: 30, fat: 8 },
      lunch: { count: 2, calories: 540, protein: 44, carbs: 41, fat: 18 },
      dinner: { count: 3, calories: 588, protein: 46, carbs: 39, fat: 21 },
      snacks: { count: 1, calories: 110, protein: 6, carbs: 12, fat: 4 },
    },
    checkIn: { mood: 'good', weight: 152.8, sideEffects: 'No side effects' },
  },
  2: {
    meals: {
      breakfast: { count: 2, calories: 330, protein: 28, carbs: 32, fat: 10 },
      lunch: { count: 2, calories: 505, protein: 42, carbs: 36, fat: 17 },
      dinner: { count: 2, calories: 610, protein: 48, carbs: 40, fat: 23 },
      snacks: EMPTY,
    },
    checkIn: { mood: 'okay', weight: 153.1, sideEffects: 'Mild headache' },
  },
};
const LOGGED_LAST_7 = [true, true, false, true, true, false, true]; // oldest → today

function longDate(daysAgo: number) {
  return new Date(ANCHOR - daysAgo * DAY_MS).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
function dayLetter(daysAgo: number) {
  return new Date(ANCHOR - daysAgo * DAY_MS).toLocaleDateString('en-US', { weekday: 'narrow', timeZone: 'UTC' });
}

const GAUGE_W = 200;
const GAUGE_H = 108;
const GAUGE_R = 84;
const GAUGE_ARC = `M ${GAUGE_W / 2 - GAUGE_R} 98 A ${GAUGE_R} ${GAUGE_R} 0 0 1 ${GAUGE_W / 2 + GAUGE_R} 98`;
const GAUGE_LEN = Math.PI * GAUGE_R;

const PILL = [
  { key: 'Today', icon: Sun },
  { key: 'Diary', icon: BookOpen },
  { key: 'Progress', icon: BarChart3 },
  { key: 'Coach', icon: MessageCircle },
] as const;

const MENU = [
  { label: 'MENU', items: [{ label: 'Library', icon: Library }, { label: 'Plan', icon: ListChecks }, { label: 'Account & settings', icon: User }] },
  { label: 'QUICK ACTIONS', items: [{ label: 'Scan a barcode', icon: ScanBarcode }, { label: 'Snap a meal photo', icon: Camera }, { label: 'Daily check-in', icon: ClipboardCheck }, { label: 'Progress photos', icon: Images }, { label: 'Log food', icon: Plus }] },
];

export function FloatingLabelsHome() {
  const [daysAgo, setDaysAgo] = useState(0);
  const [logs, setLogs] = useState(DAYS);
  const [water, setWater] = useState<Record<number, number>>({ 0: 40, 1: 64, 2: 56 });
  const [tab, setTab] = useState('Today');
  const [menuOpen, setMenuOpen] = useState(false);
  const [toast, setToast] = useState('');

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 2600);
    return () => clearTimeout(timer);
  }, [toast]);

  const isToday = daysAgo === 0;
  const day = logs[daysAgo] ?? { meals: { breakfast: EMPTY, lunch: EMPTY, dinner: EMPTY, snacks: EMPTY }, checkIn: null };
  const oz = water[daysAgo] ?? 0;
  const cupsFilled = Math.floor(oz / CUP_OZ);

  const totals = useMemo(
    () => MEAL_ORDER.reduce(
      (sum, slot) => ({
        calories: sum.calories + day.meals[slot].calories,
        protein: sum.protein + day.meals[slot].protein,
        carbs: sum.carbs + day.meals[slot].carbs,
        fat: sum.fat + day.meals[slot].fat,
      }),
      { calories: 0, protein: 0, carbs: 0, fat: 0 },
    ),
    [day],
  );
  const remaining = GOAL - totals.calories;
  const overTarget = remaining < 0;
  const pct = Math.round((totals.calories / GOAL) * 100);
  const gaugeFrac = Math.min(1, totals.calories / GOAL);
  const loggedCount = LOGGED_LAST_7.filter(Boolean).length;
  const currentWeight = 152.6;
  const lost = 180 - currentWeight;

  const focusMessage = day.checkIn ? `Feeling ${day.checkIn.mood}` : 'How are you feeling?';

  const addFood = (slot: MealSlot) => {
    const extra = { breakfast: [1, 210, 14, 22, 7], lunch: [1, 180, 18, 12, 6], dinner: [2, 470, 38, 31, 17], snacks: [1, 120, 5, 14, 5] }[slot];
    setLogs((prev) => {
      const current = prev[daysAgo] ?? day;
      const meal = current.meals[slot];
      return {
        ...prev,
        [daysAgo]: {
          ...current,
          meals: {
            ...current.meals,
            [slot]: { count: meal.count + extra[0], calories: meal.calories + extra[1], protein: meal.protein + extra[2], carbs: meal.carbs + extra[3], fat: meal.fat + extra[4] },
          },
        },
      };
    });
    setToast(`Logged to ${MEAL_LABELS[slot].toLowerCase()} · +${extra[1]} cal`);
  };

  const setWaterOz = (next: number) => {
    const clamped = Math.max(0, Math.min(CUPS * CUP_OZ, next));
    setWater((prev) => ({ ...prev, [daysAgo]: clamped }));
    setToast(`${clamped} of ${WATER_TARGET_OZ} fl oz`);
  };

  const completeCheckIn = () => {
    setLogs((prev) => ({ ...prev, [daysAgo]: { ...(prev[daysAgo] ?? day), checkIn: { mood: 'great', weight: currentWeight, sideEffects: 'No side effects' } } }));
    setToast('Checked in · feeling great');
  };

  const open = (what: string) => {
    setMenuOpen(false);
    setToast(`Opening ${what}`);
  };

  return (
    <main className="flh">
      <div className="flh-scroll">
        <div className="flh-status" aria-hidden="true">
          <span>9:41</span>
          <span className="flh-status-right"><i className="flh-sig" /><i className="flh-batt" /></span>
        </div>

        <div className="flh-hero">
          <header className="flh-top">
            <img className="flh-logo" src="/__mockup/images/thinnr-logo-official.png" alt="THINNR" />
            <button className="flh-avatar" type="button" aria-label="Account, Emma Smith" onClick={() => open('Account & settings')}>ES</button>
          </header>

          <div className="flh-date">
            <button type="button" aria-label="Previous day" disabled={daysAgo >= 6} onClick={() => setDaysAgo((d) => d + 1)}><ArrowLeft size={15} /></button>
            <span>{longDate(daysAgo)}</span>
            <button type="button" aria-label="Next day" disabled={isToday} onClick={() => setDaysAgo((d) => d - 1)}><ArrowRight size={15} /></button>
          </div>

          <h1>Welcome<br />back, Emma</h1>
          {!isToday && (
            <button type="button" className="flh-jump" onClick={() => setDaysAgo(0)}>Viewing an earlier day — jump to today</button>
          )}

          <span className="flh-orbit one"><i />day 94 · normalization</span>
          <span className="flh-orbit ink two"><i />−{lost.toFixed(1)} lb total</span>

          <div className="flh-quick">
            <button type="button" onClick={() => open('Restaurant guide')}><Utensils size={13} />Restaurant guide<ChevronRight size={13} /></button>
            <button type="button" onClick={() => open('Approved list')}><Sun size={13} />Approved list<ChevronRight size={13} /></button>
          </div>
        </div>

        <button type="button" className="flh-focus" aria-label={`Today's focus. ${focusMessage}`} onClick={() => open(day.checkIn ? 'your check-in' : 'Daily check-in')}>
          {day.checkIn ? <Check size={15} /> : <Sparkles size={15} />}
          <span className="flh-focus-label">Today&rsquo;s focus</span>
          <span className="flh-focus-value">{focusMessage}</span>
          <ChevronRight size={16} />
        </button>

        <section className="flh-card lift" aria-label="Your day at a glance">
          <div className="flh-card-head">
            <h2>Your day at a glance</h2>
            <span className="flh-tag">{loggedCount} of 7 logged</span>
          </div>
          <div className="flh-streak" aria-label={`${loggedCount} of the last 7 days have food logged`}>
            {LOGGED_LAST_7.map((logged, index) => {
              const ago = 6 - index;
              const selected = ago === daysAgo;
              return (
                <button type="button" key={ago} className={`flh-day${selected ? ' sel' : ''}${logged ? ' log' : ''}`} onClick={() => setDaysAgo(ago)} aria-label={longDate(ago)}>
                  <small>{dayLetter(ago)}</small>
                  <i />
                </button>
              );
            })}
          </div>
        </section>

        <button type="button" className="flh-row" onClick={() => open('Program instructions')}>
          <span className="flh-row-icon"><BookOpen size={16} /></span>
          <span className="flh-row-text">
            <small>Program instructions</small>
            <b>Day 94 · Metabolic Normalization Phase</b>
          </span>
          <ChevronRight size={16} />
        </button>

        <section className="flh-card" aria-label="Calories">
          <div className="flh-cal-head">
            <div>
              <small className="flh-label">{isToday ? 'Calories for today' : 'Calories this day'}</small>
              <b>{overTarget ? (isToday ? 'Over today\u2019s target.' : 'Over target this day.') : 'A well-paced day.'}</b>
            </div>
            <span className="flh-pct">{pct}% consumed</span>
          </div>
          <div className="flh-gauge">
            <svg width={GAUGE_W} height={GAUGE_H} viewBox={`0 0 ${GAUGE_W} ${GAUGE_H}`} aria-hidden="true">
              <path d={GAUGE_ARC} fill="none" stroke="#e6ebe9" strokeWidth="18" strokeLinecap="round" />
              {gaugeFrac > 0 && (
                <path d={GAUGE_ARC} fill="none" stroke={overTarget ? '#0a0a0a' : '#8fd4d5'} strokeWidth="18" strokeLinecap="round" strokeDasharray={`${GAUGE_LEN * gaugeFrac} ${GAUGE_LEN}`} />
              )}
              <path d={GAUGE_ARC} fill="none" stroke="#0a0a0a" strokeWidth="1" strokeDasharray="1 5" opacity="0.35" />
            </svg>
            <div className="flh-gauge-center">
              <b>{Math.abs(remaining).toLocaleString('en-US')}</b>
              <small>{overTarget ? 'over' : 'remaining'}</small>
            </div>
          </div>
          <div className="flh-cal-stats">
            <div><b>{GOAL.toLocaleString('en-US')}</b><small>Goal</small></div>
            <div><b>{totals.calories.toLocaleString('en-US')}</b><small>Food</small></div>
            <div><b className={overTarget ? 'over' : 'teal'}>{remaining.toLocaleString('en-US')}</b><small>Left</small></div>
          </div>
          <div className="flh-macros">
            {(
              [
                ['Protein', totals.protein, TARGETS.protein, 'ink'],
                ['Carbs', totals.carbs, TARGETS.carbs, 'teal'],
                ['Fat', totals.fat, TARGETS.fat, 'aqua'],
              ] as const
            ).map(([label, value, target, tone]) => (
              <div key={label} className="flh-macro">
                <div><span>{label}</span><span className="flh-macro-num">{value} / {target} g</span></div>
                <div className="flh-track"><i className={tone} style={{ width: `${Math.min(100, (value / target) * 100)}%` }} /></div>
              </div>
            ))}
          </div>
        </section>

        <h3 className="flh-section"><i />Meals &amp; hydration</h3>
        <section className="flh-card" aria-label="Meals and hydration">
          {MEAL_ORDER.map((slot) => {
            const meal = day.meals[slot];
            return (
              <div key={slot} className="flh-meal">
                <div>
                  <b>{MEAL_LABELS[slot]}</b>
                  <small>{meal.count === 0 ? 'Nothing logged yet' : `${meal.count} item${meal.count === 1 ? '' : 's'} · ${meal.calories.toLocaleString('en-US')} cal`}</small>
                </div>
                <button type="button" className="flh-add" onClick={() => addFood(slot)}><Plus size={12} strokeWidth={2.5} />Add</button>
              </div>
            );
          })}
          <div className="flh-water">
            <div className="flh-water-head">
              <span className="flh-row-icon"><Droplet size={15} /></span>
              <div className="flh-row-text">
                <b>Water</b>
                <small>{oz} of {WATER_TARGET_OZ} fl oz · {cupsFilled} of {CUPS} cups</small>
              </div>
              <div className="flh-adjust">
                <button type="button" aria-label="Remove a cup" onClick={() => setWaterOz(oz - CUP_OZ)}><Minus size={13} /></button>
                <button type="button" aria-label="Add a cup" onClick={() => setWaterOz(oz + CUP_OZ)}><Plus size={13} /></button>
              </div>
            </div>
            <div className="flh-cups">
              {Array.from({ length: CUPS }).map((_, index) => (
                <button
                  type="button"
                  key={index}
                  className={index < cupsFilled ? 'on' : ''}
                  aria-label={`Set water to ${(index + 1) * CUP_OZ} fl oz`}
                  onClick={() => setWaterOz(index < cupsFilled && index === cupsFilled - 1 ? index * CUP_OZ : (index + 1) * CUP_OZ)}
                />
              ))}
            </div>
          </div>
        </section>

        <section className="flh-card" aria-label="Daily check-in">
          <small className="flh-label">Daily check-in</small>
          {day.checkIn ? (
            <div className="flh-checked">
              <span className="flh-check-icon"><Check size={15} strokeWidth={2.5} /></span>
              <div className="flh-row-text">
                <b>Checked in — feeling {day.checkIn.mood}</b>
                <small>Weight {day.checkIn.weight.toFixed(1)} lbs · {day.checkIn.sideEffects}</small>
              </div>
              {isToday && (
                <button type="button" className="flh-link" onClick={() => open('your check-in')}>Update <ArrowRight size={11} /></button>
              )}
            </div>
          ) : isToday ? (
            <>
              <b className="flh-headline">You haven&rsquo;t checked in today</b>
              <p className="flh-body">Log your weight, mood, and how the plan feels. It takes 30 seconds.</p>
              <button type="button" className="flh-primary" onClick={completeCheckIn}>Complete Check-In <ArrowRight size={14} /></button>
            </>
          ) : (
            <>
              <b className="flh-headline">No check-in recorded</b>
              <p className="flh-body">Nothing was logged for this day.</p>
            </>
          )}
        </section>

        <section className="flh-card" aria-label="Weight snapshot">
          <div className="flh-card-head">
            <h2>Weight snapshot</h2>
            <button type="button" className="flh-link" onClick={() => open('Progress')}>View full progress</button>
          </div>
          <div className="flh-weights">
            <div><b>{currentWeight.toFixed(1)} lb</b><small>Current</small></div>
            <div><b className="teal">−{lost.toFixed(1)} lb</b><small>Total</small></div>
            <div><b>150 lb</b><small>Goal</small></div>
          </div>
        </section>

        <p className="flh-disclaimer">Synthetic demo data <X size={8} /> not medical advice</p>
      </div>

      <nav className="flh-pill" aria-label="Primary">
        {PILL.map(({ key, icon: Icon }) => (
          <button
            key={key}
            type="button"
            className={tab === key ? 'on' : ''}
            aria-current={tab === key ? 'page' : undefined}
            onClick={() => {
              setTab(key);
              setMenuOpen(false);
              if (key !== 'Today') setToast(`Opening ${key}`);
            }}
          >
            <Icon size={16} strokeWidth={1.9} />
            {key}
          </button>
        ))}
      </nav>
      <button type="button" className={`flh-fab${menuOpen ? ' open' : ''}`} aria-label={menuOpen ? 'Close menu' : 'Open menu'} aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
        <Plus size={20} strokeWidth={2.2} />
      </button>

      {menuOpen && (
        <div className="flh-menu" role="menu">
          {MENU.map((group) => (
            <div key={group.label}>
              <p>{group.label}</p>
              {group.items.map(({ label, icon: Icon }) => (
                <button key={label} type="button" role="menuitem" onClick={() => open(label)}>
                  <Icon size={14} strokeWidth={1.9} />{label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      {toast && (
        <div className="flh-toast" role="status">
          <i />
          {toast}
        </div>
      )}
    </main>
  );
}
