import { useState } from 'react';
import { ArrowRight, Building2, ChevronDown, Stethoscope } from 'lucide-react';
import './_group.css';
import './_thinnr-brand.css';

const colors = {
  background: '#f6fafa',
  foreground: '#0b0f0f',
  border: '#d2dede',
  card: '#ffffff',
  navy: '#0b0f0f',
  cobalt: '#0b0f0f',
  muted: '#5b6868',
  accent: '#dff3f3',
  brand: '#8fd4d5',
  sidebar: '#e4f4f4',
};

const softShadow =
  '0 1px 2px rgba(11, 15, 15, 0.05), 0 10px 28px -20px rgba(11, 15, 15, 0.28)';

const demoOptions = [
  {
    icon: Building2,
    title: 'THINNR HQ admin',
    description: 'The umbrella above every office: rollups, provider accounts, and org tools.',
    cta: 'Enter HQ admin',
  },
  {
    icon: Stethoscope,
    title: 'Office staff',
    description: 'Today’s operations desk for the med spa team, exactly as it runs day to day.',
    cta: 'Enter the office',
  },
];

export function CurrentWeb() {
  const [showDemo, setShowDemo] = useState(false);
  const [email, setEmail] = useState('');

  return (
    <div
      className="thinnr-login thinnr-brand thinnr-brand-web"
      style={{
        width: 1280,
        height: 800,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        background: colors.background,
        color: colors.foreground,
        fontFamily: "'Inter', system-ui, sans-serif",
        boxSizing: 'border-box',
      }}
    >
      <main
        style={{
          width: '100%',
          maxWidth: 760,
          minHeight: 0,
          flex: 1,
          margin: '0 auto',
          padding: '40px 20px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          boxSizing: 'border-box',
        }}
      >
        <header style={{ marginBottom: 32, textAlign: 'center' }}>
          <img
            className="th-logo"
            src="/__mockup/images/login-redesign-thinnr-logo.png"
            alt="THINNR"
            style={{ height: 56, width: 'auto', margin: '0 auto', display: 'block' }}
          />
          <h1
            style={{
              margin: '16px 0 0',
              color: colors.navy,
              fontFamily: "'GT America Mono', ui-monospace, monospace",
              fontSize: 34,
              lineHeight: 1.25,
              fontWeight: 700,
              letterSpacing: '-.02em',
            }}
          >
            Staff sign in
          </h1>
          <p
            style={{
              maxWidth: '52ch',
              margin: '8px auto 0',
              color: colors.muted,
              fontSize: 14,
              lineHeight: 1.625,
            }}
          >
            Sign in with your work email — we’ll send a one-time code. HQ admins land on the
            umbrella overview; office teams land on today’s desk.
          </p>
        </header>

        <section
          style={{
            width: '100%',
            maxWidth: 430,
            margin: '0 auto',
            padding: 24,
            border: `1px solid ${colors.border}`,
            borderRadius: 9,
            background: colors.card,
            boxShadow: softShadow,
            boxSizing: 'border-box',
          }}
        >
          <form onSubmit={(event) => event.preventDefault()} noValidate>
            <div>
              <label
                htmlFor="current-auth-email"
                style={{
                  display: 'block',
                  color: colors.navy,
                  fontSize: 12,
                  fontWeight: 600,
                  lineHeight: 1,
                }}
              >
                Work email
              </label>
              <input
                id="current-auth-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@yourclinic.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                style={{
                  display: 'flex',
                  width: '100%',
                  height: 36,
                  marginTop: 6,
                  padding: '4px 12px',
                  boxSizing: 'border-box',
                  border: `1px solid ${colors.border}`,
                  borderRadius: 7,
                  outline: 'none',
                  background: 'transparent',
                  color: colors.foreground,
                  boxShadow: '0 1px 2px rgba(0,0,0,.05)',
                  font: "400 14px 'Inter', system-ui, sans-serif",
                }}
              />
              <p
                style={{
                  margin: '6px 0 0',
                  color: colors.muted,
                  fontSize: 11,
                  lineHeight: 1.625,
                }}
              >
                We’ll email you a 6-digit sign-in code. No password needed.
              </p>
              <button
                type="submit"
                style={{
                  width: '100%',
                  height: 40,
                  marginTop: 16,
                  padding: '8px 16px',
                  border: '1px solid #0b0f0f',
                  borderRadius: 7,
                  background: '#8fd4d5',
                  color: '#0b0f0f',
                  font: "700 14px 'Inter', system-ui, sans-serif",
                  cursor: 'pointer',
                }}
              >
                Email me a code
              </button>
            </div>
          </form>
        </section>

        <div style={{ marginTop: 24, textAlign: 'center' }}>
          <button
            type="button"
            onClick={() => setShowDemo((open) => !open)}
            aria-expanded={showDemo}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: 0,
              border: 0,
              background: 'transparent',
              color: colors.muted,
              font: "600 12px 'Inter', system-ui, sans-serif",
              cursor: 'pointer',
            }}
          >
            Exploring? Browse the guided demo without an account
            <ChevronDown
              size={14}
              aria-hidden="true"
              style={{
                transition: 'transform 150ms',
                transform: showDemo ? 'rotate(180deg)' : undefined,
              }}
            />
          </button>
        </div>

        {showDemo && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: 12,
              marginTop: 16,
            }}
          >
            {demoOptions.map((option) => {
              const Icon = option.icon;
              return (
                <section
                  key={option.title}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    padding: 16,
                    border: `1px solid ${colors.border}`,
                    borderRadius: 9,
                    background: colors.card,
                    boxShadow: softShadow,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span
                      style={{
                        display: 'grid',
                        flexShrink: 0,
                        placeItems: 'center',
                        width: 32,
                        height: 32,
                        borderRadius: 7,
                        background: colors.accent,
                        color: colors.cobalt,
                      }}
                    >
                      <Icon size={18} />
                    </span>
                    <h2
                      style={{
                        margin: 0,
                        color: colors.navy,
                        fontFamily: "'GT America Mono', ui-monospace, monospace",
                        fontSize: 16,
                        fontWeight: 700,
                        letterSpacing: '-.01em',
                      }}
                    >
                      {option.title}
                    </h2>
                  </div>
                  <p style={{ margin: '8px 0 0', color: colors.muted, fontSize: 12, lineHeight: 1.625 }}>
                    {option.description}
                  </p>
                  <button
                    type="button"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 8,
                      width: '100%',
                      height: 36,
                      marginTop: 16,
                      padding: '0 16px',
                      border: `1px solid ${colors.border}`,
                      borderRadius: 7,
                      background: colors.background,
                      color: colors.foreground,
                      font: "600 12px 'Inter', system-ui, sans-serif",
                    }}
                  >
                    {option.cta}
                    <ArrowRight size={14} />
                  </button>
                </section>
              );
            })}
          </div>
        )}

        <p style={{ margin: '24px 0 0', textAlign: 'center', color: colors.muted, fontSize: 11 }}>
          Staff sign in with a one-time email code. Patients sign in with their cell phone in the
          THINNR mobile app.
        </p>
      </main>

      <footer
        style={{
          flexShrink: 0,
          padding: '8px 20px',
          borderTop: `1px solid ${colors.border}`,
          background: colors.sidebar,
          textAlign: 'center',
        }}
      >
        <p
          style={{
            margin: 0,
            color: colors.muted,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '.1em',
            lineHeight: 1.5,
            textTransform: 'uppercase',
          }}
        >
          Synthetic Demo Data • Not Medical Advice
        </p>
      </footer>
    </div>
  );
}