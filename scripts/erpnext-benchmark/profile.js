'use strict';
const crypto = require('node:crypto');
const source = require('./source-profile.json');
const suite = require('./benchmark-profiles.json');
const KINDS = ['invoices','journals','purchases','stock','orders'];
const LINES = {invoices:'invoice_lines',journals:'journal_lines',purchases:'purchase_lines',stock:'stock_lines',orders:'order_lines'};
const LANES = Object.keys(suite.lanes);
const VARIANTS = ['pilot','full'];
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
function allocateDocuments(documents, weighted) {
  const sum=weighted.reduce((total,row)=>total+row.weight,0);
  const rows=weighted.map(row=>({size:row.size,count:Math.floor(documents*row.weight/sum),
    fraction:documents*row.weight/sum%1}));
  let left=documents-rows.reduce((total,row)=>total+row.count,0);
  for(const row of [...rows].sort((a,b)=>b.fraction-a.fraction))if(left-->0)row.count++;
  return rows;
}
function adjustLineTotal(rows, targetLines, minimum) {
  let actual=rows.reduce((total,row)=>total+row.size*row.count,0);
  let remaining=targetLines-actual;
  const initialDifference=Math.abs(remaining);
  let guard=0;
  while(remaining!==0) {
    if(++guard>Math.max(10000,initialDifference*2))throw new Error('Unable to normalize invoice line distribution.');
    const candidates=rows.map((row,index)=>({row,index}))
      .filter(({row}) => row.count>0 && (remaining>0?row.size<suite.invoice_length_model.maximum:row.size>minimum));
    if(!candidates.length)throw new Error('Invoice line target is outside the configured distribution range.');
    candidates.sort((a,b)=>b.row.count-a.row.count||a.row.size-b.row.size);
    const {row,index}=candidates[0];
    const destination=rows[index+(remaining>0?1:-1)];
    row.count--;
    destination.count++;
    remaining+=remaining>0?-1:1;
  }
}
function invoiceLengthDistribution(documents, targetLines, minimum=suite.minimum_invoice_items) {
  if(!Number.isSafeInteger(documents)||documents<1||!Number.isSafeInteger(targetLines)||targetLines<documents*minimum) {
    throw new Error('Invalid invoice-line distribution totals.');
  }
  const model=suite.invoice_length_model;
  const mean=Number(model.raw_mean??model.mean);
  const dispersion=Number(model.dispersion);
  const maximum=Math.max(integer(model.maximum,'invoice-line maximum',minimum,1000),
    Math.ceil(targetLines/documents)+minimum*2);
  if(!(mean>minimum)||!(dispersion>0))throw new Error('Invalid invoice-line distribution model.');
  const probability=dispersion/(dispersion+mean);
  const weighted=[];
  let mass=Math.pow(probability,dispersion);
  for(let size=0;size<=maximum;size++) {
    if(size>=minimum)weighted.push({size,weight:mass});
    mass*=((size+dispersion)/(size+1))*(1-probability);
  }
  if(!weighted.some(row=>row.weight>0))throw new Error('Invoice-line distribution has no usable weights.');
  const rows=allocateDocuments(documents,weighted);
  adjustLineTotal(rows,targetLines,minimum);
  const totalLines=rows.reduce((total,row)=>total+row.size*row.count,0);
  const totalDocuments=rows.reduce((total,row)=>total+row.count,0);
  if(totalLines!==targetLines||totalDocuments!==documents)throw new Error('Invoice-line distribution totals do not match the benchmark profile.');
  let end=0;
  const segments=rows.filter(row=>row.count>0).map(row=>{
    end+=row.count;
    return {size:row.size,end,count:row.count};
  });
  const histogram=rows.filter(row=>row.count>0).map(row=>({size:row.size,documents:row.count}));
  const targetMean=targetLines/documents;
  let weightedSquare=0;
  for(const row of rows)weightedSquare+=row.count*(row.size-targetMean)**2;
  return {documents,total_lines:totalLines,minimum,maximum:segments.at(-1).size,mean:targetMean,
    variance:weightedSquare/documents,distinct_sizes:segments.length,segments,histogram,
    model:{type:model.type,mean,dispersion,maximum:model.maximum}};
}
function profile(variant='full', lane='stress') {
  if(!VARIANTS.includes(variant)||!LANES.includes(lane))throw new Error('Profile mode must be pilot/full and lane must be accuracy/stress.');
  const laneProfile=suite.lanes[lane];
  const definition=laneProfile[variant];
  const fullDefinition=laneProfile.full;
  const counts={...definition.counts};
  const invoice_lengths=invoiceLengthDistribution(counts.invoices,counts.invoice_lines);
  for(const kind of KINDS) {
    const expected=counts[LINES[kind]];
    if(!Number.isSafeInteger(expected)||expected<counts[kind])throw new Error(`${LINES[kind]} must provide at least one line per ${kind} document.`);
  }
  const statuses=Object.fromEntries(KINDS.map(kind=>[kind,partition(counts[kind],source.statuses[kind])]));
  const recent=Object.fromEntries(KINDS.map(kind=>{
    const share=(source.recent_counts[kind]??0)/source.counts[kind];
    return [kind,Math.round(counts[kind]*share)];
  }));
  const scale=counts.invoices/suite.lanes.stress.full.counts.invoices;
  const laneScale=counts.invoices/fullDefinition.counts.invoices;
  const range=(target,tolerance)=>({min:Math.ceil(target*(1-tolerance)),max:Math.floor(target*(1+tolerance))});
  return {...source,version:suite.version,lane,mode:variant,scale,lane_scale:laneScale,counts,statuses,recent,
    positive_outstanding:Math.round(source.submitted_positive_outstanding*scale),
    pos_flagged:Math.round(source.pos_flagged*scale),
    journal_categories:partition(counts.journals,source.journal_categories),
    invoice_lengths,
    targets:{
      invoices:counts.invoices,
      invoice_items:counts.invoice_lines,
      average_invoice_items:counts.invoice_lines/counts.invoices,
      gl_rows:counts.gl_rows,
      stock_ledger_rows:counts.stock_ledger_rows,
      tolerances:suite.tolerances,
      ranges:{
        invoices:range(counts.invoices,suite.tolerances.invoices),
        invoice_items:range(counts.invoice_lines,suite.tolerances.invoice_items),
        gl_rows:range(counts.gl_rows,suite.tolerances.gl_rows),
        stock_ledger_rows:range(counts.stock_ledger_rows,suite.tolerances.stock_ledger_rows)
      }
    },
    source_counts:{...source.counts},
    lane_description:laneProfile.description,
    assumptions:[...source.assumptions,
      `Benchmark v2 ${lane} lane uses deterministic correlated synthetic data; it is not a copy of ERPNext business records.`,
      `Invoice lengths use a ${suite.invoice_length_model.type} distribution with a ${suite.minimum_invoice_items}-item minimum and an aggregate target of ${suite.invoice_length_model.mean} items per invoice.`,
      'GL and stock-ledger row targets are approximate stress targets and must be produced by valid document lifecycles, never padding.']};
}
function gcd(a,b){while(b)[a,b]=[b,a%b];return a;}
function rank(n,total){let multiplier=104729;while(gcd(multiplier,total)!==1)multiplier+=2;return (n*multiplier+Math.floor(total/2))%total;}
function status(p,kind,n){const r=rank(n,p.counts[kind]),s=p.statuses[kind];return r<s.draft?'draft':r<s.draft+s.cancelled?'cancelled':'submitted';}
function invoiceLineCount(p,n){const index=rank(n,p.counts.invoices);for(const segment of p.invoice_lengths.segments)if(index<segment.end)return segment.size;
  throw new Error('Invoice length rank out of range.');}
function lineCount(p,kind,n){if(kind==='invoices')return invoiceLineCount(p,n);const N=p.counts[kind],L=p.counts[LINES[kind]];return Math.floor(L/N)+(n<L%N?1:0);}
function iso(day){return new Date(day*86400000).toISOString().slice(0,10);}
function day(value){return Math.floor(Date.parse(value+'T00:00:00Z')/86400000);}
function date(p,kind,n){const old=p.counts[kind]-p.recent[kind],recent=n>=old;
  const start=day(recent?p.recent_start:p.history_start),end=day(recent?p.history_end:'2021-10-17');
  return iso(start+(n*7919)%(end-start+1));}
function pair(p,n){const {items,warehouses,bins}=p.counts;n=((n%bins)+bins)%bins;const item=n%items,round=Math.floor(n/items);
  return {item_code:`EB-I-${pad(item+1)}`,item_name:`Benchmark Item ${pad(item+1)}`,warehouse:`EB Warehouse ${pad((item+round)%warehouses+1)}`,
    target_warehouse:`EB Warehouse ${pad((item+(round+1)%Math.ceil((bins-item)/items))%warehouses+1)}`};}
const invoiceStockCache=new WeakMap();
function invoiceStockPairs(p){
  if(invoiceStockCache.has(p))return invoiceStockCache.get(p);
  const pairs=Array.from({length:p.counts.warehouses},()=>[]);
  for(let n=0;n<p.counts.bins;n++){
    const row=pair(p,n);
    pairs[(Number(row.warehouse.slice(-4))-1)%p.counts.warehouses].push(row);
  }
  if(pairs.some(rows=>!rows.length))throw new Error('Every benchmark warehouse needs opening stock pairs.');
  invoiceStockCache.set(p,pairs);
  return pairs;
}
function items(p,kind,n,lines=lineCount(p,kind,n)) {
  if(kind==='invoices'){
    const available=invoiceStockPairs(p)[n%p.counts.warehouses];
    return Array.from({length:lines},(_,i)=>{
      const row=available[(n*53+i)%available.length];
      return {item_code:row.item_code,item_name:row.item_name,warehouse:row.warehouse,
        quantity:1,unit_price:15000,valuation_rate:9000};
    });
  }
  const warehouse=pair(p,n).warehouse;
  return Array.from({length:lines},(_,i)=>({...pair(p,n*53+i),
    ...(kind==='stock'?{}:{warehouse,target_warehouse:undefined}),
    quantity:1,unit_price:kind==='purchases'||kind==='orders'?9000:15000,valuation_rate:9000}));
}
function category(p,n){for(const [key,count]of Object.entries(p.journal_categories)){if(n<count)return key;n-=count;}throw new Error('Category index out of range.');}
function fingerprint(p){return crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex');}
function guard(env=process.env){
  if(env.ERP_BENCHMARK!=='1'||env.POSTGRES_HOST!=='benchmark-db'||env.POSTGRES_DB!=='work_master_erp_benchmark_hr_test')throw new Error('Dedicated ERP benchmark database and opt-in required.');
  if(!LANES.includes(env.BENCHMARK_LANE||'stress'))throw new Error('Benchmark lane must be accuracy or stress.');
  for(const key of ['PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','POSTGRES_URL','DATABASE_URL','POSTGRES_RUNTIME_URL','POSTGRES_RUNTIME_USER','ERPNEXT_URL','ERPNEXT_USERNAME','ERPNEXT_PASSWORD'])if(env[key])throw new Error(`Benchmark forbids connection override ${key}.`);
  if(!env.BENCHMARK_RUN_ID||!/^erp-(accuracy|stress)-(pilot|full)-[a-zA-Z0-9-]+$/.test(env.BENCHMARK_RUN_ID))throw new Error('Invalid benchmark run identifier.');
}
function withinTarget(actual,target,tolerance,allowAbove=false){
  if(!Number.isFinite(actual)||!Number.isFinite(target)||target<0||tolerance<0)throw new Error('Invalid benchmark target comparison.');
  if(actual<target*(1-tolerance))return false;
  return allowAbove||actual<=target*(1+tolerance);
}
function withinRange(actual,range,allowAbove=false){
  if(!Number.isFinite(actual)||!range||!Number.isSafeInteger(range.min)||!Number.isSafeInteger(range.max)||range.min>range.max)throw new Error('Invalid benchmark range comparison.');
  return actual>=range.min&&(allowAbove||actual<=range.max);
}
module.exports={source,suite,profile,invoiceLengthDistribution,partition,rank,status,lineCount,invoiceLineCount,date,pair,items,category,
  fingerprint,guard,integer,withinTarget,withinRange,KINDS,LINES,LANES,VARIANTS,pad};
