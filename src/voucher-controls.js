'use strict';
const { createHash } = require('node:crypto');
const { currentPostingDate, assertPostingDate } = require('./posting-time');
const { dateOnly } = require('./lib/dates');
const { currentUser, has } = require('./sales-controls');
const { auditActorTrusted } = require('./audit');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status, code:'voucher_approval_required' }); };
const configs = {
  purchases: { base:'/purchases', table:'app_purchases', lines:'app_purchase_items', foreign:'purchase_id',
    header:'posting_date posting_time due_date supplier_id supplier_reference price_list purchase_order_id cost_center subtotal total',
    fields:'line_no item_code warehouse quantity unit_price line_total purchase_order_item_id' },
  journals: { base:'/journals', table:'app_journal_entries', lines:'app_journal_entry_lines', foreign:'journal_entry_id',
    header:'journal_type posting_date posting_time party_type party_id reference_no cost_center total_debit total_credit',
    fields:'line_no account_id debit credit reference_no' },
  stock: { base:'/stock/entries', table:'app_stock_entries', lines:'app_stock_entry_items', foreign:'stock_entry_id',
    header:'entry_type posting_date posting_time supplier_name supplier_contact supplier_phone supplier_reference cost_center',
    fields:'line_no item_code warehouse target_warehouse quantity valuation_rate' },
};
function config(kind) { const result=configs[kind]; if (!result) fail('Unknown voucher type.'); return result; }
function pick(row, fields) { return Object.fromEntries(fields.split(' ').map(key=>[key, row[key] instanceof Date ? dateOnly(row[key]) : row[key] ?? null])); }
function fingerprint(snapshot) { return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'); }
async function reviewedVoucher(client, kind, id, lock=true) {
  const c=config(kind);
  const record=(await client.query(`SELECT * FROM ${c.table} WHERE id=$1 ${lock?'FOR UPDATE':''}`, [id])).rows[0];
  if (!record) fail('Voucher not found.',404);
  if(kind==='journals') record.linked_payment=(await client.query(`SELECT 1 FROM app_invoice_payments WHERE journal_entry_id=$1 UNION ALL SELECT 1 FROM app_purchase_payments WHERE journal_entry_id=$1 AND method<>'journal' LIMIT 1`,[id])).rowCount>0;
  const lines=(await client.query(`SELECT * FROM ${c.lines} WHERE ${c.foreign}=$1 ORDER BY line_no,id`,[id])).rows;
  const snapshot={header:pick(record,c.header),lines:lines.map(row=>pick(row,c.fields))};
  return {record,snapshot,hash:fingerprint(snapshot)};
}
function eligible(kind, record) {
  if(kind==='journals') return record.journal_type === 'journal_entry'
    || (['cash_receipt','payment_journal'].includes(record.journal_type) && !record.linked_payment);
  return kind!=='stock' || !['reconciliation','cancel'].includes(record.entry_type);
}
async function state(client, kind, id) {
  return (await client.query('SELECT * FROM app_voucher_approvals WHERE voucher_kind=$1 AND voucher_id=$2', [kind,id])).rows[0]
    || {voucher_kind:kind,voucher_id:id,revision:0,action_request:'',reason:'',allow:'',review_hash:'',approved_by:null};
}
async function recordEvent(client, kind, id, event, user, value, snapshot) {
  await client.query(`INSERT INTO app_voucher_approval_events(voucher_kind,voucher_id,event,actor_id,actor_name,state,snapshot)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,[kind,id,event,String(user?.id || ''),user?.username || 'System',JSON.stringify(value),JSON.stringify(snapshot)]);
}
async function write(client, kind, id, value, event, user, snapshot) {
  await client.query(`INSERT INTO app_voucher_approvals(voucher_kind,voucher_id,revision,action_request,reason,allow,review_hash,approved_by,approved_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(voucher_kind,voucher_id) DO UPDATE SET
    revision=EXCLUDED.revision,action_request=EXCLUDED.action_request,reason=EXCLUDED.reason,allow=EXCLUDED.allow,
    review_hash=EXCLUDED.review_hash,approved_by=EXCLUDED.approved_by,approved_at=EXCLUDED.approved_at`,
    [kind,id,value.revision,value.action_request,value.reason,value.allow,value.review_hash,value.approved_by || null,value.approved_at || null]);
  await recordEvent(client,kind,id,event,user,value,snapshot);
}
function checkRevision(payload, saved, required=false) {
  if ((required || Object.hasOwn(payload,'control_revision')) && String(payload.control_revision)!==String(saved.revision)) fail('The voucher or request changed. Reload before continuing.',409);
}
function checkAction(action, reason, record) {
  if (!['','Backdate','Cancel'].includes(action) || reason.length>4000 || action && !reason) fail('Choose an action and enter a reason of up to 4,000 characters.');
  if (action==='Backdate' && record.docstatus!=='draft' || action==='Cancel' && record.docstatus!=='submitted' || record.docstatus==='cancelled') fail('Request backdating on a draft or cancellation on a submitted voucher.');
}
function revoke(saved) { return {...saved,allow:'',approved_by:null,approved_at:null}; }
// Called after header and lines are saved, inside the voucher transaction.
async function savedVoucher(client, kind, id, payload={}) {
  const reviewed=await reviewedVoucher(client,kind,id);
  if (!eligible(kind,reviewed.record)) return;
  const user=auditActorTrusted()?null:await currentUser(client), saved=await state(client,kind,id);
  checkRevision(payload,saved);
  if (user) assertPostingDate(reviewed.record.posting_date);
  let next={...saved},changed=saved.review_hash!==reviewed.hash;
  if (changed) next=revoke(next);
  if (Object.hasOwn(payload,'action_request')) {
    const action=String(payload.action_request || ''), reason=String(payload.why_cancel || '').trim();
    checkAction(action,reason,reviewed.record);
    if (action!==saved.action_request || reason!==saved.reason) {
      if (!user || !has(user,`vouchers.${kind}.view`) && !has(user,`vouchers.${kind}.create`) && !has(user,`vouchers.${kind}.edit`)) fail('You cannot request approval for this voucher.',403);
      next={...revoke(next),action_request:action,reason}; changed=true;
    }
  }
  if (changed) {
    next.review_hash=reviewed.hash; next.revision=Number(saved.revision)+1;
    await write(client,kind,id,next,saved.allow?'approval_invalidated':'saved',user,reviewed.snapshot);
  }
}
async function requireApproval(client, kind, id, action) {
  const reviewed=await reviewedVoucher(client,kind,id);
  if (!eligible(kind,reviewed.record)) return;
  const user=auditActorTrusted()?null:await currentUser(client);
  // Trusted internal imports retain the same convention as Sales Invoice.
  if (!user) return;
  assertPostingDate(reviewed.record.posting_date);
  if (action==='Cancel' && user.role==='admin') {
    const saved=await state(client,kind,id);
    await recordEvent(client,kind,id,'admin_override_cancel',user,
      {...saved,allow:'',approved_by:null,approved_at:null},reviewed.snapshot);
    return;
  }
  if (action==='Backdate' && dateOnly(reviewed.record.posting_date)===currentPostingDate()) return;
  const saved=await state(client,kind,id);
  if (saved.allow!==action || saved.action_request!==action || !saved.approved_by || saved.review_hash!==reviewed.hash) {
    fail(`${action==='Cancel'?'Cancellation':'Backdating'} requires Admin approval for the current voucher version.`,403);
  }
  await write(client,kind,id,{...saved,revision:Number(saved.revision)+1,allow:'',approved_by:null,approved_at:null},'approval_used',user,reviewed.snapshot);
}
async function act(client,kind,id,payload,approve) {
  let reviewed=await reviewedVoucher(client,kind,id);
  if (!eligible(kind,reviewed.record)) fail('This voucher uses a separate workflow.');
  const user=await currentUser(client);
  if (!user) fail('Sign in to manage approvals.',403);
  if(!has(user,`vouchers.${kind}.view`)) fail('You cannot request approval for this voucher.',403);
  const saved=await state(client,kind,id); checkRevision(payload,saved,true);
  let next=revoke(saved);
  if (approve) {
    if (user.role!=='admin') fail('Only Admin can approve voucher exceptions.',403);
    if (saved.review_hash!==reviewed.hash) fail('The voucher changed. Save a fresh request before approval.',409);
    if (payload.allow) {
      if (payload.allow!==saved.action_request) fail('Approval must match the requested action.');
      checkAction(saved.action_request,saved.reason,reviewed.record);
      assertPostingDate(reviewed.record.posting_date);
      next={...next,allow:saved.action_request,approved_by:String(user.id),approved_at:new Date().toISOString()};
    }
  } else {
    const action=String(payload.action_request || ''),reason=String(payload.why_cancel || '').trim();
    checkAction(action,reason,reviewed.record);
    if(action==='Backdate' && payload.requested_posting_date && payload.requested_posting_date!==dateOnly(reviewed.record.posting_date)) {
      if(!has(user,`vouchers.${kind}.edit`)) fail('Edit permission is required to change the posting date.',403);
      const date=assertPostingDate(payload.requested_posting_date);
      await client.query(`UPDATE ${config(kind).table} SET posting_date=$2 WHERE id=$1`,[id,date]);
      reviewed=await reviewedVoucher(client,kind,id);
    }
    next={...next,action_request:action,reason};
  }
  next.review_hash=reviewed.hash; next.revision=Number(saved.revision)+1;
  await write(client,kind,id,next,approve?(next.allow?'approved':'revoked'):'requested',user,reviewed.snapshot);
}
async function view(client,kind,id) {
  const reviewed=await reviewedVoucher(client,kind,id,false);
  if (!eligible(kind,reviewed.record)) return null;
  const saved=await state(client,kind,id);
  const events=(await client.query(`SELECT event,actor_name,created_at,state FROM app_voucher_approval_events
    WHERE voucher_kind=$1 AND voucher_id=$2 ORDER BY id DESC LIMIT 20`,[kind,id])).rows;
  const approved=saved.allow && saved.review_hash===reviewed.hash;
  return {kind,base:config(kind).base,record:reviewed.record,...saved,allow:approved?saved.allow:'',events};
}
function requestFields(body) { return Object.fromEntries(['action_request','why_cancel','control_revision'].filter(key=>Object.hasOwn(body,key)).map(key=>[key,body[key]])); }
module.exports={requestFields,configs,fingerprint,reviewedVoucher,savedVoucher,requireApproval,act,view};
