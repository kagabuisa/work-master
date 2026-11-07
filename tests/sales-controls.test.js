'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {dateError,minimumRate}=require('../src/shared/sales-controls');
const {normalizeDiscount}=require('../src/approved-discounts');
const controls=require('../src/sales-controls');
test('calendar limits, inclusive boundaries, future dates and pending backdate requests',()=>{
 const today='2026-10-30';
 assert.equal(dateError('2026-10-28',today), '');assert.match(dateError('2026-10-27',today),/2-calendar/);
 assert.equal(dateError('2026-10-20',today,{accountant:true}),'');assert.match(dateError('2026-10-19',today,{accountant:true}),/10-calendar/);
 assert.equal(dateError('2026-10-18',today,{accountant:true},'Backdate'),'');assert.match(dateError('2026-10-17',today,{accountant:true},'Backdate'),/12-calendar/);
 assert.equal(dateError('2026-10-18',today,{accountant:true},'',true),'');
 assert.match(dateError('2026-10-31',today,{director:true}),/Future/);assert.equal(dateError('2000-01-01',today,{director:true}),'');
});
test('discount dates, restrictions, specificity and quantity tiers are deterministic',()=>{
 const ctx={today:'2026-10-30',price_list:'Retail',warehouse_type:'Shop'},item={item_code:'A',warehouse:'W',quantity:4,pricing:{price_list_rate:100}};
 const d={id:1,item_code:'A',status:'Approved',start_date:'2026-01-01',expiry_date:'2026-12-31',min_qty:1,discount_rate:90};
 const choose=ds=>minimumRate(ctx,item,ds);
 assert.equal(choose([{...d,expiry_date:'2026-10-29'}]).rate,100);
 assert.equal(choose([{...d,start_date:'2026-10-31'}]).rate,100);
 for(const change of [{warehouse:'OTHER'},{warehouse_type:'OTHER'},{price_list:'OTHER'},{status:'Disapproved'}])assert.equal(choose([{...d,...change}]).rate,100);
 assert.equal(choose([d,{...d,id:2,min_qty:4,discount_rate:80}]).rate,80);
 assert.equal(choose([{...d,warehouse:'W',discount_rate:95},{...d,id:2,min_qty:4,discount_rate:80}]).rate,95);
 assert.equal(choose([{...d,expiry_date:ctx.today}]).rate,90);
});
test('promotion scope and carton thresholds fall back safely',()=>{
 const ctx={today:'2026-10-30',customer_id:'C',price_list:'Retail',warehouse_type:'Shop'};
 const item={item_code:'A',warehouse:'W',quantity:4,pricing:{promo_rate:70,promo_qty:4,promo_customer:'C',promo_expiry_date:'2026-10-30',carton_price:80,qty_per_carton:4,price_list_rate:100}};
 assert.equal(minimumRate(ctx,item,[]).rate,70);item.pricing.promo_customer='OTHER';assert.equal(minimumRate(ctx,item,[]).rate,80);
 item.pricing.qty_per_carton=0;assert.equal(minimumRate(ctx,item,[]).rate,100);
 item.pricing={unit_cost:50};assert.equal(minimumRate(ctx,item,[]).rate,65);
 item.pricing={};assert.equal(minimumRate(ctx,item,[]).rate,null);
});
test('discount inputs reject invalid dates, negative prices and zero quantity',()=>{
 const d={item_code:'A',status:'Approved',start_date:'2026-10-30',min_qty:'1',discount_rate:'12.345678'};
 assert.equal(normalizeDiscount(d).discount_rate,d.discount_rate);
 for(const change of [{min_qty:'0'},{discount_rate:'-1'},{expiry_date:'2026-10-29'},{start_date:'2026-02-31'}]) assert.throws(()=>normalizeDiscount({...d,...change}));
});
test('server rejects low rates, invoice discount bypasses, and approval forgery',async()=>{
 const client={query:async(sql)=>{
  if(sql.includes('FROM app_master_items'))return {rows:[{item_code:'A',price_list_rate:100}]};
  if(sql.includes('FROM app_approved_discounts'))return {rows:[]};
  if(sql.includes('FROM app_master_warehouses'))return {rows:[{warehouse:'W'}]};
  return {rows:[{customer_name:'Customer'}]};
 }};
 const payload={invoice_date:require('../src/posting-time').currentPostingDate(),customer_id:'C',price_list:'Retail',items:[{item_code:'A',warehouse:'W',quantity:2,unit_price:100}]};
 const options={user:{role:'standard',permissions:[]}};
 await controls.validateInvoice(client,payload,options);
 await assert.rejects(controls.validateInvoice(client,{...payload,discount_amount:1},options),/discount/);
 await assert.rejects(controls.validateInvoice(client,{...payload,items:[{...payload.items[0],unit_price:99}]},options),/minimum rate/);
 await assert.rejects(controls.validateInvoice(client,{...payload,allow:'Backdate'},options),/approval action/);
 const changed=await controls.validateInvoice(client,payload,{...options,saved:{invoice_date:'2020-01-01',action_request:'Backdate',why_cancel:'Late documents',allow:'Backdate',approval_revision:2}});
 assert.equal(changed.allow,'');assert.equal(changed.approval_revision,3);
 const pendingChanged=await controls.validateInvoice(client,payload,{...options,saved:{invoice_date:'2020-01-01',action_request:'Backdate',why_cancel:'Late documents',approval_revision:2}});
 assert.equal(pendingChanged.approval_revision,3);
});
test('Admin can cancel sales invoices without Allow = Cancel approval',async()=>{
 const {runWithAuditUser}=require('../src/audit');
 const clientFor=(role,permissions=[])=>({query:async(sql)=>{
  if(sql.includes('SELECT u.id,u.username,u.role'))return {rows:[{
   id:'1',username:role+'-user',role,active:true,permission_grants:[],permission_denials:[],
   record_access:{},permissions,scopes:{},
  }]};
  throw new Error(`Unexpected query: ${sql}`);
 }});
 await runWithAuditUser({id:1,username:'admin-user'},()=>controls.cancellationAllowed(clientFor('admin'),{allow:''}));
 await assert.rejects(
  runWithAuditUser({id:2,username:'accountant-user'},()=>controls.cancellationAllowed(
   clientFor('standard',['vouchers.sales.cancel','sales.policy.accountant']),{allow:''})),
  /Allow = Cancel/,
 );
});
test('PostgreSQL enforces pending approvals and cancellation before stock effects', {skip:process.env.SCHEMA_TEST_POSTGRES!=='1'},async()=>{
 const store=require('../src/store'),{seedGoldenData,FIXED}=require('./helpers/golden-seed'),{runWithAuditUser}=require('../src/audit');
 let server;
 try {
  await seedGoldenData();const pool=store.getPostgresPool();
  await pool.query('INSERT INTO app_master_items(item_code,item_name,unit_cost) VALUES($1,$2,50)',[FIXED.itemCode,FIXED.itemName]);
  await pool.query('INSERT INTO app_master_customers(customer_id,customer_name) VALUES($1,$2) ON CONFLICT(customer_id) DO NOTHING',[FIXED.customerId,FIXED.customerName]);
  await pool.query("INSERT INTO app_master_warehouses(warehouse,warehouse_type) VALUES($1,'Shop')",[FIXED.warehouse]);
  const user=await require('../src/auth').createUser('sales_control_test','test-password-strong',{role:'standard'});
  await pool.query('UPDATE app_users SET permission_grants=$1 WHERE id=$2',[JSON.stringify(['sales.policy.accountant','sales.approvals.request','vouchers.sales.cancel','vouchers.sales.edit']),user.id]);
  const day=new Date(require('../src/posting-time').currentPostingDate()+'T00:00:00Z');day.setUTCDate(day.getUTCDate()-12);
  const payload={invoice_date:day.toISOString().slice(0,10),customer_id:FIXED.customerId,customer_name:FIXED.customerName,action_request:'Backdate',why_cancel:'Late documents',items:[{item_code:FIXED.itemCode,item_name:FIXED.itemName,warehouse:FIXED.warehouse,quantity:1,unit_price:100}]};
  const id=await runWithAuditUser(user,()=>store.createInvoice(payload));
  await assert.rejects(runWithAuditUser(user,()=>store.submitInvoice(id)),/10-calendar/);
  let invoice=await store.findInvoice(id);assert.equal(invoice.docstatus,'draft');assert.equal(invoice.action_request,'Backdate');
  const reviewer=await require('../src/auth').createUser('sales-reviewer','test-password-strong',{role:'admin'});
  const app=require('express')();app.use(require('express').urlencoded({extended:false}));
  app.use((req,res,next)=>{req.currentUser=req.get('X-Reviewer')==='1'?reviewer:user;runWithAuditUser(req.currentUser,next);});
  app.use(require('../src/web/routes/sales-controls'));app.use((error,req,res,next)=>res.status(error.status || 500).send(error.message));
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const post=async(path,body,review=false)=>fetch(`http://127.0.0.1:${server.address().port}/invoices/${id}/${path}`,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Reviewer':review?'1':'0'},body:new URLSearchParams(body)});
  let response=await post('action-approval',{allow:'Backdate',approval_revision:invoice.approval_revision},true);
  assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/invoices/'+id);
  response=await post('action-request',{action_request:'Backdate',why_cancel:'stale overwrite',approval_revision:invoice.approval_revision});
  assert.match(response.headers.get('location'),/request%20changed/);

  // A preview backdate request changes the saved date through the same draft checks.
  invoice=await store.findInvoice(id);
  const newerDate=new Date(payload.invoice_date+'T00:00:00Z');newerDate.setUTCDate(newerDate.getUTCDate()+1);
  response=await post('action-request',{action_request:'Backdate',why_cancel:'Updated posting day',requested_posting_date:newerDate.toISOString().slice(0,10),approval_revision:invoice.approval_revision});
  assert.equal(response.headers.get('location'),'/invoices/'+id);
  invoice=await store.findInvoice(id);assert.equal(invoice.invoice_date,newerDate.toISOString().slice(0,10));assert.equal(invoice.allow,'');
  response=await post('action-approval',{allow:'Backdate',approval_revision:invoice.approval_revision},true);
  assert.equal(response.headers.get('location'),'/invoices/'+id);
  await runWithAuditUser(user,()=>store.submitInvoice(id));
  await assert.rejects(runWithAuditUser(user,()=>store.cancelInvoice(id)),/Allow = Cancel/);
  assert.equal((await store.findInvoice(id)).docstatus,'submitted');
  invoice=await store.findInvoice(id);
  response=await post('action-request',{action_request:'Cancel',why_cancel:'Incorrect sale',approval_revision:invoice.approval_revision});
  assert.equal(response.headers.get('location'),'/invoices/'+id);
  invoice=await store.findInvoice(id);
  response=await post('action-approval',{allow:'Cancel',approval_revision:invoice.approval_revision},true);
  assert.equal(response.headers.get('location'),'/invoices/'+id);

  await runWithAuditUser(user,()=>store.cancelInvoice(id));
  assert.equal((await store.findInvoice(id)).docstatus,'cancelled');
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await store.closeStore();}
});
test('discount forms and mutually exclusive invoice approval controls render safely',async()=>{
 const {renderView}=require('./helpers/render-view');const path=require('node:path');
 const locals={assetVersion:'test',can:()=>true,currentUser:{role:'admin'},record:{status:'Disapproved'},error:null,warehouses:[],lists:[],types:[]};
 const form=await renderView(path.join(__dirname,'../views/approved-discount-form.ejs'),locals);assert.match(form,/Approved selling rate/);
 const list=await renderView(path.join(__dirname,'../views/approved-discounts.ejs'),{...locals,rows:[],q:'',page:1,hasNext:false});assert.match(list,/No discounts match/);
 const approval=await renderView(path.join(__dirname,'../views/invoice-approval.ejs'),{...locals,invoice:{id:1,docstatus:'submitted',action_request:'Cancel',why_cancel:'<unsafe>'}});assert.match(approval,/&lt;unsafe&gt;/);assert.match(approval,/action-approval/);assert.match(approval,/ui-approval-status-grid/);assert.match(approval,/Keep unapproved/);assert.match(approval,/Save decision/);assert.doesNotMatch(approval,/Request: <strong>None/);
});
test('invoice list exposes cancellation and preserves the filtered return path',async()=>{
 const {renderView}=require('./helpers/render-view');const path=require('node:path');
 const invoice={id:12,invoice_no:'INV-000012',docstatus:'submitted',invoice_date:'2026-01-15',posting_time:'10:00',customer_id:'CUSTOMER',total:100,amount_paid:0,status:'unpaid',allow:''};
 const common={assetVersion:'test',availableReports:[],currentUser:{id:7,role:'standard',username:'cashier'},invoices:[invoice],pagination:{total:1,offset:0},query:{q:'CUSTOMER'},search:'CUSTOMER',warehouses:[],money:String,formatDate:String,formatDateTime:(date,time)=>`${date} ${time}`,returnTo:'/invoices?q=CUSTOMER'};
 const html=await renderView(path.join(__dirname,'../views/invoices.ejs'),{...common,can:key=>['vouchers.sales.view','vouchers.sales.cancel'].includes(key)});
 assert.match(html,/action="\/invoices\/12\/cancel"/);
 assert.match(html,/name="return_to" value="\/invoices\?q=CUSTOMER"/);
 assert.match(html,/>Cancel<\/button>/);
 const accountant=await renderView(path.join(__dirname,'../views/invoices.ejs'),{...common,can:key=>['vouchers.sales.view','vouchers.sales.cancel','sales.policy.accountant'].includes(key)});
 assert.match(accountant,/Request Cancel and obtain Allow = Cancel/);
 assert.match(accountant,/disabled>Cancel<\/button>/);
 const reader=await renderView(path.join(__dirname,'../views/invoices.ejs'),{...common,can:key=>key==='vouchers.sales.view'});
 assert.doesNotMatch(reader,/action="\/invoices\/12\/cancel"/);
});
test('minimum comparison preserves six decimals at large selling rates',()=>{
 const {scaledRate}=require('../src/shared/sales-controls');
 assert(scaledRate('999999999998.123456')>scaledRate('999999999998.123455'));
 const result=minimumRate({today:'2026-10-30'},{pricing:{price_list_rate:'999999999998.123456'}},[]);
 assert.equal(result.rate,'999999999998.123456');
});
