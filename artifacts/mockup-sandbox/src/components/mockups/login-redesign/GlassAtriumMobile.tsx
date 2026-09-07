import { useState, type FormEvent } from 'react';
import { ArrowLeft, Eye, EyeOff } from 'lucide-react';
import './_group.css';

export function GlassAtriumMobile() {
  const [channel, setChannel] = useState<'phone' | 'email'>('phone');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [notice, setNotice] = useState('');
  const submit = (event: FormEvent) => { event.preventDefault(); setNotice(identifier && password ? 'A 6-digit code will be sent by text.' : 'Enter your sign-in details to continue.'); };
  return (
    <main className="thinnr-login" style={{ width: 393, height: 852, position: 'relative', overflow: 'hidden', background: 'var(--th-paper)', color: 'var(--th-ink)' }}>
      <style>{`
        .ga-mobile-bg{position:absolute;inset:-18px;background:linear-gradient(rgba(242,243,244,.22),rgba(32,59,100,.15)),url('/__mockup/images/login-glass-atrium-interior.png') center/cover;filter:blur(7px);transform:scale(1.05)}
        .ga-mobile-panel{position:absolute;left:0;right:0;bottom:0;min-height:640px;padding:27px 25px 29px;box-sizing:border-box;background:rgba(253,252,249,.82);border:1px solid rgba(255,255,255,.88);border-bottom:0;border-radius:18px 18px 0 0;box-shadow:0 -12px 42px rgba(32,59,100,.14);backdrop-filter:blur(19px);-webkit-backdrop-filter:blur(19px)}
        .ga-mobile-input{box-sizing:border-box;width:100%;height:46px;margin-top:7px;padding:0 12px;border:1px solid var(--th-hairline);border-radius:var(--th-radius-control);background:rgba(253,252,249,.84);font:14px var(--th-font-body);color:var(--th-ink);outline:none}.ga-mobile-input:focus{border-color:var(--th-cobalt);box-shadow:0 0 0 3px rgba(49,94,174,.18)}
        .ga-mobile-link{border:0;background:none;padding:0;color:var(--th-cobalt);font:600 12px var(--th-font-body);cursor:pointer}.ga-mobile-link:hover{text-decoration:underline}
      `}</style>
      <div className="ga-mobile-bg" aria-hidden="true" />
      <header style={{ position: 'relative', zIndex: 1, height: 54, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 20px 0' }}>
        <button aria-label="Go back" type="button" onClick={() => setNotice('')} style={{ width: 38, height: 38, display: 'grid', placeItems: 'center', border: '1px solid rgba(253,252,249,.74)', borderRadius: 7, background: 'rgba(253,252,249,.68)', color: 'var(--th-navy)', cursor: 'pointer' }}><ArrowLeft size={18} /></button>
        <div aria-label="THINNR" style={{ width: 34, height: 34, display: 'grid', placeItems: 'center', borderRadius: 8, background: 'var(--th-navy)', color: 'var(--th-brand-fg)', fontFamily: 'var(--th-font-display)', fontSize: 13, fontWeight: 700, letterSpacing: '.07em' }}>TH</div>
        <span style={{ width: 38 }} />
      </header>
      <section className="ga-mobile-panel">
        <p className="th-kicker" style={{ margin: 0 }}>Patient access</p>
        <h1 className="th-display" style={{ margin: '7px 0 27px', fontSize: 34, lineHeight: 1.1 }}>Welcome back</h1>
        <form onSubmit={submit}>
          <label htmlFor="ga-patient-id" style={{ fontSize: 12, color: 'var(--th-navy)', fontWeight: 650 }}>{channel === 'phone' ? 'Cell phone number' : 'Email address'}</label>
          <input id="ga-patient-id" className="ga-mobile-input" type={channel === 'phone' ? 'tel' : 'email'} autoComplete={channel === 'phone' ? 'tel' : 'email'} placeholder={channel === 'phone' ? 'Your cell number' : 'you@example.com'} value={identifier} onChange={(e) => setIdentifier(e.target.value)} />
          <div style={{ textAlign: 'right', margin: '7px 0 20px' }}><button type="button" className="ga-mobile-link" onClick={() => { setChannel(channel === 'phone' ? 'email' : 'phone'); setIdentifier(''); }}>{channel === 'phone' ? 'Use email instead' : 'Use phone instead'}</button></div>
          <label htmlFor="ga-patient-password" style={{ fontSize: 12, color: 'var(--th-navy)', fontWeight: 650 }}>Password</label>
          <div style={{ position: 'relative' }}><input id="ga-patient-password" className="ga-mobile-input" style={{ paddingRight: 42 }} type={showPassword ? 'text' : 'password'} autoComplete="current-password" placeholder="Your password" value={password} onChange={(e) => setPassword(e.target.value)} /><button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(!showPassword)} style={{ position: 'absolute', right: 8, top: 11, border: 0, background: 'none', color: 'var(--th-body)', padding: 5, cursor: 'pointer' }}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
          <div style={{ textAlign: 'right', margin: '7px 0 22px' }}><button className="ga-mobile-link" type="button" onClick={() => setNotice('Password recovery can begin with your cell phone number.')}>Forgot password?</button></div>
          {notice && <p role="status" style={{ margin: '-7px 0 12px', color: 'var(--th-warn)', fontSize: 11.5, lineHeight: 1.4 }}>{notice}</p>}
          <button type="submit" style={{ height: 47, width: '100%', border: 0, borderRadius: 'var(--th-radius-control)', background: 'var(--th-cobalt)', color: 'var(--th-card)', font: '650 14px var(--th-font-body)', cursor: 'pointer' }}>Continue</button>
        </form>
        <div style={{ textAlign: 'center', marginTop: 21 }}><button type="button" className="ga-mobile-link" style={{ fontSize: 13 }} onClick={() => setNotice('Account creation selected.')}>Create new account</button></div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 9, marginTop: 19, color: 'var(--th-label)', fontSize: 11.5 }}><button className="ga-mobile-link" style={{ color: 'var(--th-label)' }} type="button" onClick={() => setNotice('Demo selected.')}>Explore demo</button><span>·</span><button className="ga-mobile-link" style={{ color: 'var(--th-label)' }} type="button" onClick={() => setNotice('Provider login selected.')}>Provider login</button></div>
        <p style={{ margin: '19px auto 0', maxWidth: 230, textAlign: 'center', fontSize: 11.5, lineHeight: 1.45, color: 'var(--th-body)' }}>Your health journey, supported by your care team.</p>
      </section>
    </main>
  );
}