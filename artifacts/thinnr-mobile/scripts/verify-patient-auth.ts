process.env.EXPO_PUBLIC_DOMAIN = 'thinnr.test';
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const storage = new Map<string,string>();
(globalThis as Record<string,unknown>).localStorage = { getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>void storage.set(k,v),removeItem:(k:string)=>void storage.delete(k) };
import React,{act} from 'react';
import {Platform,Text,View} from 'react-native';
import { readFileSync } from 'node:fs';
import {create,type ReactTestRenderer} from 'react-test-renderer';
import Login from '../app/patient-login';
import Signup from '../app/patient-signup';
import ProviderLogin from '../app/provider-login';
import {FormCard} from '../components/auth/AuthPrimitives';
import {AuthPageFrame} from '../components/auth/AuthPageFrame';
import {KeyboardAwareScrollViewCompat} from '../components/KeyboardAwareScrollViewCompat';
import {space} from '../constants/spacing';
import {AppModeProvider} from '../context/AppModeContext';
import {liveEntryDecision} from '../lib/live-patient-entry';
import {DEFAULT_ANSWERS,visibleSteps} from '../data/onboarding-data';
import {clearRouterCalls,routerCalls} from './onboarding-gate-stubs/expo-router';
import {clearAuthStub,holdNextVerifyOtp,verifyOtpCalls} from './patient-auth-stubs/supabase';
import {clearSignupSeed,peekSignupSeed,takeSignupSeed} from '../lib/signup-seed';

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
const inputStyle=(t:ReactTestRenderer,id:string)=>Object.assign({},...[hosts(t,id).find(x=>typeof x.props.onChangeText==='function')?.props.style].flat(Infinity).filter(s=>s&&typeof s==='object'));
const signupErr=(t:ReactTestRenderer)=>t.root.findAllByProps({testID:'signup-error'}).map(n=>String(n.props.message??'')).join(' ');
const called=(path:string)=>calls.filter(c=>c.path===path);
const wordmarkSize=(t:ReactTestRenderer)=>{
 const mark=t.root.findAll(n=>n.type==='Text'&&n.children.includes('THINNR'))[0];
 const styles=[mark?.props.style].flat(Infinity).filter(s=>s&&typeof s==='object');
 return Object.assign({},...styles).fontSize as number|undefined;
};
const flatStyle=(style:unknown)=>Object.assign({},...[style].flat(Infinity).filter(s=>s&&typeof s==='object'));
function frameLayout(t:ReactTestRenderer,phase:string,patient:boolean){
 const frame=t.root.findByType(AuthPageFrame);
 const page=frame.findAll(n=>n.type==='View')[0];
 const scroll=frame.findByType(KeyboardAwareScrollViewCompat);
 const content=flatStyle(scroll.props.contentContainerStyle);
 const topBar=page.findAll(n=>n.type==='View'&&flatStyle(n.props.style).paddingHorizontal===16)[0];
 const header=flatStyle(topBar?.props.style);
 const native=Platform.OS!=='web';
 assert(`${phase}: patient-only 32pt offset is inside scroll content`,content.paddingTop===(patient?8+32:8));
 assert(`${phase}: keeps safe-area header position`,flatStyle(page.props.style).paddingTop===(native?8:patient?67:44)&&header.paddingTop===(patient?0:8)&&header.paddingBottom===(patient?24:16));
 assert(`${phase}: keeps header width and alignment`,header.maxWidth===520&&header.width==='100%'&&header.alignItems==='center'&&header.justifyContent==='space-between');
 const back=topBar.findAll(n=>n.type==='Pressable')[0];
 assert(`${phase}: back control keeps 44pt hit area`,flatStyle(back?.props.style).width===44&&flatStyle(back?.props.style).height===44);
 const mark=topBar.findAll(n=>n.type==='Text'&&n.children.includes('THINNR'))[0];
 assert(`${phase}: wordmark typography stays unchanged`,flatStyle(mark?.props.style).fontSize===(patient?32:23)&&flatStyle(mark?.props.style).letterSpacing===-0.5);
 assert(`${phase}: content keeps horizontal margins and flexible height`,content.paddingHorizontal===20&&content.maxWidth===520&&content.flexGrow===1&&content.height===undefined);
 assert(`${phase}: bottom safe-area padding is unchanged`,content.paddingBottom===(!native&&patient?50:32));
 assert(`${phase}: offset is normal flow, not a transform or positioned container`,[content,flatStyle(page.props.style),flatStyle(scroll.props.style)].every(s=>s.transform===undefined&&s.position===undefined&&s.top===undefined));
 assert(`${phase}: keyboard-aware scroll keeps its offset`,scroll.props.bottomOffset===96&&flatStyle(scroll.props.style).flex===1);
 const blocks=React.Children.toArray(scroll.props.children).filter(React.isValidElement) as React.ReactElement<{style?:unknown;children?:React.ReactNode}>[];
 if(patient){
  const heading=blocks.find(el=>React.Children.toArray(el.props.children).some(child=>React.isValidElement<{accessibilityRole?:string}>(child)&&child.props.accessibilityRole==='header'));
  const headingStyle=flatStyle(heading?.props.style);
  assert(`${phase}: heading keeps existing internal gaps`,headingStyle.marginTop===4&&headingStyle.marginBottom===32);
  if(frame.props.footer&&frame.props.pinFooter){
   const footer=blocks[blocks.length-1],slack=blocks[blocks.length-2];
   assert(`${phase}: footer keeps flexible slack before it`,flatStyle(slack.props.style).flexGrow===1&&flatStyle(slack.props.style).minHeight===0&&flatStyle(footer.props.style).marginTop===32);
  }
 }
}
function patientFormLayout(t:ReactTestRenderer,phase:string){
 frameLayout(t,phase,true);
 assert(`${phase}: patient branding is larger`,Number(wordmarkSize(t))>23);
 assert(`${phase}: stays photo-free`,t.root.findAll(n=>n.type==='Image').length===0);
 assert(`${phase}: fields are not double-inset inside a form card`,t.root.findAllByType(FormCard).length===0);
 assert(`${phase}: retains keyboard-friendly scrolling`,t.root.findAll(n=>n.type==='ScrollView'&&n.props.keyboardShouldPersistTaps==='handled').length===1);
}

async function frameVariants(){
 console.log('· patient-only scroll offset, including banners and native frame');
 assert('offset uses the same 32pt spacing rhythm as welcome',space.xl===32);
 const originalPlatform=Platform.OS;
 try{
  for(const platform of ['web','ios','android']){
   Platform.OS=platform;
   for(const variant of ['patient','provider'] as const){
    const Screen=()=>React.createElement(AuthPageFrame,{
     variant,onBack:()=>{},title:'Frame heading',subtitle:'Supporting copy',pinFooter:true,
     banner:React.createElement(Text,{testID:'frame-warning'},'Environment warning'),
     footer:React.createElement(Text,null,'Footer'),
     children:React.createElement(View,null,React.createElement(Text,null,'Form')),
    });
    const t=await render(Screen);
    frameLayout(t,`${platform} ${variant} warning`,variant==='patient');
    const scroll=t.root.findByType(KeyboardAwareScrollViewCompat);
    assert(`${platform} ${variant}: warning lives inside the offset content`,scroll.findAllByProps({testID:'frame-warning'}).length>0);
    const first=React.Children.toArray(scroll.props.children)[0] as React.ReactElement<{children:React.ReactElement<{testID:string}>}>;
    assert(`${platform} ${variant}: warning precedes the heading with its old gap`,first.props.children.props.testID==='frame-warning'&&flatStyle((first.props as {style:unknown}).style).marginBottom===24);
    await act(async()=>t.unmount());
   }
  }
 }finally{Platform.OS=originalPlatform}
}

async function loginFlow(){
 console.log('· phone password + MFA, email toggle');
 reset(); let t=await render(Login);
 patientFormLayout(t,'Login');
  assert('phone is default',exists(t,'login-phone'));assert('phone has a native label',label(t,'login-phone')==='Cell phone number');assert('password collected first',exists(t,'login-password'));assert('password has a native label',label(t,'login-password')==='Password');assert('password is masked by default',hosts(t,'login-password').some(n=>n.props.secureTextEntry===true));await type(t,'login-password','Secret1!');assert('masked password hides native glyphs immediately',inputStyle(t,'login-password').color==='transparent');assert('password reveal control is available',label(t,'login-password-toggle')==='Show password');await press(t,'login-password-toggle');assert('password reveal control shows the value',hosts(t,'login-password').some(n=>n.props.secureTextEntry===false)&&label(t,'login-password-toggle')==='Hide password'&&inputStyle(t,'login-password').color!=='transparent');await press(t,'login-password-toggle');assert('password is masked again',hosts(t,'login-password').some(n=>n.props.secureTextEntry===true)&&inputStyle(t,'login-password').color==='transparent');assert('MFA absent initially',!exists(t,'login-otp'));
 await press(t,'login-switch-channel');assert('email toggle works',exists(t,'login-email')&&!exists(t,'login-phone'));assert('email has a native label',label(t,'login-email')==='Email address');t.unmount();
reset();on('patient/password/login',()=>({status:200,body:{ok:true,requestId:'lr1',message:'If those details match, a code is on its way.',devCode:'222333'}}));on('login/verify',()=>({status:200,body:{ok:true,realm:'patient',tokenHash:'hash1',signInId:'signin-1'}}));
  t=await render(Login);await type(t,'login-phone','8135551234');assert('phone displays in US format',inputValue(t,'login-phone')==='(813) 555-1234');await type(t,'login-password','Secret1!');await press(t,'login-submit');
 const c=called('patient/password/login')[0];assert('password login contract',c.body.identifier==='+18135551234'&&c.body.password==='Secret1!');assert('password removed after submit',!exists(t,'login-password'));assert('MFA shown',exists(t,'login-otp'));assert('MFA has a native label',label(t,'login-otp')==='6-digit verification code');assert('MFA field focuses as soon as it mounts',hosts(t,'login-otp').some(n=>n.props.autoFocus===true));
 patientFormLayout(t,'Login verification');
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
  assert('phone entry survives the round trip',ph?.props.value==='(813) 555-1234');
 assert('switch back refocuses the fresh phone input',focusCalls.join()==='login-email,login-phone');
 await press(t,'login-switch-channel');
 assert('email entry survives the round trip',input('login-email')?.props.value==='casey@example.com');
 t.unmount();
}
async function recovery(){
 console.log('· neutral recovery phases');
 reset();on('patient/recovery/start',()=>({status:200,body:{ok:true,requestId:'rr1',message:'If that matches, a code is coming.',devCode:'123456'}}));on('patient/recovery/verify',()=>({status:200,body:{ok:true,resetToken:'reset1'}}));on('patient/recovery/complete',()=>({status:200,body:{ok:true}}));
  const t=await render(Login);await press(t,'login-forgot');
  patientFormLayout(t,'Recovery identify');
  assert('recovery identify phase',exists(t,'recovery-start'));await type(t,'login-phone','8135551234');await press(t,'recovery-start');
  patientFormLayout(t,'Recovery code');
  assert('neutral start contract',called('patient/recovery/start')[0].body.identifier==='+18135551234');assert('recovery code phase',exists(t,'recovery-otp'));assert('recovery OTP has a label',label(t,'recovery-otp')==='6-digit verification code');await type(t,'recovery-otp','123456');await press(t,'recovery-verify');
  patientFormLayout(t,'Recovery password');
  assert('new password phase',exists(t,'recovery-password'));assert('recovery passwords have labels',label(t,'recovery-password')==='New password'&&label(t,'recovery-confirm')==='Confirm new password');await type(t,'recovery-password','NewSecret1!');await type(t,'recovery-confirm','NewSecret1!');await press(t,'recovery-complete');assert('complete recovery payload',called('patient/recovery/complete')[0].body.resetToken==='reset1'&&called('patient/recovery/complete')[0].body.password==='NewSecret1!');assert('returns to login',exists(t,'login-password'));t.unmount();
}
async function signupFlows(){
 console.log('· invited and new signup phases');
 const isDisabled=(t:ReactTestRenderer,id:string)=>hosts(t,id).some(n=>n.props.accessibilityState?.disabled===true);
 const ruleMet=(t:ReactTestRenderer,key:string)=>hosts(t,'signup-rule-'+key).some(n=>n.props.accessibilityState?.checked===true);
 reset();on('signup/start',()=>({status:200,body:{ok:true,requestId:'s1',message:'Code sent',devCode:'444555'}}));on('signup/verify',()=>({status:200,body:{ok:true,mode:'enroll',signupToken:'st1',invitedName:{firstName:'Shannon',lastName:'Strotheide'}}}));
 const newPrivacy={consent:{requiredVersion:'2026-05',recordedVersion:null,satisfied:false,photoAnalysis:null,recordedAt:null},export:null,deletion:null,deletionPolicy:{graceDays:7,retentionYears:7}};
 let completes=0;on('signup/complete',()=>{completes++;return completes===1?{status:400,body:{error:'This password has appeared in a data breach — please choose a different one.',field:'password',code:'WEAK_PASSWORD'}}:{status:200,body:{ok:true,tokenHash:'sh1',signInId:'signin-2',patientId:'pt-new',privacy:newPrivacy}}});
 clearSignupSeed();
  let t=await render(Signup);
  patientFormLayout(t,'Signup choices');
  assert('explicit choices',exists(t,'signup-invited')&&exists(t,'signup-new'));await press(t,'signup-invited');
  patientFormLayout(t,'Signup contact');
  assert('signup phone is labeled',label(t,'signup-phone')==='Invited phone number');
  await type(t,'signup-phone','3147573375');assert('phone formats as typed',inputValue(t,'signup-phone')==='(314) 757-3375');
  await type(t,'signup-phone','31475733759999');assert('phone stops at 10 digits',inputValue(t,'signup-phone')==='(314) 757-3375');
  await type(t,'signup-phone','314');assert('partial phone formats',inputValue(t,'signup-phone')==='(314');
  await type(t,'signup-phone','+1 314 757 3375');assert('pasted +1 number keeps the right 10 digits',inputValue(t,'signup-phone')==='(314) 757-3375');
  await type(t,'signup-phone','');
  await type(t,'signup-email','invited@example.com');assert('invited email is labeled',label(t,'signup-email')==='Invited email address');await press(t,'signup-send');
  patientFormLayout(t,'Signup verification');
  assert('invited contract',called('signup/start')[0].body.flow==='invited'&&called('signup/start')[0].body.identifier==='invited@example.com');await type(t,'signup-otp','444555');assert('signup OTP is labeled',label(t,'signup-otp')==='6-digit verification code');await press(t,'signup-verify');
  patientFormLayout(t,'Signup name');
  assert('name step comes before the password',exists(t,'signup-first-name')&&exists(t,'signup-last-name')&&!exists(t,'signup-password'));
  assert('old optional name field is gone',!exists(t,'signup-name'));
  assert('name fields are labeled',label(t,'signup-first-name')==='First name'&&label(t,'signup-last-name')==='Last name');
  assert('invited name is prefilled from the office record',inputValue(t,'signup-first-name')==='Shannon'&&inputValue(t,'signup-last-name')==='Strotheide');
  await type(t,'signup-last-name','  ');assert('blank last name blocks continue',isDisabled(t,'signup-name-continue'));
  await type(t,'signup-last-name','Strotheide-Lane');assert('edited name can continue',!isDisabled(t,'signup-name-continue'));
  await press(t,'signup-name-continue');
  patientFormLayout(t,'Signup password');
  assert('password step has password and confirm',exists(t,'signup-password')&&exists(t,'signup-confirm'));
  assert('password labels',label(t,'signup-password')==='Password'&&label(t,'signup-confirm')==='Confirm password');
  assert('both password fields have eye toggles',exists(t,'signup-password-toggle')&&exists(t,'signup-confirm-toggle'));
  assert('checklist lists four rules',['length','upper','lower','symbol'].every(k=>exists(t,'signup-rule-'+k)));
  assert('empty password meets no rule',['length','upper','lower','symbol'].every(k=>!ruleMet(t,k)));
  assert('create disabled while empty',isDisabled(t,'signup-complete'));
  await type(t,'signup-password','abc');assert('lowercase ticks alone',ruleMet(t,'lower')&&!ruleMet(t,'upper')&&!ruleMet(t,'length')&&!ruleMet(t,'symbol'));
  await type(t,'signup-password','Abcdefgh');assert('length and uppercase tick',ruleMet(t,'length')&&ruleMet(t,'upper')&&!ruleMet(t,'symbol'));
  await type(t,'signup-confirm','Abcdefgh');assert('matching but missing a symbol stays disabled',isDisabled(t,'signup-complete'));
  await type(t,'signup-password','Abcdefg1');assert('a digit is not a symbol',!ruleMet(t,'symbol'));
  await type(t,'signup-password','Password1!');assert('every rule met',['length','upper','lower','symbol'].every(k=>ruleMet(t,k)));
  assert('rules met but confirm mismatched stays disabled',isDisabled(t,'signup-complete'));
  await type(t,'signup-confirm','Password1!');assert('rules met and matching enables create',!isDisabled(t,'signup-complete'));
  await press(t,'signup-password-toggle');assert('eye reveals the password',hosts(t,'signup-password').some(n=>n.props.secureTextEntry===false));
  await press(t,'signup-complete');
  const first=called('signup/complete')[0];
  assert('completion carries password and split name',first.body.password==='Password1!'&&first.body.firstName==='Shannon'&&first.body.lastName==='Strotheide-Lane'&&first.body.name===undefined);
  assert('breach message shows on the password step',exists(t,'signup-password')&&signupErr(t).includes('data breach'));
  assert('entered values survive the refusal',inputValue(t,'signup-password')==='Password1!'&&inputValue(t,'signup-confirm')==='Password1!');
  assert('no navigation on a refusal',!routerCalls.some(x=>x.method==='replace'));
  assert('a refusal leaves no signup seed behind',peekSignupSeed('u-refused')===null);
  assert('a refusal clears the progress steps',!exists(t,'signup-progress')&&btnLabel(t,'signup-complete')==='Create account');
  await press(t,'signup-back');assert('back from password keeps the edited name',exists(t,'signup-first-name')&&inputValue(t,'signup-last-name')==='Strotheide-Lane');
  await press(t,'signup-name-continue');assert('password survives stepping back',inputValue(t,'signup-password')==='Password1!');
  await type(t,'signup-password','Stronger!Pass9');await type(t,'signup-confirm','Stronger!Pass9');
  // Hold the sign-in open to see the progress the patient gets mid-wait.
  const releaseSignIn=holdNextVerifyOtp();
  const finishing=await pressHeld(t,'signup-complete');
  await act(async()=>{await new Promise(r=>setTimeout(r,0))});
  assert('the button names the sign-in step while it runs',btnLabel(t,'signup-complete')==='Signing you in…');
  assert('a progress line stays on screen during the wait',exists(t,'signup-progress'));
  assert('the button stays disabled while signing in',isDisabled(t,'signup-complete'));
  assert('no navigation before the session exists',!routerCalls.some(x=>x.method==='replace'));
  releaseSignIn();
  await finishing();
  assert('retry sends the new password',called('signup/complete')[1]?.body.password==='Stronger!Pass9');
  assert('signup token minted',verifyOtpCalls[0]?.token_hash==='sh1');
  assert('a completed signup lands on the consent page',routerCalls.some(x=>x.method==='replace'&&x.target==='/consent'));
  assert('it skips Today on the way',!routerCalls.some(x=>x.method==='replace'&&x.target==='/today'));
  assert('progress stays up through the navigation',btnLabel(t,'signup-complete')==='Opening your account…'&&isDisabled(t,'signup-complete'));
  const seed=peekSignupSeed('test-user');
  assert('the new account is seeded for the gate',seed?.patientId==='pt-new'&&seed.privacy.consent.satisfied===false&&seed.privacy.consent.requiredVersion==='2026-05');
  assert('the seed belongs to the first session that asks',peekSignupSeed('someone-else')===null);
  assert('the first hydration takes the seed once',takeSignupSeed('pt-new')?.patientId==='pt-new'&&takeSignupSeed('pt-new')===null);
  const fresh={mode:'patient' as const,accountKind:'real' as const,patientHydrated:true,onboardingComplete:false,pathname:'/today'};
  const gate=liveEntryDecision({modeHydrated:true,accountResolving:false,consentSatisfied:true,deletionPending:false,demoAdmitted:false,...fresh});
  assert('a fresh account is then gated into onboarding',gate.kind==='redirect'&&['/onboarding/welcome','/consent'].includes((gate as {href:string}).href));
  t.unmount();
 // A name error from the server bounces the patient back to the name step.
 reset();on('signup/start',()=>({status:200,body:{ok:true,requestId:'s3',message:null,devCode:'444555'}}));on('signup/verify',()=>({status:200,body:{ok:true,mode:'enroll',signupToken:'st3',invitedName:{firstName:'Casey',lastName:'Patient'}}}));on('signup/complete',()=>({status:400,body:{error:'Enter your last name.',field:'lastName'}}));
  t=await render(Signup);await press(t,'signup-invited');await type(t,'signup-email','casey@example.com');await press(t,'signup-send');await type(t,'signup-otp','444555');await press(t,'signup-verify');await press(t,'signup-name-continue');
  await type(t,'signup-password','Stronger!Pass9');await type(t,'signup-confirm','Stronger!Pass9');await press(t,'signup-complete');
  assert('name field error returns to the name step',exists(t,'signup-last-name')&&signupErr(t).includes('last name'));t.unmount();
 reset();let attempts=0;on('signup/start',()=>{attempts++;return attempts===1?{status:400,body:{error:'Provider code required'}}:{status:200,body:{ok:true,requestId:'s2',message:null,devCode:null}}});
 t=await render(Signup);await press(t,'signup-new');assert('new requires both contacts',exists(t,'signup-phone')&&exists(t,'signup-email'));assert('new contact/provider inputs are labeled',label(t,'signup-phone')==='Cell phone number'&&label(t,'signup-email')==='Email address'&&label(t,'signup-provider-code')==='Provider code');await type(t,'signup-phone','8135559999');assert('new phone formats as typed',inputValue(t,'signup-phone')==='(813) 555-9999');await press(t,'signup-send');assert('missing email stays local',called('signup/start').length===0&&signupErr(t).includes('both'));await type(t,'signup-email','new@example.com');await press(t,'signup-send');assert('missing provider code stays local',called('signup/start').length===0&&signupErr(t).toLowerCase().includes('provider code'));await type(t,'signup-provider-code','654321');await press(t,'signup-send');const nc=called('signup/start')[0];assert('new submit sends both contacts and code',nc.body.flow==='new'&&nc.body.phone==='+18135559999'&&nc.body.email==='new@example.com'&&nc.body.code==='654321');t.unmount();
  reset();
  on('signup/start',()=>({status:200,body:{ok:true,requestId:'new-layout',message:null}}));
  on('signup/verify',()=>({status:200,body:{ok:true,mode:'enroll',signupToken:'new-layout-token'}}));
  t=await render(Signup);await press(t,'signup-new');
  patientFormLayout(t,'New signup contact');
  await type(t,'signup-phone','2025550123');await type(t,'signup-email','layout@example.com');await type(t,'signup-provider-code','654321');await press(t,'signup-send');
  patientFormLayout(t,'New signup verification');
  await type(t,'signup-otp','444555');await press(t,'signup-verify');
  patientFormLayout(t,'New signup name');
  assert('new patients start with blank names',inputValue(t,'signup-first-name')===''&&inputValue(t,'signup-last-name')==='');
  assert('blank names block continue',isDisabled(t,'signup-name-continue'));
  await type(t,'signup-first-name','Nova');await type(t,'signup-last-name','Patient');await press(t,'signup-name-continue');
  patientFormLayout(t,'New signup password');
  t.unmount();
}
async function provider(){
 console.log('· provider route remains staff');
reset();on('login/start',()=>({status:200,body:{ok:true,requestId:'p1',message:null,devCode:'111111'}}));on('login/verify',()=>({status:200,body:{ok:true,realm:'staff',tokenHash:'ph',signInId:'signin-3'}}));
  const t=await render(ProviderLogin);
  frameLayout(t,'Provider email',false);
  assert('provider branding is unchanged by patient restyling',wordmarkSize(t)===23);
   await type(t,'provider-email','staff@example.com');await press(t,'provider-send');
   frameLayout(t,'Provider code',false);
   await type(t,'provider-otp','111111');await press(t,'provider-verify');assert('staff mode preserved',storage.get('thinnr_app_mode_v1')==='staff');assert('staff destination preserved',routerCalls.some(x=>x.target==='/'));t.unmount();

  reset();
  on('login/start',()=>({status:200,body:{ok:true,requestId:'p2',message:null,devCode:null}}));
  on('login/verify',()=>({status:200,body:{ok:true,realm:'staff',secondFactor:{stepToken:'a'.repeat(64),mode:'enroll',destination:null}}}));
  on('login/phone/start',()=>({status:200,body:{ok:true,mode:'enroll',requestId:'sms-enroll',destination:'•••-•••-1212',devCode:'222222'}}));
  on('login/phone/verify',()=>({status:200,body:{ok:true,realm:'staff',tokenHash:'phone-hash',signInId:'phone-signin'}}));
  let enroll=await render(ProviderLogin);
  await type(enroll,'provider-email','owner@example.com');await press(enroll,'provider-send');
  await type(enroll,'provider-otp','111111');await press(enroll,'provider-verify');
  assert('staff enrollment asks for a phone',exists(enroll,'input-provider-phone'));
  await press(enroll,'button-provider-phone-send');
  assert('staff enrollment requires a plausible phone',called('login/phone/start').length===0&&exists(enroll,'provider-error'));
  await type(enroll,'input-provider-phone','8135551212');await press(enroll,'button-provider-phone-send');
  const phoneStart=called('login/phone/start')[0];
  assert('phone start carries step token and normalized phone',phoneStart.body.stepToken==='a'.repeat(64)&&phoneStart.body.phone==='+18135551212');
  assert('enrollment advances to text code',exists(enroll,'input-provider-sms-code')&&exists(enroll,'provider-sms-devcode'));
  await type(enroll,'input-provider-sms-code','222222');await press(enroll,'button-provider-sms-verify');
  const phoneVerify=called('login/phone/verify')[0];
  assert('phone verify carries step token and request',phoneVerify.body.stepToken==='a'.repeat(64)&&phoneVerify.body.requestId==='sms-enroll');
  assert('phone success redeems token hash',verifyOtpCalls[0]?.token_hash==='phone-hash');
  enroll.unmount();

  reset();
  on('login/start',()=>({status:200,body:{ok:true,requestId:'p3',message:null,devCode:null}}));
  on('login/verify',()=>({status:200,body:{ok:true,realm:'staff',secondFactor:{stepToken:'b'.repeat(64),mode:'sms',destination:'•••-•••-3434'}}}));
  on('login/phone/start',()=>({status:200,body:{ok:true,mode:'sms',requestId:'sms-existing',destination:'•••-•••-3434',devCode:null}}));
  on('login/phone/verify',()=>({status:400,body:{error:'This step expired.',code:'STEP_EXPIRED'}}));
  const sms=await render(ProviderLogin);
  await type(sms,'provider-email','staff@example.com');await press(sms,'provider-send');
  await type(sms,'provider-otp','111111');await press(sms,'provider-verify');
  assert('existing phone auto-sends and shows sms phase',called('login/phone/start')[0].body.phone===undefined&&exists(sms,'input-provider-sms-code'));
  await type(sms,'input-provider-sms-code','333333');await press(sms,'button-provider-sms-verify');
  assert('expired phone step returns to email',exists(sms,'provider-email')&&!exists(sms,'input-provider-sms-code'));
  assert('expired phone step shows neutral notice',exists(sms,'provider-notice'));
  sms.unmount();
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
async function main(){await frameVariants();await loginFlow();await channelSwitch();await recovery();await signupFlows();await staleResponses();await provider();routing();console.log(`\n${checks} checks, ${failures} failures`);process.exit(failures?1:0)}
main().catch(e=>{console.error(e);process.exit(1)});