'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {profile,suite,partition,guard,KINDS,LINES,status,lineCount,date,pair,items,category,fingerprint,withinTarget,withinRange}=require('../scripts/erpnext-benchmark/profile');
const {Stats,success}=require('../scripts/erpnext-benchmark/workload');
test('dedicated benchmark rejects application databases, source credentials and connection aliases',()=>{
  const valid={ERP_BENCHMARK:'1',POSTGRES_HOST:'benchmark-db',POSTGRES_DB:'work_master_erp_benchmark_hr_test',
    BENCHMARK_LANE:'stress',BENCHMARK_RUN_ID:'erp-stress-pilot-20261018-test'};
  assert.doesNotThrow(()=>guard(valid));
  for(const [key,value]of [['ERP_BENCHMARK',''],['POSTGRES_HOST','postgres'],['POSTGRES_DB','work_master'],['BENCHMARK_RUN_ID','../../prod'],
    ['BENCHMARK_RUN_ID','erp-pilot-20261018-test'],['BENCHMARK_LANE','production'],
    ['PGHOST','other'],['PGPORT','5433'],['PGDATABASE','work_master'],['PGUSER','app_user'],['PGPASSWORD','app_password'],
    ['POSTGRES_URL','postgresql://other/work_master'],['DATABASE_URL','postgresql://other/work_master'],['POSTGRES_RUNTIME_URL','postgresql://other/work_master'],
    ['POSTGRES_RUNTIME_USER','app_user'],['ERPNEXT_URL','https://source.invalid'],['ERPNEXT_USERNAME','source-user'],['ERPNEXT_PASSWORD','secret']])assert.throws(()=>guard({...valid,[key]:value}),key);
});
test('accuracy and stress profiles preserve targets, realistic invoice variation and deterministic partitions',()=>{
  const expected={
    'accuracy-pilot':[2000,20000],'accuracy-full':[100000,1000000],
    'stress-pilot':[10000,100000],'stress-full':[1000000,10000000]
  };
  for(const lane of Object.keys(suite.lanes))for(const mode of ['full','pilot']){
    const p=profile(mode,lane),key=lane+'-'+mode;
    assert.deepEqual([p.counts.invoices,p.counts.invoice_lines],expected[key]);
    assert.equal(p.invoice_lengths.total_lines,p.counts.invoice_lines);
    assert.equal(p.invoice_lengths.documents,p.counts.invoices);
    assert.ok(p.invoice_lengths.minimum>=3);
    assert.ok(Math.abs(p.invoice_lengths.mean-10)<=0.2);
    assert.ok(p.invoice_lengths.distinct_sizes>=3);
    assert.ok(p.invoice_lengths.maximum>10);
    assert.equal(p.invoice_lengths.histogram.reduce((sum,row)=>sum+row.documents,0),p.counts.invoices);
    assert.equal(p.invoice_lengths.histogram.reduce((sum,row)=>sum+row.size*row.documents,0),p.counts.invoice_lines);
    const invoiceItems=items(p,'invoices',0);
    assert.equal(new Set(invoiceItems.map(row=>row.warehouse)).size,1);
    for(const kind of KINDS){
      assert.equal(Object.values(p.statuses[kind]).reduce((a,b)=>a+b,0),p.counts[kind]);
      assert.ok(p.recent[kind]>=0&&p.recent[kind]<=p.counts[kind]);
      for(let n=0;n<Math.min(1000,p.counts[kind]);n++){
        const d=date(p,kind,n);assert.ok(d>=p.history_start&&d<=p.history_end);
      }
      assert.equal(fingerprint(p),fingerprint(profile(mode,lane)));
    }
    const pairs=new Set();for(let n=0;n<p.counts.bins;n++){const row=pair(p,n);pairs.add(row.item_code+'|'+row.warehouse);}
    assert.equal(pairs.size,p.counts.bins);
    for(let n=0;n<Math.min(p.counts.bins,1000);n++){const row=pair(p,n);assert.notEqual(row.warehouse,row.target_warehouse);assert.ok(pairs.has(row.item_code+'|'+row.target_warehouse));}
    for(let n=0;n<Math.min(100,p.counts.invoices);n++){
      const invoiceItems=items(p,'invoices',n);
      assert.equal(new Set(invoiceItems.map(row=>row.warehouse)).size,1);
      for(const row of invoiceItems)assert.ok(pairs.has(row.item_code+'|'+row.warehouse));
    }
    assert.equal(Object.values(p.journal_categories).reduce((a,b)=>a+b),p.counts.journals);
    assert.ok(category(p,p.counts.journals-1));
  }
  const stress=profile();
  assert.equal(stress.counts.invoices,1000000);
  assert.equal(stress.counts.invoice_lines,10000000);
  assert.equal(stress.targets.gl_rows,7500000);
  assert.equal(stress.targets.stock_ledger_rows,11900000);
  assert.deepEqual(stress.targets.ranges.invoice_items,{min:9900000,max:10100000});
  assert.deepEqual(stress.targets.ranges.gl_rows,{min:7350000,max:7650000});
  assert.deepEqual(stress.targets.ranges.stock_ledger_rows,{min:11662000,max:12138000});
  assert.throws(()=>profile('production'));
});
test('benchmark target tolerances accept approximate row counts and reject lower or padded upper values',()=>{
  assert.equal(withinTarget(9900000,10000000,.01),true);
  assert.equal(withinTarget(10100000,10000000,.01),true);
  assert.equal(withinTarget(9899999,10000000,.01),false);
  assert.equal(withinTarget(10100001,10000000,.01),false);
  assert.equal(withinTarget(10100001,10000000,.01,true),true);
  assert.equal(withinRange(10100000,{min:9900000,max:10100000}),true);
  assert.equal(withinRange(10100001,{min:9900000,max:10100000}),false);
  assert.equal(withinRange(10100001,{min:9900000,max:10100000},true),true);
});
test('rounding small partitions neither creates nor drops documents',()=>{
  assert.deepEqual(partition(1,{draft:7,submitted:234454,cancelled:2799}),{draft:0,submitted:1,cancelled:0});
  for(let n=0;n<100;n++)assert.equal(Object.values(partition(n,{a:3,b:7,c:1})).reduce((a,b)=>a+b),n);
});
test('HTTP validation rejects login/error redirects and unexpected mutation destinations',()=>{
  const target=/^\/invoices\/\d+$/;
  assert.equal(success(302,'/invoices/123',target),true);
  for(const [s,l]of [[200,'/invoices/123'],[302,'/login'],[302,'/invoices/123?error=failed'],[302,'https://outside.invalid/invoices/123'],[302,'/journals/123']])assert.equal(success(s,l,target),false);
  assert.equal(success(403,null,'deny'),true);assert.equal(success(200,null,'deny'),false);
  assert.equal(success(302,'/login','read'),false);
});
test('bounded latency histogram reports failures and percentile tails without retaining responses',()=>{
  const s=new Stats();for(let n=1;n<=100;n++)s.record(n,200,20,false);
  s.record(20000,503,0,true,'unexpected_response');
  assert.equal(s.json().requests,101);assert.equal(s.json().failed,1);assert.equal(s.json().p50_ms,51);
  assert.equal(s.json().p95_ms,96);assert.equal(s.json().p99_ms,100);assert.equal(s.percentile(1),20000);
});
