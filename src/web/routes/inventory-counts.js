'use strict';
const router=require('express').Router();
router.use((_req,res,next)=>{res.locals.countEffects=require('../../../public/count-effects');next();});
// Preserve bookmarks while keeping all workflow screens under reconciliation.
router.use((req,res,next)=>{
 if(req.method==='GET' && req.baseUrl==='/stock' && /^\/(counts|corrections)(\/|$)/.test(req.path))
   return res.redirect(303, `/stock/reconciliations${req.url}`);
 next();
});
const {getPostgresPool}=require('../../core');
const {warehouseAllowed,accountAllowed,categoryAllowed}=require('../../access');
const {can}=require('../../authorize');
const {countAction,correctionAction,loadCount}=require('../../inventory-counts');
const arrays=value=>Array.isArray(value)?value:value===undefined?[]:[value];
const stamp=value=>value?new Date(value).toLocaleString('en-GB',{timeZone:'Africa/Kampala',hour12:false}):'—';
async function indexData(user){
 const pool=getPostgresPool();
 const enabled=(await pool.query('SELECT wm_inventory_enabled() AS enabled')).rows[0].enabled;
 const warehouses=(await pool.query(`SELECT w.warehouse,c.active_count,c.closed_through FROM app_master_warehouses w LEFT JOIN wm_inventory_control c USING(warehouse) WHERE NOT w.disabled AND NOT w.is_group ORDER BY w.warehouse`)).rows.filter(row=>warehouseAllowed(user,row.warehouse));
 const counts=(await pool.query('SELECT c.*,s.entry_no FROM wm_inventory_counts c JOIN app_stock_entries s ON s.id=c.reconciliation_id ORDER BY c.id DESC LIMIT 200')).rows.filter(row=>warehouseAllowed(user,row.warehouse));
 const pending=(await pool.query(`SELECT 'Sales invoice' kind,i.invoice_no reference,x.warehouse FROM app_invoices i JOIN app_invoice_items x ON x.invoice_pk=i.id WHERE i.docstatus='draft'
 UNION SELECT 'Purchase',p.purchase_no,x.warehouse FROM app_purchases p JOIN app_purchase_items x ON x.purchase_id=p.id WHERE p.docstatus='draft'
 UNION SELECT 'Stock entry',s.entry_no,x.warehouse FROM app_stock_entries s JOIN app_stock_entry_items x ON x.stock_entry_id=s.id WHERE s.docstatus='draft' AND s.entry_type<>'reconciliation'
 UNION SELECT 'Physical correction',source_reference,warehouse FROM wm_inventory_corrections WHERE state IN('draft','approved') AND treatment='physical' LIMIT 200`)).rows.filter(row=>warehouseAllowed(user,row.warehouse));
 return {enabled,warehouses,counts,pending,stamp};
}
router.get('/counts',async(req,res,next)=>{try{res.render('inventory-counts',{...await indexData(req.currentUser),error:req.query.error||null});}catch(error){next(error);}});
router.post('/counts',async(req,res,next)=>{try{
 const count=await countAction(req.currentUser,'start',{warehouse:req.body.warehouse,readiness:req.body.readiness});res.redirect(303,`/stock/reconciliations/counts/${count.id}`);
}catch(error){if(error.status||error.code==='P0001')res.status(error.status||409).render('inventory-counts',{...await indexData(req.currentUser),error:error.message});else next(error);}});
const scans=require('../../reconciliation-attachments');
const {withPostgresTransaction}=require('../../core');
router.get('/counts/:id/items',async(req,res,next)=>{try{
 const {count}=await loadCount(req.currentUser,req.params.id);
 const query=String(req.query.q||'').trim();
 if(!query)return res.json([]);
 const {rows}=await getPostgresPool().query(`SELECT i.item_code,i.item_name,
   COALESCE(NULLIF(b.valuation_rate,0),i.unit_cost,0)::float AS valuation_rate
   FROM app_master_items i LEFT JOIN app_stock_balances b ON b.item_code=i.item_code AND b.warehouse=$1
   WHERE NOT i.disabled AND i.docstatus='submitted'
   AND (strpos(lower(i.item_code),lower($2))>0 OR strpos(lower(i.item_name),lower($2))>0)
   ORDER BY (i.item_code=$2) DESC,i.item_code LIMIT 50`,[count.warehouse,query]);
 res.set('Cache-Control','private, no-store');res.json(rows);
}catch(error){next(error);}});
router.get('/counts/:id/attachments',async(req,res,next)=>{try{
 const {count}=await loadCount(req.currentUser,req.params.id);
 const files=await scans.listAttachments(getPostgresPool(),count.reconciliation_id);
 res.set('Cache-Control','private, no-store');res.json(files.map(file=>({...file,uploaded_time:stamp(file.uploaded_at)})));
}catch(error){next(error);}});
router.get('/counts/:id/attachments/:fileId',async(req,res,next)=>{try{
 const {count}=await loadCount(req.currentUser,req.params.id);const file=await scans.findAttachment(getPostgresPool(),count.reconciliation_id,req.params.fileId);
 res.set('Cache-Control','private, no-store');res.set('X-Content-Type-Options','nosniff');res.type(file.content_type);res.attachment(file.file_name);res.send(file.content);
}catch(error){next(error);}});
const scanUpload=require('multer')({storage:require('multer').memoryStorage(),limits:{fileSize:scans.MAX_SCAN_BYTES,files:scans.MAX_SCAN_FILES,fields:0}}).array('scans',scans.MAX_SCAN_FILES);
router.post('/counts/:id/attachments',(req,res,next)=>scanUpload(req,res,async uploadError=>{try{
 if(uploadError)throw Object.assign(new Error('Upload up to three supported count sheets/photos, maximum 10 MB each.'),{status:400});
 const {count}=await loadCount(req.currentUser,req.params.id);
 await withPostgresTransaction(client=>scans.saveAttachments(client,count.reconciliation_id,req.files,req.currentUser),{inventoryExclusive:true});
 res.json({uploaded:req.files.length});
}catch(error){if(error.status)res.status(error.status).json({error:error.message});else next(error);}}));
router.post('/counts/:id/attachments/:fileId/delete',async(req,res,next)=>{try{
 const {count}=await loadCount(req.currentUser,req.params.id);
 await withPostgresTransaction(client=>scans.deleteAttachment(client,count.reconciliation_id,req.params.fileId),{inventoryExclusive:true});res.json({deleted:true});
}catch(error){if(error.status)res.status(error.status).json({error:error.message});else next(error);}});
router.get('/counts/:id/sheet',async(req,res,next)=>{try{
 const {count,lines}=await loadCount(req.currentUser,req.params.id);
 const {createCountSheet,countSheetFilename}=require('../../stock-count-sheet');
 const session={id:count.id,revision:count.revision,cutoff:count.cutoff.toISOString()};
 const buffer=await createCountSheet(count.warehouse,lines.map(l=>({...l,quantity:l.book_qty})),session);
 res.set('Cache-Control','private, no-store');res.attachment(countSheetFilename(`COUNT-${count.id}-REV-${count.revision}`,count.warehouse));res.send(buffer);
}catch(error){next(error);}});
const sheetUpload=require('multer')({storage:require('multer').memoryStorage(),limits:{fileSize:5*1024*1024,files:1,fields:0}}).single('count_sheet');
router.post('/counts/:id/sheet',(req,res,next)=>sheetUpload(req,res,async uploadError=>{try{
 if(uploadError||!req.file)throw Object.assign(new Error('Upload one Excel count sheet, no larger than 5 MB.'),{status:400});
 const {count,lines}=await loadCount(req.currentUser,req.params.id);
 const session={id:count.id,revision:count.revision,cutoff:count.cutoff.toISOString()};
 const imported=await require('../../stock-count-sheet').readCountSheet(req.file.buffer,count.warehouse,session);
 const byCode=new Map(lines.map(l=>[l.item_code,l]));
 await countAction(req.currentUser,'save',{id:count.id,revision:count.revision,sheet_import:true,lines:imported.map(i=>({item_code:i.item_code,counted_qty:i.quantity,valuation_rate:byCode.get(i.item_code)?.valuation_rate||0,explanation:byCode.get(i.item_code)?.explanation||''}))});
 res.redirect(303,`/stock/reconciliations/counts/${count.id}`);
}catch(error){if(error.status||error.code==='P0001')res.redirect(303,`/stock/reconciliations/counts/${req.params.id}?error=${encodeURIComponent(error.message)}`);else next(error);}}));
router.get('/counts/:id',async(req,res,next)=>{try{res.render('inventory-count',{...await loadCount(req.currentUser,req.params.id),stamp,error:req.query.error||null});}catch(error){next(error);}});
router.post('/counts/:id/found-item',async(req,res,next)=>{try{
 const code=String(req.body.found_item||'').trim();
 const count=await countAction(req.currentUser,'save',{id:req.params.id,revision:Number(req.body.revision),addOnly:true,
   lines:[{item_code:code,counted_qty:req.body.found_quantity,valuation_rate:req.body.found_rate,explanation:req.body.found_reason}]});
 const line=(await getPostgresPool().query('SELECT * FROM wm_inventory_count_lines WHERE count_id=$1 AND item_code=$2',[count.id,code])).rows[0];
 res.json({revision:count.revision,line});
}catch(error){if(error.status||error.code==='P0001')res.status(error.status||409).json({error:error.message});else next(error);}});
router.post('/counts/:id/:action',async(req,res,next)=>{try{
 const action=req.params.action;
 const payload=req.countPayload={id:req.params.id,revision:Number(req.body.revision),reason:req.body.reason};
 if(action==='save'){
 const codes=arrays(req.body.item_code),qty=arrays(req.body.counted_qty),rates=arrays(req.body.valuation_rate),explanations=arrays(req.body.explanation);
 payload.lines=codes.map((code,index)=>({item_code:code,counted_qty:qty[index]===''?null:qty[index],valuation_rate:rates[index],explanation:explanations[index]||''}));

 }
 await countAction(req.currentUser,action,payload);res.redirect(303,`/stock/reconciliations/counts/${req.params.id}`);
}catch(error){if(error.status||error.code==='P0001'){
 if(req.params.action==='save'&&req.countPayload){const data=await loadCount(req.currentUser,req.params.id);const attempted=new Map((req.countPayload.lines||[]).map(l=>[l.item_code,l]));data.lines=data.lines.map(l=>({...l,...(attempted.get(l.item_code)||{})}));res.status(error.status||409).render('inventory-count',{...data,stamp,error:error.message});}
 else res.redirect(303,`/stock/reconciliations/counts/${req.params.id}?error=${encodeURIComponent(error.message)}`);
 }else next(error);}});
router.get('/corrections',async(req,res,next)=>{try{
 const data=await indexData(req.currentUser);
 let corrections=(await getPostgresPool().query('SELECT * FROM wm_inventory_corrections ORDER BY id DESC LIMIT 200')).rows.filter(row=>warehouseAllowed(req.currentUser,row.warehouse)&&row.financial_lines.every(line=>accountAllowed(req.currentUser,line.account_id)));
 if(req.currentUser.role!=='admin'){
   const customerIds=[...new Set(corrections.flatMap(c=>c.financial_lines.filter(l=>l.party_type==='customer').map(l=>l.party_id)))];
   const supplierIds=[...new Set(corrections.flatMap(c=>c.financial_lines.filter(l=>l.party_type==='supplier').map(l=>l.party_id)))];
   const customers=(await getPostgresPool().query('SELECT customer_id,customer_group FROM app_master_customers WHERE customer_id=ANY($1::text[])',[customerIds])).rows;
   const suppliers=(await getPostgresPool().query('SELECT supplier_id,supplier_type FROM app_master_suppliers WHERE supplier_id=ANY($1::text[])',[supplierIds])).rows;
   corrections=corrections.filter(c=>c.financial_lines.every(l=>l.party_type==='customer'?customers.some(p=>p.customer_id===l.party_id&&categoryAllowed(req.currentUser,'customers',p.customer_group)):l.party_type==='supplier'?suppliers.some(p=>p.supplier_id===l.party_id&&categoryAllowed(req.currentUser,'suppliers',p.supplier_type)):true));
 }

 const accounts=(await getPostgresPool().query('SELECT id,account_code,account_name FROM app_accounts WHERE is_active AND NOT is_group ORDER BY account_code')).rows.filter(account=>accountAllowed(req.currentUser,account.id));
 res.render('inventory-corrections',{...data,corrections,accounts,error:req.query.error||null});
}catch(error){next(error);}});
router.post('/corrections',async(req,res,next)=>{try{
 const ids=arrays(req.body.account_id),debits=arrays(req.body.debit),credits=arrays(req.body.credit),types=arrays(req.body.party_type),parties=arrays(req.body.party_id);
 const financial_lines=ids.map((id,index)=>({account_id:Number(id),debit:Number(debits[index]||0),credit:Number(credits[index]||0),party_type:types[index]||null,party_id:parties[index]||null})).filter(row=>row.account_id&&(row.debit||row.credit));
 await correctionAction(req.currentUser,'create',{warehouse:req.body.warehouse,source_reference:req.body.source_reference,reason:req.body.reason,treatment:req.body.treatment,count_id:req.body.count_id,item_code:req.body.item_code,quantity:req.body.quantity,rate:req.body.rate,financial_lines});
 res.redirect(303,'/stock/reconciliations/corrections');
}catch(error){if(error.status||error.code==='P0001'||error.code==='23505')res.redirect(303,`/stock/reconciliations/corrections?error=${encodeURIComponent(error.code==='23505'?'That source reference already has a correction.':error.message)}`);else next(error);}});
router.post('/corrections/:id/:action',async(req,res,next)=>{try{await correctionAction(req.currentUser,req.params.action,{id:req.params.id,reason:req.body.reason});res.redirect(303,'/stock/reconciliations/corrections');}catch(error){if(error.status||error.code==='P0001')res.redirect(303,`/stock/reconciliations/corrections?error=${encodeURIComponent(error.message)}`);else next(error);}});
module.exports=router;
