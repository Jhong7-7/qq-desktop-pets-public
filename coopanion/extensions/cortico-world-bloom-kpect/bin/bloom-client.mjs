#!/usr/bin/env node
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import path from 'node:path';

// Bot client never reads a human's browser credentials or sends platform messages.
const file=path.resolve(process.env.BLOOM_CREDENTIAL_FILE||'.bloom-bot.json');
const [command='state',...args]=process.argv.slice(2);
let credentials=null;
try{credentials=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const base=(process.env.BLOOM_URL||credentials?.url||'').replace(/\/$/,'');
if(!base||!/^https?:\/\//.test(base))throw Error('Set BLOOM_URL to your town URL.');
const destination=new URL(base);
if(destination.username||destination.password||destination.search||destination.hash)throw Error('Town URL must not contain credentials, query or fragment.');
if(credentials&&new URL(credentials.url).href.replace(/\/$/,'')!==destination.href.replace(/\/$/,''))throw Error('Town URL differs from saved credentials; use a separate credential file.');
async function call(endpoint,body,token){
  const response=await fetch(base+'/api/'+endpoint,{method:body?'POST':'GET',redirect:'error',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
  const value=await response.json();if(!response.ok){const error=new Error((value.error||`HTTP ${response.status}`)+(value.nextStep?"\n下一步："+value.nextStep:""));error.status=response.status;error.code=value.code;throw error;}return value;
}
// A lost response must not become a second purchase or a duplicated letter.
// Keep exactly one unresolved mutation; explicit requestId remains available to SDK callers.
async function durableCall(endpoint,input,token){
  if(input.requestId)return call(endpoint,input,token);
  const pendingFile=file+'.pending.json',identity=createHash('sha256').update(base+'\0'+token).digest('hex'),payload=JSON.stringify({endpoint,input});
  let pending;try{pending=JSON.parse(await readFile(pendingFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(pending&&(pending.identity!==identity||pending.payload!==payload))throw Error('An earlier mutation is unresolved. Retry its same command first, or inspect '+pendingFile+' and its requestId before starting another action.');
  if(!pending){pending={identity,payload,requestId:randomUUID()};await writeFile(pendingFile,JSON.stringify(pending,null,2),{flag:'wx',mode:0o600});}
  try{const result=await call(endpoint,{...input,requestId:pending.requestId},token);await unlink(pendingFile);return result;}
  catch(error){if(error.status>=400&&error.status<500&&error.code!=='CONCURRENT_UPDATE')await unlink(pendingFile);throw error;}
}
if(command==='join'){
  const name=args[0];if(!name||!process.env.BLOOM_INVITE)throw Error('Usage: set BLOOM_INVITE, then bloom-client.mjs join <name>.');
  if(credentials&&(credentials.url!==base||credentials.name!==name))throw Error('Credential file belongs to another town or resident; choose another BLOOM_CREDENTIAL_FILE.');
  if(!credentials){credentials={url:base,name,token:randomBytes(32).toString('hex'),requestId:randomUUID()};await writeFile(file,JSON.stringify(credentials,null,2),{flag:'wx',mode:0o600});}
  const result=await call('join',{code:process.env.BLOOM_INVITE,name,kind:'bot',clientToken:credentials.token,requestId:credentials.requestId});
  credentials.member=result.member;await writeFile(file,JSON.stringify(credentials,null,2),{mode:0o600});
  console.log(JSON.stringify({joined:result.member,onboarding:result.onboarding,botSafety:result.botSafety,credentialFile:file},null,2));
}else{
  const token=process.env.BLOOM_TOKEN||credentials?.token;if(!token)throw Error('Join first, or set BLOOM_TOKEN.');
  let result;
  if(command==='state'){
    const state=await call('state',undefined,token);
    result=args.includes('--full')?state:{contentPolicy:state.contentPolicy,botSafety:state.botSafety,clock:state.clock,me:state.me,onboarding:state.onboarding,careers:state.careers,activeAction:state.activeAction,plots:state.plots,claims:state.claims,nearby:state.locations.find(l=>l.id===state.me.location),jobs:state.jobs.filter(j=>!j.done),neighbors:state.residents,availableActions:state.availableActions,home:state.home,mail:state.mail,life:state.life,leisure:state.leisure,porch:state.porch,seasonal:state.seasonal,belongings:state.belongings,crafting:state.crafting,economy:state.economy,custody:state.custody,housing:state.housing,trade:state.trade,pendingFeatures:state.pendingFeatures};
  }else if(command==='guide')result=await call('guide'+(args[0]?'?location='+encodeURIComponent(args[0]):''),undefined,token);
  else if(command==='npc')result=await call('npc?npcId='+encodeURIComponent(args[0]||'dahunii')+'&scene='+encodeURIComponent(args[1]||'greeting'),undefined,token);
  else if(command==='actions')result=await call('actions',undefined,token);
  else if(command==='messages')result=await call('messages?channel='+encodeURIComponent(args[0]||'town'),undefined,token);
  else if(command==='chat')result=await durableCall('messages',{channel:args[0]||'town',text:args.slice(1).join(' ')},token);
  else if(command==='action'){
    if(!args[0])throw Error('Usage: action <JSON or @file.json>.');
    const input=JSON.parse(args[0].startsWith('@')?await readFile(path.resolve(args[0].slice(1)),'utf8'):args[0]);
    result=await durableCall('action',input,token);
  }else throw Error('Commands: join, state, guide, npc, actions, messages, chat, action.');
  console.log(JSON.stringify(result,null,2));
}
