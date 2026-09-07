import { useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import './_group.css';

const colors = {
  background: '#f2f3f4',
  card: '#fdfcf9',
  border: '#d8e0e9',
  navy: '#203b64',
  cobalt: '#315eae',
  label: '#7e8994',
  subtle: '#858d95',
};

const labelStyle = {
  display: 'block',
  marginBottom: 8,
  color: colors.label,
  fontFamily: "'Inter', system-ui, sans-serif",
  fontSize: 10.5,
  fontWeight: 700,
  lineHeight: '13px',
  letterSpacing: 1.3,
  textTransform: 'uppercase' as const,
};

export function CurrentMobile() {
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');

  return (
    <div
      className="thinnr-login"
      style={{
        width: 393,
        height: 852,
        overflow: 'hidden',
        background: colors.background,
        color: colors.navy,
        fontFamily: "'Inter', system-ui, sans-serif",
        boxSizing: 'border-box',
      }}
    >
      <div style={{ height: 44 }} aria-hidden="true" />
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          height: 66,
          padding: '10px 16px 12px',
          boxSizing: 'border-box',
        }}
      >
        <button
          type="button"
          aria-label="Go back"
          style={{
            display: 'grid',
            placeItems: 'center',
            width: 44,
            height: 44,
            padding: 0,
            border: `1px solid ${colors.border}`,
            borderRadius: 7,
            background: colors.card,
            color: colors.navy,
          }}
        >
          <ChevronLeft size={18} strokeWidth={2} />
        </button>
        <div
          style={{
            display: 'grid',
            placeItems: 'center',
            width: 34,
            height: 34,
            boxSizing: 'border-box',
            border: `1px solid ${colors.border}`,
            borderRadius: 7,
            background: colors.card,
            color: colors.navy,
            fontFamily: "'Playfair Display', Georgia, serif",
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: 1,
          }}
        >
          TH
        </div>
        <div style={{ width: 44 }} />
      </header>

      <main
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          width: '100%',
          padding: '8px 20px 28px',
          boxSizing: 'border-box',
        }}
      >
        <div
          style={{
            color: colors.label,
            fontSize: 10.5,
            fontWeight: 700,
            lineHeight: '13px',
            letterSpacing: 1.5,
          }}
        >
          PATIENT ACCESS
        </div>
        <h1
          style={{
            margin: 0,
            color: colors.navy,
            fontFamily: "'Playfair Display', Georgia, serif",
            fontSize: 30,
            fontWeight: 700,
            lineHeight: '36px',
          }}
        >
          Welcome back
        </h1>

        <section
          style={{
            overflow: 'hidden',
            padding: 18,
            border: `1px solid ${colors.border}`,
            borderRadius: 9,
            background: colors.card,
            boxShadow: '0 8px 20px rgba(40, 55, 74, 0.07)',
          }}
        >
          <label htmlFor="current-login-phone" style={labelStyle}>
            Cell phone number
          </label>
          <input
            id="current-login-phone"
            type="tel"
            autoComplete="tel"
            placeholder="Your cell number"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            style={{
              width: '100%',
              height: 48,
              padding: '13px 12px',
              boxSizing: 'border-box',
              border: `1px solid ${colors.border}`,
              borderRadius: 7,
              outline: 'none',
              background: colors.card,
              color: colors.navy,
              font: "500 16px 'Inter', system-ui, sans-serif",
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6, marginBottom: 10 }}>
            <button type="button" style={linkStyle}>
              Use email instead
            </button>
          </div>

          <label htmlFor="current-login-password" style={labelStyle}>
            Password
          </label>
          <input
            id="current-login-password"
            type="password"
            autoComplete="current-password"
            placeholder="Your password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            style={{
              width: '100%',
              height: 48,
              padding: '13px 12px',
              boxSizing: 'border-box',
              border: `1px solid ${colors.border}`,
              borderRadius: 7,
              outline: 'none',
              background: colors.card,
              color: colors.navy,
              font: "500 16px 'Inter', system-ui, sans-serif",
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6, marginBottom: 10 }}>
            <button type="button" style={linkStyle}>
              Forgot password?
            </button>
          </div>

          <button
            type="button"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '100%',
              minHeight: 48,
              marginTop: 14,
              padding: '14px 12px',
              border: 0,
              borderRadius: 7,
              background: colors.cobalt,
              color: '#fff',
              fontFamily: "'Inter', system-ui, sans-serif",
              fontSize: 14,
              fontWeight: 700,
              lineHeight: '17px',
              letterSpacing: 0.3,
            }}
          >
            Continue
          </button>
        </section>

        <button
          type="button"
          style={{
            alignSelf: 'center',
            padding: '6px 8px',
            border: 0,
            background: 'transparent',
            color: colors.cobalt,
            fontFamily: "'Inter', system-ui, sans-serif",
            fontSize: 13.5,
            fontWeight: 700,
            lineHeight: '17px',
          }}
        >
          Create new account
        </button>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
          <button type="button" style={quietLinkStyle}>
            Explore demo
          </button>
          <span style={{ color: colors.label, fontSize: 13, fontWeight: 700 }}>·</span>
          <button type="button" style={quietLinkStyle}>
            Provider login
          </button>
        </div>

        <p
          style={{
            margin: 0,
            color: colors.subtle,
            textAlign: 'center',
            fontFamily: "'Inter', system-ui, sans-serif",
            fontSize: 12,
            lineHeight: '17px',
          }}
        >
          Your health journey, supported by your care team.
        </p>
      </main>
    </div>
  );
}

const linkStyle = {
  padding: '4px',
  border: 0,
  background: 'transparent',
  color: colors.cobalt,
  fontFamily: "'Inter', system-ui, sans-serif",
  fontSize: 12.5,
  fontWeight: 600,
  lineHeight: '15px',
};

const quietLinkStyle = {
  ...linkStyle,
  color: colors.subtle,
};