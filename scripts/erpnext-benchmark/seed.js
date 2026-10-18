'use strict';
const crypto=require('node:crypto');
const {guard,fingerprint,KINDS,LINES,pad,status,lineCount,date,pair,items,category,rank,integer}=require('./profile');
const state=require('./state');
const TABLES={invoices:['app_invoices','notes'],journals:['app_journal_entries','remarks'],purchases:['app_purchases','remarks'],stock:['app_stock_entries','remarks'],orders:['app_purchase_orders','remarks']};
const prefix='ERP-BENCH:seed:';

async function bootstrap(p) {
  guard();
  const store=require('../../src/store'),pool=store.getPostgresPool();
  const actual=(await pool.query('SELECT current_database() AS name')).rows[0].name;
  if(actual!==process.env.POSTGRES_DB)throw new Error('Actual database does not match the benchmark database.');
  const lock=await pool.connect();
  if(!(await lock.query("SELECT pg_try_advisory_lock(hashtext('erp-benchmark-generator')) AS locked")).rows[0].locked){lock.release();throw new Error('Another benchmark generator is already running.');}
  try {
    const marker=(await pool.query("SELECT to_regclass('wm_benchmark_fixture') AS marker,to_regclass('app_invoices') AS app")).rows[0];
    if(!marker.marker&&marker.app)throw new Error('Refusing a pre-existing application database without a benchmark marker.');
    await pool.query(`CREATE TABLE IF NOT EXISTS wm_benchmark_fixture (id int PRIMARY KEY CHECK(id=1),fingerprint text NOT NULL,run_id text NOT NULL,mode text NOT NULL,created_at timestamptz DEFAULT now())`);
    await pool.query('INSERT INTO wm_benchmark_fixture(id,fingerprint,run_id,mode) VALUES(1,$1,$2,$3) ON CONFLICT DO NOTHING',[fingerprint(p),process.env.BENCHMARK_RUN_ID,p.mode]);
    const saved=(await pool.query('SELECT * FROM wm_benchmark_fixture WHERE id=1')).rows[0];
    if(saved.fingerprint!==fingerprint(p)||saved.run_id!==process.env.BENCHMARK_RUN_ID||saved.mode!==p.mode)throw new Error('Retained fixture belongs to a different run or profile.');
    await store.initStore();
    const controlled=(await pool.query('SELECT wm_inventory_enabled() AS enabled')).rows[0].enabled;
    if(controlled)throw new Error('Historical generator requires the default legacy inventory mode; no control setting was changed.');
    for(const [kind,[table,column]]of Object.entries(TABLES)) {
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS wm_benchmark_${kind}_key ON ${table}(${column}) WHERE ${column} LIKE 'ERP-BENCH:seed:%'`);
    }
    return {store,pool,release:()=>lock.release()};
  } catch(e){lock.release();throw e;}
}

async function masters(p,pool) {
  const {customers,suppliers,items:countItems,warehouses,accounts,users,enabled_users}=p.counts;
  await pool.query(`INSERT INTO app_master_customers(customer_id,customer_name,customer_group,docstatus)
    SELECT 'EB-C-'||lpad(n::text,4,'0'),'Benchmark Customer '||lpad(n::text,4,'0'),CASE WHEN n%3=0 THEN 'Wholesale' ELSE 'Retail' END,'submitted'
    FROM generate_series(1,$1::int)n ON CONFLICT DO NOTHING`,[customers]);
  await pool.query(`INSERT INTO app_master_suppliers(supplier_id,supplier_name,supplier_type,docstatus)
    SELECT 'EB-S-'||lpad(n::text,4,'0'),'Benchmark Supplier '||lpad(n::text,4,'0'),'Local','submitted'
    FROM generate_series(1,$1::int)n ON CONFLICT DO NOTHING`,[suppliers]);
  await pool.query(`INSERT INTO app_master_items(item_code,item_name,stock_uom,default_rate,unit_cost,category,docstatus)
    SELECT 'EB-I-'||lpad(n::text,4,'0'),'Benchmark Item '||lpad(n::text,4,'0'),'Each',15000,9000,'Category '||(n%20),'submitted'
    FROM generate_series(1,$1::int)n ON CONFLICT DO NOTHING`,[countItems]);
  await pool.query(`INSERT INTO app_master_warehouses(warehouse,docstatus)
    SELECT 'EB Warehouse '||lpad(n::text,4,'0'),'submitted' FROM generate_series(1,$1::int)n ON CONFLICT DO NOTHING`,[warehouses]);
  await pool.query(`INSERT INTO app_master_price_lists(price_list,currency,price_type,pricelist_type,active,docstatus)
    VALUES('EB Retail','UGX','selling','Retail',1,'submitted'),('EB Buying','UGX','buying',NULL,1,'submitted') ON CONFLICT DO NOTHING;
    INSERT INTO app_master_cost_centers(cost_center,cost_center_name,docstatus) VALUES('EB Main','Benchmark Main','submitted') ON CONFLICT DO NOTHING;`);
  await pool.query(`INSERT INTO app_master_employees(employee_id,employee_name,status,docstatus)
    SELECT 'EB-E-'||lpad(n::text,4,'0'),'Benchmark Employee '||n,'Active','submitted' FROM generate_series(1,$1::int)n ON CONFLICT DO NOTHING`,[enabled_users]);
  const defaults=Number((await pool.query("SELECT count(*) n FROM app_accounts WHERE account_code NOT LIKE 'EBA-%'")).rows[0].n);
  if(defaults>accounts)throw new Error('Default account count exceeds the planned profile.');
  await pool.query(`INSERT INTO app_accounts(account_code,account_name,account_type,normal_balance)
    SELECT 'EBA-'||lpad(n::text,4,'0'),'Benchmark account '||n,CASE WHEN n%2=0 THEN 'equity' ELSE 'asset' END,
      CASE WHEN n%2=0 THEN 'credit' ELSE 'debit' END FROM generate_series(1,$1::int)n ON CONFLICT DO NOTHING`,[accounts-defaults]);
  let credentials=state.read('credentials.json');
  if(!credentials){credentials={password:crypto.randomBytes(32).toString('base64url')};state.write('credentials.json',credentials);}
  const auth=require('../../src/auth');
  const hash=await auth.passwordHash(credentials.password);
  await pool.query(`INSERT INTO app_users(username,password_hash,role,active,record_access,permission_grants)
    SELECT 'erp-bench-'||lpad(n::text,2,'0'),$1,CASE WHEN n<5 THEN 'admin' ELSE 'standard' END,n<$3,
      jsonb_build_object('employee_id','EB-E-'||lpad((n%$3+1)::text,4,'0'),'warehouse','EB Warehouse 0001','cost_center','EB Main','retail_price_list','EB Retail'),
      jsonb_build_array('employee.view:EB-E-'||lpad((n%$3+1)::text,4,'0'),'masters.warehouses.view','warehouse.view:EB Warehouse 0001','cost-center.view:EB Main','invoice.price-list.view:EB Retail')
    FROM generate_series(0,$2::int-1)n ON CONFLICT(username) DO NOTHING`,[hash,users,enabled_users]);
  // One enabled account provides an explicit negative report-permission check.
  await pool.query("UPDATE app_users SET permission_denials='[\"reports.general-ledger.view\"]'::jsonb WHERE username='erp-bench-54'");
  const actors=(await pool.query('SELECT id,username,role,record_access FROM app_users WHERE active ORDER BY username')).rows;
  const settings=Object.fromEntries((await pool.query('SELECT setting_key,account_id FROM app_accounting_settings')).rows.map(r=>[r.setting_key,Number(r.account_id)]));
  const manualAccounts=(await pool.query("SELECT id FROM app_accounts WHERE account_code LIKE 'EBA-%' ORDER BY account_code")).rows.map(r=>Number(r.id));
  if(actors.length!==enabled_users||manualAccounts.length<2)throw new Error('Benchmark master initialization is incomplete.');
  return {actors,settings,manualAccounts};
}

async function existing(pool,kind,key) {
  const [table,column]=TABLES[kind];
  return (await pool.query(`SELECT id,docstatus FROM ${table} WHERE ${column}=$1 AND ${column} LIKE 'ERP-BENCH:seed:%'`,[key])).rows[0];
}
async function openings(p,ctx) {
  const byWarehouse=new Map();
  for(let n=0;n<p.counts.bins;n++){const line={...pair(p,n),quantity:10000,valuation_rate:9000};delete line.target_warehouse;
    if(!byWarehouse.has(line.warehouse))byWarehouse.set(line.warehouse,[]);byWarehouse.get(line.warehouse).push(line);}
  for(const [warehouse,lines]of byWarehouse){state.diskGuard(p.mode);const key=prefix+'opening:'+warehouse;
    const found=await existing(ctx.pool,'stock',key);
    if(!found)await require('../../src/audit').runWithAuditUser(ctx.actors[0],()=>ctx.store.createStockEntry({entry_type:'opening',posting_date:'2016-05-31',posting_time:'00:00',cost_center:'EB Main',remarks:key,items:lines}));
    else if(found.docstatus!=='submitted')throw new Error('Retained opening is not submitted.');
  }
  state.event({event:'openings_ready',warehouses:byWarehouse.size,pairs:p.counts.bins});
}

async function seedOne(p,ctx,kind,n) {
  const key=prefix+kind+':'+n,actor=ctx.actors[n%ctx.actors.length],target=status(p,kind,n),posting_date=date(p,kind,n);
  const row=await existing(ctx.pool,kind,key);
  let id=row?Number(row.id):null,docstatus=row?.docstatus;
  const purchase=require('../../src/purchases'),orders=require('../../src/purchase-orders');
  const common={posting_date,posting_time:'12:00',cost_center:'EB Main',remarks:key};
  if(kind==='invoices') {
    const pos=rank((n+Math.floor(p.counts.invoices/3))%p.counts.invoices,p.counts.invoices)<p.pos_flagged;
    if(!id){id=await ctx.store.createInvoice({invoice_date:posting_date,posting_time:'12:00',due_date:posting_date,
      customer_id:`EB-C-${pad(n%p.counts.customers+1)}`,customer_name:`Benchmark Customer ${pad(n%p.counts.customers+1)}`,
      price_list:'EB Retail',cost_center:'EB Main',invoicer_id:actor.record_access.employee_id,
      invoicer:`Benchmark Employee ${n%ctx.actors.length+1}`,notes:key,is_cash_sale:pos,items:items(p,kind,n)});docstatus='draft';}
    if(docstatus==='draft'&&target!=='draft'){await ctx.store.submitInvoice(id);docstatus='submitted';}
    const r=rank(n,p.counts.invoices),unpaid=target==='submitted'&&r<p.statuses.invoices.draft+p.statuses.invoices.cancelled+p.positive_outstanding;
    if(docstatus==='submitted'&&!unpaid){const payment=(await ctx.pool.query('SELECT total,amount_paid FROM app_invoices WHERE id=$1',[id])).rows[0];
      if(Number(payment.amount_paid)<Number(payment.total))await ctx.store.addInvoicePayment(id,{payment_date:posting_date,amount:Number(payment.total)-Number(payment.amount_paid),account_id:ctx.settings.cash,method:'cash',notes:key});}
    if(docstatus==='submitted'&&target==='cancelled')await ctx.store.cancelInvoice(id);
  } else if(kind==='journals') {
    if(!id){const length=lineCount(p,kind,n),a=ctx.manualAccounts[n%ctx.manualAccounts.length],b=ctx.manualAccounts[(n+1)%ctx.manualAccounts.length];
      id=await ctx.store.createJournalEntry({...common,reference_no:'EB '+category(p,n),journal_type:'journal_entry',
        lines:Array.from({length},(_,i)=>({account_id:i===0?a:b,debit:i===0?1000*(length-1):0,credit:i?1000:0}))},{submit:target!=='draft'});docstatus=target==='draft'?'draft':'submitted';}
    if(docstatus==='submitted'&&target==='cancelled')await ctx.store.cancelJournalEntry(id);
  } else if(kind==='stock') {
    if(!id){id=await ctx.store.createStockEntry({...common,entry_type:'transfer',action:target==='draft'?'save_draft':'submit',items:items(p,kind,n)});docstatus=target==='draft'?'draft':'submitted';}
    if(docstatus==='submitted'&&target==='cancelled')await ctx.store.cancelStockEntry(id,{reason:key,posting_date});
  } else {
    const order=kind==='orders',supplier_id=`EB-S-${pad(n%p.counts.suppliers+1)}`;
    if(!id){id=await (order?orders.createPurchaseOrder:purchase.createPurchase)({...common,supplier_id,price_list:'EB Buying',
      supplier_reference:'EB-'+kind+'-'+n,warehouse:pair(p,n).warehouse,items:items(p,kind,n)});docstatus='draft';}
    if(docstatus==='draft'&&target!=='draft'){await(order?orders.submitPurchaseOrder:purchase.submitPurchase)(id);docstatus='submitted';}
    if(docstatus==='submitted'&&target==='cancelled')await(order?orders.cancelPurchaseOrder:purchase.cancelPurchase)(id);
  }
  return id;
}

async function seed(p,ctx) {
  const master=await masters(p,ctx.pool);Object.assign(ctx,master);
  state.write('profile.json',p);
  await openings(p,ctx);
  const workers=integer(process.env.BENCHMARK_SEED_WORKERS??2,'seed workers',1,4);
  const checkpoint=state.read('seed-checkpoint.json',{fingerprint:fingerprint(p),completed:{}});
  if(checkpoint.fingerprint!==fingerprint(p))throw new Error('Seed checkpoint profile mismatch.');
  if(p.mode==='pilot'&&!checkpoint.partial_commit_checked){
    // Simulate losing the result after a committed draft but before submission.
    // The normal retry must discover the durable source key and finish it once.
    if(!await existing(ctx.pool,'invoices',prefix+'invoices:0')){
      const interrupted={...ctx,store:{...ctx.store,createInvoice:async payload=>{
        await ctx.store.createInvoice(payload);
        const error=new Error('Intentional pilot interruption after committed draft');error.code='PILOT_INTERRUPTION';throw error;
      }}};
      try{await require('../../src/audit').runWithAuditUser(ctx.actors[0],()=>seedOne(p,interrupted,'invoices',0));throw new Error('Pilot interruption was not injected.');}
      catch(e){if(e.code!=='PILOT_INTERRUPTION')throw e;}
    }
    await require('../../src/audit').runWithAuditUser(ctx.actors[0],()=>seedOne(p,ctx,'invoices',0));
    await require('../../src/audit').runWithAuditUser(ctx.actors[0],()=>seedOne(p,ctx,'invoices',0));
    checkpoint.partial_commit_checked=true;state.write('seed-checkpoint.json',checkpoint);
    state.event({event:'partial_commit_recovery_checked'});
  }
  const started=Date.now();
  for(const kind of ['orders','purchases','stock','invoices','journals']){
    const total=p.counts[kind],start=checkpoint.completed[kind]||0;
    for(let lo=start;lo<total;lo+=50){ctx.signal?.throwIfAborted();state.diskGuard(p.mode);const hi=Math.min(total,lo+50);let next=lo;
      const tasks=Array.from({length:workers},async()=>{while(next<hi){const n=next++;
        await require('../../src/audit').runWithAuditUser(ctx.actors[n%ctx.actors.length],()=>seedOne(p,ctx,kind,n));}});
      // Wait for all workers even after one fails, so no writes continue after failure is recorded.
      const results=await Promise.allSettled(tasks),failure=results.find(r=>r.status==='rejected');
      if(failure)throw failure.reason;
      checkpoint.completed[kind]=hi;state.write('seed-checkpoint.json',checkpoint);
      state.progress('seeding',{kind,completed:hi,total,elapsed_seconds:Math.round((Date.now()-started)/1000)});
      state.event({event:'seed_progress',kind,completed:hi,total});
    }
    await ctx.pool.query('ANALYZE '+TABLES[kind][0]);
  }
  await ctx.pool.query('ANALYZE');
  if(p.mode==='pilot'){
    // Replay completed sources of every available status. Unique seed keys and
    // lifecycle-state checks must leave counts and receipt links unchanged.
    for(const kind of KINDS)for(const target of ['draft','submitted','cancelled']){
      if(!p.statuses[kind][target])continue;
      let n=0;while(status(p,kind,n)!==target)n++;
      await require('../../src/audit').runWithAuditUser(ctx.actors[n%ctx.actors.length],()=>seedOne(p,ctx,kind,n));
    }
    state.event({event:'completed_seed_replay_checked'});
  }
  state.event({event:'seed_complete',elapsed_seconds:Math.round((Date.now()-started)/1000)});
  return ctx;
}
module.exports={bootstrap,masters,seed,seedOne,existing,TABLES,prefix};
