'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {quantity,photoCountRows,savePhotoCount}=require('../src/photo-count');
test('photo quantities distinguish blank and zero and reject invalid precision or negative values',()=>{
 assert.equal(quantity(''),null);assert.equal(quantity('0'),'0');assert.equal(quantity('12.125'),'12.125');
 for(const value of ['-1','1.2345','NaN','Infinity','1e2','100000000000'])assert.throws(()=>quantity(value));
});
test('photo counts group warehouse stock and persist independently without posting', {skip:process.env.RECONCILIATION_TEST_POSTGRES!=='1'},async()=>{
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
 const client=await pg.connect();try{
 await client.query('BEGIN');
 await savePhotoCount(client,id,{photo_id:'Shared photo',auditor_qty:'0',verified_qty:'2.5'},[{originalname:'items.png',buffer:Buffer.from([137,80,78,71,13,10,26,10,1])}],{username:'Auditor',id:null});
 await client.query('COMMIT');
 }finally{client.release();}
 const saved=(await photoCountRows(pg,id))[0];assert.equal(Number(saved.auditor_qty),0);assert.equal(Number(saved.verified_qty),2.5);
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
 const form=new FormData();form.append('photo_id','Shared photo');form.append('auditor_qty','4');form.append('verified_qty','3.125');
 form.append('photos',new Blob([Buffer.from([255,216,255,1])]),'items.jpg');
 const response=await fetch(endpoint,{method:'POST',body:form,redirect:'manual'});
 assert.equal(response.status,303);assert.equal(response.headers.get('location'),`/stock/reconciliations/${id}/photo-count`);
 assert.equal(Number((await photoCountRows(pg,id))[0].verified_qty),3.125);
 const attached=(await pg.query('SELECT id FROM app_stock_reconciliation_attachments WHERE stock_entry_id=$1 AND file_name=$2',[id,'items.jpg'])).rows[0];
 const download=await fetch(`http://127.0.0.1:${server.address().port}/stock/reconciliations/${id}/attachments/${attached.id}`);
 assert.equal(download.status,200);assert.equal(download.headers.get('content-type'),'image/jpeg');
 const invalid=new FormData();invalid.append('photo_id','Shared photo');invalid.append('auditor_qty','-1');
 const rejected=await fetch(endpoint,{method:'POST',body:invalid,redirect:'manual'});assert.match(rejected.headers.get('location'),/error=/);
 assert.equal(Number((await photoCountRows(pg,id))[0].auditor_qty),4);
 }finally{await new Promise(resolve=>server.close(resolve));}
 await store.deleteDraftVoucher('stock',id);
 assert.equal((await pg.query('SELECT count(*)::int AS n FROM app_reconciliation_photo_counts WHERE stock_entry_id=$1',[id])).rows[0].n,0);
 }finally{await store.closeStore();}
});
test('photo report uses escaped IDs, row uploads, and permission-based editors',async()=>{
 const {renderView}=require('./helpers/render-view');
 const locals={entry:{id:1,entry_no:'REC-000001'},warehouse:'Main',rows:[{photo_id:'<Photo & ID>',inventory_qty:'12',auditor_qty:'0',verified_qty:null}],photos:[],error:null,assetVersion:'test',currentUser:{role:'standard',scopes:{}},availableReports:[],currentPostingTime:()=> '12:00'};
 const file=require('node:path').join(__dirname,'..','views','reconciliation-photo-count.ejs');
 const html=await renderView(file,{...locals,can:()=>true});
 assert.match(html,/Photo Count Rpt/);assert.match(html,/&lt;Photo &amp; ID&gt;/);assert.match(html,/enctype="multipart\/form-data"/);assert.match(html,/form="photo-count-0"/);
 const readOnly=await renderView(file,{...locals,can:()=>false});assert.doesNotMatch(readOnly,/name="auditor_qty"|name="photos"|Save row/);
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
