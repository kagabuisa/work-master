'use strict';
const {profile}=require('./profile');
const state=require('./state');
// Current-schema, lifecycle-generated pilot; estimates remain planning bounds.
async function footprint(p,ctx,integrity){
  const rows=(await ctx.pool.query(`SELECT relname,pg_total_relation_size(relid)::text bytes FROM pg_stat_user_tables WHERE schemaname='public' ORDER BY relname`)).rows;
  const full=profile('full'),master={app_master_customers:'customers',app_master_suppliers:'suppliers',app_master_items:'items',app_master_warehouses:'warehouses',app_accounts:'accounts',app_stock_balances:'bins'};
  const transactions=new Set(['app_invoices','app_invoice_items','app_invoice_payments','app_journal_entries','app_journal_entry_lines','app_purchases','app_purchase_items','app_purchase_orders','app_purchase_order_items','app_stock_entries','app_stock_entry_items','app_stock_ledger','app_gl_entries','wm_gl_daily']);
  const tables=[];let measured=0,estimated=0;
  for(const row of rows){const bytes=Number(row.bytes);let factor=1;
    if(transactions.has(row.relname))factor=1/p.scale;
    else if(master[row.relname])factor=full.counts[master[row.relname]]/p.counts[master[row.relname]];
    measured+=bytes;estimated+=bytes*factor;tables.push({table:row.relname,measured_bytes:bytes,scale_factor:factor,estimated_full_bytes:Math.ceil(bytes*factor)});}
  estimated+=Math.max(0,integrity.database_bytes-measured);
  const budget=Math.ceil(estimated*2.5+1024**3),disk=state.diskGuard(p.mode);
  const result={at:new Date().toISOString(),mode:p.mode,pilot_scale:p.scale,measured_database_bytes:integrity.database_bytes,
    estimated_full_database_bytes:Math.ceil(estimated),planning_budget_bytes:budget,available_volume_bytes:disk,
    reserve_bytes:6*1024**3,fits_with_reserve:budget+6*1024**3<disk,tables,
    method:'Scale current-schema transaction tables from the valid pilot; scale observed masters separately. Add 50% database headroom, one backup and 1 GiB WAL/scratch, plus a 6 GiB free-space reserve.',
    limitations:'Small pilot table/page/index overhead is conservatively scaled, derived-summary grouping may saturate, and full-scale generation speed/peak storage can differ. This is not a measured full run.'};
  state.write('storage-projection.json',result);return result;
}
module.exports={footprint};
