import { useState, type FormEvent } from 'react';
import { ArrowLeft, Eye, EyeOff } from 'lucide-react';
import './_group.css';

export function CobaltFieldMobile() {
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [notice, setNotice] = useState('');
  const [emailMode, setEmailMode] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setNotice(phone && password ? 'We’ll send a 6-digit code by text next.' : 'Enter your details to continue.');
  };
  return (
    <div className="thinnr-login cobalt-mobile" style={{ position: 'relative', width: 393, height: 852, overflow: 'hidden', color: 'var(--th-ink)', background: 'linear-gradient(155deg, var(--th-navy), #274e8d 57%, var(--th-cobalt))' }}>
      <style>{`
        .cobalt-mobile * { box-sizing:border-box; }
        .cobalt-mobile:before { content:""; position:absolute; inset:0; pointer-events:none; opacity:.19; background-image:radial-gradient(circle at 1px 1px, #dce6fa 1px, transparent 1.3px); background-size:19px 19px; mask-image:linear-gradient(to bottom, black, transparent 67%); }
        .cobalt-mobile input { outline:none; font:500 14px var(--th-font-body); color:var(--th-ink); }
        .cobalt-mobile input:focus { border-color:var(--th-cobalt)!important; box-shadow:0 0 0 3px rgba(49,94,174,.18); }
        .cobalt-mobile button { font-family:var(--th-font-body); cursor:pointer; }
        .cobalt-mobile button:focus-visible { outline:3px solid var(--th-cobalt-light); outline-offset:2px; }
      `}</style>
      <div style={{ position: 'relative', height: 54, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 20px', color: 'var(--th-brand-fg)' }}>
        <span style={{ width: 44 }} />
        <div style={{ width: 32, height: 32, display: 'grid', placeItems: 'center', border: '1px solid rgba(220,230,250,.28)', borderRadius: 9, fontFamily: 'var(--th-font-display)', fontWeight: 700, fontSize: 13 }}>TH</div>
        <button aria-label="Go back" type="button" onClick={() => setNotice('Back control selected.')} style={{ height: 44, width: 44, display: 'grid', placeItems: 'center', border: 0, color: 'var(--th-brand-fg)', background: 'transparent' }}><ArrowLeft size={19} /></button>
      </div>
      <section style={{ position: 'relative', padding: '37px 25px 0', color: 'var(--th-brand-fg)' }}>
        <div className="th-kicker" style={{ color: '#b9c9e7' }}>Patient access</div>
        <h1 style={{ margin: '8px 0 0', color: '#f2f5fb', font: '700 39px/1.08 var(--th-font-display)', letterSpacing: '-.045em' }}>Welcome back</h1>
      </section>
      <form onSubmit={submit} style={{ position: 'absolute', left: 15, right: 15, bottom: 34, minHeight: 575, padding: '31px 25px 25px', borderRadius: 'var(--th-radius-card) var(--th-radius-card) 0 0', background: 'var(--th-card)', boxShadow: '0 -10px 38px rgba(12,31,62,.18)' }}>
        <div style={{ width: 32, height: 3, margin: '0 auto 26px', borderRadius: 4, background: 'var(--th-accent-border)' }} />
        <label htmlFor="cobalt-phone" style={{ display: 'block', fontSize: 12, fontWeight: 750, color: 'var(--th-navy)', marginBottom: 8 }}>{emailMode ? 'Email address' : 'Cell phone number'}</label>
        <input id="cobalt-phone" type={emailMode ? 'email' : 'tel'} inputMode={emailMode ? 'email' : 'tel'} placeholder={emailMode ? 'you@example.com' : 'Your cell number'} value={phone} onChange={(event) => setPhone(event.target.value)} style={{ width: '100%', height: 46, padding: '0 13px', border: '1px solid var(--th-hairline)', borderRadius: 'var(--th-radius-control)', background: 'var(--th-paper-alt)' }} />
        <button type="button" onClick={() => { setEmailMode((value) => !value); setPhone(''); }} style={{ border: 0, padding: '8px 0 18px', background: 'transparent', color: 'var(--th-cobalt)', fontSize: 12, fontWeight: 750 }}>{emailMode ? 'Use phone instead' : 'Use email instead'}</button>
        <label htmlFor="cobalt-password" style={{ display: 'block', fontSize: 12, fontWeight: 750, color: 'var(--th-navy)', marginBottom: 8 }}>Password</label>
        <div style={{ position: 'relative' }}>
          <input id="cobalt-password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" placeholder="Your password" value={password} onChange={(event) => setPassword(event.target.value)} style={{ width: '100%', height: 46, padding: '0 44px 0 13px', border: '1px solid var(--th-hairline)', borderRadius: 'var(--th-radius-control)', background: 'var(--th-paper-alt)' }} />
          <button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword((value) => !value)} style={{ position: 'absolute', right: 2, top: 1, height: 44, width: 42, display: 'grid', placeItems: 'center', color: 'var(--th-body)', background: 'transparent', border: 0 }}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button>
        </div>
        <button type="button" onClick={() => setNotice('Password recovery selected.')} style={{ border: 0, padding: '8px 0 23px', background: 'transparent', color: 'var(--th-cobalt)', fontSize: 12, fontWeight: 750 }}>Forgot password?</button>
        <button type="submit" style={{ width: '100%', height: 46, border: 0, borderRadius: 'var(--th-radius-control)', background: 'var(--th-cobalt)', color: 'var(--th-card)', fontSize: 13, fontWeight: 750 }}>Continue</button>
        {notice && <p aria-live="polite" style={{ margin: '10px 0 -2px', color: 'var(--th-body)', fontSize: 11, lineHeight: 1.4, textAlign: 'center' }}>{notice}</p>}
        <button type="button" onClick={() => setNotice('Account creation selected.')} style={{ display: 'block', margin: '21px auto 13px', padding: 4, border: 0, background: 'transparent', color: 'var(--th-cobalt)', fontWeight: 750, fontSize: 13 }}>Create new account</button>
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, color: 'var(--th-label)', fontSize: 11.5 }}>
          <button type="button" onClick={() => setNotice('Demo selected.')} style={{ padding: 3, border: 0, background: 'transparent', color: 'inherit', fontSize: 'inherit' }}>Explore demo</button>
          <span>·</span>
          <button type="button" onClick={() => setNotice('Provider login selected.')} style={{ padding: 3, border: 0, background: 'transparent', color: 'inherit', fontSize: 'inherit' }}>Provider login</button>
        </div>
        <p style={{ margin: '22px 3px 0', paddingTop: 14, borderTop: '1px solid var(--th-hairline)', textAlign: 'center', color: 'var(--th-body)', fontSize: 11.5, lineHeight: 1.45 }}>Your health journey, supported by your care team.</p>
      </form>
    </div>
  );
}