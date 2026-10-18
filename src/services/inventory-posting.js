'use strict';
const states = new WeakMap();
let ready = false;
function inventorySchemaReady() { ready = true; }
async function loadTransactionMode(client) {
  states.delete(client);
  if (!ready) return;
  const exists = (await client.query("SELECT to_regprocedure('wm_inventory_enabled()') IS NOT NULL AS exists")).rows[0]?.exists;
  if (exists) states.set(client, Boolean((await client.query('SELECT wm_inventory_enabled() AS enabled')).rows[0]?.enabled));
}
async function enabled(client) { return states.get(client) === true; }
async function beginInventoryPosting(client, type, id, warehouses, reversal = false) {
  if (!await enabled(client)) return null;
  const keys = [...new Set(warehouses.filter(Boolean))].sort();
  const event = (await client.query('SELECT wm_inventory_begin($1,$2,$3,$4::text[]) AS event', [type,id,reversal,keys])).rows[0]?.event;
  return event;
}
async function inventoryMovement(client, movement) {
  if (!await enabled(client)) return null;
  const value = (await client.query('SELECT wm_inventory_apply($1::jsonb) AS movement',[JSON.stringify(movement)])).rows[0].movement;
  return Object.fromEntries(Object.entries(value).map(([key,value])=>[key,Number(value)]));
}
async function inventoryGlDate(client, entry) {
  // Invoice accounting follows its document date; physical stock keeps the controlled event time.
  if (entry.voucher_type === 'sales_invoice' || !await enabled(client)) return entry;
  let type = entry.voucher_type.replace(/_(cancellation|reversal)$/, '');
  if (type === 'sales_invoice') type = 'invoice';
  const event = (await client.query(`SELECT (movement_at AT TIME ZONE 'Africa/Kampala')::date AS date, (movement_at AT TIME ZONE 'Africa/Kampala')::time::text AS time
    FROM wm_inventory_events WHERE txid=txid_current() AND voucher_type=$1 AND voucher_id=$2 AND is_reversal=$3`,
  [type, entry.voucher_id, Boolean(entry.is_reversal)])).rows[0];
  return event ? {...entry,posting_date:event.date,posting_time:event.time} : entry;
}
module.exports = { inventorySchemaReady, loadTransactionMode, enabled, beginInventoryPosting, inventoryMovement, inventoryGlDate };
