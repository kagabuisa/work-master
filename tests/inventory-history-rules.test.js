'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const store=require('../src/store');
const auth=require('../src/auth');
const {runWithAuditUser}=require('../src/audit');
const {withPostgresTransaction}=require('../src/core');
const {seedGoldenData,FIXED}=require('./helpers/golden-seed');
const {countAction,loadCount}=require('../src/inventory-counts');
const {currentPostingDate}=require('../src/posting-time');
const options={skip:process.env.RECONCILIATION_TEST_POSTGRES!=='1'};
const today=()=>currentPostingDate();
const yesterday=()=>new Date(new Date(`${today()}T12:00:00Z`).getTime()-86400000).toISOString().slice(0,10);
const code='HISTORICAL-20-800';
const line=q=>({item_code:code,item_name:code,warehouse:FIXED.warehouse,quantity:q,valuation_rate:50,unit_price:100});
async function setup(){
 await seedGoldenData();const pool=store.getPostgresPool();
 await pool.query('INSERT INTO app_master_items(item_code,item_name) VALUES($1,$1),($2,$3) ON CONFLICT DO NOTHING',[code,FIXED.itemCode,FIXED.itemName]);
 await pool.query('INSERT INTO app_master_warehouses(warehouse) VALUES($1) ON CONFLICT DO NOTHING',[FIXED.warehouse]);
 await store.createStockEntry({entry_type:'opening',posting_date:yesterday(),posting_time:'00:00',items:[line(20)]});
 const maker=await auth.createUser('history-maker','HistoryRules123!',{role:'admin'});
 const reviewer=await auth.createUser('history-reviewer','HistoryRules123!',{role:'admin'});
 await pool.query('SELECT wm_inventory_activate()');return {pool,maker,reviewer};
}
async function draft(qs,day=yesterday(),time='12:00'){
 return store.createInvoice({invoice_date:day,posting_time:time,customer_id:FIXED.customerId,customer_name:FIXED.customerName,payments:[],items:qs.map(line)});
}
async function balance(pool){return Number((await pool.query('SELECT quantity FROM app_stock_balances WHERE item_code=$1 AND warehouse=$2',[code,FIXED.warehouse])).rows[0].quantity);}
async function rejected(pool,maker,id,pattern){
 const before=await balance(pool);
 await assert.rejects(runWithAuditUser(maker,()=>store.submitInvoice(id)),pattern);
 assert.equal(await balance(pool),before);
 assert.equal((await pool.query('SELECT docstatus FROM app_invoices WHERE id=$1',[id])).rows[0].docstatus,'draft');
 for(const [table,type] of [['app_stock_ledger','invoice'],['app_gl_entries','sales_invoice']])assert.equal((await pool.query(`SELECT count(*)::int n FROM ${table} WHERE voucher_type=$1 AND voucher_id=$2`,[type,id])).rows[0].n,0);
 assert.equal((await pool.query('SELECT count(*)::int n FROM wm_inventory_events WHERE voucher_type=\'invoice\' AND voucher_id=$1',[id])).rows[0].n,0);
}
async function finishCount(maker,reviewer,qty){
 let count=await countAction(maker,'start',{warehouse:FIXED.warehouse,readiness:'Synthetic test: physical movements stopped and all preceding documents submitted.'});
 count=await countAction(maker,'save',{id:count.id,revision:count.revision,lines:(await loadCount(maker,count.id)).lines.map(r=>({item_code:r.item_code,counted_qty:r.item_code===code?qty:r.book_qty,valuation_rate:r.item_code===code?50:r.book_rate,explanation:'Historical stock rule test.'}))});
 count=await countAction(maker,'review',{id:count.id,revision:count.revision});
 count=await countAction(reviewer,'approve',{id:count.id,revision:count.revision});
 return countAction(maker,'submit',{id:count.id,revision:count.revision});
}

test('20 yesterday and 800 today: reject backdated 100; cumulative lines and concurrent sales cannot reuse historical stock',options,async()=>{
 try{
 const {pool,maker}=await setup();
 await runWithAuditUser(maker,()=>store.createStockEntry({entry_type:'opening',posting_date:today(),posting_time:'00:00',items:[line(780)]}));
 assert.equal(await balance(pool),800);
 await rejected(pool,maker,await draft([100]),/insufficient_stock: Historical stock.*20/);
 const good=await draft([10]);await runWithAuditUser(maker,()=>store.submitInvoice(good));assert.equal(await balance(pool),790);
 assert.deepEqual((await pool.query("SELECT DISTINCT posting_date::text FROM app_gl_entries WHERE voucher_type='sales_invoice' AND voucher_id=$1",[good])).rows,[{posting_date:yesterday()}]);
 assert.deepEqual((await pool.query("SELECT DISTINCT posting_date::text FROM app_stock_ledger WHERE voucher_type='invoice' AND voucher_id=$1",[good])).rows,[{posting_date:today()}]);
 await rejected(pool,maker,await draft([6,5]),/insufficient_stock/);
 const ids=await Promise.all([draft([10]),draft([10])]);
 const outcomes=await Promise.allSettled(ids.map(id=>runWithAuditUser(maker,()=>store.submitInvoice(id))));
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(await balance(pool),780);
 await rejected(pool,maker,await draft([1]),/insufficient_stock/);
 }finally{await store.closeStore();}
});

test('backdated sales preserve later stock minima even when a later receipt replenishes current stock',options,async()=>{
 try{
 const {pool,maker}=await setup();
 const later=await draft([15],today(),'00:00');await runWithAuditUser(maker,()=>store.submitInvoice(later));
 await runWithAuditUser(maker,()=>store.createStockEntry({entry_type:'opening',posting_date:today(),posting_time:'00:00',items:[line(780)]}));
 assert.equal(await balance(pool),785);
 await rejected(pool,maker,await draft([6]),/available after later transactions is 5/);
 const exact=await draft([5]);await runWithAuditUser(maker,()=>store.submitInvoice(exact));assert.equal(await balance(pool),780);
 }finally{await store.closeStore();}
});

test('completed reconciliation blocks all ordinary pre-cutoff documents, including the exact 800/20/100 case and new items',options,async()=>{
 try{
 const {pool,maker,reviewer}=await setup();
 const count=await finishCount(maker,reviewer,800);assert.equal(await balance(pool),800);
 const closed=(await pool.query('SELECT * FROM app_stock_ledger ORDER BY id')).rows;
 await rejected(pool,maker,await draft([100]),/inventory_period_closed/);
 await rejected(pool,maker,await draft([1]),/inventory_period_closed/);
 const stamp=new Date(new Date(count.cutoff).getTime()+3*3600000).toISOString();
 const atCutoff=await draft([1],stamp.slice(0,10),stamp.slice(11,16));
 // cutoff carries UTC; use an exact Kampala timestamp from the database.
 await pool.query("UPDATE app_invoices SET posting_time=($2::timestamptz AT TIME ZONE 'Africa/Kampala')::time WHERE id=$1",[atCutoff,count.cutoff]);
 await rejected(pool,maker,atCutoff,/inventory_period_closed/);
 await pool.query("INSERT INTO app_master_items(item_code,item_name) VALUES('AFTER-COUNT-ITEM','After count item')");
 for(const item of [line(1),{...line(1),item_code:'AFTER-COUNT-ITEM',item_name:'After count item'}]){
 await assert.rejects(runWithAuditUser(maker,()=>store.createStockEntry({entry_type:'opening',posting_date:yesterday(),posting_time:'12:00',items:[item]})),/inventory_period_closed/);
 }
 await pool.query("INSERT INTO app_master_warehouses(warehouse) VALUES('History Target')");
 await assert.rejects(runWithAuditUser(maker,()=>store.createStockEntry({entry_type:'transfer',posting_date:yesterday(),posting_time:'12:00',items:[{...line(1),target_warehouse:'History Target'}]})),/inventory_period_closed/);
 const purchases=require('../src/purchases');
 await pool.query("INSERT INTO app_master_suppliers(supplier_id,supplier_name) VALUES('HISTORY-SUP','History supplier');INSERT INTO app_master_price_lists(price_list,currency,price_type,active) VALUES('HISTORY-BUY','UGX','buying',1)");
 const purchase=await purchases.createPurchase({posting_date:yesterday(),posting_time:'12:00',supplier_id:'HISTORY-SUP',price_list:'HISTORY-BUY',items:[{...line(1),unit_price:50}]});
 await assert.rejects(runWithAuditUser(maker,()=>purchases.submitPurchase(purchase)),/inventory_period_closed/);
 assert.equal(await balance(pool),800);
 assert.deepEqual((await pool.query('SELECT * FROM app_stock_ledger ORDER BY id')).rows,closed);
 // Current-period sales remain possible without reopening the reconciliation.
 const open=new Date(new Date(count.cutoff).getTime()+120000+3*3600000).toISOString();
 const valid=await draft([1],open.slice(0,10),open.slice(11,16));await runWithAuditUser(maker,()=>store.submitInvoice(valid));assert.equal(await balance(pool),799);
 await assert.rejects(store.cancelStockEntry(count.reconciliation_id),/count_source_immutable|closed_voucher_immutable/);
 assert.equal((await pool.query('SELECT count(*)::int n FROM wm_inventory_closures')).rows[0].n,1);
 }finally{await store.closeStore();}
});

test('SQL movement payload cannot forge a newer date to bypass saved invoice history',options,async()=>{
 try{
 const {pool,maker}=await setup();
 await runWithAuditUser(maker,()=>store.createStockEntry({entry_type:'opening',posting_date:today(),items:[line(780)]}));
 const id=await draft([100]);
 await pool.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='wm_history_test_runtime') THEN CREATE ROLE wm_history_test_runtime NOLOGIN NOINHERIT; END IF; END $$");
 await pool.query('GRANT USAGE ON SCHEMA public TO wm_history_test_runtime');
 await pool.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO wm_history_test_runtime');
 for(const signature of ['wm_inventory_begin(text,bigint,boolean,text[])','wm_inventory_apply(jsonb)'])await pool.query(`GRANT EXECUTE ON FUNCTION ${signature} TO wm_history_test_runtime`);
 await assert.rejects(runWithAuditUser(maker,()=>withPostgresTransaction(async client=>{
  await client.query('SET LOCAL ROLE wm_history_test_runtime');
  await client.query('SELECT wm_inventory_begin($1,$2,false,$3::text[])',['invoice',id,[FIXED.warehouse]]);
  await client.query('SELECT wm_inventory_apply($1::jsonb)',[JSON.stringify({posting_date:today(),posting_time:'23:59',voucher_type:'invoice',voucher_id:id,item_code:code,item_name:code,warehouse:FIXED.warehouse,qty_change:-100})]);
 })),/insufficient_stock: Historical stock/);
 assert.equal(await balance(pool),800);
 }finally{await store.closeStore();}
});


test('current-minute defaults can sell a just-received item after a same-minute closure',options,async()=>{
 try{
 const {pool,maker,reviewer}=await setup();
 await finishCount(maker,reviewer,20);
 const {currentPostingTime}=require('../src/posting-time');
 await runWithAuditUser(maker,()=>store.createStockEntry({entry_type:'opening',posting_date:today(),posting_time:currentPostingTime(),items:[line(5)]}));
 const id=await draft([25],today(),currentPostingTime());
 await runWithAuditUser(maker,()=>store.submitInvoice(id));assert.equal(await balance(pool),0);
 }finally{await store.closeStore();}
});
