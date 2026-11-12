'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {profile}=require('./profile');
const state=require('./state');
const execFileAsync=promisify(execFile);

async function measureCompressedBackup(databaseBytes) {
  const file=path.join(state.OUT,'.storage-probe.dump');
  const env={...process.env,
    PGHOST:process.env.POSTGRES_HOST || 'benchmark-db',
    PGDATABASE:process.env.POSTGRES_DB,
    PGUSER:process.env.POSTGRES_USER,
    PGPASSWORD:process.env.POSTGRES_PASSWORD};
  try {
    await execFileAsync('pg_dump',['--format=custom','--compress=6','--no-owner','--file',file,process.env.POSTGRES_DB],{
      env,timeout:10*60*1000,maxBuffer:1024*1024
    });
    const bytes=fs.statSync(file).size;
    return {bytes,ratio:bytes/databaseBytes};
  } finally {
    fs.rmSync(file,{force:true});
  }
}

// Current-schema, lifecycle-generated pilot; estimates remain planning bounds.
async function footprint(p,ctx,integrity){
  const rows=(await ctx.pool.query(`SELECT relname,pg_total_relation_size(relid)::text bytes FROM pg_stat_user_tables WHERE schemaname='public' ORDER BY relname`)).rows;
  const full=profile('full',p.lane),master={app_master_customers:'customers',app_master_suppliers:'suppliers',app_master_items:'items',app_master_warehouses:'warehouses',app_accounts:'accounts',app_stock_balances:'bins'};
  const transactions=new Set(['app_invoices','app_invoice_items','app_invoice_payments','app_journal_entries','app_journal_entry_lines','app_purchases','app_purchase_items','app_purchase_orders','app_purchase_order_items','app_stock_entries','app_stock_entry_items','app_stock_ledger','app_gl_entries','wm_gl_daily']);
  const tables=[];let measured=0,estimated=0;
  for(const row of rows){const bytes=Number(row.bytes);let factor=1;
    if(transactions.has(row.relname))factor=1/p.lane_scale;
    else if(master[row.relname])factor=full.counts[master[row.relname]]/p.counts[master[row.relname]];
    measured+=bytes;estimated+=bytes*factor;tables.push({table:row.relname,measured_bytes:bytes,scale_factor:factor,estimated_full_bytes:Math.ceil(bytes*factor)});}
  estimated+=Math.max(0,integrity.database_bytes-measured);
  const backup=await measureCompressedBackup(integrity.database_bytes);
  const estimatedBackup=Math.ceil(estimated*backup.ratio);
  const walAndScratch=Math.max(1024**3,Math.ceil(estimated*0.1));
  const budget=Math.ceil(estimated+estimatedBackup+walAndScratch),disk=state.diskGuard(p.mode);
  const result={at:new Date().toISOString(),mode:p.mode,lane:p.lane,pilot_scale:p.lane_scale,measured_database_bytes:integrity.database_bytes,
    measured_compressed_backup_bytes:backup.bytes,compressed_backup_ratio:backup.ratio,
    estimated_full_database_bytes:Math.ceil(estimated),estimated_full_backup_bytes:estimatedBackup,
    estimated_wal_and_scratch_bytes:walAndScratch,planning_budget_bytes:budget,available_volume_bytes:disk,
    reserve_bytes:6*1024**3,fits_with_reserve:budget+6*1024**3<disk,tables,
    method:'Scale current-schema transaction tables from the valid pilot; scale masters separately. Add a projected compressed-backup copy using the measured pilot ratio, 10% WAL/scratch (minimum 1 GiB), and a 6 GiB free-space reserve.',
    limitations:'Small pilot table/page/index overhead may differ at full scale, compressed backup ratios can change with data composition, derived-summary grouping may saturate, and this is not a measured full run.'};
  state.write('storage-projection.json',result);return result;
}
module.exports={footprint};
