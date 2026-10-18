'use strict';
const {pad}=require('./profile');
const state=require('./state');
const base='http://127.0.0.1:3020';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
class Stats {
  constructor(){this.n=0;this.failed=0;this.bytes=0;this.total_ms=0;this.statuses={};this.errors={};this.bins=new Uint32Array(18001);}
  record(ms,status,bytes,failed,error){this.n++;this.failed+=Number(failed);this.bytes+=bytes;this.total_ms+=ms;
    if(status)this.statuses[status]=(this.statuses[status]||0)+1;if(error)this.errors[error]=(this.errors[error]||0)+1;
    this.bins[Math.min(18000,ms<=10000?Math.ceil(ms):ms<=60000?10000+Math.ceil((ms-10000)/10):15000+Math.ceil((ms-60000)/100))]++;}
  percentile(fraction){let n=0;for(let i=0;i<this.bins.length;i++){n+=this.bins[i];if(n>=Math.ceil(this.n*fraction))return i<=10000?i:i<=15000?10000+(i-10000)*10:60000+(i-15000)*100;}return 0;}
  json(){return {requests:this.n,failed:this.failed,response_bytes:this.bytes,statuses:this.statuses,errors:this.errors,
    p50_ms:this.percentile(.5),p95_ms:this.percentile(.95),p99_ms:this.percentile(.99),mean_ms:this.n?Math.round(this.total_ms/this.n):0};}
}
function success(status,location,expected) {
  if(expected==='read')return status===200;
  if(expected==='deny')return status===403||status===404;
  if(!(status===302||status===303)||!location)return false;
  const u=new URL(location,base);
  return u.origin===base&&!u.searchParams.has('error')&&expected.test(u.pathname)&&!u.pathname.startsWith('/login');
}
async function request(user,label,path,body,stats,expected=body?/^\/(invoices|journals|purchases|purchase-orders)\/\d+$/: 'read',signal) {
  let status=0,bytes=0,failed=true,error,location;const started=performance.now();
  try {
    const response=await fetch(base+path,{method:body?'POST':'GET',body,headers:user?.cookie?{cookie:user.cookie}:{},redirect:'manual',
      signal:signal?AbortSignal.any([signal,AbortSignal.timeout(90000)]):AbortSignal.timeout(90000)});
    status=response.status;location=response.headers.get('location');
    if(response.body)for await(const chunk of response.body)bytes+=chunk.byteLength;
    failed=!success(status,location,expected);
    if(failed)error='unexpected_response';
  }catch(e){error=e.name;}
  const ms=performance.now()-started;
  if(stats){const key=(user?.role||'system')+'/'+label;if(!stats.has(key))stats.set(key,new Stats());stats.get(key).record(ms,status,bytes,failed,error);}
  if(failed){const e=new Error('Benchmark request failed: '+label);e.details={label,status,error};throw e;}
  return {status,location,id:location?Number(new URL(location,base).pathname.split('/').pop()):null};
}
async function login(actor,password,stats,signal) {
  const started=performance.now();let status=0,cookie;
  try {
    const response=await fetch(base+'/login',{method:'POST',body:new URLSearchParams({username:actor.username,password}),redirect:'manual',signal:AbortSignal.timeout(60000)});
    status=response.status;await response.arrayBuffer();cookie=response.headers.getSetCookie().find(v=>v.startsWith('wm_session='))?.split(';')[0];
    if(![302,303].includes(status)||!cookie||new URL(response.headers.get('location')||'/login',base).pathname.startsWith('/login'))throw new Error('Login failed');
    return {...actor,cookie};
  } finally {if(stats){if(!stats.has('login'))stats.set('login',new Stats());stats.get('login').record(performance.now()-started,status,0,!cookie,!cookie?'login_failed':null);}signal?.throwIfAborted();}
}
function formLines(body,lines,fields){for(const line of lines)for(const field of fields)body.append(field,String(line[field]??''));return body;}
function invoiceBody(p,user,lines,action,key,today){return new URLSearchParams({action,invoice_date:today,posting_time:'23:59',due_date:today,
  customer_id:`EB-C-${pad(user.ordinal%p.counts.customers+1)}`,customer_name:`Benchmark Customer ${pad(user.ordinal%p.counts.customers+1)}`,
  invoicer_id:user.record_access.employee_id,invoicer:'Benchmark Employee',warehouse:lines[0].warehouse,price_list:'EB Retail',cost_center:'EB Main',
  notes:key,items_json:JSON.stringify(lines),cash_sale_account_id:String(user.cash),cash_sale_method:'cash'});}
function chooseLines(ctx,user,n,count,shared=false){
  const warehouse=shared?'EB Warehouse 0001':ctx.warehouses[(user.ordinal+n)%ctx.warehouses.length];
  const pairs=ctx.pairs.get(warehouse);return Array.from({length:count},(_,i)=>({...pairs[(shared?i:n*7+i+user.ordinal)%pairs.length],quantity:1,unit_price:15000}));
}
async function operation(p,ctx,user,n,stats,signal,{forced,shared=false}={}) {
  signal?.throwIfAborted();
  const type=forced||['list','search','detail','ledger','stock-ledger','draft','cash-sale','credit-payment','journal','transfer','list','detail','search','ledger','draft','cash-sale','purchase','order','trial-balance','list'][n%20];
  const key=`ERP-BENCH:traffic:${process.env.BENCHMARK_RUN_ID}:${ctx.phase}:${user.ordinal}:${n}`;
  const today=ctx.today,from=new Date(Date.parse(today+'T00:00:00Z')-30*86400000).toISOString().slice(0,10);
  const length=[1,5,10,20,50][Math.floor(n/20)%5],lines=chooseLines(ctx,user,n,length,shared);
  const req=(label,path,body,expected)=>request(user,label,path,body,stats,expected,signal);
  if(type==='list')return req('invoice-list','/invoices');
  if(type==='search')return req('invoice-search','/invoices?q='+encodeURIComponent(n%2?'INV-000':'Benchmark Customer '+pad((n%p.counts.customers)+1)));
  if(type==='detail')return req('invoice-detail','/invoices/'+user.invoice_id);
  if(type==='ledger')return req('ledger-recent','/reports/general-ledger?'+new URLSearchParams({from,to:today}));
  if(type==='stock-ledger')return req('stock-ledger-recent','/reports/stock-ledger?'+new URLSearchParams({from,to:today,warehouse:lines[0].warehouse}));
  if(type==='trial-balance')return req('trial-balance','/reports/trial-balance?'+new URLSearchParams({from,to:today}));
  if(['draft','cash-sale','credit-payment'].includes(type)) {
    const action=type==='draft'?'save_draft':type==='cash-sale'?'cash_sale':'submit_invoice';
    const result=await req(`${type}/${length}-lines`,'/invoices',invoiceBody(p,user,lines,action,key,today));
    if(type==='credit-payment')await req('invoice-payment','/invoices/'+result.id+'/payments',new URLSearchParams({payment_date:today,amount:String(length*15000),account_id:String(user.cash),notes:key}));
    return result;
  }
  if(type==='journal') {
    const b=new URLSearchParams({journal_type:'journal_entry',posting_date:today,posting_time:'23:59',cost_center:'EB Main',remarks:key});
    for(const [i,id]of ctx.manualAccounts.slice(0,2).entries()){b.append('account_id',String(id));b.append('debit',i?'0':'1000');b.append('credit',i?'1000':'0');}
    return req('journal-post','/journals',b);
  }
  if(type==='transfer') {
    const row={...lines[0],target_warehouse:ctx.warehouses[(ctx.warehouses.indexOf(lines[0].warehouse)+1)%ctx.warehouses.length],valuation_rate:9000};
    const b=new URLSearchParams({entry_type:'transfer',action:'submit',posting_date:today,posting_time:'23:59',cost_center:'EB Main',remarks:key});
    formLines(b,[row],['item_code','item_name','warehouse','target_warehouse','quantity','valuation_rate']);
    return req('stock-transfer','/stock/entries',b,/^\/stock\/entries$/);
  }
  const order=type==='order',b=new URLSearchParams({posting_date:today,posting_time:'23:59',due_date:today,supplier_id:`EB-S-${pad(user.ordinal%p.counts.suppliers+1)}`,price_list:'EB Buying',cost_center:'EB Main',remarks:key,supplier_reference:key});
  const buyLines=lines.slice(0,4).map(row=>({...row,unit_price:9000}));
  if(order)b.set('warehouse',lines[0].warehouse);
  formLines(b,buyLines,order?['item_code','item_name','quantity','unit_price']:['item_code','item_name','warehouse','quantity','unit_price']);
  const path=order?'/purchase-orders':'/purchases',created=await req(order?'order-draft':'purchase-draft',path,b);
  return req(order?'order-submit':'purchase-submit',path+'/'+created.id+'/submit',new URLSearchParams());
}

async function prepare(p,ctx,signal) {
  ctx.today=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Kampala',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  ctx.pairs=new Map();
  for(const row of(await ctx.pool.query('SELECT item_code,item_name,warehouse FROM app_stock_balances WHERE quantity>100 ORDER BY warehouse,item_code')).rows){
    if(!ctx.pairs.has(row.warehouse))ctx.pairs.set(row.warehouse,[]);ctx.pairs.get(row.warehouse).push(row);}
  ctx.warehouses=[...ctx.pairs.keys()];ctx.phase='checks';
  if(ctx.warehouses.length<2)throw new Error('Concurrency workload requires at least two stocked warehouses.');
  const credentials=state.read('credentials.json'),stats=new Map();
  const results=await Promise.allSettled(ctx.actors.map((actor,ordinal)=>login({...actor,ordinal,cash:ctx.settings.cash},credentials.password,stats,signal)));
  const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason;
  ctx.users=results.map(r=>r.value);
  const visible=(await ctx.pool.query(`SELECT DISTINCT ON(created_by_user_id) created_by_user_id,id FROM app_invoices WHERE docstatus='submitted' ORDER BY created_by_user_id,id`)).rows;
  for(const user of ctx.users){user.invoice_id=visible.find(r=>r.created_by_user_id===String(user.id))?.id;
    if(!user.invoice_id)throw new Error('Every test account needs a visible historical invoice.');}
  const normal=ctx.users[5],hidden=ctx.users[0].invoice_id;
  await request(normal,'deny-other-owner','/invoices/'+hidden,null,stats,'deny',signal);
  await request(ctx.users[54],'deny-report','/reports/general-ledger',null,stats,'deny',signal);
  await request(ctx.users[0],'ledger-history','/reports/general-ledger?'+new URLSearchParams({from:p.history_start,to:p.history_end}),null,stats,'read',signal);
  // Deterministic checks ensure every write class is exercised, even in a short pilot.
  for(const [n,type]of ['list','search','detail','ledger','stock-ledger','draft','cash-sale','credit-payment','journal','transfer','purchase','order','trial-balance'].entries())
    await operation(p,ctx,normal,n,stats,signal,{forced:type});
  const report=Object.fromEntries([...stats].map(([key,s])=>[key,s.json()]));state.write('http-checks.json',report);
  state.event({event:'http_checks_passed',checks:Object.keys(report).length,distinct_accounts:ctx.users.length});
}

async function phase(p,ctx,concurrency,name,duration,think,signal,shared) {
  ctx.phase=`${concurrency}-${name}`;
  state.diskGuard(p.mode);
  state.progress('concurrency',{users:concurrency,phase:name,duration_seconds:duration,shared_items:shared});
  const stats=new Map(),failures=[];let transactions=0,failed=0;
  const password=state.read('credentials.json').password;
  const admins=Math.max(1,Math.round(concurrency/10));
  const selected=[...ctx.users.filter(u=>u.role==='admin').slice(0,admins),...ctx.users.filter(u=>u.role==='standard').slice(0,concurrency-admins)];
  if(selected.length!==concurrency)throw new Error('Not enough distinct accounts for this concurrency stage.');
  const loginResults=await Promise.allSettled(selected.map(u=>login(u,password,stats,signal)));
  const loginFailure=loginResults.find(r=>r.status==='rejected');if(loginFailure)throw loginFailure.reason;
  const users=loginResults.map(r=>r.value),started=performance.now(),deadline=started+duration*1000;
  const workers=users.map(async user=>{let n=user.ordinal;
    while(performance.now()<deadline){signal?.throwIfAborted();try{await operation(p,ctx,user,n,stats,signal,{shared});}catch(e){failed++;if(failures.length<20)failures.push(e.details||{error:e.name});}
      transactions++;n++;
      if(think)await sleep(500+(n*37)%1000);
    }
  });
  const outcomes=await Promise.allSettled(workers),failure=outcomes.find(r=>r.status==='rejected');if(failure)throw failure.reason;
  const elapsed=(performance.now()-started)/1000;
  const result={users:concurrency,admin_accounts:admins,standard_accounts:concurrency-admins,name,shared_items:shared,think_time_ms:think?[500,1499]:0,target_duration_seconds:duration,elapsed_seconds:+elapsed.toFixed(2),
    transactions,failed_transactions:failed,transactions_per_second:+(transactions/elapsed).toFixed(2),
    operations:Object.fromEntries([...stats].map(([key,s])=>[key,s.json()])),failure_examples:failures,
    percentile_resolution:'1 ms below 10 s, 10 ms below 60 s, 100 ms thereafter; client deadline 90 s'};
  state.write(`phase-${concurrency}-${name}.json`,result);state.event({event:'phase_complete',users:concurrency,name,transactions,failed});
  return result;
}
async function exports(p,ctx,signal){
  const stats=new Map(),admin=await login(ctx.users[0],state.read('credentials.json').password,null,signal);
  const end=ctx.today,failures=[];
  for(const [label,format,from]of [['full-history-csv','csv',p.history_start],['daily-xlsx','xlsx',end],['daily-pdf','pdf',end]]){
    try{await request(admin,label,'/reports/general-ledger?'+new URLSearchParams({from,to:end,format}),null,stats,'read',signal);}
    catch(e){failures.push(e.details||{label,error:e.name});signal?.throwIfAborted();}
  }
  const report={passed:failures.length===0,operations:Object.fromEntries([...stats].map(([name,s])=>[name,s.json()])),failures};state.write('exports.json',report);return report;
}
async function run(p,ctx,signal) {
  await prepare(p,ctx,signal);
  const results=[];
  for(const users of [10,20,50]){
    const pilot=p.mode==='pilot';
    results.push(await phase(p,ctx,users,'warmup',pilot?2:60,true,signal,false));
    results.push(await phase(p,ctx,users,'sustained',pilot?8:users===50?1500:900,true,signal,false));
    results.push(await phase(p,ctx,users,'burst-shared',pilot?4:180,false,signal,true));
  }
  const downloads=await exports(p,ctx,signal);
  const result={at:new Date().toISOString(),mode:p.mode,passed:results.every(r=>r.failed_transactions===0)&&downloads.passed,phases:results,exports:downloads,
    scope:'Real HTTP requests with distinct authenticated accounts; no browser rendering or external network simulation. Warmup is reported separately.'};
  state.write('workload.json',result);return result;
}
module.exports={Stats,success,request,login,operation,prepare,phase,run,chooseLines};
