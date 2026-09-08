process.env.EXPO_PUBLIC_DOMAIN = 'thinnr.test';
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const storage = new Map<string,string>();
(globalThis as Record<string,unknown>).localStorage = { getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>void storage.set(k,v),removeItem:(k:string)=>void storage.delete(k) };
import React,{act} from 'react';
import { readFileSync } from 'node:fs';
import {create,type ReactTestRenderer} from 'react-test-renderer';
import Login from '../app/patient-login';
import Signup from '../app/patient-signup';
import ProviderLogin from '../app/provider-login';
import {AppModeProvider} from '../context/AppModeContext';
import {liveEntryDecision} from '../lib/live-patient-entry';
import {DEFAULT_ANSWERS,visibleSteps} from '../data/onboarding-data';
import {clearRouterCalls,routerCalls} from './onboarding-gate-stubs/expo-router';
import {clearAuthStub,verifyOtpCalls} from './patient-auth-stubs/supabase';

let checks=0, failures=0;
const assert=(label:string,value:boolean)=>{checks++;if(!value){failures++;console.error('  FAIL '+label)}};
type Call={path:string;body:Record<string,unknown>}; const calls:Call[]=[]; const handlers=new Map<string,(c:Call)=>{status:number;body:unknown}>();
const on=(path:string,fn:(c:Call)=>{status:number;body:unknown})=>handlers.set(path,fn);
const reset=()=>{calls.length=0;handlers.clear();clearRouterCalls();clearAuthStub();storage.clear();focusCalls.length=0};
globalThis.fetch=(async(input:unknown,init?:{body?:string})=>{const path=String(input).split('/api/auth/')[1];const call={path,body:JSON.parse(init?.body??'{}')};calls.push(call);const out=handlers.get(path)?.(call)??{status:500,body:{error:'unscripted '+path}};return{status:out.status,json:async()=>out.body}}) as typeof fetch;
// Each host mount gets its own node mock (created at ref attach), so focusCalls
// records WHICH mounted input focus() landed on — a stale pre-switch mount would
// record the old testID and fail the channel-switch checks.
const focusCalls:string[]=[];
async function render(Screen:React.ComponentType){let tree!:ReactTestRenderer;await act(async()=>{tree=create(React.createElement(AppModeProvider,null,React.createElement(Screen)),{createNodeMock:el=>({focus:()=>void focusCalls.push(String(el.props.testID)),blur:()=>{},isFocused:()=>false})})});return tree}
const hosts=(t:ReactTestRenderer,id:string)=>t.root.findAllByProps({testID:id}).filter(n=>typeof n.type==='string');
const exists=(t:ReactTestRenderer,id:string)=>hosts(t,id).length>0;
const label=(t:ReactTestRenderer,id:string)=>hosts(t,id).find(x=>'accessibilityLabel' in x.props)?.props.accessibilityLabel as string|undefined;
async function type(t:ReactTestRenderer,id:string,v:string){const n=hosts(t,id).find(x=>typeof x.props.onChangeText==='function');if(!n)throw Error('missing input '+id);await act(async()=>n.props.onChangeText(v))}
async function press(t:ReactTestRenderer,id:string){const n=hosts(t,id).find(x=>typeof x.props.onPress==='function');if(!n)throw Error('missing press '+id);await act(async()=>n.props.onPress())}
// Fires a press whose network response is being held open (see the gate in
// staleResponses) WITHOUT awaiting it, so the test can act mid-request. Returns
// a flusher to await once the gate opens.
async function pressHeld(t:ReactTestRenderer,id:string){const n=hosts(t,id).find(x=>typeof x.props.onPress==='function');if(!n)throw Error('missing press '+id);let held!:Promise<unknown>;await act(async()=>{held=Promise.resolve(n.props.onPress())});return()=>act(async()=>{await held})}
const btnLabel=(t:ReactTestRenderer,id:string)=>t.root.findAllByProps({testID:id}).map(n=>n.props.label).find(x=>typeof x==='string');
const err=(t:ReactTestRenderer)=>t.root.findAllByProps({testID:'login-error'}).map(n=>String(n.props.message??'')).join(' ');
const inputValue=(t:ReactTestRenderer,id:string)=>hosts(t,id).find(x=>typeof x.props.onChangeText==='function')?.props.value;
const signupErr=(t:ReactTestRenderer)=>t.root.findAllByProps({testID:'signup-error'}).map(n=>String(n.props.message??'')).join(' ');
const called=(path:string)=>calls.filter(c=>c.path===path);

async function loginFlow(){
 console.log('· phone password + MFA, email toggle');
 reset(); let t=await render(Login);
 assert('phone is default',exists(t,'login-phone'));assert('phone has a native label',label(t,'login-phone')==='Cell phone number');assert('password collected first',exists(t,'login-password'));assert('password has a native label',label(t,'login-password')==='Password');assert('MFA absent initially',!exists(t,'login-otp'));
 await press(t,'login-switch-channel');assert('email toggle works',exists(t,'login-email')&&!exists(t,'login-phone'));assert('email has a native label',label(t,'login-email')==='Email address');t.unmount();
reset();on('patient/password/login',()=>({status:200,body:{ok:true,requestId:'lr1',message:'If those details match, a code is on its way.',devCode:'222333'}}));on('login/verify',()=>({status:200,body:{ok:true,realm:'patient',tokenHash:'hash1',signInId:'signin-1'}}));
 t=await render(Login);await type(t,'login-phone','8135551234');await type(t,'login-password','Secret1!');await press(t,'login-submit');
 const c=called('patient/password/login')[0];assert('password login contract',c.body.identifier==='+18135551234'&&c.body.password==='Secret1!');assert('password removed after submit',!exists(t,'login-password'));assert('MFA shown',exists(t,'login-otp'));assert('MFA has a native label',label(t,'login-otp')==='6-digit verification code');assert('MFA field focuses as soon as it mounts',hosts(t,'login-otp').some(n=>n.props.autoFocus===true));
 await type(t,'login-otp','222333');await press(t,'login-verify');assert('MFA token minted',verifyOtpCalls[0]?.token_hash==='hash1');assert('patient destination',routerCalls.some(x=>x.method==='replace'&&x.target==='/today'));t.unmount();
  reset();on('patient/password/login',()=>({status:401,body:{error:"The phone or email and password you entered don't match. Check them and try again, or reset your password."}}));
  t=await render(Login);await type(t,'login-phone','8135551234');await type(t,'login-password','WrongSecret1!');await press(t,'login-submit');
  assert('wrong password stays on login',exists(t,'login-password')&&!exists(t,'login-otp'));
  assert('wrong password remains available to correct',inputValue(t,'login-password')==='WrongSecret1!');
  assert('wrong password explains the problem',err(t).toLowerCase().includes('password'));
  assert('wrong password button is ready again',btnLabel(t,'login-submit')==='Continue');
  t.unmount();
  for (const [status,message] of [[502,"We couldn't send a verification code right now."],[429,'Too many verification codes were requested.']] as const) {
    reset();on('patient/password/login',()=>({status,body:{error:message,retryable:true}}));
    t=await render(Login);await type(t,'login-phone','8135551234');await type(t,'login-password','Secret1!');await press(t,'login-submit');
    assert(`${status} delivery failure stays on login`,exists(t,'login-password')&&!exists(t,'login-otp'));
    assert(`${status} delivery failure keeps password`,inputValue(t,'login-password')==='Secret1!');
    assert(`${status} delivery failure is explained`,err(t).includes(message));
    t.unmount();
  }
}
async function channelSwitch(){
 console.log('· channel switch remounts + refocuses the identifier input');
 reset();const t=await render(Login);
 const input=(id:string)=>hosts(t,id).find(x=>typeof x.props.onChangeText==='function');
 assert('no focus grab on initial mount',focusCalls.length===0);
 await type(t,'login-phone','8135551234');
 await press(t,'login-switch-channel');
 const email=input('login-email');
 assert('email mount carries email keyboard + autofill hints',email?.props.keyboardType==='email-address'&&email?.props.autoComplete==='email'&&email?.props.textContentType==='emailAddress');
 assert('email keeps its own value, not the phone entry',email?.props.value==='');
 assert('switch focuses the freshly mounted email input',focusCalls.join()==='login-email');
 await type(t,'login-email','casey@example.com');
 await press(t,'login-switch-channel');
 const ph=input('login-phone');
 assert('phone mount restores phone keyboard + autofill hints',ph?.props.keyboardType==='phone-pad'&&ph?.props.autoComplete==='tel'&&ph?.props.textContentType==='telephoneNumber');
 assert('phone entry survives the round trip',ph?.props.value==='8135551234');
 assert('switch back refocuses the fresh phone input',focusCalls.join()==='login-email,login-phone');
 await press(t,'login-switch-channel');
 assert('email entry survives the round trip',input('login-email')?.props.value==='casey@example.com');
 t.unmount();
}
async function recovery(){
 console.log('· neutral recovery phases');
 reset();on('patient/recovery/start',()=>({status:200,body:{ok:true,requestId:'rr1',message:'If that matches, a code is coming.',devCode:'123456'}}));on('patient/recovery/verify',()=>({status:200,body:{ok:true,resetToken:'reset1'}}));on('patient/recovery/complete',()=>({status:200,body:{ok:true}}));
 const t=await render(Login);await press(t,'login-forgot');assert('recovery identify phase',exists(t,'recovery-start'));await type(t,'login-phone','8135551234');await press(t,'recovery-start');assert('neutral start contract',called('patient/recovery/start')[0].body.identifier==='+18135551234');assert('recovery code phase',exists(t,'recovery-otp'));assert('recovery OTP has a label',label(t,'recovery-otp')==='6-digit verification code');await type(t,'recovery-otp','123456');await press(t,'recovery-verify');assert('new password phase',exists(t,'recovery-password'));assert('recovery passwords have labels',label(t,'recovery-password')==='New password'&&label(t,'recovery-confirm')==='Confirm new password');await type(t,'recovery-password','NewSecret1!');await type(t,'recovery-confirm','NewSecret1!');await press(t,'recovery-complete');assert('complete recovery payload',called('patient/recovery/complete')[0].body.resetToken==='reset1'&&called('patient/recovery/complete')[0].body.password==='NewSecret1!');assert('returns to login',exists(t,'login-password'));t.unmount();
}
async function signupFlows(){
 console.log('· invited and new signup phases');
reset();on('signup/start',()=>({status:200,body:{ok:true,requestId:'s1',message:'Code sent',devCode:'444555'}}));on('signup/verify',()=>({status:200,body:{ok:true,mode:'enroll',signupToken:'st1'}}));on('signup/complete',()=>({status:200,body:{ok:true,tokenHash:'sh1',signInId:'signin-2'}}));
 let t=await render(Signup);assert('explicit choices',exists(t,'signup-invited')&&exists(t,'signup-new'));await press(t,'signup-invited');assert('signup phone is labeled',label(t,'signup-phone')==='Invited phone number');await type(t,'signup-email','invited@example.com');assert('invited email is labeled',label(t,'signup-email')==='Invited email address');await press(t,'signup-send');assert('invited contract',called('signup/start')[0].body.flow==='invited'&&called('signup/start')[0].body.identifier==='invited@example.com');await type(t,'signup-otp','444555');assert('signup OTP is labeled',label(t,'signup-otp')==='6-digit verification code');await press(t,'signup-verify');assert('invited reaches password details',exists(t,'signup-password'));assert('signup password/name labels',label(t,'signup-password')==='Create password'&&label(t,'signup-name')==='Name');await type(t,'signup-password','Secret1!');await type(t,'signup-name','Casey');await press(t,'signup-complete');assert('completion carries password',called('signup/complete')[0].body.password==='Secret1!');assert('signup token minted',verifyOtpCalls[0]?.token_hash==='sh1');t.unmount();
 reset();let attempts=0;on('signup/start',()=>{attempts++;return attempts===1?{status:400,body:{error:'Provider code required'}}:{status:200,body:{ok:true,requestId:'s2',message:null,devCode:null}}});
 t=await render(Signup);await press(t,'signup-new');assert('new requires both contacts',exists(t,'signup-phone')&&exists(t,'signup-email'));assert('new contact/provider inputs are labeled',label(t,'signup-phone')==='Cell phone number'&&label(t,'signup-email')==='Email address'&&label(t,'signup-provider-code')==='Provider code');await type(t,'signup-phone','8135559999');await press(t,'signup-send');assert('missing email stays local',called('signup/start').length===0&&signupErr(t).includes('both'));await type(t,'signup-email','new@example.com');await press(t,'signup-send');assert('missing provider code stays local',called('signup/start').length===0&&signupErr(t).toLowerCase().includes('provider code'));await type(t,'signup-provider-code','654321');await press(t,'signup-send');const nc=called('signup/start')[0];assert('new submit sends both contacts and code',nc.body.flow==='new'&&nc.body.phone==='+18135559999'&&nc.body.email==='new@example.com'&&nc.body.code==='654321');t.unmount();
}
async function provider(){
 console.log('· provider route remains staff');
reset();on('login/start',()=>({status:200,body:{ok:true,requestId:'p1',message:null,devCode:'111111'}}));on('login/verify',()=>({status:200,body:{ok:true,realm:'staff',tokenHash:'ph',signInId:'signin-3'}}));
 const t=await render(ProviderLogin);await type(t,'provider-email','staff@example.com');await press(t,'provider-send');await type(t,'provider-otp','111111');await press(t,'provider-verify');assert('staff mode preserved',storage.get('thinnr_app_mode_v1')==='staff');assert('staff destination preserved',routerCalls.some(x=>x.target==='/'));t.unmount();
}
function routing(){
 console.log('· welcome, deep-link guard, demo admission, onboarding filtering');
 const signedOut={modeHydrated:true,mode:'patient' as const,accountResolving:false,accountKind:'demo' as const,patientHydrated:true,onboardingComplete:null,consentSatisfied:true,deletionPending:false,pathname:'/onboarding/height',demoAdmitted:false};
 const welcomeSource=readFileSync(new URL('../app/patient-welcome.tsx',import.meta.url),'utf8');
 const staffTabsLayout=readFileSync(new URL('../app/(tabs)/_layout.tsx',import.meta.url),'utf8');
 const patientTabsLayout=readFileSync(new URL('../app/(patient)/_layout.tsx',import.meta.url),'utf8');
  const rootLayout=readFileSync(new URL('../app/_layout.tsx',import.meta.url),'utf8');
 assert('welcome exposes primary actions',welcomeSource.includes('testID="welcome-login"')&&welcomeSource.includes('testID="welcome-signup"'));
  assert('welcome keeps provider login without the demo door',!welcomeSource.includes('testID="welcome-demo"')&&!welcomeSource.includes('Explore demo')&&welcomeSource.includes('testID="welcome-provider"'));
  assert('welcome preserves all three navigation destinations',["router.push('/patient-login')","router.push('/patient-signup')","router.push('/provider-login')"].every(target=>welcomeSource.includes(target)));
  assert('welcome removes the top note and framed greeting',!welcomeSource.includes('Patient app')&&!welcomeSource.includes('<PlateHero')&&!welcomeSource.includes('<Footnote'));
  const loginSource=readFileSync(new URL('../app/patient-login.tsx',import.meta.url),'utf8');
  assert('demo remains accessible through patient login',loginSource.includes('testID="login-demo"')&&loginSource.includes('onPress={login.openDemo}'));
 assert('fresh root enters patient welcome',staffTabsLayout.includes("mode === 'patient' ? '/today' : '/patient-welcome'"));
 assert('fresh patient tab enters patient welcome',patientTabsLayout.includes("mode === 'staff' ? '/' : '/patient-welcome'"));
  assert('root navigator stays mounted while a guard redirects',rootLayout.includes('{children}')&&rootLayout.includes("decision.kind === 'redirect' ? <Redirect"));
 assert('signed-out deep link goes welcome',liveEntryDecision(signedOut).kind==='redirect'&&(liveEntryDecision(signedOut) as {href:string}).href==='/patient-welcome');
 assert('persisted staff cannot open signed-out patient demo',liveEntryDecision({...signedOut,mode:'staff',pathname:'/today'}).kind==='redirect');
 assert('operations staff route remains available',liveEntryDecision({...signedOut,mode:'staff',pathname:'/patients'}).kind==='allow');
 assert('welcome itself allowed',liveEntryDecision({...signedOut,pathname:'/patient-welcome'}).kind==='allow');
 assert('explicit demo admitted',liveEntryDecision({...signedOut,demoAdmitted:true}).kind==='allow');
 assert('incomplete real patient goes onboarding',liveEntryDecision({...signedOut,accountKind:'real',patientHydrated:true,onboardingComplete:false,pathname:'/today'}).kind==='redirect');
 assert('complete real patient leaves onboarding',liveEntryDecision({...signedOut,accountKind:'real',patientHydrated:true,onboardingComplete:true,pathname:'/onboarding/welcome'}).kind==='redirect'&&(liveEntryDecision({...signedOut,accountKind:'real',patientHydrated:true,onboardingComplete:true,pathname:'/onboarding/welcome'}) as {href:string}).href==='/today');
 const demo=visibleSteps(DEFAULT_ANSWERS),real=visibleSteps(DEFAULT_ANSWERS,true);
 assert('demo retains simulated account sequence',['contact','verify','provider-code','face-id','password'].every(k=>demo.includes(k as never)));
 assert('real onboarding filters credential/device steps',['contact','verify','provider-code','face-id','password'].every(k=>!real.includes(k as never)));
}
async function staleResponses(){
 console.log('· slow responses cannot yank the screen into a stale phase');
 const mockFetch=globalThis.fetch;
 const hold=()=>{let release!:()=>void;const gate=new Promise<void>(r=>{release=r});globalThis.fetch=(async(input:unknown,init?:{body?:string})=>{const p=(mockFetch as (i:unknown,x?:unknown)=>Promise<Response>)(input,init);await gate;return p}) as typeof fetch;return release};
 // Login: user leaves for recovery while the password request hangs; the late
 // success must not force the MFA phase.
 reset();on('patient/password/login',()=>({status:200,body:{ok:true,requestId:'lr9',message:'Code on the way.',devCode:'999111'}}));
 let release=hold();let t=await render(Login);
 await type(t,'login-phone','8135551234');await type(t,'login-password','Secret1!');
 const flushLogin=await pressHeld(t,'login-submit');
 assert('held login request reached the server',called('patient/password/login').length===1);
 await press(t,'login-forgot');
 assert('recovery form shows while the request hangs',exists(t,'recovery-start'));
 release();await flushLogin();
 assert('late login response cannot hijack recovery',exists(t,'recovery-start')&&!exists(t,'login-otp'));
 assert('busy released for the new phase',btnLabel(t,'recovery-start')==='Send recovery code');
 globalThis.fetch=mockFetch;t.unmount();
 // Signup: user backs out to the chooser while signup/start hangs; the late
 // success must not force the code phase.
 reset();on('signup/start',()=>({status:200,body:{ok:true,requestId:'sr9',message:'Code sent.',devCode:'123456'}}));
 release=hold();t=await render(Signup);
 await press(t,'signup-new');
 await type(t,'signup-phone','8135559999');await type(t,'signup-email','new@example.com');await type(t,'signup-provider-code','654321');
 const flushSignup=await pressHeld(t,'signup-send');
 assert('held signup request reached the server',called('signup/start').length===1);
 await press(t,'signup-back');
 assert('chooser shows while the request hangs',exists(t,'signup-invited'));
 release();await flushSignup();
 assert('late signup response cannot hijack the chooser',exists(t,'signup-invited')&&!exists(t,'signup-otp'));
 await press(t,'signup-new');
 assert('busy released after the stale response',btnLabel(t,'signup-send')==='Send verification code');
 globalThis.fetch=mockFetch;t.unmount();
}
async function main(){await loginFlow();await channelSwitch();await recovery();await signupFlows();await staleResponses();await provider();routing();console.log(`\n${checks} checks, ${failures} failures`);process.exit(failures?1:0)}
main().catch(e=>{console.error(e);process.exit(1)});