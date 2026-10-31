'use strict';
const router=require('express').Router();
const { getPostgresPool,withPostgresTransaction }=require('../../core');
const controls=require('../../sales-controls');
const { saveDiscount,visibleDiscount }=require('../../approved-discounts');
const { warehouseAllowed,invoicePriceListAllowed,masterRecordAllowed }=require('../../access');
const { requireInvoiceInTransaction }=require('../../api/policy');
const { clearInvoiceCaches }=require('../cache');
const fail=(message,status=422)=>{throw Object.assign(new Error(message),{status});};
const discountBase='/settings/approved-discounts';
router.get(discountBase,async(req,res,next)=>{
 try {
  const pool=getPostgresPool(),q=String(req.query.q || '').trim().slice(0,200),page=Math.max(1,Math.min(100000,Number.parseInt(req.query.page,10)||1));
  // Reference visibility is evaluated before pagination, including named denials.
  const choices=await formData(req.currentUser,true);
  const rows=(await pool.query(`SELECT *,start_date::text,expiry_date::text FROM app_approved_discounts
    WHERE (item_code ILIKE $1 OR COALESCE(warehouse,'') ILIKE $1 OR COALESCE(price_list,'') ILIKE $1)
    AND (warehouse IS NULL OR warehouse=ANY($2::text[])) AND (price_list IS NULL OR price_list=ANY($3::text[]))
    ORDER BY id DESC LIMIT 51 OFFSET $4`,['%'+q+'%',choices.warehouses.map(w=>w.warehouse),choices.lists.map(l=>l.price_list),(page-1)*50])).rows;
  res.render('approved-discounts',{rows:rows.slice(0,50),q,page,hasNext:rows.length>50,error:req.query.error || null});
 }catch(e){next(e);}
});
async function formData(user,includeInactive=false) {
 const pool=getPostgresPool();
 const [warehouses,lists,types]=await Promise.all([
  pool.query(`SELECT warehouse FROM app_master_warehouses ${includeInactive?'':"WHERE NOT disabled AND NOT is_group AND docstatus='submitted'"} ORDER BY warehouse`),
  pool.query(`SELECT price_list FROM app_master_price_lists ${includeInactive?'':"WHERE active=1 AND currency='UGX' AND price_type IN ('selling','both')"} ORDER BY price_list`),
  pool.query("SELECT DISTINCT warehouse_type FROM app_master_warehouses WHERE COALESCE(warehouse_type,'')<>'' ORDER BY warehouse_type")]);
 return {warehouses:warehouses.rows.filter(w=>warehouseAllowed(user,w.warehouse)),lists:lists.rows.filter(l=>invoicePriceListAllowed(user,l.price_list)),types:types.rows};
}
async function renderForm(req,res,next,id=null) {
 try {
  if(!controls.has(req.currentUser,'sales.discounts.manage')) fail('You cannot manage discounts.',403);
  let record={status:'Disapproved',start_date:require('../../posting-time').currentPostingDate()};
  if(id){record=(await getPostgresPool().query('SELECT *,start_date::text,expiry_date::text FROM app_approved_discounts WHERE id=$1',[id])).rows[0];if(!record || !visibleDiscount(req.currentUser,record)) fail('Discount not found.',404);}
  res.render('approved-discount-form',{record,error:null,...await formData(req.currentUser)});
 }catch(e){next(e);}
}
router.get(discountBase+'/new',(req,res,next)=>renderForm(req,res,next));
router.get(discountBase+'/:id',(req,res,next)=>renderForm(req,res,next,req.params.id));
async function save(req,res,next,id=null) {
 try {await withPostgresTransaction(async client=>saveDiscount(client,await controls.currentUser(client),req.body,id));res.redirect(303,discountBase);}
 catch(e){if(e.status && e.status<500){try{res.status(e.status).render('approved-discount-form',{record:{...req.body,id},error:e.message,...await formData(req.currentUser)});}catch(err){next(err);}}else next(e);}
}
router.post(discountBase,(req,res,next)=>save(req,res,next));
router.post(discountBase+'/:id',(req,res,next)=>save(req,res,next,req.params.id));
for(const approve of [false,true]) router.post('/invoices/:id/'+(approve?'action-approval':'action-request'),async(req,res,next)=>{
 try {
  await withPostgresTransaction(async client=>{
   const user=await controls.currentUser(client),permission=approve?'sales.approvals.approve':'sales.approvals.request';
   const invoice=await requireInvoiceInTransaction(client,{kind:'mobile',user},req.params.id,'',permission);
   if(invoice.docstatus==='cancelled') fail('Cancelled invoices cannot receive approvals.');
   const state=controls.approvalState(invoice);
   if(Number(req.body.approval_revision)!==state.approval_revision) fail('The request changed. Reload before continuing.',409);
   if(approve){
    const allow=String(req.body.allow || '');
    if(!['','Backdate','Cancel'].includes(allow) || allow && (allow!==state.action_request || !state.why_cancel)) fail('Approval must match a request with a reason.');
    if(allow==='Backdate' && invoice.docstatus!=='draft' || allow==='Cancel' && invoice.docstatus!=='submitted') fail('Backdate approval requires a draft; cancellation approval requires a submitted invoice.');
    const request=(await client.query("SELECT actor_id FROM app_sales_approval_events WHERE invoice_id=$1 AND event IN ('request','request_or_invalidation') ORDER BY id DESC LIMIT 1",[invoice.id])).rows[0];
    if(allow && user.role!=='admin' && request?.actor_id===String(user.id)) fail('Another authorized person must approve your request.',403);
    Object.assign(state,{allow,approved_by:allow?user.username:null,approved_at:allow?new Date().toISOString():null});
   }else{
    const action_request=String(req.body.action_request || ''),why_cancel=String(req.body.why_cancel || '').trim();
    if(!['','Backdate','Cancel'].includes(action_request) || why_cancel.length>4000 || action_request && !why_cancel) fail('Choose an action and explain why it is needed (up to 4,000 characters).');
    if(action_request==='Backdate' && invoice.docstatus!=='draft' || action_request==='Cancel' && invoice.docstatus!=='submitted') fail('Request backdating on a draft or cancellation on a submitted invoice.');
    const selectedDate=String(req.body.requested_posting_date || '');
    if(action_request==='Backdate' && selectedDate && selectedDate!==require('../../lib/dates').dateOnly(invoice.invoice_date)) {
     if(!controls.has(user,'vouchers.sales.edit')) fail('Sales Invoice Edit permission is required to change the posting date.',403);
     const payload={...invoice,invoice_date:selectedDate,due_date:require('../../lib/dates').dateOnly(invoice.due_date),action_request,why_cancel,approval_revision:state.approval_revision,payments:[],amount_paid:0};
     await require('../../services/invoice-draft-validation').validateInvoiceDraftStock(client,payload);
     await require('../../domain/sales').updatePostgresInvoiceInTransaction(client,invoice.id,payload);
     return;
    }
    Object.assign(state,{action_request,why_cancel,allow:'',approved_by:null,approved_at:null});
   }
   state.approval_revision++;
   await controls.saveApprovalState(client,invoice.id,state);
   await controls.approvalEvent(client,invoice.id,user,state,approve?'approval':'request');
  });
  clearInvoiceCaches();res.redirect(303,'/invoices/'+req.params.id);
 }catch(e){if(e.status && e.status<500)res.redirect(303,'/invoices/'+req.params.id+'?error='+encodeURIComponent(e.message));else next(e);}
});
router.post('/api/invoice-minimum-prices',async(req,res,next)=>{
 try {
  const body=req.body;
  if(!Array.isArray(body.items) || body.items.length>200 || !body.items.length) fail('Provide 1–200 invoice lines.');
  const invoice={customer_id:String(body.customer_id || ''),price_list:String(body.price_list || ''),items:body.items.map(i=>({item_code:String(i.item_code || ''),warehouse:String(i.warehouse || ''),quantity:Number(i.quantity)}))};
  if(invoice.items.some(i=>!i.item_code || !i.warehouse || !Number.isFinite(i.quantity) || i.quantity<=0 || !warehouseAllowed(req.currentUser,i.warehouse)) || !invoicePriceListAllowed(req.currentUser,invoice.price_list) || !await masterRecordAllowed(req.currentUser,'customers',invoice.customer_id)) fail('The pricing references are not permitted.',403);
  res.set('Cache-Control','no-store');res.json(await controls.priceResults(getPostgresPool(),invoice,req.currentUser));
 }catch(e){next(e);}
});
module.exports=router;
