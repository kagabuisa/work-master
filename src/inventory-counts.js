'use strict';
const { withPostgresTransaction, getPostgresPool } = require('./core');
const { runWithAuditUser } = require('./audit');
const { currentUser } = require('./api/auth');
const { can } = require('./authorize');
const { warehouseAllowed, accountAllowed, categoryAllowed } = require('./access');
const { postStockEntryGlEntry, postGlEntry } = require('./domain/posting');
function fail(message,status=409) { const e=new Error(message);e.status=status;throw e; }
async function actor(client,user,permission,warehouse) {
  const fresh=await currentUser(client,user?.id,true);
  if(!fresh || !can(fresh,permission) || !warehouseAllowed(fresh,warehouse)) fail('You cannot perform this inventory action for this warehouse.',403);
  return fresh;
}
async function countAction(user,action,payload) {
  return runWithAuditUser(user,()=>withPostgresTransaction(async client=>{
    const saved=action==='start'?null:(await client.query('SELECT * FROM wm_inventory_counts WHERE id=$1',[payload.id])).rows[0];
    if(action!=='start'&&!saved)fail('Count not found.',404);
    const warehouse=saved?.warehouse||payload.warehouse;
    await actor(client,user,`inventory.count.${action}`,warehouse);
    if(action==='save'&&payload.addOnly){
      const line=payload.lines?.[0];
      if(payload.lines?.length!==1||!line?.item_code||!(Number(line.counted_qty)>0)||!(Number(line.valuation_rate)>0)||String(line.explanation||'').trim().length<3)
        fail('Choose an item, enter a positive physical quantity and valuation rate, and explain the found stock.',400);
      if((await client.query('SELECT 1 FROM wm_inventory_count_lines WHERE count_id=$1 AND item_code=$2',[saved.id,line.item_code])).rowCount)
        fail('This item is already in the count. Edit its existing row instead.',409);
      if(!(await client.query("SELECT 1 FROM app_master_items WHERE item_code=$1 AND NOT disabled AND docstatus='submitted'",[line.item_code])).rowCount)
        fail('Choose an active submitted item.',400);
    }
    const command=action==='submit'?'prepare_submit':action;
    let count=(await client.query('SELECT wm_inventory_count_action($1,$2::jsonb) AS count',[command,JSON.stringify(payload)])).rows[0].count;
    if(action==='submit'&&count.state!=='submitted') {
      await postStockEntryGlEntry(client,{id:count.reconciliation_id,entryNo:`REC-${String(count.reconciliation_id).padStart(6,'0')}`,
        entryType:'reconciliation',postingDate:count.cutoff.slice(0,10)});
      count=(await client.query("SELECT wm_inventory_count_action('finish',$1::jsonb) AS count",[JSON.stringify({id:count.id,revision:count.revision})])).rows[0].count;
    }
    return count;
  },{inventoryExclusive:true}));
}
async function correctionAction(user,action,payload) {
  return runWithAuditUser(user,()=>withPostgresTransaction(async client=>{
    const saved=action==='create'?null:(await client.query('SELECT * FROM wm_inventory_corrections WHERE id=$1',[payload.id])).rows[0];
    if(action!=='create'&&!saved)fail('Correction not found.',404);
    const fresh=await actor(client,user,`inventory.correction.${action}`,saved?.warehouse||payload.warehouse);
    if(action==='submit'&&saved?.state==='submitted')return saved;
    const input= saved||payload;
    const financial=input.financial_lines||[];
    if(!Array.isArray(financial))fail('Provide financial correction lines.',400);
    if(financial.some(line=>![Number(line.debit||0),Number(line.credit||0)].every(Number.isFinite)))fail('Correction amounts must be finite numbers.',400);
    if(financial.some(line=>!accountAllowed(fresh,line.account_id)))fail('A correction account is not permitted.',403);
    for(const line of financial){
      const account=(await client.query('SELECT account_detail_type FROM app_accounts WHERE id=$1 AND is_active AND NOT is_group FOR SHARE',[line.account_id])).rows[0];
      if(!account)fail('Choose active posting accounts.',400);
      const kind=String(account.account_detail_type||'').toLowerCase();
      if(['receivable','payable'].includes(kind)){
        const type=kind==='receivable'?'customer':'supplier';
        if(line.party_type!==type||!line.party_id)fail('Receivable/payable correction lines require the correct customer/supplier identity.',400);
        const table=type==='customer'?'app_master_customers':'app_master_suppliers';
        const key=type==='customer'?'customer_id':'supplier_id';
        const party=(await client.query(`SELECT * FROM ${table} WHERE ${key}=$1 FOR SHARE`,[line.party_id])).rows[0];
        if(!party||!categoryAllowed(fresh,type==='customer'?'customers':'suppliers',type==='customer'?party.customer_group:party.supplier_type))fail('Correction party is not permitted.',403);
        line.party_name=type==='customer'?party.customer_name:party.supplier_name;
      }
    }
    let correction=(await client.query('SELECT wm_inventory_correction_action($1,$2::jsonb) AS correction',[action==='submit'?'prepare_submit':action,JSON.stringify(action==='create'?{...payload,financial_lines:financial}:payload)])).rows[0].correction;
    if(action==='submit'&&correction.state!=='submitted') {
      let lines=correction.financial_lines;
      if(!lines.length&&correction.treatment==='physical') {
        const value=Number((await client.query("SELECT COALESCE(sum(stock_value_change),0) AS value FROM app_stock_ledger WHERE voucher_type='inventory_correction' AND voucher_id=$1",[correction.id])).rows[0].value);
        lines=value>0?[{account_key:'inventory',debit:value},{account_key:'stock_adjustment_gain',credit:value}]
          :[{account_key:'stock_adjustment_loss',debit:-value},{account_key:'inventory',credit:-value}];
      }
      await postGlEntry(client,{posting_date:new Date().toISOString().slice(0,10),voucher_type:'inventory_correction',voucher_id:correction.id,
        voucher_no:`COR-${correction.id}`,remarks:correction.reason,lines});
      correction=(await client.query("SELECT wm_inventory_correction_action('finish',$1::jsonb) AS correction",[JSON.stringify({id:correction.id})])).rows[0].correction;
    }
    return correction;
  },{inventoryExclusive:true}));
}
async function loadCount(user,id) {
  const count=(await getPostgresPool().query('SELECT c.*,s.entry_no,u.username preparer,r.username reviewer FROM wm_inventory_counts c JOIN app_stock_entries s ON s.id=c.reconciliation_id JOIN app_users u ON u.id=c.prepared_by LEFT JOIN app_users r ON r.id=c.approved_by WHERE c.id=$1',[id])).rows[0];
  if(!count||!warehouseAllowed(user,count.warehouse)||!can(user,'inventory.count.view'))fail('Count is not available.',403);
  const lines=(await getPostgresPool().query('SELECT * FROM wm_inventory_count_lines WHERE count_id=$1 ORDER BY item_code',[id])).rows;
  const audit=(await getPostgresPool().query('SELECT a.*,u.username FROM wm_inventory_count_audit a JOIN app_users u ON u.id=a.actor_id WHERE count_id=$1 ORDER BY a.id',[id])).rows;
  return {count,lines,audit};
}
module.exports={countAction,correctionAction,loadCount};
