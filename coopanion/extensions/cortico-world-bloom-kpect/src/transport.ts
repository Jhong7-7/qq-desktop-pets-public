import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,unlink,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';

// One process owns each data directory. Instances in this process share the lock;
// separate OS processes must use separate data directories. Legacy mutation.lock
// files are intentionally ignored and left untouched. pending.json remains the
// durable journal for retrying an unknown outcome with the same identity/payload.
const mutationLocks=new Set<string>();

export function serverUrl(input:string){
 const u=new URL(input);
 if(u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('服务器地址只能包含协议、主机和端口');
 if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)))throw Error('远程服务器必须使用HTTPS；HTTP仅用于本机回环地址');
 return u.origin;
}
export class BloomHttpError extends Error{constructor(public status:number,public code:string,public nextStep:string){super(`花语乡拒绝请求：${code}（HTTP ${status}）。${nextStep}`);}}
export class BloomTransport{
 constructor(private config:()=>{url:string;token:string},private dir:string){this.dir=resolve(dir);}
 identity(){const c=this.config();const url=serverUrl(c.url);if(!/^[A-Za-z0-9_-]{32,128}$/.test(c.token))throw Error('请配置有效的花语乡Bot令牌');return {url,token:c.token,key:createHash('sha256').update(url+'\0'+c.token).digest('hex')};}
 async read(endpoint:string,signal?:AbortSignal){return this.request(endpoint,undefined,signal);}
 private async request(endpoint:string,body?:unknown,signal?:AbortSignal,expectedIdentity?:string){
  if(!/^(state|actions|opportunities\?topic=(?:all|work|market|social)&limit=\d+&offset=\d+|guide(?:\?location=[^&]*)?|messages(?:\?channel=[^&]*(?:&after=\d+)?)?|chat-groups|action)$/.test(endpoint))throw Error('不支持的花语乡入口');
  const {url,token,key}=this.identity();if(expectedIdentity&&key!==expectedIdentity)throw Error('连接配置已变化，原请求未重发');
  await mkdir(this.dir,{recursive:true});const binding=join(this.dir,'server-'+createHash('sha256').update(token).digest('hex')+'.json');
  try{await writeFile(binding,JSON.stringify({url}),{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;if(JSON.parse(await readFile(binding,'utf8')).url!==url)throw Error('此Bot令牌已绑定另一服务器，请使用新服务器独立签发的令牌');}
  const response=await fetch(url+'/api/'+endpoint,{method:body?'POST':'GET',redirect:'error',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.any([AbortSignal.timeout(20000),...(signal?[signal]:[])])}).catch(()=>{throw Error('花语乡连接中断或超时；已提交动作的结果可能未知，请保留原requestId');});
  const reader=response.body?.getReader();if(!reader)throw Error('花语乡未返回有效响应');let size=0;const chunks:Uint8Array[]=[];
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>2_000_000)throw Error('花语乡响应过大');chunks.push(part.value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}
  let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('花语乡响应不是有效JSON；动作结果可能未知');}
  if(!response.ok)throw new BloomHttpError(response.status,typeof value?.code==='string'?value.code.replace(/[^A-Z0-9_]/g,'').slice(0,80):'HTTP_ERROR',typeof value?.nextStep==='string'?value.nextStep.split(token).join('[redacted]').slice(0,1000):'请刷新状态后核对规则。');
  return JSON.parse(JSON.stringify(value).split(token).join('[redacted]'));
 }
 async pending(){try{return JSON.parse(await readFile(join(this.dir,'pending.json'),'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw Error('未解决请求记录损坏，请操作者核查，不自动覆盖');}}
 async mutate(endpoint:'action'|'messages'|'chat-groups',body:Record<string,unknown>,signal?:AbortSignal){
  if(typeof body.requestId!=='string'||!body.requestId.trim()||body.requestId.length>100)throw Error('需要最多100字符的稳定requestId');
  const encoded=JSON.stringify(body);if(Buffer.byteLength(encoded)>16000)throw Error('请求超过16000字节');
  await mkdir(this.dir,{recursive:true});
  const canonicalDir=await realpath(this.dir),lockKey=process.platform==='win32'?canonicalDir.toLowerCase():canonicalDir;
  // No await between checking and taking the lock: this is atomic in one JS process.
  if(mutationLocks.has(lockKey))throw Error('另一个花语乡动作正在提交，请等待当前请求完成后再试');
  mutationLocks.add(lockKey);
  try{
   const identity=this.identity().key,old=await this.pending(),payload=JSON.stringify({endpoint,body});
   if(old&&(old.identity!==identity||old.payload!==payload))throw Error('有未解决动作，请先用原requestId和相同参数重试；不能换服务器、令牌或请求绕过');
   if(signal?.aborted)throw Error('请求已取消，尚未提交');
   if(!old)await writeFile(join(this.dir,'pending.json'),JSON.stringify({identity,payload,requestId:body.requestId}),{flag:'wx',mode:0o600});
   try{const result=await this.request(endpoint,body,signal,identity);await unlink(join(this.dir,'pending.json'));return result;}
   catch(error){if(error instanceof BloomHttpError&&error.status>=400&&error.status<500&&error.code!=='CONCURRENT_UPDATE')await unlink(join(this.dir,'pending.json'));throw error;}
  }finally{mutationLocks.delete(lockKey);}
 }
}
