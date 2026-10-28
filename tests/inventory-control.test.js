'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const store=require('../src/store');const auth=require('../src/auth');
const {FIXED,seedGoldenData}=require('./helpers/golden-seed');
const {countAction,correctionAction,loadCount}=require('../src/inventory-counts');
const {runWithAuditUser}=require('../src/audit');
const {withPostgresTransaction}=require('../src/core');
test('controlled warehouse counts close history, require independent approval, and post corrections without duplicating stock', {skip:process.env.RECONCILIATION_TEST_POSTGRES!=='1'},async()=>{
 try{
 await seedGoldenData();const pool=store.getPostgresPool();
 const maker=await auth.createUser('count-maker','CountPassword123!',{role:'standard'});
 maker.permissions=auth.PERMISSIONS.map(p=>p.key);
 await pool.query('UPDATE app_users SET permission_grants=$1::jsonb WHERE id=$2',[JSON.stringify(maker.permissions),maker.id]);
 const reviewer=await auth.createUser('count-reviewer','CountPassword123!',{role:'admin'});
 await pool.query('INSERT INTO app_master_warehouses(warehouse) VALUES($1) ON CONFLICT DO NOTHING',[FIXED.warehouse]);
 await pool.query('INSERT INTO app_master_items(item_code,item_name) VALUES($1,$2) ON CONFLICT DO NOTHING',[FIXED.itemCode,FIXED.itemName]);
 await pool.query('SELECT wm_inventory_activate()');
 await assert.rejects(pool.query("UPDATE app_accounting_settings SET setting_key='changed_inventory' WHERE setting_key='inventory'"),/inventory_mapping_immutable/);
 const invAccount=(await pool.query("SELECT account_id FROM app_accounting_settings WHERE setting_key='inventory'")).rows[0].account_id;
 const equity=(await pool.query("SELECT id FROM app_accounts WHERE account_code='3000'")).rows[0].id;
 await assert.rejects(pool.query('UPDATE app_gl_entries SET account_id=$1 WHERE id=(SELECT id FROM app_gl_entries WHERE account_id=$2 LIMIT 1)',[equity,invAccount]),/inventory_posting_required/);
 await assert.rejects(runWithAuditUser(maker,()=>store.createJournalEntry({journal_type:'journal_entry',posting_date:'2020-01-01',lines:[{account_id:invAccount,debit:1},{account_id:equity,credit:1}]})),/inventory_posting_required/);
 const before=Number((await pool.query('SELECT quantity FROM app_stock_balances WHERE item_code=$1 AND warehouse=$2',[FIXED.itemCode,FIXED.warehouse])).rows[0].quantity);
 const invoice=()=>store.createInvoice({invoice_date:'2020-01-01',posting_time:'08:17',customer_id:FIXED.customerId,customer_name:FIXED.customerName,payments:[],items:[{item_code:FIXED.itemCode,item_name:FIXED.itemName,warehouse:FIXED.warehouse,quantity:1,unit_price:100}]});
 const futureDraft=await store.createInvoice({invoice_date:'2999-01-01',customer_id:FIXED.customerId,customer_name:FIXED.customerName,payments:[],items:[{item_code:FIXED.itemCode,item_name:FIXED.itemName,warehouse:FIXED.warehouse,quantity:1,unit_price:100}]});
 await assert.rejects(runWithAuditUser(maker,()=>store.submitInvoice(futureDraft)),{code:'future_posting_date',status:400});
 const draft=await invoice();
 let count=await countAction(maker,'start',{warehouse:FIXED.warehouse,readiness:'Physical movements stopped; all preceding transactions submitted.'});
 const itemRoute=require('../src/web/routes/inventory-counts').stack.find(layer=>layer.route?.path==='/counts/:id/items'&&layer.route.methods.get).route.stack[0].handle;
 let suggestions;
 await itemRoute({currentUser:maker,params:{id:count.id},query:{q:FIXED.itemCode}},
   {set(){},json(rows){suggestions=rows;}},error=>{throw error;});
 assert.equal(suggestions[0].item_code,FIXED.itemCode);
 assert.ok(Number(suggestions[0].valuation_rate)>0);
 await assert.rejects(store.submitInvoice(draft),/warehouse_count_in_progress/);
 await assert.rejects(countAction(maker,'start',{warehouse:FIXED.warehouse,readiness:'All movements have stopped and documents posted.'}),/already active/);
 await assert.rejects(countAction(maker,'review',{id:count.id,revision:count.revision}),/count_incomplete/);
 count=await countAction(maker,'save',{id:count.id,revision:count.revision,lines:[{item_code:FIXED.itemCode,counted_qty:before-2,valuation_rate:50,explanation:'Two omitted dispatch units already reflected in physical count.'}]});
 count=await countAction(maker,'review',{id:count.id,revision:count.revision});
 await assert.rejects(countAction(maker,'approve',{id:count.id,revision:count.revision}),/independent/);
 count=await countAction(reviewer,'approve',{id:count.id,revision:count.revision});
 await runWithAuditUser(maker,()=>assert.rejects(withPostgresTransaction(client=>client.query("SELECT wm_inventory_count_action('prepare_submit',$1::jsonb)",[JSON.stringify({id:count.id,revision:count.revision})]),{inventoryExclusive:true}),/inventory_incomplete_posting/));
 assert.equal((await pool.query('SELECT active_count FROM wm_inventory_control WHERE warehouse=$1',[FIXED.warehouse])).rows[0].active_count,String(count.id));
 count=await countAction(maker,'submit',{id:count.id,revision:count.revision});
 assert.equal(count.state,'submitted');
 assert.equal((await countAction(maker,'submit',{id:count.id,revision:count.revision})).state,'submitted');
 assert.equal((await pool.query('SELECT count(*)::int n FROM wm_inventory_closures')).rows[0].n,1);
 const closedStock=(await pool.query(`SELECT s.id FROM app_stock_entries s JOIN app_stock_ledger l ON l.voucher_id=s.id
   AND l.voucher_type LIKE 'stock_%' JOIN wm_inventory_control c ON c.warehouse=l.warehouse
   WHERE s.entry_type <> 'reconciliation' AND l.movement_at<=c.closed_through LIMIT 1`)).rows[0];
 assert.ok(closedStock);
 const documentBefore=(await pool.query('SELECT to_jsonb(s) AS document FROM app_stock_entries s WHERE id=$1',[closedStock.id])).rows[0].document;
 await require('../src/stock-entry-workflow').changeStockEntryWorkflow(reviewer,closedStock.id,'delivery','All Received');
 assert.equal((await store.loadStockEntry(closedStock.id)).entry.delivery_status,'All Received');
 assert.deepEqual((await pool.query('SELECT to_jsonb(s) AS document FROM app_stock_entries s WHERE id=$1',[closedStock.id])).rows[0].document,documentBefore);
 await assert.rejects(store.cancelInvoice(1),/closed_voucher_immutable/);
 await assert.rejects(store.cancelStockEntry(count.reconciliation_id),/count_source_immutable|closed_voucher_immutable/);
 await assert.rejects(pool.query('DELETE FROM app_stock_ledger WHERE id=1'),/closed_history_immutable/);
 await assert.rejects(pool.query("UPDATE app_invoices SET invoice_date='2020-01-01' WHERE id=1"),/closed_voucher_immutable/);
 let correction=await correctionAction(maker,'create',{warehouse:FIXED.warehouse,source_reference:'OMITTED-DISPATCH-001',reason:'Dispatch already included in physical count; reviewed revenue/expense reclassification.',treatment:'absorbed',count_id:count.id,item_code:FIXED.itemCode,quantity:-2,rate:0,financial_lines:[{account_id:(await pool.query("SELECT id FROM app_accounts WHERE account_code='5000'")).rows[0].id,debit:100},{account_id:(await pool.query("SELECT id FROM app_accounts WHERE account_code='5100'")).rows[0].id,credit:100}]});
 await assert.rejects(correctionAction(maker,'approve',{id:correction.id}),/independent/);
 await correctionAction(reviewer,'approve',{id:correction.id});
 correction=await correctionAction(maker,'submit',{id:correction.id});
 assert.equal(correction.state,'submitted');
 assert.deepEqual((await pool.query("SELECT DISTINCT posting_date::text FROM app_gl_entries WHERE voucher_type='inventory_correction' AND voucher_id=$1",[correction.id])).rows,[{posting_date:require('../src/posting-time').currentPostingDate()}]);
 assert.equal((await pool.query("SELECT count(*)::int n FROM app_stock_ledger WHERE voucher_type='inventory_correction' AND voucher_id=$1",[correction.id])).rows[0].n,0);
 assert.equal(Number((await pool.query('SELECT quantity FROM app_stock_balances WHERE item_code=$1 AND warehouse=$2',[FIXED.itemCode,FIXED.warehouse])).rows[0].quantity),before-2);
 await assert.rejects(correctionAction(maker,'create',{warehouse:FIXED.warehouse,source_reference:'OMITTED-DISPATCH-002',reason:'Duplicate absorption must fail.',treatment:'absorbed',count_id:count.id,item_code:FIXED.itemCode,quantity:-1,rate:0,financial_lines:correction.financial_lines}),/exceeds_absorbed/);
 let replacement=await correctionAction(maker,'create',{warehouse:FIXED.warehouse,source_reference:'REPLACED-PHYSICAL',reason:'Unposted preparation mistake, abandoned before physical posting.',treatment:'physical',item_code:FIXED.itemCode,quantity:1,rate:50,financial_lines:[]});
 await correctionAction(maker,'abandon',{id:replacement.id,reason:'Incorrect preparation; replace without posting stock.'});
 replacement=await correctionAction(maker,'create',{warehouse:FIXED.warehouse,source_reference:'REPLACED-PHYSICAL',reason:'Corrected preparation of a future physical movement.',treatment:'physical',item_code:FIXED.itemCode,quantity:2,rate:50,financial_lines:[]});
 assert.equal(replacement.state,'draft');await correctionAction(maker,'abandon',{id:replacement.id,reason:'No physical movement occurred; close this unposted preparation.'});
 await assert.rejects(runWithAuditUser(maker,()=>store.submitInvoice(draft)),/inventory_period_closed/);
 const openStamp=new Date(new Date(count.cutoff).getTime()+120000+3*3600000).toISOString();
 await pool.query('UPDATE app_invoices SET invoice_date=$2,posting_time=$3 WHERE id=$1',[draft,openStamp.slice(0,10),openStamp.slice(11,16)]);
 await runWithAuditUser(maker,()=>store.submitInvoice(draft));
 const movement=(await pool.query("SELECT * FROM app_stock_ledger WHERE voucher_type='invoice' AND voucher_id=$1",[draft])).rows[0];
 assert.ok(movement.movement_at>new Date(count.cutoff));assert.notEqual(movement.posting_date,'2020-01-01');
 const accountingDates=(await pool.query("SELECT DISTINCT posting_date::text FROM app_gl_entries WHERE voucher_type='sales_invoice' AND voucher_id=$1",[draft])).rows;
 assert.deepEqual(accountingDates,[{posting_date:openStamp.slice(0,10)}]);
 assert.equal((await pool.query("SELECT posting_date::text FROM app_journal_entries WHERE journal_type='sales_invoice' AND reference_no=(SELECT invoice_no FROM app_invoices WHERE id=$1)",[draft])).rows[0].posting_date,openStamp.slice(0,10));
 assert.equal((await pool.query("SELECT posting_time::text FROM app_journal_entries WHERE journal_type='sales_invoice' AND reference_no=(SELECT invoice_no FROM app_invoices WHERE id=$1)",[draft])).rows[0].posting_time.slice(0,5),openStamp.slice(11,16));

 let receipt=await correctionAction(maker,'create',{warehouse:FIXED.warehouse,source_reference:'CURRENT-PHYSICAL-001',reason:'Actual new physical receipt after the closed stock count.',treatment:'physical',item_code:FIXED.itemCode,quantity:1,rate:50,financial_lines:[]});
 await correctionAction(reviewer,'approve',{id:receipt.id});receipt=await correctionAction(maker,'submit',{id:receipt.id});assert.equal(receipt.state,'submitted');
 assert.equal(Number((await pool.query("SELECT sum(qty_change) q FROM app_stock_ledger WHERE voucher_type='inventory_correction' AND voucher_id=$1",[receipt.id])).rows[0].q),1);
 await assert.rejects(correctionAction(maker,'create',{warehouse:FIXED.warehouse,source_reference:'current-physical-001',reason:'A case-only duplicate reference must not create another physical movement.',treatment:'physical',item_code:FIXED.itemCode,quantity:1,rate:50,financial_lines:[]}),{code:'23505'});
 let zero=await countAction(maker,'start',{warehouse:FIXED.warehouse,readiness:'All movements stopped and preceding documents posted.'});
 const lines=(await loadCount({...maker,permissions:[],role:'admin'},zero.id)).lines;
 zero=await countAction(maker,'save',{id:zero.id,revision:zero.revision,lines:lines.map(l=>({item_code:l.item_code,counted_qty:l.book_qty,valuation_rate:l.book_rate,explanation:''}))});
 zero=await countAction(maker,'review',{id:zero.id,revision:zero.revision});zero=await countAction(reviewer,'approve',{id:zero.id,revision:zero.revision});zero=await countAction(maker,'submit',{id:zero.id,revision:zero.revision});
 assert.equal(zero.state,'submitted');assert.equal((await pool.query('SELECT count(*)::int n FROM wm_inventory_closures')).rows[0].n,2);
 const abandoned=await countAction(maker,'start',{warehouse:FIXED.warehouse,readiness:'All movements stopped and preceding documents posted.'});
 await countAction(maker,'abandon',{id:abandoned.id,revision:abandoned.revision,reason:'Physical movement invalidated the count; restarting later.'});
 assert.equal((await pool.query('SELECT count(*)::int n FROM wm_inventory_closures')).rows[0].n,2);
 await assert.rejects(countAction(maker,'save',{id:abandoned.id,revision:abandoned.revision,lines:[]}),/terminal/);
 }finally{await store.closeStore();}
});

test('count locks drain preceding postings, both transfer warehouses freeze, approval evidence changes invalidate review, and runtime SQL cannot bypass controls',{skip:process.env.RECONCILIATION_TEST_POSTGRES!=='1'},async()=>{
 let held;
 try{
 await seedGoldenData();const pool=store.getPostgresPool();
 await pool.query('INSERT INTO app_master_warehouses(warehouse) VALUES($1),($2)',[FIXED.warehouse,'Count target']);
 await pool.query('INSERT INTO app_master_items(item_code,item_name) VALUES($1,$2)',[FIXED.itemCode,FIXED.itemName]);
 const maker=await auth.createUser('lock-maker','CountPassword123!',{role:'admin'});const reviewer=await auth.createUser('lock-reviewer','CountPassword123!',{role:'admin'});
 await pool.query('SELECT wm_inventory_activate()');
 const id=await store.createInvoice({invoice_date:FIXED.date,customer_id:FIXED.customerId,customer_name:FIXED.customerName,payments:[],items:[{item_code:FIXED.itemCode,item_name:FIXED.itemName,warehouse:FIXED.warehouse,quantity:1,unit_price:100}]});
 held=await pool.connect();await held.query('BEGIN');await held.query('SELECT pg_advisory_xact_lock_shared(1776342162)');
 await held.query("SELECT set_config('app.audit_user_id',$1,true)",[String(maker.id)]);await require('../src/services/inventory-posting').loadTransactionMode(held);
 const starting=countAction(maker,'start',{warehouse:FIXED.warehouse,readiness:'Physical movements stopped and preceding postings draining.'});
 let queued=false;for(let n=0;n<40;n++){queued=(await pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND objid=1776342162) AS queued")).rows[0].queued;if(queued)break;await new Promise(resolve=>setTimeout(resolve,10));}
 assert.equal(queued,true);
 await require('../src/domain/sales').submitPostgresInvoiceInTransaction(held,id);await held.query('COMMIT');held.release();held=null;
 let count=await starting;
 const data=await loadCount({...maker,role:'admin'},count.id);assert.equal(Number(data.lines[0].book_qty),11);
 const inbound=()=>runWithAuditUser(maker,()=>store.createStockEntry({entry_type:'transfer',posting_date:FIXED.date,items:[{item_code:FIXED.itemCode,item_name:FIXED.itemName,warehouse:'Count target',target_warehouse:FIXED.warehouse,quantity:1,valuation_rate:50}]}));
 await assert.rejects(inbound(),/warehouse_count_in_progress/);
 count=await countAction(maker,'save',{id:count.id,revision:count.revision,lines:data.lines.map(l=>({item_code:l.item_code,counted_qty:l.book_qty,valuation_rate:l.book_rate,explanation:''}))});
 count=await countAction(maker,'review',{id:count.id,revision:count.revision});count=await countAction(reviewer,'approve',{id:count.id,revision:count.revision});
 await runWithAuditUser(maker,()=>pool.query(`INSERT INTO app_stock_reconciliation_attachments(stock_entry_id,file_name,content_type,byte_size,content) VALUES($1,'count.csv','text/csv',3,$2)`,[count.reconciliation_id,Buffer.from('a,b')]));
 await assert.rejects(countAction(maker,'submit',{id:count.id,revision:count.revision}),/revision_conflict/);
 const changed=await loadCount({...maker,role:'admin'},count.id);assert.equal(changed.count.state,'counting');assert.equal(changed.count.approved_by,null);
 await countAction(maker,'abandon',{id:count.id,revision:changed.count.revision,reason:'Count evidence changed; abandon and repeat physical count.'});
 const transfer=await runWithAuditUser(maker,()=>store.createStockEntry({entry_type:'order',posting_date:FIXED.date,items:[{item_code:FIXED.itemCode,item_name:FIXED.itemName,warehouse:FIXED.warehouse,target_warehouse:'Count target',quantity:1,valuation_rate:50}]}));
 await runWithAuditUser(maker,()=>store.cancelStockEntry(transfer));
 const purchases=require('../src/purchases');
 await pool.query("INSERT INTO app_master_suppliers(supplier_id,supplier_name) VALUES('COUNT-SUP','Count supplier'); INSERT INTO app_master_price_lists(price_list,currency,price_type,active) VALUES('COUNT-BUY','UGX','buying',1)");
 const purchase=await purchases.createPurchase({posting_date:'2020-01-01',supplier_id:'COUNT-SUP',price_list:'COUNT-BUY',items:[{item_code:FIXED.itemCode,warehouse:FIXED.warehouse,quantity:1,unit_price:50}]});
 await runWithAuditUser(maker,()=>purchases.submitPurchase(purchase));await runWithAuditUser(maker,()=>purchases.cancelPurchase(purchase));
 // Exercise an actual restricted SQL role, with no role membership or ownership.
 await pool.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='wm_count_test_runtime') THEN CREATE ROLE wm_count_test_runtime NOLOGIN NOINHERIT;END IF;END $$");
 await pool.query('GRANT USAGE ON SCHEMA public TO wm_count_test_runtime');
 await pool.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO wm_count_test_runtime');
 await pool.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO wm_count_test_runtime');
 for(const table of ['wm_inventory_policy','wm_inventory_control','wm_inventory_counts','wm_inventory_count_lines','wm_inventory_closures','wm_inventory_events','wm_inventory_count_audit','wm_inventory_corrections','wm_inventory_correction_audit','app_stock_ledger','app_stock_balances'])await pool.query(`REVOKE ALL ON ${table} FROM wm_count_test_runtime;GRANT SELECT ON ${table} TO wm_count_test_runtime`);

 for(const signature of ['wm_inventory_enabled()','wm_inventory_begin(text,bigint,boolean,text[])','wm_inventory_apply(jsonb)'])await pool.query(`GRANT EXECUTE ON FUNCTION ${signature} TO wm_count_test_runtime`);
 await pool.query("INSERT INTO app_master_customers(customer_id,customer_name) VALUES('COUNT-CUST','Count customer');INSERT INTO app_master_employees(employee_id,employee_name) VALUES('COUNT-EMP','Count employee');INSERT INTO app_master_price_lists(price_list,currency,price_type,active) VALUES('COUNT-SELL','UGX','selling',1)");
 await runWithAuditUser(maker,()=>withPostgresTransaction(async client=>{
   await client.query('SET LOCAL ROLE wm_count_test_runtime');
   const validation=require('../src/services/sales-transaction-validation');const sales=require('../src/domain/sales');
   const payload=await validation.lockReferences(client,{user:{...maker,role:'admin'}},{customer_id:'COUNT-CUST',price_list:'COUNT-SELL',invoicer_id:'COUNT-EMP',invoice_date:FIXED.date,items:[{item_code:FIXED.itemCode,warehouse:FIXED.warehouse,quantity:1,unit_price:100}]},{creating:true});
   const invoiceId=await sales.createPostgresInvoiceInTransaction(client,payload);
   await require('../src/services/inventory-posting').beginInventoryPosting(client,'invoice',invoiceId,[FIXED.warehouse]);
   await validation.lockStock(client,payload.items);await sales.submitPostgresInvoiceInTransaction(client,invoiceId);
 }));
 const incompleteDraft=await store.createInvoice({invoice_date:FIXED.date,customer_id:FIXED.customerId,customer_name:FIXED.customerName,payments:[],items:[{item_code:FIXED.itemCode,item_name:FIXED.itemName,warehouse:FIXED.warehouse,quantity:1,unit_price:100}]});
 held=await pool.connect();
 for(const sql of ["UPDATE wm_inventory_policy SET enabled=false","UPDATE app_stock_balances SET quantity=999","DELETE FROM wm_inventory_closures","TRUNCATE app_stock_ledger","ALTER TABLE app_stock_ledger DISABLE TRIGGER ALL"]){
 await held.query('BEGIN');await held.query('SET LOCAL ROLE wm_count_test_runtime');await assert.rejects(held.query(sql),error=>error.code==='42501');await held.query('ROLLBACK');
 }
 await held.query('BEGIN');await held.query('SET LOCAL ROLE wm_count_test_runtime');await held.query("SELECT set_config('app.audit_user_id',$1,true)",[String(maker.id)]);
 await held.query("SELECT wm_inventory_begin('invoice',$2,false,$1::text[])",[[FIXED.warehouse],incompleteDraft]);
 await assert.rejects(held.query('COMMIT'),/inventory_incomplete_posting/);await held.query('ROLLBACK');
 held.release();held=null;
 assert.equal((await pool.query('SELECT count(*)::int n FROM wm_inventory_closures')).rows[0].n,0);
 }finally{if(held){await held.query('ROLLBACK');held.release();}await store.closeStore();}
});

test('count and correction templates render their workflow states with shared surfaces',async()=>{
 const path=require('node:path');const {renderView}=require('./helpers/render-view');
 const common={assetVersion:'test',availableReports:[],currentUser:{role:'admin'},can:()=>true,stamp:value=>value||'—',error:null};
 const count={id:1,entry_no:'REC-000001',warehouse:'Main',cutoff:'2026-10-17T10:00:00Z',state:'approved',revision:2,reconciliation_id:1,preparer:'Maker',reviewer:'Reviewer',readiness:'All prior documents posted.'};
 const html=await renderView(path.join(__dirname,'../views/inventory-count.ejs'),{...common,count,lines:[{item_code:'A',book_qty:10,book_value:500,book_rate:50,valuation_rate:50,counted_qty:8,explanation:'Missing units'}],audit:[]});
 assert.match(html,/Submit reconciliation and close history/);assert.match(html,/ui-table-scroll/);assert.match(html,/name="revision" value="2"/);
 const corrections=await renderView(path.join(__dirname,'../views/inventory-corrections.ejs'),{...common,enabled:true,warehouses:[{warehouse:'Main'}],corrections:[],accounts:[]});
 assert.match(corrections,/Already absorbed in closed count/);assert.match(corrections,/Save for independent approval/);
});

test('adding a found item saves only its new line and rejects duplicates and stale revisions',{skip:process.env.RECONCILIATION_TEST_POSTGRES!=='1'},async()=>{
 try{
  await seedGoldenData();const pool=store.getPostgresPool();
  await pool.query('INSERT INTO app_master_warehouses(warehouse) VALUES($1)',[FIXED.warehouse]);
  await pool.query("INSERT INTO app_master_items(item_code,item_name) VALUES($1,$2),('FOUND-NEW','Found item')",[FIXED.itemCode,FIXED.itemName]);
  const maker=await auth.createUser('found-maker','CountPassword123!',{role:'admin'});
  await pool.query('SELECT wm_inventory_activate()');
  let count=await countAction(maker,'start',{warehouse:FIXED.warehouse,readiness:'Physical movements stopped and all preceding transactions posted.'});
  const oldRevision=count.revision;
  const line={item_code:'FOUND-NEW',counted_qty:2,valuation_rate:50,explanation:'Found during physical count'};
  count=await countAction(maker,'save',{id:count.id,revision:count.revision,addOnly:true,lines:[line]});
  const saved=await loadCount(maker,count.id);
  assert.equal(saved.lines.find(l=>l.item_code===FIXED.itemCode).counted_qty,null);
  assert.equal(Number(saved.lines.find(l=>l.item_code==='FOUND-NEW').counted_qty),2);
  assert.equal(Number(count.revision),Number(oldRevision)+1);
  await assert.rejects(countAction(maker,'save',{id:count.id,revision:count.revision,addOnly:true,lines:[line]}),/already in the count/);
  await pool.query("INSERT INTO app_master_items(item_code,item_name) VALUES('FOUND-SECOND','Second item')");
  await assert.rejects(countAction(maker,'save',{id:count.id,revision:oldRevision,addOnly:true,lines:[{...line,item_code:'FOUND-SECOND'}]}),/revision_conflict/);
 }finally{await store.closeStore();}
});

test('Excel import revises reviewed counts atomically and requires independent approval again',{skip:process.env.RECONCILIATION_TEST_POSTGRES!=='1'},async()=>{
 try{
  await seedGoldenData();const pool=store.getPostgresPool();
  await pool.query('INSERT INTO app_master_warehouses(warehouse) VALUES($1)',[FIXED.warehouse]);
  await pool.query('INSERT INTO app_master_items(item_code,item_name) VALUES($1,$2)',[FIXED.itemCode,FIXED.itemName]);
  const maker=await auth.createUser('import-maker','CountPassword123!',{role:'standard'});
 maker.permissions=auth.PERMISSIONS.map(p=>p.key);
 await pool.query('UPDATE app_users SET permission_grants=$1::jsonb WHERE id=$2',[JSON.stringify(maker.permissions),maker.id]);
  const reviewer=await auth.createUser('import-reviewer','CountPassword123!',{role:'admin'});
  await pool.query('SELECT wm_inventory_activate()');
  let count=await countAction(maker,'start',{warehouse:FIXED.warehouse,readiness:'All physical movements stopped and prior vouchers submitted.'});
  const lines=(await loadCount(maker,count.id)).lines.map(l=>({item_code:l.item_code,counted_qty:l.book_qty,valuation_rate:l.book_rate,explanation:''}));
  count=await countAction(maker,'save',{id:count.id,revision:count.revision,lines});
  count=await countAction(maker,'review',{id:count.id,revision:count.revision});
  count=await countAction(reviewer,'approve',{id:count.id,revision:count.revision});
  const revision=count.revision;
  await assert.rejects(countAction(maker,'save',{id:count.id,revision,lines}),/review_locked/);
  await assert.rejects(countAction(maker,'save',{id:count.id,revision,sheet_import:true,lines:[{...lines[0],counted_qty:-1}]}),/invalid_count/);
  assert.equal((await loadCount(maker,count.id)).count.state,'approved');
  count=await countAction(maker,'save',{id:count.id,revision,sheet_import:true,lines});
  assert.equal(count.state,'counting');assert.equal(count.approved_by,null);
  assert.equal(Number(count.revision),Number(revision)+1);
  await assert.rejects(countAction(maker,'submit',{id:count.id,revision:count.revision}),/approved/);
  count=await countAction(maker,'review',{id:count.id,revision:count.revision});
  count=await countAction(maker,'save',{id:count.id,revision:count.revision,sheet_import:true,lines});
  assert.equal(count.state,'counting');
  count=await countAction(maker,'review',{id:count.id,revision:count.revision});
  await assert.rejects(countAction(maker,'approve',{id:count.id,revision:count.revision}),/independent/);
  count=await countAction(reviewer,'approve',{id:count.id,revision:count.revision});
  count=await countAction(maker,'submit',{id:count.id,revision:count.revision});
  await assert.rejects(countAction(maker,'save',{id:count.id,revision:count.revision,sheet_import:true,lines}),/terminal/);
 }finally{await store.closeStore();}
});

test('administrator may revise, review, approve and submit their own reconciliation',{skip:process.env.RECONCILIATION_TEST_POSTGRES!=='1'},async()=>{
 try{
  await seedGoldenData();const pool=store.getPostgresPool();
  await pool.query('INSERT INTO app_master_warehouses(warehouse) VALUES($1)',[FIXED.warehouse]);
  await pool.query('INSERT INTO app_master_items(item_code,item_name) VALUES($1,$2)',[FIXED.itemCode,FIXED.itemName]);
  const admin=await auth.createUser('reconciliation-admin','CountPassword123!',{role:'admin'});
  await pool.query('SELECT wm_inventory_activate()');
  let count=await countAction(admin,'start',{warehouse:FIXED.warehouse,readiness:'Physical movements stopped and previous transactions submitted.'});
  const lines=(await loadCount(admin,count.id)).lines.map(l=>({item_code:l.item_code,counted_qty:l.book_qty,valuation_rate:l.book_rate,explanation:''}));
  count=await countAction(admin,'save',{id:count.id,revision:count.revision,lines});
  count=await countAction(admin,'review',{id:count.id,revision:count.revision});
  count=await countAction(admin,'approve',{id:count.id,revision:count.revision});
  count=await countAction(admin,'save',{id:count.id,revision:count.revision,lines});
  assert.equal(count.state,'counting');assert.equal(count.approved_by,null);
  count=await countAction(admin,'review',{id:count.id,revision:count.revision});
  count=await countAction(admin,'approve',{id:count.id,revision:count.revision});
  count=await countAction(admin,'submit',{id:count.id,revision:count.revision});
  assert.equal(count.state,'submitted');
  await assert.rejects(countAction(admin,'save',{id:count.id,revision:count.revision,lines}),/terminal/);
 }finally{await store.closeStore();}
});
