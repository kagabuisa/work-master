'use strict';
const { isValidIsoDate } = require('./lib/dates');
const { has } = require('./sales-controls');
const { warehouseAllowed,invoicePriceListAllowed } = require('./access');
const fail = (message,status=422)=>{throw Object.assign(new Error(message),{status});};
function normalizeDiscount(body) {
  const record={};
  for(const key of ['item_code','warehouse','warehouse_type','price_list']) {
    const value=String(body[key] || '').trim();
    if(value.length>200) fail('Reference fields must be 200 characters or fewer.');
    record[key]=value || null;
  }
  if(!record.item_code) fail('Choose an item.');
  record.status=body.status;
  if(!['Approved','Disapproved'].includes(record.status)) fail('Choose Approved or Disapproved.');
  record.start_date=String(body.start_date || '');record.expiry_date=String(body.expiry_date || '') || null;
  if(!isValidIsoDate(record.start_date) || record.expiry_date && !isValidIsoDate(record.expiry_date)) fail('Choose valid discount dates.');
  if(record.expiry_date && record.expiry_date<record.start_date) fail('Expiry cannot precede the start date.');
  for(const [key,scale,max] of [['min_qty',3,99999999999.999],['discount_rate',6,999999999999]]) {
    const value=String(body[key] ?? '');
    if(!new RegExp('^\\d+(?:\\.\\d{1,'+scale+'})?$').test(value) || Number(value)<=0 || Number(value)>max) fail(`Enter a positive ${key==='min_qty'?'minimum quantity':'selling rate'} with up to ${scale} decimal places.`);
    record[key]=value;
  }
  return record;
}
function visibleDiscount(user,record) {
  return (!record.warehouse || warehouseAllowed(user,record.warehouse)) && (!record.price_list || invoicePriceListAllowed(user,record.price_list));
}
async function saveDiscount(client,user,body,id=null) {
  if(!has(user,'sales.discounts.manage')) fail('You cannot manage discounts.',403);
  const record=normalizeDiscount(body);
  if(!visibleDiscount(user,record)) fail('Discount scope is not permitted.',403);
  if(id) {
    const saved=(await client.query('SELECT * FROM app_approved_discounts WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!saved || !visibleDiscount(user,saved)) fail('Discount not found.',404);
    if(Number(body.revision)!==saved.revision) fail('This discount changed. Reload before saving.',409);
  }
  const item=(await client.query("SELECT item_code FROM app_master_items WHERE item_code=$1 AND NOT disabled AND docstatus='submitted' FOR SHARE",[record.item_code])).rows[0];
  if(!item) fail('Choose an active submitted item.');
  if(record.warehouse) {
    const wh=(await client.query("SELECT warehouse,warehouse_type FROM app_master_warehouses WHERE warehouse=$1 AND NOT disabled AND NOT is_group AND docstatus='submitted' FOR SHARE",[record.warehouse])).rows[0];
    if(!wh) fail('Choose an active warehouse.');
    if(record.warehouse_type && wh.warehouse_type!==record.warehouse_type) fail('Warehouse and warehouse type must match.');
  }
  if(record.warehouse_type && !(await client.query('SELECT 1 FROM app_master_warehouses WHERE warehouse_type=$1 LIMIT 1',[record.warehouse_type])).rowCount) fail('Choose an existing warehouse type.');
  if(record.price_list && !(await client.query("SELECT price_list FROM app_master_price_lists WHERE price_list=$1 AND active=1 AND currency='UGX' AND price_type IN ('selling','both') FOR SHARE",[record.price_list])).rowCount) fail('Choose an active UGX selling price list.');
  const fields=Object.keys(record),values=Object.values(record);
  let row;
  if(id) row=(await client.query(`UPDATE app_approved_discounts SET ${fields.map((f,i)=>f+'=$'+(i+1)).join(',')},revision=revision+1 WHERE id=$${values.length+1} RETURNING *`,[...values,id])).rows[0];
  else row=(await client.query(`INSERT INTO app_approved_discounts(${fields.join(',')}) VALUES(${values.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,values)).rows[0];
  await client.query('INSERT INTO app_discount_events(discount_id,actor_id,state) VALUES($1,$2,$3::jsonb)',[row.id,String(user.id),JSON.stringify(row)]);
  return row.id;
}
module.exports={normalizeDiscount,visibleDiscount,saveDiscount};
