import { useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Eye, EyeOff } from 'lucide-react';
import './_thinnr-brand.css';

export function Concept7Mobile() {
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [emailMode, setEmailMode] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [notice, setNotice] = useState('');
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice('Your sign-in details are ready to continue.');
  };

  return (
    <main className="thinnr-brand thinnr-brand-mobile c7-mobile">
      <style>{`
        .c7-mobile{width:393px;height:852px;overflow:hidden;background:#fdfdfb;color:#0a0a0a;position:relative;font-family:Inter,system-ui,sans-serif}.c7-mobile *{box-sizing:border-box}.c7-mobile button,.c7-mobile input{font-family:inherit}.c7-mobile button{cursor:pointer}.c7-mobile:before{content:"";position:absolute;inset:0;background:repeating-linear-gradient(0deg,transparent 0,transparent 106px,rgba(10,10,10,.055) 106px,rgba(10,10,10,.055) 107px);pointer-events:none}
        .m7-safe{height:33px}.m7-head{height:57px;border-bottom:1px solid #0a0a0a;display:flex;align-items:center;justify-content:space-between;padding:0 20px;position:relative;z-index:1}.m7-back{width:33px;height:33px;border:1px solid #0a0a0a;border-radius:0;background:#fdfdfb;display:grid;place-items:center}.m7-logo{font:700 17px "GT America Mono",ui-monospace,monospace;letter-spacing:-.5px}.m7-index{font:9px "GT America Mono",ui-monospace,monospace;letter-spacing:.09em;color:#555}.m7-content{position:relative;z-index:1;padding:42px 25px 0}.m7-kicker{font:10px "GT America Mono",ui-monospace,monospace;text-transform:uppercase;letter-spacing:.1em;display:flex;gap:9px;align-items:center}.m7-kicker i{width:7px;height:7px;border-radius:50%;background:#8fd4d5}.m7-content h1{font:700 36px/.98 "GT America Mono",ui-monospace,monospace;letter-spacing:-.04em;text-transform:uppercase;margin:17px 0 10px}.m7-intro{font-size:12.5px;line-height:1.5;color:#51514e;margin:0 0 25px;max-width:290px}.m7-form{border:1px solid #0a0a0a;background:#fff;padding:18px;box-shadow:5px 5px 0 #8fd4d5}.m7-field{margin-bottom:16px}.m7-field label{display:block;font:11px "GT America Mono",ui-monospace,monospace;letter-spacing:.02em;margin-bottom:8px}.m7-field input{height:45px;width:100%;border:1px solid #0a0a0a;border-radius:0;padding:0 11px;background:#fdfdfb;font-size:13px;outline:none}.m7-field input:focus{box-shadow:0 0 0 3px #8fd4d5}.m7-switch,.m7-forgot{padding:7px 0 0;border:0;background:none;color:#0a0a0a;font:10px "GT America Mono",ui-monospace,monospace;letter-spacing:.02em;text-decoration:underline;text-underline-offset:3px}.m7-password{position:relative}.m7-password input{padding-right:45px}.m7-eye{position:absolute;right:1px;top:1px;width:42px;height:43px;border:0;background:none;display:grid;place-items:center}.m7-continue{height:46px;width:100%;background:#0a0a0a;border:1px solid #0a0a0a;color:#fff;font:700 11px "GT America Mono",ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;display:flex;align-items:center;justify-content:center;gap:9px;transition:transform .16s ease}.m7-continue:hover{transform:translate(-2px,-2px)}.m7-notice{font-size:10.5px;line-height:1.4;margin:12px 0 0;padding-left:9px;border-left:3px solid #4fb3b4}.m7-actions{margin-top:24px;border-top:1px solid #0a0a0a}.m7-create{width:100%;height:44px;background:none;border:0;border-bottom:1px solid #0a0a0a;text-align:left;padding:0;font:700 11px "GT America Mono",ui-monospace,monospace;letter-spacing:.05em;text-transform:uppercase;display:flex;justify-content:space-between;align-items:center}.m7-lower{display:flex;justify-content:space-between;padding-top:15px}.m7-lower button{border:0;background:none;padding:0;font:10px "GT America Mono",ui-monospace,monospace;text-decoration:underline;text-underline-offset:3px}.m7-bottom{position:absolute;z-index:1;bottom:26px;left:25px;right:25px;display:flex;justify-content:space-between;align-items:center;font:9px "GT America Mono",ui-monospace,monospace;text-transform:uppercase;letter-spacing:.07em;color:#5b5b59}.m7-dots{display:flex;gap:5px}.m7-dots i{width:6px;height:6px;border-radius:50%;background:#8fd4d5}.m7-dots i+ i{background:#4fb3b4}
      `}</style>
      <div className="m7-safe" />
      <header className="m7-head"><button className="m7-back" type="button" aria-label="Go back" onClick={() => setNotice('Returning to the previous screen.')}><ArrowLeft size={17} /></button><span className="m7-logo th-brand"><img className="th-logo" src="/__mockup/images/getthinnr-login-round3-thinnr-logo.png" alt="THINNR" /></span><span className="m7-index">01/03</span></header>
      <section className="m7-content">
        <div className="m7-kicker"><i /> Patient access</div>
        <h1>Welcome<br />back.</h1>
        <p className="m7-intro">Sign in to continue with your THINNR account.</p>
        <form className="m7-form" onSubmit={submit}>
          <div className="m7-field"><label htmlFor="m7-identifier">{emailMode ? 'Email address' : 'Phone number'}</label><input id="m7-identifier" type={emailMode ? 'email' : 'tel'} autoComplete={emailMode ? 'email' : 'tel'} inputMode={emailMode ? 'email' : 'tel'} required placeholder={emailMode ? 'you@example.com' : '(555) 000-0000'} value={phone} onChange={(event) => setPhone(event.target.value)} /><button className="m7-switch" type="button" onClick={() => setEmailMode(!emailMode)}>{emailMode ? 'Use phone number instead' : 'Use email instead'}</button></div>
          <div className="m7-field"><label htmlFor="m7-password">Password</label><div className="m7-password"><input id="m7-password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required placeholder="Enter password" value={password} onChange={(event) => setPassword(event.target.value)} /><button className="m7-eye" type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div><button className="m7-forgot" type="button" onClick={() => setNotice('Password reset instructions are ready for your account.')}>Forgot password?</button></div>
          <button className="m7-continue" type="submit">Continue <ArrowRight size={15} /></button>
          {notice && <p className="m7-notice" role="status">{notice}</p>}
        </form>
        <div className="m7-actions"><button className="m7-create" type="button" onClick={() => setNotice('New account setup begins with your provider.')}><span>Create new account</span><ArrowRight size={15} /></button><div className="m7-lower"><button type="button" onClick={() => setNotice('Opening the patient demo.')}>Explore demo</button><button type="button" onClick={() => setNotice('Provider login is available on THINNR Operations.')}>Provider login</button></div></div>
      </section>
      <footer className="m7-bottom"><span>THINNR / patient</span><span className="m7-dots"><i /><i /></span><span>Secure access</span></footer>
    </main>
  );
}