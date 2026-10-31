'use strict';
const { auditActor, auditActorTrusted } = require('./audit');
const { currentPostingDate, assertPostingDate } = require('./posting-time');
const { dateOnly, isValidIsoDate } = require('./lib/dates');
const { multiplyMoney, roundMoney } = require('./lib/money');
const { dateError, minimumRate, scaledRate } = require('./shared/sales-controls');
const fail = (message, status = 422, code = 'sales_policy_failed') => { throw Object.assign(new Error(message), { status, code }); };
const has = (u, key) => u?.role === 'admin' || u?.permissions?.includes(key);
function capabilities(user) {
  return { director: has(user, 'sales.policy.director'), accountant: has(user, 'sales.policy.accountant'),
    price_override: has(user, 'sales.policy.price-override'), request: has(user, 'sales.approvals.request'), approve: has(user, 'sales.approvals.approve') };
}
async function currentUser(client, id = auditActor().id) {
  // No request actor denotes trusted internal imports/backfills, not an HTTP caller.
  if (!id) return null;
  if (auditActorTrusted()) return null;
  if (!/^\d+$/.test(String(id))) return null;
  const row = (await client.query(`SELECT u.id,u.username,u.role,u.active,u.permission_grants,u.permission_denials,u.record_access,
    r.permissions,r.scopes FROM app_users u JOIN app_roles r ON r.slug=u.role WHERE u.id=$1 FOR SHARE OF u,r`, [id])).rows[0];
  if (!row?.active) fail('Your account is no longer active.', 403);
  row.permissions = require('./auth').applyPermissionOverrides(row.permissions, row.permission_grants, row.permission_denials);
  return row;
}
async function loadPricing(client, invoice) {
  const codes = [...new Set((invoice.items || []).map(i => i.item_code))].sort();
  const warehouses = [...new Set((invoice.items || []).map(i => i.warehouse || invoice.warehouse).filter(Boolean))].sort();
  const prices = (await client.query(`SELECT i.item_code,i.qty_per_carton,i.unit_cost,p.price_list_rate,p.promo_rate,p.promo_qty,
    p.carton_price,p.promo_start_date::text,p.promo_expiry_date::text,p.promo_warehouse,p.promo_customer,p.warehouse_type
    FROM app_master_items i LEFT JOIN app_master_item_prices p ON p.item_code=i.item_code AND p.price_list=$2
    AND p.active=1 AND p.docstatus='submitted' WHERE i.item_code=ANY($1::text[])`, [codes,invoice.price_list || ''])).rows;
  const discounts = (await client.query(`SELECT *,start_date::text,expiry_date::text FROM app_approved_discounts
    WHERE item_code=ANY($1::text[]) AND status='Approved' AND start_date<=$2::date
    AND (expiry_date IS NULL OR expiry_date>=$2::date) ORDER BY id FOR SHARE`, [codes,currentPostingDate()])).rows;
  const types = (await client.query('SELECT warehouse,warehouse_type FROM app_master_warehouses WHERE warehouse=ANY($1::text[])', [warehouses])).rows;
  return { prices: new Map(prices.map(p => [p.item_code,p])), discounts, types: new Map(types.map(w => [w.warehouse,w.warehouse_type])) };
}
async function priceResults(client, invoice, user) {
  if (capabilities(user).price_override) return invoice.items.map(i => ({ item_code:i.item_code,warehouse:i.warehouse || invoice.warehouse,rate:0,reason:'Authorized pricing override' }));
  const data = await loadPricing(client,invoice);
  // Customer identity is resolved on the server; never trust an exception name from a request.
  const customer = (await client.query('SELECT customer_name FROM app_master_customers WHERE customer_id=$1', [invoice.customer_id])).rows[0];
  return invoice.items.map(item => {
    const warehouse = item.warehouse || invoice.warehouse;
    const result = minimumRate({ today:currentPostingDate(),price_list:invoice.price_list,customer_id:invoice.customer_id,
      customer_name:customer?.customer_name,warehouse_type:data.types.get(warehouse) }, { ...item,warehouse,pricing:data.prices.get(item.item_code) },data.discounts);
    return { item_code:item.item_code,warehouse,...result };
  });
}
function approvalState(invoice = {}) {
  invoice = invoice || {};
  return { action_request:invoice.action_request || '',why_cancel:invoice.why_cancel || '',allow:invoice.allow || '',
    approval_revision:Number(invoice.approval_revision || 0),approved_by:invoice.approved_by || null,approved_at:invoice.approved_at || null };
}
async function approvalEvent(client, id, user, state, kind) {
  await client.query(`INSERT INTO app_sales_approval_events(invoice_id,actor_id,actor_name,event,state)
    VALUES($1,$2,$3,$4,$5::jsonb)`, [id,String(user?.id || ''),user?.username || 'System',kind,JSON.stringify(state)]);
}
async function saveApprovalState(client, id, state) {
  await client.query(`UPDATE app_invoices SET action_request=$2,why_cancel=$3,allow=$4,approval_revision=$5,
    approved_by=$6,approved_at=$7 WHERE id=$1`, [id,state.action_request,state.why_cancel,state.allow,state.approval_revision,state.approved_by,state.approved_at]);
}
async function validateInvoice(client, payload, { saved = null, submitting = false, user: suppliedUser } = {}) {
  const user = suppliedUser === undefined ? await currentUser(client) : suppliedUser;
  if (!user) return approvalState(saved);
  const state = approvalState(saved);
  if (Object.hasOwn(payload,'allow') && String(payload.allow || '') !== state.allow) fail('Approval must be changed through the approval action.',403);
  const request = Object.hasOwn(payload,'action_request') ? String(payload.action_request || '') : state.action_request;
  const reason = Object.hasOwn(payload,'why_cancel') ? String(payload.why_cancel || '').trim() : state.why_cancel;
  if (!['','Backdate','Cancel'].includes(request) || reason.length > 4000) fail('Choose a valid action and a reason of up to 4,000 characters.');
  const dateChanged = saved && dateOnly(saved.invoice_date) !== dateOnly(payload.invoice_date);
  if (request !== state.action_request || reason !== state.why_cancel || dateChanged && (state.allow === 'Backdate' || state.action_request === 'Backdate')) {
    if (saved && Object.hasOwn(payload,'approval_revision') && Number(payload.approval_revision)!==state.approval_revision) fail('The approval request changed. Reload before saving.',409);
    if ((request !== state.action_request || reason !== state.why_cancel) && !has(user,'sales.approvals.request')) fail('You cannot change approval requests.',403);
    if (request && !reason) fail('Explain why cancellation or backdating is needed.');
    Object.assign(state,{action_request:request,why_cancel:reason,allow:'',approved_by:null,approved_at:null,approval_revision:state.approval_revision+1});
  }
  const date = dateOnly(payload.invoice_date);
  if (!isValidIsoDate(date)) fail('Choose a valid posting date.');
  assertPostingDate(date);
  const pending = !submitting && state.action_request === 'Backdate' && !!state.why_cancel;
  const error = dateError(date,currentPostingDate(),capabilities(user),state.allow,pending);
  if (error) fail(error);
  // Pending 11/12-day drafts may be saved for approval, but cannot be submitted.
  const floors = await priceResults(client,payload,user);
  let minimum = 0;
  for (let index=0; index<floors.length; index++) {
    const floor=floors[index], item=payload.items[index];
    if (floor.rate === null) fail(`${item.item_code}: ${floor.reason}`);
    if (scaledRate(item.unit_price) < scaledRate(floor.rate)) fail(`${item.item_code}: minimum rate is ${floor.rate} (${floor.reason}).`);
    minimum += multiplyMoney(item.quantity,floor.rate);
  }
  const subtotal=payload.items.reduce((sum,item)=>sum+multiplyMoney(item.quantity,item.unit_price),0);
  if (roundMoney(subtotal-roundMoney(payload.discount_amount || 0)) < roundMoney(minimum)) fail('Invoice discount reduces the selling total below the minimum permitted prices.');
  return state;
}
async function persistValidation(client,id,payload,options) {
  const state=await validateInvoice(client,payload,options);
  if (JSON.stringify(state)!==JSON.stringify(approvalState(options?.saved))) {
    await saveApprovalState(client,id,state);
    await approvalEvent(client,id,await currentUser(client),state,'request_or_invalidation');
  }
  return state;
}
async function cancellationAllowed(client, invoice) {
  const user=await currentUser(client);
  if (!user) return;
  if (!has(user,'vouchers.sales.cancel')) fail('You cannot cancel sales invoices.',403);
  const caps=capabilities(user);
  if (!caps.director && caps.accountant && invoice.allow!=='Cancel') fail('Cancellation requires Allow = Cancel from an authorized approver.',403);
}
module.exports={has,capabilities,currentUser,priceResults,approvalState,approvalEvent,saveApprovalState,validateInvoice,persistValidation,cancellationAllowed};
