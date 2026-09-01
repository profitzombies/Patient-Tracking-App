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
const reset=()=>{calls.length=0;handlers.clear();clearRouterCalls();clearAuthStub();storage.clear()};
globalThis.fetch=(async(input:unknown,init?:{body?:string})=>{const path=String(input).split('/api/auth/')[1];const call={path,body:JSON.parse(init?.body??'{}')};calls.push(call);const out=handlers.get(path)?.(call)??{status:500,body:{error:'unscripted '+path}};return{status:out.status,json:async()=>out.body}}) as typeof fetch;
async function render(Screen:React.ComponentType){let tree!:ReactTestRenderer;await act(async()=>{tree=create(React.createElement(AppModeProvider,null,React.createElement(Screen)))});return tree}
const hosts=(t:ReactTestRenderer,id:string)=>t.root.findAllByProps({testID:id}).filter(n=>typeof n.type==='string');
const exists=(t:ReactTestRenderer,id:string)=>hosts(t,id).length>0;
const label=(t:ReactTestRenderer,id:string)=>hosts(t,id).find(x=>'accessibilityLabel' in x.props)?.props.accessibilityLabel as string|undefined;
async function type(t:ReactTestRenderer,id:string,v:string){const n=hosts(t,id).find(x=>typeof x.props.onChangeText==='function');if(!n)throw Error('missing input '+id);await act(async()=>n.props.onChangeText(v))}
async function press(t:ReactTestRenderer,id:string){const n=hosts(t,id).find(x=>typeof x.props.onPress==='function');if(!n)throw Error('missing press '+id);await act(async()=>n.props.onPress())}
const err=(t:ReactTestRenderer)=>t.root.findAllByProps({testID:'login-error'}).map(n=>String(n.props.message??'')).join(' ');
const signupErr=(t:ReactTestRenderer)=>t.root.findAllByProps({testID:'signup-error'}).map(n=>String(n.props.message??'')).join(' ');
const called=(path:string)=>calls.filter(c=>c.path===path);

async function loginFlow(){
 console.log('· phone password + MFA, email toggle');
 reset(); let t=await render(Login);
 assert('phone is default',exists(t,'login-phone'));assert('phone has a native label',label(t,'login-phone')==='Cell phone number');assert('password collected first',exists(t,'login-password'));assert('password has a native label',label(t,'login-password')==='Password');assert('MFA absent initially',!exists(t,'login-otp'));
 await press(t,'login-switch-channel');assert('email toggle works',exists(t,'login-email')&&!exists(t,'login-phone'));assert('email has a native label',label(t,'login-email')==='Email address');t.unmount();
 reset();on('patient/password/login',()=>({status:200,body:{ok:true,requestId:'lr1',message:'If those details match, a code is on its way.',devCode:'222333'}}));on('login/verify',()=>({status:200,body:{ok:true,realm:'patient',tokenHash:'hash1'}}));
 t=await render(Login);await type(t,'login-phone','8135551234');await type(t,'login-password','Secret1!');await press(t,'login-submit');
 const c=called('patient/password/login')[0];assert('password login contract',c.body.identifier==='+18135551234'&&c.body.password==='Secret1!');assert('password removed after submit',!exists(t,'login-password'));assert('MFA shown',exists(t,'login-otp'));assert('MFA has a native label',label(t,'login-otp')==='6-digit verification code');
 await type(t,'login-otp','222333');await press(t,'login-verify');assert('MFA token minted',verifyOtpCalls[0]?.token_hash==='hash1');assert('patient destination',routerCalls.some(x=>x.method==='replace'&&x.target==='/today'));t.unmount();
}
async function recovery(){
 console.log('· neutral recovery phases');
 reset();on('patient/recovery/start',()=>({status:200,body:{ok:true,requestId:'rr1',message:'If that matches, a code is coming.',devCode:'123456'}}));on('patient/recovery/verify',()=>({status:200,body:{ok:true,resetToken:'reset1'}}));on('patient/recovery/complete',()=>({status:200,body:{ok:true}}));
 const t=await render(Login);await press(t,'login-forgot');assert('recovery identify phase',exists(t,'recovery-start'));await type(t,'login-phone','8135551234');await press(t,'recovery-start');assert('neutral start contract',called('patient/recovery/start')[0].body.identifier==='+18135551234');assert('recovery code phase',exists(t,'recovery-otp'));assert('recovery OTP has a label',label(t,'recovery-otp')==='6-digit verification code');await type(t,'recovery-otp','123456');await press(t,'recovery-verify');assert('new password phase',exists(t,'recovery-password'));assert('recovery passwords have labels',label(t,'recovery-password')==='New password'&&label(t,'recovery-confirm')==='Confirm new password');await type(t,'recovery-password','NewSecret1!');await type(t,'recovery-confirm','NewSecret1!');await press(t,'recovery-complete');assert('complete recovery payload',called('patient/recovery/complete')[0].body.resetToken==='reset1'&&called('patient/recovery/complete')[0].body.password==='NewSecret1!');assert('returns to login',exists(t,'login-password'));t.unmount();
}
async function signupFlows(){
 console.log('· invited and new signup phases');
 reset();on('signup/start',()=>({status:200,body:{ok:true,requestId:'s1',message:'Code sent',devCode:'444555'}}));on('signup/verify',()=>({status:200,body:{ok:true,mode:'enroll',signupToken:'st1'}}));on('signup/complete',()=>({status:200,body:{ok:true,tokenHash:'sh1'}}));
 let t=await render(Signup);assert('explicit choices',exists(t,'signup-invited')&&exists(t,'signup-new'));await press(t,'signup-invited');assert('signup phone is labeled',label(t,'signup-phone')==='Cell phone number');await type(t,'signup-email','invited@example.com');assert('invited email is labeled',label(t,'signup-email')==='Invited email address');await press(t,'signup-send');assert('invited contract',called('signup/start')[0].body.flow==='invited'&&called('signup/start')[0].body.identifier==='invited@example.com');await type(t,'signup-otp','444555');assert('signup OTP is labeled',label(t,'signup-otp')==='6-digit verification code');await press(t,'signup-verify');assert('invited reaches password details',exists(t,'signup-password'));assert('signup password/name labels',label(t,'signup-password')==='Create password'&&label(t,'signup-name')==='Name');await type(t,'signup-password','Secret1!');await type(t,'signup-name','Casey');await press(t,'signup-complete');assert('completion carries password',called('signup/complete')[0].body.password==='Secret1!');assert('signup token minted',verifyOtpCalls[0]?.token_hash==='sh1');t.unmount();
 reset();let attempts=0;on('signup/start',()=>{attempts++;return attempts===1?{status:400,body:{error:'Provider code required'}}:{status:200,body:{ok:true,requestId:'s2',message:null,devCode:null}}});
 t=await render(Signup);await press(t,'signup-new');assert('new requires both contacts',exists(t,'signup-phone')&&exists(t,'signup-email'));assert('new contact/provider inputs are labeled',label(t,'signup-phone')==='Cell phone number'&&label(t,'signup-email')==='Email address'&&label(t,'signup-provider-code')==='Provider code');await type(t,'signup-phone','8135559999');await press(t,'signup-send');assert('missing email stays local',called('signup/start').length===0&&signupErr(t).includes('both'));await type(t,'signup-email','new@example.com');await press(t,'signup-send');assert('server provider requirement shown',signupErr(t).includes('Provider code required'));await type(t,'signup-provider-code','654321');await press(t,'signup-send');const nc=called('signup/start')[1];assert('new retry sends both contacts and code',nc.body.flow==='new'&&nc.body.phone==='+18135559999'&&nc.body.email==='new@example.com'&&nc.body.code==='654321');t.unmount();
}
async function provider(){
 console.log('· provider route remains staff');
 reset();on('login/start',()=>({status:200,body:{ok:true,requestId:'p1',message:null,devCode:'111111'}}));on('login/verify',()=>({status:200,body:{ok:true,realm:'staff',tokenHash:'ph'}}));
 const t=await render(ProviderLogin);await type(t,'provider-email','staff@example.com');await press(t,'provider-send');await type(t,'provider-otp','111111');await press(t,'provider-verify');assert('staff mode preserved',storage.get('thinnr_app_mode_v1')==='staff');assert('staff destination preserved',routerCalls.some(x=>x.target==='/'));t.unmount();
}
function routing(){
 console.log('· welcome, deep-link guard, demo admission, onboarding filtering');
 const signedOut={modeHydrated:true,mode:'patient' as const,accountResolving:false,accountKind:'demo' as const,patientHydrated:true,onboardingComplete:null,pathname:'/onboarding/height',demoAdmitted:false};
 const welcomeSource=readFileSync(new URL('../app/patient-welcome.tsx',import.meta.url),'utf8');
 const staffTabsLayout=readFileSync(new URL('../app/(tabs)/_layout.tsx',import.meta.url),'utf8');
 const patientTabsLayout=readFileSync(new URL('../app/(patient)/_layout.tsx',import.meta.url),'utf8');
 assert('welcome exposes primary actions',welcomeSource.includes('testID="welcome-login"')&&welcomeSource.includes('testID="welcome-signup"'));
 assert('welcome preserves subtle demo and provider doors',welcomeSource.includes('testID="welcome-demo"')&&welcomeSource.includes('testID="welcome-provider"'));
 assert('fresh root enters patient welcome',staffTabsLayout.includes("mode === 'patient' ? '/today' : '/patient-welcome'"));
 assert('fresh patient tab enters patient welcome',patientTabsLayout.includes("mode === 'staff' ? '/' : '/patient-welcome'"));
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
async function main(){await loginFlow();await recovery();await signupFlows();await provider();routing();console.log(`\n${checks} checks, ${failures} failures`);process.exit(failures?1:0)}
main().catch(e=>{console.error(e);process.exit(1)});