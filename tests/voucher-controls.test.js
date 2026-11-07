'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const store=require('../src/store'),purchases=require('../src/purchases'),controls=require('../src/voucher-controls');
const {runWithAuditUser}=require('../src/audit');
const {withPostgresTransaction}=require('../src/core');
const {currentPostingDate}=require('../src/posting-time');
const {FIXED,seedGoldenData}=require('./helpers/golden-seed');
const {permissionCheck}=require('../src/authorize');
test('voucher request routes allow readers to request but reserve approval to Admin',()=>{
 for(const [kind,base] of Object.entries(controls.configs)) {
  const user={role:'standard',permissions:[`vouchers.${kind}.view`]};
  assert.equal(permissionCheck({path:base.base+'/1/action-request',method:'POST',currentUser:user}),true);
  assert.equal(permissionCheck({path:base.base+'/1/action-approval',method:'POST',currentUser:user}),false);
  assert.equal(permissionCheck({path:base.base+'/1/action-approval',method:'POST',currentUser:{role:'admin'}}),true);
 }
});
test('compact voucher request and approval views escape reasons and show Admin actions only to Admin',async()=>{
 const {renderView}=require('./helpers/render-view');const path=require('node:path');
 const record={id:1,posting_date:'2026-01-01',docstatus:'submitted'};
 const voucherControl={voucher_kind:'purchases',base:'/purchases',record,revision:2,action_request:'Cancel',reason:'<unsafe>',allow:'',events:[]};
 const locals={currentUser:{role:'standard'},voucherControl,can:()=>true};
 let html=await renderView(path.join(__dirname,'../views/voucher-approval.ejs'),locals);
 assert.match(html,/&lt;unsafe&gt;/);assert.match(html,/data-request-cancel/);assert.match(html,/ui-approval-workflow/);assert.match(html,/Requested action/);assert.doesNotMatch(html,/Approve Cancellation/);
 html=await renderView(path.join(__dirname,'../views/voucher-approval.ejs'),{...locals,currentUser:{role:'admin'}});
 assert.match(html,/Approve Cancellation/);assert.match(html,/Approval decision/);
 assert.match(html,/Admin cancellation does not require approval/);
});
test('Admin cancellation bypasses approval and records an auditable override',async()=>{
 const {auditActor}=require('../src/audit');
 const yesterday=new Date(currentPostingDate()+'T00:00:00Z');yesterday.setUTCDate(yesterday.getUTCDate()-1);
 const makeClient=(role)=>{
  const events=[];
  return {events,async query(sql,params=[]){
   if(sql.includes('SELECT * FROM app_purchases WHERE id=$1'))return {rows:[{
    id:1,posting_date:yesterday.toISOString().slice(0,10),posting_time:'12:00',docstatus:'submitted',
    due_date:null,supplier_id:'SUP-1',supplier_reference:null,price_list:'Buying',purchase_order_id:null,
    cost_center:null,subtotal:100,total:100,
   }]};
   if(sql.includes('SELECT * FROM app_purchase_items'))return {rows:[]};
   if(sql.includes('SELECT u.id,u.username,u.role'))return {rows:[{
    id:'1',username:role+'-user',role,active:true,permission_grants:[],permission_denials:[],
    record_access:{},permissions:[],scopes:{},
   }]};
   if(sql.includes('SELECT * FROM app_voucher_approvals'))return {rows:[]};
   if(sql.includes('INSERT INTO app_voucher_approval_events')){events.push({sql,params});return {rows:[]};}
   throw new Error(`Unexpected query: ${sql}`);
  }};
 };
 const adminClient=makeClient('admin');
 await runWithAuditUser({id:1,username:'admin-user'},()=>controls.requireApproval(adminClient,'purchases',1,'Cancel'));
 assert.equal(adminClient.events.length,1);
 assert.equal(adminClient.events[0].params[2],'admin_override_cancel');
 assert.equal(adminClient.events[0].params[3],'1');
 assert.equal(adminClient.events[0].params[4],'admin-user');
 await assert.rejects(
  runWithAuditUser({id:1,username:'admin-user'},()=>controls.requireApproval(makeClient('admin'),'purchases',1,'Backdate')),
  /Backdating requires Admin approval/,
 );
 const makerClient=makeClient('standard');
 await assert.rejects(
  runWithAuditUser({id:2,username:'maker'},()=>controls.requireApproval(makerClient,'purchases',1,'Cancel')),
  /Cancellation requires Admin approval/,
 );
 assert.equal(makerClient.events.length,0);
 assert.equal(auditActor().id,null);
});
test('backdating and cancellation bind to reviewed versions, require explicit Admin approval, and commit atomically', {skip:process.env.SCHEMA_TEST_POSTGRES!=='1'},async()=>{
 let server;
 try {
  await seedGoldenData();const pool=store.getPostgresPool(),auth=require('../src/auth');
  const admin=await auth.createUser('voucher-admin','VoucherPassword123!',{role:'admin'});
  const user=await auth.createUser('voucher-maker','VoucherPassword123!',{role:'standard'});
  await pool.query('UPDATE app_users SET permission_grants=$1 WHERE id=$2',[JSON.stringify(['vouchers.purchases.view','vouchers.purchases.create','vouchers.purchases.edit','vouchers.stock.view','vouchers.stock.edit','vouchers.journals.view','vouchers.journals.edit']),user.id]);
  await pool.query('INSERT INTO app_master_suppliers(supplier_id,supplier_name) VALUES($1,$2) ON CONFLICT(supplier_id) DO NOTHING',[FIXED.supplierRef,FIXED.supplierName]);
  await pool.query('INSERT INTO app_master_items(item_code,item_name) VALUES($1,$2)',[FIXED.itemCode,FIXED.itemName]);
  await pool.query('INSERT INTO app_master_warehouses(warehouse) VALUES($1)',[FIXED.warehouse]);
  await pool.query("INSERT INTO app_master_price_lists(price_list,currency,price_type,active) VALUES('Voucher Buying','UGX','buying',1)");
  const today=currentPostingDate(),past=new Date(today+'T00:00:00Z');past.setUTCDate(past.getUTCDate()-1);const yesterday=past.toISOString().slice(0,10);
  const accounts=(await store.accountingAccounts()),a=code=>accounts.find(row=>row.account_code===code).id;
  const fixtures=[
   ['purchases',{posting_date:yesterday,supplier_id:FIXED.supplierRef,price_list:'Voucher Buying',items:[{item_code:FIXED.itemCode,warehouse:FIXED.warehouse,quantity:1,unit_price:100}]},purchases.createPurchase,purchases.updatePurchase,purchases.submitPurchase,purchases.cancelPurchase],
   ['journals',{posting_date:yesterday,journal_type:'journal_entry',lines:[{account_id:a('1120'),debit:100},{account_id:a('3000'),credit:100}]},p=>store.createJournalEntry(p,{submit:false}),store.updateJournalEntry,store.submitJournalEntry,store.cancelJournalEntry],
   ['stock',{posting_date:yesterday,posting_time:'12:00',entry_type:'opening',action:'save_draft',items:[{item_code:FIXED.itemCode,item_name:FIXED.itemName,warehouse:FIXED.warehouse,quantity:1,valuation_rate:100}]},store.createStockEntry,store.updateStockEntry,null,id=>store.cancelStockEntry(id)],
  ];
  for(const [kind,payload,create,update,submit,cancel] of fixtures) {
   const asUser=fn=>runWithAuditUser(user,fn),asAdmin=fn=>runWithAuditUser(admin,fn);
   const id=await asUser(()=>create(payload));
   const read=()=>controls.view(pool,kind,id);
   const act=async(allow,approve=false,actor=approve?asAdmin:asUser)=>{const v=await read();return actor(()=>withPostgresTransaction(client=>controls.act(client,kind,id,{control_revision:v.revision,...(approve?{allow}:{action_request:allow,why_cancel:'Late source documents'})},approve)));};
   const post=()=>asUser(()=>submit?submit(id):update(id,{...payload,action:'submit'}));
   await assert.rejects(post(),/requires Admin approval/);
   await act('Backdate');let v=await read(),revision=v.revision;
   await assert.rejects(asUser(()=>withPostgresTransaction(client=>controls.act(client,kind,id,{control_revision:revision,allow:'Backdate'},true))),/Only Admin/);
   await act('Backdate',true);await assert.rejects(asAdmin(()=>withPostgresTransaction(client=>controls.act(client,kind,id,{control_revision:revision,allow:'Backdate'},true))),/changed/);
   assert.equal((await read()).allow,'Backdate');
   const changed=structuredClone(payload);
   if(kind==='journals'){changed.lines[0].debit=101;changed.lines[1].credit=101;}
   else changed.items[0].quantity=2;
   await asUser(()=>update(id,changed));v=await read();assert.equal(v.allow,'');assert.equal(v.events[0].event,'approval_invalidated');
   await assert.rejects(post(),/requires Admin approval/);
   // Restore and freshly approve the precise submitted version.
   await asUser(()=>update(id,payload));await act('Backdate',true);await post();
   await assert.rejects(asUser(()=>cancel(id)),/requires Admin approval/);
   await act('Cancel');await act('Cancel',true);
   await asUser(()=>cancel(id));v=await read();assert.equal(v.record.docstatus,'cancelled');assert.equal(v.events[0].event,'approval_used');
   assert.ok(v.events.some(event=>event.event==='approved'&&event.actor_name===admin.username));
  }
  for(const [kind,payload,create] of fixtures) await assert.rejects(runWithAuditUser(user,()=>create({...payload,posting_date:'2999-01-01'})),/future/);
  await assert.rejects(pool.query("UPDATE app_voucher_approval_events SET actor_name='forged'"),/immutable/);
  // Browser request paths repeat current access and Admin checks and allow preview date selection.
  const express=require('express'),app=express();app.use(express.urlencoded({extended:false}));
  app.use((req,res,next)=>{req.currentUser=req.get('X-Admin')==='1'?admin:user;runWithAuditUser(req.currentUser,next);});
  app.use(require('../src/web/routes/voucher-controls'));app.use((e,req,res,next)=>res.status(e.status || 500).send(e.message));
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const draft=await runWithAuditUser(user,()=>purchases.createPurchase({...fixtures[0][1],posting_date:today}));
  const v=await controls.view(pool,'purchases',draft);
  const response=await fetch(`http://127.0.0.1:${server.address().port}/purchases/${draft}/action-request`,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({control_revision:v.revision,action_request:'Backdate',why_cancel:'Late invoice',requested_posting_date:yesterday})});
  assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/purchases/'+draft);
  assert.equal(require('../src/lib/dates').dateOnly((await controls.view(pool,'purchases',draft)).record.posting_date),yesterday);
 } finally {if(server)await new Promise(resolve=>server.close(resolve));await store.closeStore();}
});
