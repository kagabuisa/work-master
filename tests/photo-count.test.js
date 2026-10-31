'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {quantity,photoCountRows,savePhotoCount,saveAllPhotoCounts}=require('../src/photo-count');
test('photo quantities distinguish blank and zero and reject invalid precision or negative values',()=>{
 assert.equal(quantity(''),null);assert.equal(quantity('0'),'0');assert.equal(quantity('12.125'),'12.125');
 for(const value of ['-1','1.2345','NaN','Infinity','1e2','100000000000'])assert.throws(()=>quantity(value));
});
test('Save all rejects malformed, duplicate and invalid quantities before writing',async()=>{
 const client={query:()=>{throw Error('Database must not be reached');}};
 for(const rows of ['invalid','{}','[]',JSON.stringify([null]),JSON.stringify([{photo_id:'P',verified_qty:'-1'}]),JSON.stringify([{photo_id:'P',verified_qty:'0'},{photo_id:'P',verified_qty:'2'}])]){
  await assert.rejects(saveAllPhotoCounts(client,1,{rows},{role:'admin'}),error=>error.status===400);
 }
});
test('photo physical quantities follow voucher counts while verified quantities and photos persist without posting', {skip:process.env.RECONCILIATION_TEST_POSTGRES!=='1'},async()=>{
 const store=require('../src/store');const {FIXED,seedGoldenData}=require('./helpers/golden-seed');
 try{
 await seedGoldenData();const pg=store.getPostgresPool();
 await pg.query(`INSERT INTO app_master_items(item_code,item_name,photo_count_id) VALUES($1,$2,$3)
 ON CONFLICT(item_code) DO UPDATE SET photo_count_id=EXCLUDED.photo_count_id`,[FIXED.itemCode,FIXED.itemName,'Shared photo']);
 await pg.query("INSERT INTO app_master_items(item_code,item_name,photo_count_id) VALUES('PHOTO-OTHER','Other','Shared photo')");
 await store.createStockEntry({entry_type:'opening',posting_date:FIXED.date,items:[{item_code:'PHOTO-OTHER',item_name:'Other',warehouse:FIXED.warehouse,quantity:3,valuation_rate:5}]});
 const id=await store.createStockEntry({entry_type:'reconciliation',action:'save_draft',posting_date:FIXED.date,items:[{item_code:FIXED.itemCode,item_name:FIXED.itemName,warehouse:FIXED.warehouse,quantity:7,valuation_rate:50}]});
 const expected=(await pg.query('SELECT SUM(quantity)::text AS qty FROM app_stock_balances WHERE warehouse=$1 AND item_code=ANY($2::text[])',[FIXED.warehouse,[FIXED.itemCode,'PHOTO-OTHER']])).rows[0].qty;
 const rows=await photoCountRows(pg,id);assert.equal(rows.length,1);assert.equal(Number(rows[0].inventory_qty),Number(expected));
 assert.equal(Number(rows[0].physical_qty),7);
 await pg.query('INSERT INTO app_reconciliation_photo_counts(stock_entry_id,photo_id,auditor_qty) VALUES($1,$2,99)',[id,'Shared photo']);
 const client=await pg.connect();try{
 await client.query('BEGIN');
 await savePhotoCount(client,id,{photo_id:'Shared photo',verified_qty:'2.5'},[{originalname:'items.png',buffer:Buffer.from([137,80,78,71,13,10,26,10,1])}],{username:'Auditor',id:null});
 await client.query('COMMIT');
 }finally{client.release();}
 const saved=(await photoCountRows(pg,id))[0];assert.equal(Number(saved.physical_qty),7);assert.equal(Number(saved.verified_qty),2.5);
 assert.equal(Number((await pg.query('SELECT auditor_qty FROM app_reconciliation_photo_counts WHERE stock_entry_id=$1',[id])).rows[0].auditor_qty),99);
 assert.equal((await pg.query('SELECT photo_id FROM app_stock_reconciliation_attachments WHERE stock_entry_id=$1',[id])).rows[0].photo_id,'Shared photo');
 assert.equal((await store.loadStockEntry(id)).items[0].quantity,7);
 assert.equal((await pg.query('SELECT count(*)::int AS n FROM app_stock_ledger WHERE voucher_id=$1 AND voucher_type=$2',[id,'stock_reconciliation'])).rows[0].n,0);
 await assert.rejects(()=>savePhotoCount(pg,id,{photo_id:'wrong'},[],{username:'test'}),/Choose a Photo ID/);
 const express=require('express');const app=express();
 app.use((req,res,next)=>{req.currentUser={role:'admin',username:'Photo auditor',id:1};next();});
 app.use('/stock',require('../src/web/routes/stock'));
 const server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});
 try {
 const endpoint=`http://127.0.0.1:${server.address().port}/stock/reconciliations/${id}/photo-count`;
 const form=new FormData();form.append('photo_id','Shared photo');form.append('verified_qty','3.125');
 form.append('photos',new Blob([Buffer.from([255,216,255,1])]),'items.jpg');
 const response=await fetch(endpoint,{method:'POST',body:form,redirect:'manual'});
 assert.equal(response.status,303);assert.equal(response.headers.get('location'),`/stock/reconciliations/${id}/photo-count`);
 assert.equal(Number((await photoCountRows(pg,id))[0].verified_qty),3.125);
 const bulk=new FormData();bulk.append('action','save_all');bulk.append('rows',JSON.stringify([{photo_id:'Shared photo',verified_qty:'0'}]));
 const bulkResponse=await fetch(endpoint,{method:'POST',body:bulk,headers:{Accept:'application/json'}});
 assert.equal(bulkResponse.status,200);assert.deepEqual(await bulkResponse.json(),{saved:1,revision:null});
 assert.equal(Number((await photoCountRows(pg,id))[0].verified_qty),0);
 const rollback=new FormData();rollback.append('action','save_all');rollback.append('rows',JSON.stringify([{photo_id:'Shared photo',verified_qty:'10'},{photo_id:'missing',verified_qty:'20'}]));
 const rolledBack=await fetch(endpoint,{method:'POST',body:rollback,headers:{Accept:'application/json'}});
 assert.equal(rolledBack.status,400);assert.match((await rolledBack.json()).error,/Choose a Photo ID/);
 assert.equal(Number((await photoCountRows(pg,id))[0].verified_qty),0);
 const restore=new FormData();restore.append('action','save_all');restore.append('rows',JSON.stringify([{photo_id:'Shared photo',verified_qty:'3.125'}]));
 assert.equal((await fetch(endpoint,{method:'POST',body:restore,headers:{Accept:'application/json'}})).status,200);
 const attached=(await pg.query('SELECT id FROM app_stock_reconciliation_attachments WHERE stock_entry_id=$1 AND file_name=$2',[id,'items.jpg'])).rows[0];
 const download=await fetch(`http://127.0.0.1:${server.address().port}/stock/reconciliations/${id}/attachments/${attached.id}`);
 assert.equal(download.status,200);assert.equal(download.headers.get('content-type'),'image/jpeg');
 const invalid=new FormData();invalid.append('photo_id','Shared photo');invalid.append('verified_qty','-1');
 const rejected=await fetch(endpoint,{method:'POST',body:invalid,redirect:'manual'});assert.match(rejected.headers.get('location'),/error=/);
 assert.equal(Number((await photoCountRows(pg,id))[0].physical_qty),7);
 await assert.rejects(()=>savePhotoCount(pg,id,{photo_id:'Shared photo',physical_qty:'0'},[],{username:'test'}),/Physical Qty comes from/);
 await assert.rejects(()=>savePhotoCount(pg,id,{photo_id:'Shared photo',auditor_qty:'0'},[],{username:'test'}),/Physical Qty comes from/);
 await store.updateStockEntry(id,{entry_type:'reconciliation',action:'save_draft',posting_date:FIXED.date,items:[{item_code:FIXED.itemCode,item_name:FIXED.itemName,warehouse:FIXED.warehouse,quantity:0,valuation_rate:50}]});
 assert.equal(Number((await photoCountRows(pg,id))[0].physical_qty),0);
 assert.equal(Number((await photoCountRows(pg,id))[0].verified_qty),3.125);
 }finally{await new Promise(resolve=>server.close(resolve));}
 await store.deleteDraftVoucher('stock',id);
 assert.equal((await pg.query('SELECT count(*)::int AS n FROM app_reconciliation_photo_counts WHERE stock_entry_id=$1',[id])).rows[0].n,0);
 const submittedId=await store.createStockEntry({entry_type:'reconciliation',action:'submit',posting_date:FIXED.date,items:[{item_code:FIXED.itemCode,item_name:FIXED.itemName,warehouse:FIXED.warehouse,quantity:5,valuation_rate:50}]});
 assert.equal(Number((await photoCountRows(pg,submittedId))[0].physical_qty),5);
 const posted=(await pg.query('SELECT quantity,counted_quantity FROM app_stock_entry_items WHERE stock_entry_id=$1',[submittedId])).rows[0];
 assert.notEqual(Number(posted.quantity),5);assert.equal(Number(posted.counted_quantity),5);
 await store.cancelStockEntry(submittedId,{posting_date:FIXED.date,reason:'Verify retained physical count'});
 assert.equal(Number((await photoCountRows(pg,submittedId))[0].physical_qty),5);
 }finally{await store.closeStore();}
});
test('photo report uses escaped IDs, row uploads, and permission-based editors',async()=>{
 const {renderView}=require('./helpers/render-view');
 const locals={entry:{id:1,entry_no:'REC-000001',docstatus:'draft'},warehouse:'Main',rows:[{photo_id:'<Photo & ID>',inventory_qty:'12',physical_qty:'0',verified_qty:null}],photos:[],error:null,assetVersion:'test',currentUser:{role:'standard',scopes:{}},availableReports:[],currentPostingTime:()=> '12:00'};
 const file=require('node:path').join(__dirname,'..','views','reconciliation-photo-count.ejs');
 const html=await renderView(file,{...locals,can:()=>true});
 assert.match(html,/Photo Count Rpt/);assert.match(html,/&lt;Photo &amp; ID&gt;/);assert.match(html,/enctype="multipart\/form-data"/);assert.match(html,/id="photo-count-0"/);
 assert.match(html,/>Physical Qty<\/th>/);assert.doesNotMatch(html,/Auditor Qty|name="physical_qty"|name="auditor_qty"/);
 assert.match(html,/href="\/stock\/reconciliations\/1\/edit#reconciliation-form"/);
 assert.match(html,/data-save-all/);assert.doesNotMatch(html,/data-count-all/);
 const readOnly=await renderView(file,{...locals,can:()=>false});assert.doesNotMatch(readOnly,/name="auditor_qty"|name="photos"|Save row/);
 assert.doesNotMatch(readOnly,/data-save-all|data-count-all/);
 const empty=await renderView(file,{...locals,rows:[],can:()=>false});assert.match(empty,/No items with a Photo ID/);
});
test('photo count routes require stock read or edit and saves require edit',()=>{
 const {permissionCheck}=require('../src/authorize');
 const check=(method,permissions,path='/stock/reconciliations/1/photo-count')=>permissionCheck({path,method,body:{},currentUser:{role:'standard',permissions}});
 assert.equal(check('GET',['vouchers.stock.view']),true);
 assert.equal(check('GET',['vouchers.stock.edit']),true);
 assert.equal(check('POST',['vouchers.stock.view']),false);
 assert.equal(check('POST',['vouchers.stock.edit']),true);
 assert.equal(check('GET',[]),false);
 assert.equal(check('GET',['vouchers.stock.view'],'/stock/reconciliations/1/photo-count/unknown'),false);
});

test('controlled photo reports use count permissions and lock completed evidence',async()=>{
 const {permissionCheck}=require('../src/authorize');
 const check=(method,permissions,path='/stock/reconciliations/counts/5/photo-count')=>permissionCheck({path,method,body:{},currentUser:{role:'standard',permissions}});
 assert.equal(check('GET',['inventory.count.view']),true);
 assert.equal(check('POST',['inventory.count.view','inventory.count.save']),true);
 assert.equal(check('POST',['inventory.count.view']),false);
 assert.equal(check('POST',['inventory.count.save']),false);
 assert.equal(check('GET',['vouchers.stock.view','vouchers.stock.edit']),false);
 assert.equal(check('POST',['vouchers.stock.edit']),false);
 assert.equal(check('DELETE',['inventory.count.view','inventory.count.save']),false);
 assert.equal(check('GET',['inventory.count.view'],'/stock/reconciliations/counts/5/photo-count/unknown'),false);
 assert.equal(check('GET',['inventory.count.view'],'/stock/reconciliations/counts/unknown/photo-count'),false);
 const {renderView}=require('./helpers/render-view');
 const file=require('node:path').join(__dirname,'../views/reconciliation-photo-count.ejs');
 const locals={entry:{id:12,entry_no:'REC-000012'},warehouse:'Main',count:{id:5,state:'approved',revision:7},rows:[{photo_id:'Shared photo',inventory_qty:'12',physical_qty:'0',verified_qty:null}],photos:[{id:9,photo_id:'Shared photo',file_name:'items.png'}],error:null,assetVersion:'test',currentUser:{role:'standard',scopes:{}},availableReports:[],can:p=>['inventory.count.view','inventory.count.save'].includes(p)};
 const html=await renderView(file,locals);
 assert.match(html,/action="\/stock\/reconciliations\/counts\/5\/photo-count"/);
 assert.match(html,/name="revision" value="7"/);
 assert.match(html,/href="\/stock\/reconciliations\/counts\/5\/attachments\/9\?preview=1"/);
 assert.match(html,/clears any approval/);
 assert.match(html,/href="\/stock\/reconciliations\/counts\/5#inventory-count-form"/);
 assert.doesNotMatch(html,/Auditor Qty|name="physical_qty"|name="auditor_qty"/);
 const partial=await renderView(file,{...locals,rows:[{...locals.rows[0],physical_qty:null,uncounted_items:2}]});
 assert.match(partial,/2 uncounted items/);
 for(const state of ['submitted','abandoned']) {
  const closed=await renderView(file,{...locals,count:{...locals.count,state}});
  assert.doesNotMatch(closed,/name="auditor_qty"|name="photos"|Save row/);
  assert.match(closed,/read-only/);
  assert.doesNotMatch(closed,/data-save-all|data-count-all/);
  assert.match(closed,/items.png/);
 }
 const viewer=await renderView(file,{...locals,can:p=>p==='inventory.count.view'});
 assert.doesNotMatch(viewer,/name="auditor_qty"|name="photos"|Save row/);
});

test('controlled photo counts work before submission and retain count review and warehouse protections',{skip:process.env.RECONCILIATION_TEST_POSTGRES!=='1'},async()=>{
 const store=require('../src/store');const auth=require('../src/auth');
 const {FIXED,seedGoldenData}=require('./helpers/golden-seed');
 const {countAction,loadCount}=require('../src/inventory-counts');
 const {runWithAuditUser}=require('../src/audit');
 const {withPostgresTransaction}=require('../src/core');
 const {permissionCheck,scopeCheck,can}=require('../src/authorize');
 const express=require('express');const path=require('node:path');const {renderView}=require('./helpers/render-view');
 let server;
 try {
  await seedGoldenData();const pool=store.getPostgresPool();
  const users={};
  for(const [name,actions] of [['maker',['view','start','save','review','submit','abandon']],['reviewer',['view','approve']],['viewer',['view']],['saveOnly',['save']],['stockOnly',[]]]) {
   const user=await auth.createUser('photo-'+name,'PhotoCountPassword123!',{role:'standard'});
   const permissions=actions.map(action=>'inventory.count.'+action);
   if(name==='stockOnly')permissions.push('vouchers.stock.view','vouchers.stock.edit');
   await pool.query('UPDATE app_users SET permission_grants=$1::jsonb WHERE id=$2',[JSON.stringify(permissions),user.id]);
   users[name]={...user,role:'standard',permissions};
  }
  users.blocked={...users.maker,scopes:{warehouses:{mode:'selected',values:['Other warehouse']}}};
  await pool.query('INSERT INTO app_master_warehouses(warehouse) VALUES($1) ON CONFLICT DO NOTHING',[FIXED.warehouse]);
  await pool.query('INSERT INTO app_master_items(item_code,item_name,photo_count_id) VALUES($1,$2,$3) ON CONFLICT(item_code) DO UPDATE SET photo_count_id=EXCLUDED.photo_count_id',[FIXED.itemCode,FIXED.itemName,'Shared photo']);
  await pool.query("INSERT INTO app_master_items(item_code,item_name,photo_count_id,docstatus) VALUES('PHOTO-OTHER','Other','Shared photo','submitted'),('PHOTO-FOUND','Found','Found zero stock','submitted')");
  await store.createStockEntry({entry_type:'opening',posting_date:FIXED.date,items:[{item_code:'PHOTO-OTHER',item_name:'Other',warehouse:FIXED.warehouse,quantity:3,valuation_rate:5}]});
  await pool.query('SELECT wm_inventory_activate()');
  let count=await countAction(users.maker,'start',{warehouse:FIXED.warehouse,readiness:'Physical movements stopped and all preceding documents submitted.'});
  count=await countAction(users.maker,'save',{id:count.id,revision:count.revision,addOnly:true,lines:[{item_code:'PHOTO-FOUND',counted_qty:1,valuation_rate:50,explanation:'Found during physical count'}]});
  assert.equal((await store.loadStockEntry(count.reconciliation_id)).items.length,0);
  let rows=await photoCountRows(pool,count.reconciliation_id);
  assert.deepEqual(rows.map(row=>row.photo_id),['Found zero stock','Shared photo']);
  assert.equal(Number(rows[0].inventory_qty),0);
  assert.equal(Number(rows[0].physical_qty),1);
  assert.equal(rows[1].physical_qty,null);assert.equal(rows[1].uncounted_items,2);
  count=await countAction(users.maker,'save',{id:count.id,revision:count.revision,lines:[{item_code:FIXED.itemCode,counted_qty:0,valuation_rate:50,explanation:'Zero physical quantity recorded'}]});
  const partialRows=await photoCountRows(pool,count.reconciliation_id);
  assert.equal(partialRows[1].physical_qty,null);assert.equal(partialRows[1].uncounted_items,1);
  const sharedQty=(await pool.query('SELECT SUM(quantity)::text qty FROM app_stock_balances WHERE warehouse=$1',[FIXED.warehouse])).rows[0].qty;
  assert.equal(Number(rows[1].inventory_qty),Number(sharedQty));
  const lines=(await loadCount(users.maker,count.id)).lines.map(line=>({...line,counted_qty:line.item_code==='PHOTO-FOUND'?1:line.book_qty,explanation:'Physical quantity checked'}));
  count=await countAction(users.maker,'save',{id:count.id,revision:count.revision,lines});
  count=await countAction(users.maker,'review',{id:count.id,revision:count.revision});
  count=await countAction(users.reviewer,'approve',{id:count.id,revision:count.revision});
  const before=(await pool.query('SELECT item_code,warehouse,quantity::text,stock_value::text FROM app_stock_balances ORDER BY item_code,warehouse')).rows;
  const ledgerBefore=(await pool.query('SELECT count(*)::int n FROM app_stock_ledger')).rows[0].n;
  const app=express();app.set('views',path.join(__dirname,'../views'));app.set('view engine','ejs');
  app.engine('ejs',(file,locals,done)=>renderView(file,locals).then(html=>done(null,html),done));
  app.use((req,res,next)=>{
   req.currentUser=users[req.get('x-test-user')||'maker'];
   res.locals={assetVersion:'test',availableReports:[],currentUser:req.currentUser,can:p=>can(req.currentUser,p)};
   next();
  });
  app.use(async(req,res,next)=>{try{if(!permissionCheck(req)||!await scopeCheck(req))return res.sendStatus(403);runWithAuditUser(req.currentUser,next);}catch(error){next(error);}});
  app.use('/stock',require('../src/web/routes/stock'));
  app.use((error,req,res,next)=>res.status(error.status||500).send(error.message));
  server=await new Promise(resolve=>{const running=app.listen(0,'127.0.0.1',()=>resolve(running));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const endpoint=`${base}/stock/reconciliations/counts/${count.id}/photo-count`;
  const viewer=await fetch(endpoint,{headers:{'x-test-user':'viewer'}});
  assert.equal(viewer.status,200);assert.match(viewer.headers.get('cache-control'),/no-store/);
  assert.match(await viewer.text(),/Shared photo/);
  for(const name of ['stockOnly','saveOnly','blocked'])assert.equal((await fetch(endpoint,{headers:{'x-test-user':name}})).status,403);
  const save=async(revision,verified='2.5',photoTotal=0,user='maker')=>{
   const form=new FormData();form.append('photo_id','Shared photo');form.append('verified_qty',verified);form.append('revision',revision);
   for(let i=0;i<photoTotal;i++)form.append('photos',new Blob([Buffer.from([137,80,78,71,13,10,26,10,1])]),`items-${i}.png`);
   return fetch(endpoint,{method:'POST',headers:{'x-test-user':user},body:form,redirect:'manual'});
  };
  assert.equal((await save(count.revision,'4',0,'viewer')).status,403);
  const approvedRevision=count.revision;
  await assert.rejects(runWithAuditUser(users.saveOnly,()=>withPostgresTransaction(client=>savePhotoCount(client,count.reconciliation_id,{photo_id:'Shared photo',verified_qty:'99',revision:count.revision},[],users.saveOnly),{inventoryExclusive:true})),{status:403});
  const saved=await save(approvedRevision,'2.5',3);
  assert.equal(saved.status,303);assert.equal(saved.headers.get('location'),new URL(endpoint).pathname);
  count=(await loadCount(users.maker,count.id)).count;
  assert.equal(count.state,'counting');assert.equal(count.approved_by,null);assert.equal(Number(count.revision),Number(approvedRevision)+4);
  rows=await photoCountRows(pool,count.reconciliation_id);
  assert.equal(Number(rows[1].physical_qty),Number(sharedQty));assert.equal(Number(rows[1].verified_qty),2.5);
  const photo=(await pool.query('SELECT id FROM app_stock_reconciliation_attachments WHERE stock_entry_id=$1 ORDER BY id LIMIT 1',[count.reconciliation_id])).rows[0];
  const download=`${base}/stock/reconciliations/counts/${count.id}/attachments/${photo.id}`;
  assert.equal((await fetch(download,{headers:{'x-test-user':'viewer'}})).status,200);
  assert.equal((await fetch(download,{headers:{'x-test-user':'blocked'}})).status,403);
  assert.match((await save(approvedRevision,'99')).headers.get('location'),/error=/);
  assert.equal(Number((await photoCountRows(pool,count.reconciliation_id))[1].physical_qty),Number(sharedQty));
  assert.equal(Number((await photoCountRows(pool,count.reconciliation_id))[1].verified_qty),2.5);
  const photoAction=async(action,revision,attachmentId,user='maker',photoId='Shared photo',json=false)=>{
   const form=new FormData();form.append('action',action);form.append('revision',revision);form.append('photo_id',photoId);
   if(attachmentId)form.append('attachment_id',attachmentId);
   if(action==='upload_photo')form.append('photos',new Blob([Buffer.from([137,80,78,71,13,10,26,10,1])]),'automatic-upload.png');
   return fetch(endpoint,{method:'POST',headers:{'x-test-user':user,...(json?{Accept:'application/json'}:{})},body:form,redirect:'manual'});
  };
  assert.equal((await photoAction('remove_photo',count.revision,photo.id,'viewer')).status,403);
  assert.match((await photoAction('remove_photo',approvedRevision,photo.id)).headers.get('location'),/error=/);
  assert.match((await photoAction('remove_photo',count.revision,photo.id,'maker','Found zero stock')).headers.get('location'),/error=/);
  const removeRevision=count.revision;
  const removed=await photoAction('remove_photo',count.revision,photo.id);assert.doesNotMatch(removed.headers.get('location'),/error=/);
  assert.equal((await fetch(download,{headers:{'x-test-user':'viewer'}})).status,404);
  count=(await loadCount(users.maker,count.id)).count;assert.equal(Number(count.revision),Number(removeRevision)+1);
  assert.equal(Number((await photoCountRows(pool,count.reconciliation_id))[1].verified_qty),2.5);
  const autoUploaded=await photoAction('upload_photo',count.revision);assert.doesNotMatch(autoUploaded.headers.get('location'),/error=/);
  count=(await loadCount(users.maker,count.id)).count;
  const ajaxUpload=await photoAction('upload_photo',count.revision,null,'maker','Shared photo',true);assert.equal(ajaxUpload.status,200);
  count=(await loadCount(users.maker,count.id)).count;assert.equal((await ajaxUpload.json()).revision,count.revision);
  const ajaxPhoto=(await pool.query('SELECT id FROM app_stock_reconciliation_attachments WHERE stock_entry_id=$1 ORDER BY id DESC LIMIT 1',[count.reconciliation_id])).rows[0];
  const ajaxRemove=await photoAction('remove_photo',count.revision,ajaxPhoto.id,'maker','Shared photo',true);assert.equal(ajaxRemove.status,200);
  count=(await loadCount(users.maker,count.id)).count;assert.equal((await ajaxRemove.json()).revision,count.revision);
  assert.equal(Number((await photoCountRows(pool,count.reconciliation_id))[1].verified_qty),2.5);
  const retries=await Promise.all([save(count.revision),save(count.revision)]);
  assert.equal(retries.filter(response=>!response.headers.get('location').includes('?error=')).length,1);
  assert.equal(retries.filter(response=>response.headers.get('location').includes('?error=')).length,1);
  count=(await loadCount(users.maker,count.id)).count;
  const bulkSave=async(revision,rows,user='maker')=>{
   const form=new FormData();form.append('action','save_all');form.append('revision',revision);form.append('rows',JSON.stringify(rows));
   return fetch(endpoint,{method:'POST',headers:{'x-test-user':user,Accept:'application/json'},body:form});
  };
  const bulkRows=[{photo_id:'Shared photo',verified_qty:'0'},{photo_id:'Found zero stock',verified_qty:''}];
  for(const name of ['viewer','saveOnly','stockOnly','blocked'])assert.equal((await bulkSave(count.revision,bulkRows,name)).status,403);
  const batchRevision=count.revision;
  const batch=await bulkSave(batchRevision,bulkRows);assert.equal(batch.status,200);
  assert.deepEqual(await batch.json(),{saved:2,revision:batchRevision+3});
  count=(await loadCount(users.maker,count.id)).count;
  assert.equal(count.state,'counting');assert.equal(count.approved_by,null);
  const bulkReport=await photoCountRows(pool,count.reconciliation_id);
  assert.equal(Number(bulkReport.find(r=>r.photo_id==='Shared photo').verified_qty),0);
  assert.equal(bulkReport.find(r=>r.photo_id==='Found zero stock').verified_qty,null);
  assert.equal((await bulkSave(batchRevision,[{photo_id:'Shared photo',verified_qty:'99'}])).status,409);
  const failedBatch=await bulkSave(count.revision,[{photo_id:'Shared photo',verified_qty:'99'},{photo_id:'missing',verified_qty:'99'}]);
  assert.equal(failedBatch.status,400);
  assert.equal((await loadCount(users.maker,count.id)).count.revision,count.revision);
  assert.equal(Number((await photoCountRows(pool,count.reconciliation_id)).find(r=>r.photo_id==='Shared photo').verified_qty),0);
  const restoreBatch=await bulkSave(count.revision,[{photo_id:'Shared photo',verified_qty:'2.5'}]);assert.equal(restoreBatch.status,200);
  count=(await loadCount(users.maker,count.id)).count;
  await pool.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='wm_photo_test_runtime') THEN CREATE ROLE wm_photo_test_runtime NOLOGIN NOINHERIT;END IF;END $$");
  await pool.query('GRANT USAGE ON SCHEMA public TO wm_photo_test_runtime');
  await pool.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO wm_photo_test_runtime');
  await pool.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO wm_photo_test_runtime');
  for(const table of ['wm_inventory_policy','wm_inventory_control','wm_inventory_counts','wm_inventory_count_lines','wm_inventory_closures','wm_inventory_events','wm_inventory_count_audit','wm_inventory_corrections','wm_inventory_correction_audit','app_stock_ledger','app_stock_balances'])await pool.query(`REVOKE ALL ON ${table} FROM wm_photo_test_runtime;GRANT SELECT ON ${table} TO wm_photo_test_runtime`);
  await runWithAuditUser(users.maker,()=>withPostgresTransaction(async client=>{
   await client.query('SET LOCAL ROLE wm_photo_test_runtime');
   assert.equal((await client.query("SELECT has_table_privilege(current_user,'wm_inventory_counts','UPDATE') AS can_update")).rows[0].can_update,false);
   await savePhotoCount(client,count.reconciliation_id,{photo_id:'Shared photo',verified_qty:'2.5',revision:count.revision},[],users.maker);
  },{inventoryExclusive:true}));
  count=(await loadCount(users.maker,count.id)).count;
  assert.deepEqual((await pool.query('SELECT item_code,warehouse,quantity::text,stock_value::text FROM app_stock_balances ORDER BY item_code,warehouse')).rows,before);
  assert.equal((await pool.query('SELECT count(*)::int n FROM app_stock_ledger')).rows[0].n,ledgerBefore);
  count=await countAction(users.maker,'review',{id:count.id,revision:count.revision});
  count=await countAction(users.reviewer,'approve',{id:count.id,revision:count.revision});
  count=await countAction(users.maker,'submit',{id:count.id,revision:count.revision});
  const closed=await fetch(endpoint);assert.equal(closed.status,200);
  assert.doesNotMatch(await closed.text(),/name="auditor_qty"|name="photos"|Save row/);
  assert.match((await save(count.revision,'99')).headers.get('location'),/error=/);
  assert.equal((await bulkSave(count.revision,[{photo_id:'Shared photo',verified_qty:'99'}])).status,409);
  const remainingPhoto=(await pool.query('SELECT id FROM app_stock_reconciliation_attachments WHERE stock_entry_id=$1 LIMIT 1',[count.reconciliation_id])).rows[0];
  assert.match((await photoAction('remove_photo',count.revision,remainingPhoto.id)).headers.get('location'),/error=/);
  assert.equal(Number((await photoCountRows(pool,count.reconciliation_id))[1].physical_qty),Number(sharedQty));
  assert.equal(Number((await photoCountRows(pool,count.reconciliation_id))[1].verified_qty),2.5);
  assert.equal((await pool.query('SELECT count(*)::int n FROM app_stock_reconciliation_attachments WHERE stock_entry_id=$1',[count.reconciliation_id])).rows[0].n,3);
 } finally {if(server)await new Promise(resolve=>server.close(resolve));await store.closeStore();}
});
