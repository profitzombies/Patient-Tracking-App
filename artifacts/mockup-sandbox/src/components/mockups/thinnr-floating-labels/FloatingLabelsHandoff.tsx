import { useEffect, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, Copy, KeyRound } from 'lucide-react';
import './_fl-base.css';
import './FloatingLabelsHandoff.css';

/*
 * Floating Labels — implementation handoff.
 * Answers "how does this become real code?" in the design system itself:
 * tokens with web (HSL) + mobile (hex) values, type + font wiring, live
 * component recipes, a frame → real-file map, and the ordered checklist.
 */

type SystemTab = 'tokens' | 'type' | 'recipes';

type Token = { name: string; hex: string; hsl: string; role: string; maps: string; tag?: string };

const TOKENS: Token[] = [
  { name: 'ink', hex: '#0a0a0a', hsl: '0 0% 3.9%', role: 'Text, 1px borders, primary buttons, toasts', maps: '--foreground · --primary' },
  { name: 'paper', hex: '#fbfcfa', hsl: '90 25% 98.4%', role: 'Page background behind every screen', maps: '--background' },
  { name: 'card', hex: '#ffffff', hsl: '0 0% 100%', role: 'Cards, inputs, chips, tab pill', maps: '--card · --popover' },
  { name: 'aqua', hex: '#8fd4d5', hsl: '181 45.5% 69.8%', role: 'Offset shadows, focus ring, gauge fill, signal dots', maps: '--accent · --ring', tag: 'PMS 630C' },
  { name: 'aqua-soft', hex: '#e9f6f6', hsl: '180 41.9% 93.9%', role: 'Tinted surfaces, mobile focus halo, code marks', maps: '--accent-soft (new)' },
  { name: 'teal', hex: '#4fb3b4', hsl: '181 40.2% 50.8%', role: 'Secondary dots, hover shadow, done strikes', maps: '--chart-2 · --accent-strong (new)' },
  { name: 'powder', hex: '#bacdea', hsl: '216 53.3% 82.4%', role: 'Third data hue in revenue bars only', maps: '--chart-3' },
  { name: 'powder-soft', hex: '#eef3fa', hsl: '215 54.5% 95.7%', role: 'Powder tint behind stage labels', maps: '--chart-3-soft (new)' },
  { name: 'line', hex: '#d7dcda', hsl: '156 6.7% 85.3%', role: 'Hairlines, chip borders, table rules', maps: '--border · --input' },
  { name: 'track', hex: '#e6ebe9', hsl: '156 11.1% 91.2%', role: 'Gauge and progress-bar tracks', maps: '--muted' },
  { name: 'muted', hex: '#5e6564', hsl: '171 3.6% 38.2%', role: 'Secondary and helper text', maps: '--muted-foreground' },
];

const RETIRED = [
  { name: 'cobalt #315eae', hex: '#315eae' },
  { name: 'navy #203b64', hex: '#203b64' },
  { name: 'orange #df772c', hex: '#df772c' },
  { name: 'cream #fdfcf9', hex: '#fdfcf9' },
];

type Route = { id: string; index: string; kind: string; title: string; from: string; to: string[]; keep: string[] };

const ROUTES: Route[] = [
  {
    id: 'login-web',
    index: '01',
    kind: 'Staff login · desktop',
    title: 'Sign in to the work.',
    from: 'mockup-sandbox/…/getthinnr-login-round3/Concept2Web.tsx',
    to: ['thinnr-operations/src/pages/SignIn.tsx', 'thinnr-operations/src/pages/AuthScreens.tsx (code, invite, reset)'],
    keep: ['Email first, then a six-digit one-time code — no password', 'Card 416px wide, 1px ink border, 9px aqua offset', 'Five floating protocol chips plus the crosshair mark', '"Try the guided demo" disclosure under the form'],
  },
  {
    id: 'login-mobile',
    index: '02',
    kind: 'Patient login · mobile',
    title: 'Welcome back.',
    from: 'mockup-sandbox/…/getthinnr-login-round3/Concept2Mobile.tsx',
    to: ['thinnr-mobile/app/patient-login.tsx', 'thinnr-mobile/app/provider-login.tsx (same shell)', 'thinnr-mobile/app/patient-signup.tsx'],
    keep: ['Phone / email toggle, password eye, forgot link', 'Form card with 6px aqua offset, 43px inputs, 7px radius', 'Two orbit chips, create-account and provider links', '35px square back button, kicker with teal dot'],
  },
  {
    id: 'dashboard',
    index: '03',
    kind: 'Staff admin dashboard · desktop',
    title: 'Practice pulse.',
    from: 'mockup-sandbox/…/thinnr-floating-labels/FloatingLabelsDashboard.tsx',
    to: ['thinnr-operations/src/pages/Overview.tsx', 'thinnr-operations/src/OfficeApp.tsx (shell + sidebar)', 'thinnr-operations/src/index.css (:root tokens, fonts)'],
    keep: ['Sidebar groups with signal dots, logo top-left', 'Four metric stats and the overdue banner', 'Revenue bars in aqua / teal / powder, protocol stages', 'Watchlist table, team activity, floating chips, toast'],
  },
  {
    id: 'home',
    index: '04',
    kind: 'Patient app home · mobile',
    title: 'Today.',
    from: 'mockup-sandbox/…/thinnr-floating-labels/FloatingLabelsHome.tsx',
    to: ['thinnr-mobile/app/(patient)/today.tsx', 'thinnr-mobile/app/(patient)/_layout.tsx (pill tab bar)', 'thinnr-mobile/constants/colors.ts + hooks/useColors.ts'],
    keep: ['Day strip, greeting, orbit chips, focus bar', 'Calorie gauge: aqua fill on the #e6ebe9 track', 'Macros, meals and water, check-in, weight snapshot', 'Pill nav with FAB menu, same toast pattern'],
  },
];

type Step = { id: string; title: string; detail: string };

const GROUND: Step[] = [
  { id: 'fonts', title: 'Ship GT America Mono Bold to both apps', detail: 'attached_assets/GT-America-Mono-Bold_1788801993205.otf → thinnr-operations/public/fonts/ and thinnr-mobile/assets/fonts/. Inter stays as the reading face.' },
  { id: 'logo', title: 'Ship the official wordmark', detail: 'attached_assets/6781908106a06dc74db0c27c_(4)_1788802358387.png (1280×294, black on transparent) → both apps. 32px tall on web, 28px on mobile.' },
  { id: 'web-tokens', title: 'Rewrite the web :root', detail: 'thinnr-operations/src/index.css — HSL column above replaces the Heritage cobalt/cream values; --radius 7px; --font-mono → GT America Mono; drop Playfair and Spline Sans Mono.' },
  { id: 'mobile-tokens', title: 'Repoint the mobile palette', detail: 'thinnr-mobile/constants/colors.ts — keep every key name, move the values. Add GTAmericaMono_700Bold to APP_FONTS in app/_layout.tsx.' },
  { id: 'screens', title: 'Rebuild the four screens, in this order', detail: 'SignIn + AuthScreens → patient-login / provider-login / signup → OfficeApp shell + Overview → (patient)/_layout + today.' },
  { id: 'verify', title: 'Verify contrast and dark mode', detail: 'Aqua is a shadow/fill colour, never text on white. Decide the .dark mapping before the shell ships.' },
];

const WEB_SNIPPET = `/* thinnr-operations/src/index.css */
@font-face {
  font-family: "GT America Mono";
  src: url("/fonts/gt-america-mono-bold.otf")
       format("opentype");
  font-weight: 700; font-display: swap;
}
@theme inline {
  --font-sans: "Inter", ui-sans-serif, system-ui;
  --font-mono: "GT America Mono", ui-monospace;
}
:root {
  --radius: 7px;
  --background: 90 25% 98.4%;     /* paper  */
  --foreground: 0 0% 3.9%;        /* ink    */
  --card: 0 0% 100%;
  --primary: 0 0% 3.9%;           /* ink    */
  --accent: 181 45.5% 69.8%;      /* aqua   */
  --ring: 181 45.5% 69.8%;
  --border: 156 6.7% 85.3%;       /* line   */
  --input: 0 0% 3.9%;
  --muted: 156 11.1% 91.2%;       /* track  */
  --muted-foreground: 171 3.6% 38.2%;
  --chart-2: 181 40.2% 50.8%;     /* teal   */
  --chart-3: 216 53.3% 82.4%;     /* powder */
}`;

const MOBILE_SNIPPET = `// thinnr-mobile/app/_layout.tsx
const APP_FONTS = {
  ...existingFonts,
  GTAmericaMono_700Bold:
    require("../assets/fonts/GT-America-Mono-Bold.otf"),
};

// thinnr-mobile/constants/colors.ts (keep key names)
light: {
  background: "#fbfcfa",  foreground: "#0a0a0a",
  card: "#ffffff",        primary: "#0a0a0a",
  primaryForeground: "#ffffff",
  accent: "#8fd4d5",      accentForeground: "#0a0a0a",
  border: "#d7dcda",      input: "#0a0a0a",
  muted: "#e6ebe9",       mutedForeground: "#5e6564",
  track: "#e6ebe9",       teal: "#4fb3b4",
  aquaSoft: "#e9f6f6",    powder: "#bacdea",
}

// usage
fontFamily: "GTAmericaMono_700Bold"  // headlines, labels
fontFamily: "Inter_400Regular"       // reading text`;

function buildBrief(checks: Record<string, boolean>): string {
  const mark = (id: string) => (checks[id] ? '[x]' : '[ ]');
  return [
    '# THINNR — Floating Labels: design → code handoff',
    '',
    '## Tokens (web HSL / mobile hex)',
    ...TOKENS.map((t) => `- ${t.name}: ${t.hex} · hsl(${t.hsl}) — ${t.role} → ${t.maps}`),
    `- retired: ${RETIRED.map((r) => r.name).join(', ')}, Playfair Display, Spline Sans Mono`,
    '',
    '## Type',
    '- Display + labels: GT America Mono Bold, uppercase. Display 40–62px / 0.94–0.98, tracking -0.04em. Labels 10–11px, tracking +0.07 to +0.14em.',
    '- Body: Inter 13px / 1.5, muted #5e6564 for helper text.',
    '',
    '## Components',
    '- Primary button: 48px, ink fill, 7px radius, mono 12px uppercase; hover lifts 2px with 3px teal offset.',
    '- Input: 48px (43px mobile), 1px ink border, 7px radius, focus = 0 0 0 3px aqua.',
    '- Card: white, 1px ink border, offset shadow 9px aqua (web) / 6px (mobile); hover 3px.',
    '- Chip: white pill, 1px line border, mono 10px uppercase, 7px signal dot (aqua / teal / ink), float 5s.',
    '- Notice: 3px aqua left border. Toast: ink pill, mono 10px, bottom-centre.',
    '',
    '## Groundwork',
    ...GROUND.map((g, i) => `${mark(g.id)} ${i + 1}. ${g.title} — ${g.detail}`),
    '',
    '## Screens',
    ...ROUTES.map((r) => `${mark(r.id)} ${r.index} ${r.kind} — "${r.title}"\n    from: ${r.from}\n    to: ${r.to.join('; ')}\n    keep: ${r.keep.join('; ')}`),
  ].join('\n');
}

export function FloatingLabelsHandoff() {
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState('');
  const [lastCopied, setLastCopied] = useState('');
  const [tab, setTab] = useState<SystemTab>('tokens');

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 2600);
    return () => clearTimeout(timer);
  }, [toast]);

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setLastCopied(label);
      setToast(`Copied ${label}`);
    } catch {
      setToast(`Clipboard blocked — ${label} is selectable`);
    }
  };

  const toggle = (id: string) => setChecks((current) => ({ ...current, [id]: !current[id] }));
  const total = GROUND.length + ROUTES.length;
  const done = [...GROUND, ...ROUTES].filter((item) => checks[item.id]).length;
  const setAll = (value: boolean) => {
    const next: Record<string, boolean> = {};
    [...GROUND, ...ROUTES].forEach((item) => { next[item.id] = value; });
    setChecks(next);
    setToast(value ? 'Everything marked ready' : 'Checklist reset');
  };

  return (
    <main className="flx">
      <header className="flx-header">
        <div className="flx-brand">
          <img src="/__mockup/images/thinnr-logo-official.png" alt="THINNR" />
          <span>/ Design system</span>
        </div>
        <div className="flx-status">
          <span><i className="flx-dot" /> floating labels · handoff 01</span>
          <span><i className="flx-dot ink" /> 4 screens · 2 apps · 1 token sheet</span>
        </div>
      </header>

      <section className="flx-hero">
        <div>
          <p className="flx-eyebrow"><i className="flx-dot teal" /> Implementation handoff / 01</p>
          <h1>From frame to <em>codebase.</em></h1>
          <p className="flx-lede">
            The four Floating Labels frames share one small system: eleven colours, two typefaces, five component recipes.
            Land the groundwork once, then each screen is a restyle of a file that already exists.
          </p>
          <div className="flx-hero-meta">
            <span className="flx-chip float"><i className="flx-dot" />11 tokens</span>
            <span className="flx-chip float" style={{ animationDelay: '-1.4s' }}><i className="flx-dot teal" />2 typefaces</span>
            <span className="flx-chip float" style={{ animationDelay: '-2.6s' }}><i className="flx-dot ink" />5 recipes</span>
            <span className="flx-chip float" style={{ animationDelay: '-3.4s' }}><i className="flx-dot powder" />12 real files</span>
          </div>
        </div>
        <aside className="flx-seq" aria-label="Build sequence">
          <h2>Build sequence <span>ordered</span></h2>
          <ol>
            <li><span className="n">01</span><span className="t">Groundwork<small>Fonts, wordmark, token sheets in both apps</small></span><span className="w">web + mobile</span></li>
            <li><span className="n">02</span><span className="t">Sign-in pair<small>Staff email-code flow, patient phone + password</small></span><span className="w">web + mobile</span></li>
            <li><span className="n">03</span><span className="t">Shell and Overview<small>Sidebar rail, Practice Pulse, watchlist, chips</small></span><span className="w">web</span></li>
            <li><span className="n">04</span><span className="t">Patient Today<small>Day strip, gauge, macros, pill nav, FAB</small></span><span className="w">mobile</span></li>
          </ol>
        </aside>
      </section>

      <section className="flx-section" aria-labelledby="flx-system">
        <div className="flx-section-head">
          <h2 id="flx-system"><span>01</span>The system</h2>
          <div className="flx-tabs" role="tablist" aria-label="System sheets">
            <button type="button" role="tab" aria-selected={tab === 'tokens'} className={`flx-tab${tab === 'tokens' ? ' on' : ''}`} onClick={() => setTab('tokens')}><i className="flx-dot" />Tokens · 11</button>
            <button type="button" role="tab" aria-selected={tab === 'type'} className={`flx-tab${tab === 'type' ? ' on' : ''}`} onClick={() => setTab('type')}><i className="flx-dot teal" />Type and font wiring</button>
            <button type="button" role="tab" aria-selected={tab === 'recipes'} className={`flx-tab${tab === 'recipes' ? ' on' : ''}`} onClick={() => setTab('recipes')}><i className="flx-dot ink" />Component recipes · 8</button>
          </div>
        </div>

        {tab === 'tokens' && (
          <div className="flx-panel" role="tabpanel" key="tokens">
            <p className="flx-panel-note">Hex is the mobile value for <code>constants/colors.ts</code>. The HSL triple drops straight into the web <code>:root</code>. Click a swatch to copy its hex.</p>
            <div className="flx-swatches">
          {TOKENS.map((token) => (
            <button
              key={token.name}
              type="button"
              className="flx-swatch"
              onClick={() => copy(token.hex, token.hex)}
              aria-label={`Copy ${token.name} ${token.hex}`}
            >
              <span className="color" style={{ background: token.hex }}>
                <span className="copy">{lastCopied === token.hex ? <Check size={11} /> : <Copy size={11} />}</span>
              </span>
              <span className="body">
                <span className="name">{token.name}{token.tag && <small>{token.tag}</small>}</span>
                <span className="hex">{token.hex}</span>
                <span className="hsl">{token.hsl}</span>
                <span className="role">{token.role}</span>
                <span className="maps">{token.maps}</span>
              </span>
            </button>
          ))}
          <div className="flx-swatch" style={{ borderStyle: 'dashed', background: 'transparent' }}>
            <span className="color" style={{ background: 'linear-gradient(135deg, var(--aqua) 0 50%, var(--teal) 50% 100%)' }} />
            <span className="body">
              <span className="name">rule</span>
              <span className="hex">no coral</span>
              <span className="hsl">no purple, no neon</span>
              <span className="role">Aqua and teal are the only accents. Powder appears in data only.</span>
              <span className="maps">one accent family</span>
            </span>
          </div>
        </div>
        <div className="flx-retired">
          <b>Retired from Heritage</b>
          {RETIRED.map((item) => <span key={item.name}><i style={{ background: item.hex }} />{item.name}</span>)}
          <span>Playfair Display</span>
          <span>Spline Sans Mono</span>
        </div>
          </div>
        )}

        {tab === 'type' && (
          <div className="flx-panel" role="tabpanel" key="type">
            <p className="flx-panel-note">GT America Mono carries every headline and label; Inter does the reading. Only the Bold cut exists, so the mono face is never used at regular weight. Both snippets are copy-ready.</p>
            <div className="flx-type">
          <div className="flx-specimens">
            <div className="flx-spec"><div className="meta"><b>Display</b>GT America Mono 700<br />40–62px / 0.94–0.98<br />tracking -0.04em · uppercase</div><div className="flx-display">Sign in to the work.</div></div>
            <div className="flx-spec"><div className="meta"><b>Section</b>GT America Mono 700<br />24–27px / 1 · -0.04em</div><div className="flx-h2">Practice pulse</div></div>
            <div className="flx-spec"><div className="meta"><b>Eyebrow</b>GT America Mono 700<br />10px · +0.14em · uppercase</div><div className="flx-eyebrow-sample">Staff access / 01</div></div>
            <div className="flx-spec"><div className="meta"><b>Field label</b>GT America Mono 700<br />11px · +0.07em · uppercase</div><div className="flx-label-sample">Work email</div></div>
            <div className="flx-spec"><div className="meta"><b>Body</b>Inter 400<br />13px / 1.5 · muted</div><div className="flx-body-sample">We’ll email a one-time code. It’s a password-free way to verify it’s you.</div></div>
            <div className="flx-spec"><div className="meta"><b>Meta</b>GT America Mono 700<br />10px · +0.06em · muted</div><div className="flx-meta-sample">THINNR Operations · Staff workspace</div></div>
          </div>
          <div className="flx-snippets">
            <div className="flx-code">
              <header>
                <span>Web · index.css</span>
                <button type="button" onClick={() => copy(WEB_SNIPPET, 'the web snippet')}>{lastCopied === 'the web snippet' ? <Check size={11} /> : <Copy size={11} />} Copy</button>
              </header>
              <pre>{WEB_SNIPPET}</pre>
            </div>
            <div className="flx-code">
              <header>
                <span>Mobile · Expo</span>
                <button type="button" onClick={() => copy(MOBILE_SNIPPET, 'the mobile snippet')}>{lastCopied === 'the mobile snippet' ? <Check size={11} /> : <Copy size={11} />} Copy</button>
              </header>
              <pre>{MOBILE_SNIPPET}</pre>
            </div>
          </div>
        </div>
          </div>
        )}

        {tab === 'recipes' && (
          <div className="flx-panel" role="tabpanel" key="recipes">
            <p className="flx-panel-note">Live specimens — hover the button, click into the field. Each one is a few lines of CSS or a StyleSheet block; no new libraries.</p>
            <div className="flx-parts">
          <div className="flx-part">
            <h3>Primary button</h3>
            <p>Ink fill, lifts on hover with a teal offset.</p>
            <div className="stage"><button type="button" className="flx-primary" onClick={() => setToast('A one-time code is on its way')}>Email me a code <ArrowRight size={15} /></button></div>
            <div className="spec">h 48 · radius 7 · mono 12 / +0.06em<br />hover: translate(-2,-2) + 3px teal</div>
          </div>
          <div className="flx-part">
            <h3>Input + label</h3>
            <p>Ink hairline, aqua focus ring, no inner shadow.</p>
            <div className="stage"><div className="flx-field"><label htmlFor="flx-demo-email">Work email</label><input id="flx-demo-email" type="email" placeholder="you@yourpractice.com" /></div></div>
            <div className="spec">h 48 web / 43 mobile · radius 7<br />focus: 0 0 0 3px aqua</div>
          </div>
          <div className="flx-part">
            <h3>Offset card</h3>
            <p>The signature: hard aqua shadow, never blurred.</p>
            <div className="stage"><div className="flx-offset"><small>Staff access / 01</small><b>Check your inbox</b></div></div>
            <div className="spec">border 1px ink · shadow 9px web / 6px mobile<br />small cards 3–4px</div>
          </div>
          <div className="flx-part">
            <h3>Signal chips</h3>
            <p>Status as a dot, never as a coloured background.</p>
            <div className="stage">
              <div className="flx-legend">
                <span><span className="flx-chip"><i className="flx-dot" />protocol ready</span> aqua · on track</span>
                <span><span className="flx-chip"><i className="flx-dot teal" />team access</span> teal · secondary</span>
                <span><span className="flx-chip"><i className="flx-dot ink" />needs review</span> ink · attention</span>
              </div>
            </div>
            <div className="spec">pill · line border · mono 10 · dot 7px<br />float 5s ease-in-out, staggered delays</div>
          </div>
          <div className="flx-part">
            <h3>Gauge and tracks</h3>
            <p>Aqua fill on the track grey; ink numerals.</p>
            <div className="stage"><div className="flx-gauge"><i>62%</i></div></div>
            <div className="spec">conic aqua → track #e6ebe9<br />bars: aqua / teal / powder in that order</div>
          </div>
          <div className="flx-part">
            <h3>Notice and toast</h3>
            <p>Quiet inline notice; ink pill for confirmations.</p>
            <div className="stage"><div className="flx-stack"><p className="flx-notice" style={{ margin: 0 }}>A one-time code is ready for your work inbox.</p><span className="flx-toast-sample"><KeyRound size={11} /> Code verified</span></div></div>
            <div className="spec">notice: 3px aqua left rule · 11px<br />toast: bottom-centre, 2.6s, rise 8px</div>
          </div>
          <div className="flx-part">
            <h3>Grid backdrop</h3>
            <p>32px hairline grid, faded at the edges.</p>
            <div className="stage" style={{ backgroundImage: 'linear-gradient(rgba(10,10,10,.06) 1px, transparent 1px), linear-gradient(90deg, rgba(10,10,10,.06) 1px, transparent 1px)', backgroundSize: '32px 32px' }}><span className="flx-chip"><i className="flx-dot" />paper + grid</span></div>
            <div className="spec">rgba(10,10,10,.026) lines · mask 20–80%<br />mobile: 24px vertical rules only</div>
          </div>
          <div className="flx-part">
            <h3>Wordmark</h3>
            <p>Official PNG, black on transparent, never inverted on light.</p>
            <div className="stage"><img src="/__mockup/images/thinnr-logo-official.png" alt="THINNR wordmark" style={{ height: 30, width: 'auto' }} /></div>
            <div className="spec">web header 32px · mobile 28px<br />paired with “/ Operations” in mono 12</div>
          </div>
        </div>
          </div>
        )}
      </section>

      <section className="flx-section" aria-labelledby="flx-routes">
        <div className="flx-section-head">
          <h2 id="flx-routes"><span>02</span>Where each frame lands</h2>
          <p>Every mockup mirrors a screen that already exists. Nothing new gets routed — the real files are restyled in place and keep their data hooks.</p>
        </div>
        <div className="flx-map">
          {ROUTES.map((route) => (
            <article key={route.id} className={`flx-route${checks[route.id] ? ' done' : ''}`}>
              <div className="head">
                <div>
                  <p className="flx-eyebrow" style={{ margin: 0 }}><i className="flx-dot" /> Frame {route.index} · {route.kind}</p>
                  <h3>{route.title}</h3>
                  <p className="from">{route.from}</p>
                </div>
                <button type="button" className={`flx-check${checks[route.id] ? ' on' : ''}`} onClick={() => toggle(route.id)} aria-pressed={!!checks[route.id]}>
                  <i>{checks[route.id] && <Check size={11} />}</i>{checks[route.id] ? 'Graduated' : 'Ready to graduate'}
                </button>
              </div>
              <div>
                <h4><ArrowUpRight size={11} /> Real files</h4>
                <ul>{route.to.map((file) => <li key={file}><code>{file}</code></li>)}</ul>
              </div>
              <div>
                <h4>Keep exactly</h4>
                <ul>{route.keep.map((item) => <li key={item}><i className="flx-dot teal" />{item}</li>)}</ul>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="flx-section" aria-labelledby="flx-ground">
        <div className="flx-section-head">
          <h2 id="flx-ground"><span>03</span>Groundwork checklist</h2>
          <p>Do these before touching a screen. They are the only steps that cross both apps, and they make every later change a find-and-replace.</p>
        </div>
        <div className="flx-ground">
          <ol className="flx-steps">
            {GROUND.map((step, index) => (
              <li key={step.id} className={checks[step.id] ? 'on' : ''}>
                <span className="n">0{index + 1}</span>
                <span className="t"><span>{step.title}</span><small>{step.detail}</small></span>
                <button type="button" className={`flx-check${checks[step.id] ? ' on' : ''}`} onClick={() => toggle(step.id)} aria-pressed={!!checks[step.id]}>
                  <i>{checks[step.id] && <Check size={11} />}</i>{checks[step.id] ? 'Done' : 'Mark done'}
                </button>
              </li>
            ))}
          </ol>
          <aside className="flx-brief">
            <h3>Hand it to the build.</h3>
            <p>Copies a markdown brief with every token, recipe, file path and the current checklist state — paste it into the build task and the engineer has no guessing left.</p>
            <div className="progress"><i style={{ transform: `scaleX(${total ? done / total : 0})` }} /></div>
            <div className="count"><span>{done} of {total} marked ready</span><span>{done === total ? 'ship it' : 'in progress'}</span></div>
            <button type="button" className="flx-brief-btn" onClick={() => copy(buildBrief(checks), 'the handoff brief')}>
              {lastCopied === 'the handoff brief' ? <Check size={15} /> : <Copy size={15} />} Copy handoff brief
            </button>
            <button type="button" className="ghost" onClick={() => setAll(done !== total)}>{done === total ? 'Reset checklist' : 'Mark everything ready'}</button>
            <p className="fine">Application code lives outside this sandbox — the brief is the contract.</p>
          </aside>
        </div>
      </section>

      <footer className="flx-footer">
        <span>THINNR design system · Floating Labels</span>
        <span>Protocol aqua PMS 630C · GT America Mono Bold · Inter</span>
      </footer>

      {toast && <div className="flx-toast" role="status"><Check size={11} /> {toast}</div>}
    </main>
  );
}
