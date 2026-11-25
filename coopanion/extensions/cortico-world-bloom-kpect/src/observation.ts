// Projection happens only after the authenticated server has filtered the resident view.
type State=Record<string,any>;
export const coreSections=['clock','me','activeAction','onboarding','plots','claims','botSafety','contentPolicy','quiz','parlor','economyV7','marketRegulation','whale'] as const;
const legacySections=['clock','me','activeAction','onboarding','plots','claims','availableActions','nearby','jobs','neighbors','home','life','leisure','quiz','parlor','porch','seasonal','belongings','crafting','economy','custody','housing','trade','orders','botSafety','contentPolicy'];
export const stateSections=[...new Set([...legacySections,'economyV7','marketRegulation','whale','careers','chat','titles','shops','locations','residents','catalog','recipes','market','mailbox','visits','visitingHome','projects','caravan','registeredEvents','chronicle','donation','television','houses','ledger','activity','finance','publicBudget','publicSpending','buybackPolicies','todayRecommendation','npcReplies','observer','observedResidentId','pendingFeatures'])];
function normalized(state:State):State{return {...state,nearby:state.locations?.find((l:{id:string})=>l.id===state.me?.location),neighbors:state.residents};}
function pick(state:State,keys:readonly string[]){return Object.fromEntries(keys.filter(key=>state[key]!==undefined).map(key=>[key,state[key]]));}
function compactEconomy(value:State){return {...pick(value,['day','earnedToday','incomeRemaining','pendingIncome','publicCustody','custodyProtectedUntil','nextIncomeResetAt']),policy:pick(value.policy??{},['dailyIncomeLimit','idleWalletThreshold','idleAfterMs'])};}
function compactMarket(value:State){return {...pick(value,['policy','limits','transactionsUsedMinute','transactionsUsedHour','feeRule']),...(value.resources?{resources:{location:value.resources.location,availableKinds:value.resources.items?.filter((x:State)=>x.remaining>0).length??0,totalKinds:value.resources.items?.length??0,nextRefillAt:value.resources.nextRefillAt}}:{})};}
function compactWhale(value:State){
 if(!value.joined)return pick(value,['name','joined','open','initialCash']);
 const me=value.me??{},prizes=me.prizes??[];
 return {...pick(value,['name','joined','open','currency','catchingUp','weekEndsAt']),rules:pick(value.rules??{},['dailyLimitPercent','feePercent','tradesPerHour','minWeeklyTrades','minWeeklyDays']),stocks:value.stocks?.map((s:State)=>pick(s,['id','price','changePercent'])),me:{...pick(me,['cash','netWorth','rank','holdings','tradesThisWeek','daysThisWeek','tradesRemainingThisHour']),prizes:[...prizes.filter((p:State)=>p.rank===1&&!p.claimedTitle),...prizes.filter((p:State)=>p.claimedTitle).slice(-3)]}};
}
function summaries(source:State){return {...(source.economyV7!==undefined?{economyV7:source.economyV7===null?null:compactEconomy(source.economyV7)}:{}),...(source.marketRegulation!==undefined?{marketRegulation:source.marketRegulation===null?null:compactMarket(source.marketRegulation)}:{}),...(source.whale!==undefined?{whale:source.whale===null?null:compactWhale(source.whale)}:{})};}
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
/** Decision hints use server fields only and never participate in eventVersion. */
export function decisionSummary(state:State,now=Date.now()):State{
 const me=state.me??{},parts:string[]=[],out:State={};
 if(typeof state.clock?.weather==='string'){out.weather=state.clock.weather;parts.push(`天气${state.clock.weather}`);}
 if(finite(me.energy)){out.energy=me.energy;parts.push(`体力${me.energy}`);}
 if(state.activeAction){out.busy=pick(state.activeAction,['id','type','endsAt','finishAt']);parts.push('当前有进行中的动作');}
 if(Array.isArray(state.plots)){
  const ready=state.plots.filter((plot:State)=>plot.crop&&!plot.busy&&(plot.mature===true||finite(plot.maturesAt)&&plot.maturesAt<=(finite(state.clock?.serverNow)?state.clock.serverNow:now)));
  out.crops={ready:ready.length,plotIds:ready.map((plot:State)=>plot.id).filter((id:unknown)=>typeof id==='string')};parts.push(`成熟待收${ready.length}块`);
 }
 if(Array.isArray(state.jobs)){
  const known=state.jobs.filter((job:State)=>finite(job.remaining)&&finite(job.fundedRemaining)&&finite(job.reward)&&finite(job.energy)&&typeof job.done==='boolean');
  const incomeRemaining=state.economyV7?.incomeRemaining;
  const candidates=known.filter((job:State)=>!state.activeAction&&finite(me.energy)&&me.energy>=job.energy&&(!finite(incomeRemaining)||job.reward<=incomeRemaining)&&!job.done&&!job.unavailableReason&&job.remaining>0&&job.fundedRemaining>0);
  const ready=candidates.filter((job:State)=>job.location===me.location),travel=candidates.filter((job:State)=>job.location!==me.location);
  out.work={readyHere:ready.map((job:State)=>job.id),needsTravel:travel.map((job:State)=>job.id),sharedBudget:true};
  if(finite(incomeRemaining))out.work.incomeRemaining=incomeRemaining;
  if(known.length!==state.jobs.length||!finite(me.energy))out.work.needsCheck=true;
  if(finite(state.economy?.workRemaining)){
   const funds=Math.max(0,state.economy.workRemaining);out.work.sharedFunds=funds;
   let spent=0,count=0;
   for(const job of [...candidates].sort((a:State,b:State)=>a.reward-b.reward)){if(job.reward<0||spent+job.reward>funds||finite(incomeRemaining)&&spent+job.reward>incomeRemaining)continue;spent+=job.reward;count++;}
   out.work.affordableTypesUpperBound=count;
  }
  parts.push(`这里可接${ready.length}类工作，换地点可考虑${travel.length}类（共用工资池，名额不相加${out.work.needsCheck?'；部分信息待查':''}）`);
 }
 if(state.housing||Array.isArray(state.houses)){
  const home=state.houses?.find((house:State)=>house.id===me.homeId),rent:State={};
  if(Array.isArray(state.housing?.invoices)){
   const unpaid=state.housing.invoices.filter((bill:State)=>bill.status==='UNPAID');rent.unpaidInvoices=unpaid.length;
   if(unpaid.every((bill:State)=>finite(bill.amount)&&bill.amount>=0))rent.unpaidAmount=unpaid.reduce((sum:number,bill:State)=>sum+bill.amount,0);
  }
  if(home?.tenantId===me.id&&!home.ownerId){if(finite(home.rent))rent.amount=home.rent;if(finite(home.leaseDueAt)&&Math.abs(home.leaseDueAt)<=8640000000000000)rent.nextDueAt=home.leaseDueAt;if(finite(home.graceAt))rent.graceStartedAt=home.graceAt;}
  if(Object.keys(rent).length){
   out.rent=rent;if(rent.unpaidAmount>0)parts.push(`未付租金${rent.unpaidAmount}花币`);
   if(rent.nextDueAt!==undefined){rent.due=rent.nextDueAt<=(finite(state.clock?.serverNow)?state.clock.serverNow:now);parts.push(`${rent.due?'租金账期已到':'下次租金'}${new Date(rent.nextDueAt).toISOString()}`);}
  }
 }
 return {summary:parts.join('；'),...out};
}
export function selectState(state:State,sections?:unknown):State{
 const source=normalized(state);
 if(sections===undefined)return {...pick(source,legacySections),...summaries(source)}; // Keep old unparameterized clients compatible.
 if(!Array.isArray(sections)||!sections.length||sections.length>stateSections.length+2||sections.some(s=>typeof s!=='string'||!['core','full',...stateSections].includes(s)))throw Error('sections须为有效状态章节数组');
 if(sections.includes('full'))return source;
 const keys=[...new Set(sections.flatMap(s=>s==='core'?[...coreSections]:[s]))];
 const projection=pick(source,keys);
 // Explicit chapters override their core summary, independent of requested order.
 if(sections.includes('core'))for(const [key,value]of Object.entries(summaries(source)))if(!sections.includes(key))projection[key]=value;
 return {...projection,...(sections.includes('core')?{decisionSummary:decisionSummary(source)}:{}),sectionsAvailable:stateSections.filter(key=>source[key]!==undefined),view:'selected',requestedSections:sections};
}
export function compactReceipt(result:State):State{return result?.state?.me?{...result,state:selectState(result.state,['core'])}:result;}
// Server clock ticks do not represent decisions. Crop maturity and turn transitions do.
export function eventVersion(state:State,now=Date.now()):State{
 const short=summaries(state),changes:State={};
 if(short.economyV7!==undefined)changes.economyV7=short.economyV7===null?null:pick(short.economyV7,['policy','earnedToday','incomeRemaining','pendingIncome','publicCustody']);
 if(short.marketRegulation!==undefined){const market=short.marketRegulation;changes.marketRegulation=market===null?null:{...pick(market,['policy','limits','transactionsUsedMinute','transactionsUsedHour','feeRule']),resources:pick(market.resources??{},['location','availableKinds','totalKinds'])};}
 if(short.whale!==undefined)changes.whale=short.whale===null?null:pick(short.whale,['joined','open','catchingUp','rules','stocks','me']);
 return {...pick(state,['me','chat','onboarding','activeAction','claims','botSafety','quiz','parlor','orders','trade','custody','shops','mailbox','visits','projects']),...changes,plots:state.plots?.map((p:{maturesAt?:number})=>({...p,mature:typeof p.maturesAt==='number'&&p.maturesAt<=now})),clock:pick(state.clock??{},['day','season','weather'])};
}
export function stateEvent(state:State,previous:State|null,version:State){
 const changedSections=Object.keys(version).filter(key=>!previous||JSON.stringify(version[key])!==JSON.stringify(previous[key]));
 if(!changedSections.length)return null;
 const core=selectState(state,['core']);
 return {trust:'server-state-with-untrusted-user-fields',mode:previous?'changes':'snapshot',changedSections,state:previous?{...pick(core,changedSections),sectionsAvailable:core.sectionsAvailable}:core,read:'Read changedSections with bloom_state({sections:["core",...changedSections]}) when needed. Omitted payloads do not mean empty or unchanged.'};
}
