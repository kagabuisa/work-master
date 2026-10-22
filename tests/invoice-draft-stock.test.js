'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const store=require('../src/store');const auth=require('../src/auth');
const {runWithAuditUser}=require('../src/audit');
const {seedGoldenData,FIXED}=require('./helpers/golden-seed');
const {buildInvoicePayload}=require('../src/services/sales-validation');
const {currentPostingDate,currentPostingTime}=require('../src/posting-time');
const {countAction,loadCount}=require('../src/inventory-counts');

test('multi-item save checks keep each warehouse history, later minimum and repeated quantity separate', {
 skip:process.env.RECONCILIATION_TEST_POSTGRES!=='1',
},async()=>{
 try{
  await seedGoldenData();const pool=store.getPostgresPool();
  const {validateInvoiceDraftStock}=require('../src/services/invoice-draft-validation');
  const pairs=[{item_code:'PRECHECK-A',warehouse:'Precheck Main'},
   {item_code:'PRECHECK-A',warehouse:'Precheck Other'},
   {item_code:'PRECHECK-B',warehouse:'Precheck Main'}];
  for(const [index,pair] of pairs.entries()){
   const initial=[20,30,40][index],out=[15,21,28][index];
   await pool.query(`INSERT INTO app_stock_balances(item_code,item_name,warehouse,quantity)
    VALUES($1,$1,$2,$3)`,[pair.item_code,pair.warehouse,initial-out+100]);
   for(const [date,quantity] of [['2026-01-10',initial],['2026-01-11',-out],['2026-01-12',100]])
    await pool.query(`INSERT INTO app_stock_ledger(posting_date,item_code,item_name,warehouse,voucher_type,
     qty_change,qty_after_transaction,stock_value_after_transaction,movement_at)
     VALUES($1,$2,$2,$3,'precheck_fixture',$4,0,0,($1::date+TIME '09:00') AT TIME ZONE 'Africa/Kampala')`,[date,pair.item_code,pair.warehouse,quantity]);
  }
  const payload=quantities=>({invoice_date:'2026-01-10',posting_time:'12:00',items:pairs.flatMap((pair,index)=>[
   {...pair,quantity:quantities[index]/2},{...pair,quantity:quantities[index]/2}])});
  const before=(await pool.query('SELECT * FROM app_stock_balances ORDER BY item_code,warehouse')).rows;
  await validateInvoiceDraftStock(pool,payload([5,9,12]));
  for(let index=0;index<3;index++){
   const quantities=[5,9,12];quantities[index]++;
   await assert.rejects(validateInvoiceDraftStock(pool,payload(quantities)),error=>
    error.code==='insufficient_stock'&&error.stockWarning.item_code===pairs[index].item_code
     &&error.stockWarning.warehouse===pairs[index].warehouse&&error.stockWarning.available===[5,9,12][index]);
  }
  await assert.rejects(validateInvoiceDraftStock(pool,{invoice_date:'2026-01-09',posting_time:'12:00',items:[{...pairs[0],quantity:1}]}),error=>error.stockWarning.available===0);
  await assert.rejects(validateInvoiceDraftStock(pool,{invoice_date:'2026-01-10',posting_time:'12:00',items:[{item_code:'MISSING',warehouse:'Precheck Main',quantity:1}]}),error=>error.stockWarning.available===0);
  for(const pair of [{item_code:null,warehouse:'Precheck Main'},{item_code:'PRECHECK-A',warehouse:null}])
   await assert.rejects(validateInvoiceDraftStock(pool,{invoice_date:'2026-01-10',posting_time:'12:00',items:[{...pair,quantity:1}]}),error=>error.stockWarning.available===0);
  assert.deepEqual((await pool.query('SELECT * FROM app_stock_balances ORDER BY item_code,warehouse')).rows,before);
 }finally{await store.closeStore();}
});

test('invoice saves reject historical/current shortages and closed dates, preserve failed edits, and do not reserve stock',{
 skip:process.env.RECONCILIATION_TEST_POSTGRES!=='1',
},async()=>{
 try{
 await seedGoldenData();const pool=store.getPostgresPool();
 const today=currentPostingDate(),yesterday=new Date(new Date(`${today}T12:00:00Z`).getTime()-86400000).toISOString().slice(0,10);
 const code='DRAFT-STOCK-20-800';
 const line=quantity=>({item_code:code,item_name:code,warehouse:FIXED.warehouse,quantity,unit_price:100,valuation_rate:50});
 await pool.query('INSERT INTO app_master_items(item_code,item_name) VALUES($1,$1),($2,$3) ON CONFLICT DO NOTHING',[code,FIXED.itemCode,FIXED.itemName]);
 await pool.query('INSERT INTO app_master_warehouses(warehouse) VALUES($1) ON CONFLICT DO NOTHING',[FIXED.warehouse]);
 await pool.query("INSERT INTO app_master_customers(customer_id,customer_name) VALUES('DRAFT-C','Draft customer');INSERT INTO app_master_employees(employee_id,employee_name,status) VALUES('DRAFT-E','Draft employee','Active');INSERT INTO app_master_price_lists(price_list,currency,price_type,active) VALUES('DRAFT-L','UGX','selling',1)");
 await store.createStockEntry({entry_type:'opening',posting_date:yesterday,posting_time:'00:00',items:[line(20)]});
 const actor=await auth.createUser('draft-stock-admin','DraftStock123!',{role:'admin'});
 await pool.query('SELECT wm_inventory_activate()');
 await runWithAuditUser(actor,()=>store.createStockEntry({entry_type:'opening',posting_date:today,posting_time:currentPostingTime(),items:[line(780)]}));
 const body=(qs,day=yesterday,time='12:00')=>({customer_id:'DRAFT-C',customer_name:'untrusted',invoicer_id:'DRAFT-E',price_list:'DRAFT-L',warehouse:FIXED.warehouse,invoice_date:day,posting_time:time,items_json:JSON.stringify(qs.map(line))});
 const save=async data=>store.createInvoice(await buildInvoicePayload(data,actor));
 const stock=async()=>Number((await pool.query('SELECT quantity FROM app_stock_balances WHERE item_code=$1 AND warehouse=$2',[code,FIXED.warehouse])).rows[0].quantity);
 const footprint=async()=> (await pool.query('SELECT (SELECT count(*) FROM app_invoices)::int AS invoices,(SELECT count(*) FROM app_stock_ledger)::int AS stock_rows,(SELECT count(*) FROM app_gl_entries)::int AS gl_rows,(SELECT count(*) FROM wm_inventory_events)::int AS events')).rows[0];
 const before=await footprint();
 await assert.rejects(save(body([100])),e=>e.code==='insufficient_stock'&&e.stockWarning.available===20);
 await assert.rejects(save(body([11,10])),e=>e.code==='insufficient_stock'&&e.stockWarning.requested===21);
 await assert.rejects(save(body([801],today,currentPostingTime())),/Cannot save.*insufficient stock/);
 assert.deepEqual(await footprint(),before);assert.equal(await stock(),800);
 const id=await save(body([10]));const saved=await store.findInvoice(id);
 await assert.rejects((async()=>store.updateInvoice(id,await buildInvoicePayload(body([100]),actor)))(),/Cannot save.*insufficient stock/);
 assert.deepEqual(await store.findInvoice(id),saved);
 await store.updateInvoice(id,await buildInvoicePayload(body([15]),actor));assert.equal((await store.findInvoice(id)).items[0].quantity,15);
 const second=await save(body([20]));assert.equal(await stock(),800);
 const afterDrafts=await footprint();assert.equal(afterDrafts.stock_rows,before.stock_rows);assert.equal(afterDrafts.gl_rows,before.gl_rows);assert.equal(afterDrafts.events,before.events);
 await runWithAuditUser(actor,()=>store.submitInvoice(second));assert.equal(await stock(),780);
 await assert.rejects(save(body([1])),e=>e.code==='insufficient_stock'&&e.stockWarning.available===0);
 // Saving did not reserve the historical stock for the first draft: submission
 // must reject it now that the independently saved second draft consumed it.
 await assert.rejects(runWithAuditUser(actor,()=>store.submitInvoice(id)),/insufficient_stock/);
 let count=await countAction(actor,'start',{warehouse:FIXED.warehouse,readiness:'Synthetic save validation: all physical movements stopped and preceding transactions submitted.'});
 count=await countAction(actor,'save',{id:count.id,revision:count.revision,lines:(await loadCount(actor,count.id)).lines.map(r=>({item_code:r.item_code,counted_qty:r.book_qty,valuation_rate:r.book_rate,explanation:''}))});
 count=await countAction(actor,'review',{id:count.id,revision:count.revision});count=await countAction(actor,'approve',{id:count.id,revision:count.revision});await countAction(actor,'submit',{id:count.id,revision:count.revision});
 await assert.rejects(save(body([1])),{code:'inventory_period_closed',status:409});
 const current=await save(body([1],today,currentPostingTime()));assert.equal((await store.findInvoice(current)).docstatus,'draft');assert.equal(await stock(),780);
 }finally{await store.closeStore();}
});
