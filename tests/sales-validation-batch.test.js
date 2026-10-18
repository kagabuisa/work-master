'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const store=require('../src/store');const {buildInvoicePayload}=require('../src/services/sales-validation');
test('multi-line website validation uses three reads and preserves master and stock checks',{
 skip:process.env.GL_EXPORT_TEST_POSTGRES!=='1',
},async()=>{
 try{
  await require('./helpers/golden-seed').resetGoldenSchema();const p=store.getPostgresPool();
  await p.query(`INSERT INTO app_master_customers(customer_id,customer_name,docstatus) VALUES ('B-C','Batch Customer','submitted');
   INSERT INTO app_master_price_lists(price_list,currency,price_type,active) VALUES ('Batch','UGX','selling',1);
   INSERT INTO app_master_employees(employee_id,employee_name,status) VALUES ('B-E','Batch Employee','Active');
   INSERT INTO app_master_items(item_code,item_name,docstatus) VALUES ('B-I','Batch Item','submitted');
   INSERT INTO app_master_warehouses(warehouse) VALUES ('Main')`);
  await store.createStockEntry({entry_type:'opening',posting_date:'2026-01-01',posting_time:'00:00',items:[{item_code:'B-I',item_name:'Batch Item',warehouse:'Main',quantity:10,valuation_rate:1}]});
  const body={customer_id:'B-C',customer_name:'untrusted',invoice_date:'2026-01-01',invoicer_id:'B-E',price_list:'Batch',warehouse:'Main',
   items_json:JSON.stringify(Array.from({length:20},()=>({item_code:'B-I',quantity:0.25,unit_price:100})))};
  const original=p.query.bind(p);let queries=0;
  p.query=(...args)=>{queries++;return original(...args);};
  let payload;try{payload=await buildInvoicePayload(body,{role:'admin'},{checkStock:true});}finally{p.query=original;}
  assert.equal(queries,3);assert.equal(payload.items.length,20);assert.equal(payload.customer_name,'Batch Customer');
  assert.ok(payload.items.every(i=>i.stock_at_sale===10&&i.item_name==='Batch Item'));
  await assert.rejects(buildInvoicePayload({...body,items_json:'{}'},{role:'admin'}),error=>error.status===400);
  const invalid={...body,items_json:JSON.stringify([{item_code:'B-I',quantity:11,unit_price:100}])};
  await assert.rejects(buildInvoicePayload(invalid,{role:'admin'},{checkStock:true}),e=>e.code==='insufficient_stock');
  await assert.rejects(buildInvoicePayload(invalid,{role:'admin'}),e=>e.code==='insufficient_stock');
  await p.query("UPDATE app_master_items SET disabled=true WHERE item_code='B-I'");
  await assert.rejects(buildInvoicePayload(body,{role:'admin'}),/not available/);
  await p.query("UPDATE app_master_items SET disabled=false; UPDATE app_master_customers SET disabled=true");
  await assert.rejects(buildInvoicePayload(body,{role:'admin'}),/Select a customer/);
 }finally{await store.closeStore();}
});
