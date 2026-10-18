'use strict';
const crypto = require('node:crypto');
const source = require('./source-profile.json');
const KINDS = ['invoices','journals','purchases','stock','orders'];
const LINES = {invoices:'invoice_lines',journals:'journal_lines',purchases:'purchase_lines',stock:'stock_lines',orders:'order_lines'};
const pad = n => String(n).padStart(4,'0');
function integer(value, name, min, max) {
  const n=Number(value);
  if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return n;
}
function partition(total, weights) {
  const sum=Object.values(weights).reduce((a,b)=>a+b,0);
  if(!Number.isSafeInteger(total)||total<0||!sum)throw new Error('Invalid partition.');
  const rows=Object.entries(weights).map(([key,n])=>({key,n:Math.floor(total*n/sum),fraction:total*n/sum%1}));
  let left=total-rows.reduce((a,r)=>a+r.n,0);
  for(const row of [...rows].sort((a,b)=>b.fraction-a.fraction))if(left-->0)row.n++;
  return Object.fromEntries(rows.map(r=>[r.key,r.n]));
}
function profile(mode='full') {
  if(!['full','pilot'].includes(mode))throw new Error('Mode must be full or pilot.');
  const scale=mode==='pilot'?0.002:1;
  const counts={...source.counts};
  for(const kind of KINDS){counts[kind]=Math.max(1,Math.round(counts[kind]*scale));counts[LINES[kind]]=Math.round(counts[LINES[kind]]*scale);}
  if(mode==='pilot')Object.assign(counts,{customers:60,suppliers:15,items:60,warehouses:3,accounts:26,bins:180});
  const statuses=Object.fromEntries(KINDS.map(k=>[k,partition(counts[k],source.statuses[k])]));
  const recent=Object.fromEntries(KINDS.map(k=>[k,Math.round(counts[k]*(source.recent_counts[k]??source.recent_counts.invoices)/(source.counts[k]&&source.recent_counts[k]!==undefined?source.counts[k]:source.counts.invoices))]));
  return {...source,mode,scale,counts,statuses,recent,
    positive_outstanding:Math.round(source.submitted_positive_outstanding*scale),
    pos_flagged:Math.round(source.pos_flagged*scale),
    journal_categories:partition(counts.journals,source.journal_categories)};
}
function gcd(a,b){while(b)[a,b]=[b,a%b];return a;}
function rank(n,total){let multiplier=104729;while(gcd(multiplier,total)!==1)multiplier+=2;return (n*multiplier+Math.floor(total/2))%total;}
function status(p,kind,n){const r=rank(n,p.counts[kind]),s=p.statuses[kind];return r<s.draft?'draft':r<s.draft+s.cancelled?'cancelled':'submitted';}
function lineCount(p,kind,n){const N=p.counts[kind],L=p.counts[LINES[kind]];return Math.floor(L/N)+(n<L%N?1:0);}
function iso(day){return new Date(day*86400000).toISOString().slice(0,10);}
function day(value){return Math.floor(Date.parse(value+'T00:00:00Z')/86400000);}
function date(p,kind,n){const old=p.counts[kind]-p.recent[kind],recent=n>=old;
  const start=day(recent?p.recent_start:p.history_start),end=day(recent?p.history_end:'2021-10-17');
  return iso(start+(n*7919)%(end-start+1));}
function pair(p,n){const {items,warehouses,bins}=p.counts;n=((n%bins)+bins)%bins;const item=n%items,round=Math.floor(n/items);
  return {item_code:`EB-I-${pad(item+1)}`,item_name:`Benchmark Item ${pad(item+1)}`,warehouse:`EB Warehouse ${pad((item+round)%warehouses+1)}`,
    target_warehouse:`EB Warehouse ${pad((item+(round+1)%Math.ceil((bins-item)/items))%warehouses+1)}`};}
function items(p,kind,n,lines=lineCount(p,kind,n)) {return Array.from({length:lines},(_,i)=>({...pair(p,n*53+i),quantity:1,unit_price:kind==='purchases'||kind==='orders'?9000:15000,valuation_rate:9000}));}
function category(p,n){for(const [key,count]of Object.entries(p.journal_categories)){if(n<count)return key;n-=count;}throw new Error('Category index out of range.');}
function fingerprint(p){return crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex');}
function guard(env=process.env){
  if(env.ERP_BENCHMARK!=='1'||env.POSTGRES_HOST!=='benchmark-db'||env.POSTGRES_DB!=='work_master_erp_benchmark_hr_test')throw new Error('Dedicated ERP benchmark database and opt-in required.');
  for(const key of ['PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','POSTGRES_URL','DATABASE_URL','POSTGRES_RUNTIME_URL','POSTGRES_RUNTIME_USER','ERPNEXT_URL','ERPNEXT_USERNAME','ERPNEXT_PASSWORD'])if(env[key])throw new Error(`Benchmark forbids connection override ${key}.`);
  if(!env.BENCHMARK_RUN_ID||!/^erp-(pilot|full)-[a-zA-Z0-9-]+$/.test(env.BENCHMARK_RUN_ID))throw new Error('Invalid benchmark run identifier.');
}
module.exports={source,profile,partition,rank,status,lineCount,date,pair,items,category,fingerprint,guard,integer,KINDS,LINES,pad};
