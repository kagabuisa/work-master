'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {profile,partition,guard,KINDS,LINES,status,lineCount,date,pair,category,fingerprint}=require('../scripts/erpnext-benchmark/profile');
const {Stats,success}=require('../scripts/erpnext-benchmark/workload');
test('dedicated benchmark rejects application databases, source credentials and connection aliases',()=>{
  const valid={ERP_BENCHMARK:'1',POSTGRES_HOST:'benchmark-db',POSTGRES_DB:'work_master_erp_benchmark_hr_test',BENCHMARK_RUN_ID:'erp-pilot-20261018-test'};
  assert.doesNotThrow(()=>guard(valid));
  for(const [key,value]of [['ERP_BENCHMARK',''],['POSTGRES_HOST','postgres'],['POSTGRES_DB','work_master'],['BENCHMARK_RUN_ID','../../prod'],
    ['PGHOST','other'],['PGPORT','5433'],['PGDATABASE','work_master'],['PGUSER','app_user'],['PGPASSWORD','app_password'],
    ['POSTGRES_URL','postgresql://other/work_master'],['DATABASE_URL','postgresql://other/work_master'],['POSTGRES_RUNTIME_URL','postgresql://other/work_master'],
    ['POSTGRES_RUNTIME_USER','app_user'],['ERPNEXT_URL','https://source.invalid'],['ERPNEXT_USERNAME','source-user'],['ERPNEXT_PASSWORD','secret']])assert.throws(()=>guard({...valid,[key]:value}),key);
});
test('full and pilot profiles preserve exact line/status/date partitions and unique stocked pairs',()=>{
  for(const mode of ['full','pilot']){
    const p=profile(mode);
    for(const kind of KINDS){
      let lines=0,recent=0;const statuses={draft:0,submitted:0,cancelled:0};
      for(let n=0;n<p.counts[kind];n++){
        lines+=lineCount(p,kind,n);statuses[status(p,kind,n)]++;
        const d=date(p,kind,n);assert.ok(d>=p.history_start&&d<=p.history_end);
        recent+=Number(d>=p.recent_start);
      }
      assert.equal(lines,p.counts[LINES[kind]],kind+' lines');assert.deepEqual(statuses,p.statuses[kind]);assert.equal(recent,p.recent[kind]);
    }
    const pairs=new Set();for(let n=0;n<p.counts.bins;n++){const row=pair(p,n);pairs.add(row.item_code+'|'+row.warehouse);}
    assert.equal(pairs.size,p.counts.bins);
    for(let n=0;n<p.counts.bins;n++){const row=pair(p,n);assert.notEqual(row.warehouse,row.target_warehouse);assert.ok(pairs.has(row.item_code+'|'+row.target_warehouse));}
    assert.equal(Object.values(p.journal_categories).reduce((a,b)=>a+b),p.counts.journals);
    assert.ok(category(p,p.counts.journals-1));
    assert.equal(fingerprint(p),fingerprint(profile(mode)));
  }
  assert.equal(profile().counts.invoices,237260);assert.equal(profile().counts.invoice_lines,2214223);
  assert.throws(()=>profile('production'));
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
