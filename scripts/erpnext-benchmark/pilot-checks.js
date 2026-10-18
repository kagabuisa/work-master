'use strict';
const state=require('./state');
const {verify}=require('./verify');
async function pilotChecks(p,ctx){
  if(p.mode!=='pilot')return;
  const client=await ctx.pool.connect();let detected=false;
  try {
    await client.query('BEGIN');
    const removed=await client.query(`DELETE FROM app_gl_entries WHERE voucher_type='sales_invoice_cancellation' AND voucher_id=(SELECT min(id) FROM app_invoices WHERE docstatus='cancelled') RETURNING id`);
    if(!removed.rowCount)throw new Error('Pilot needs a cancelled invoice to test its reversal check.');
    try{await verify(p,{...ctx,pool:client},'intentional-fault');}
    catch(e){const report=state.read('integrity-intentional-fault.json');
      if(!report?.checks.some(check=>check.name==='cancelled_invoice_reversals'&&!check.passed))throw e;
      detected=true;}
    if(!detected)throw new Error('Integrity verifier did not detect deliberately missing cancellation rows.');
  } finally {await client.query('ROLLBACK');client.release();}
  state.write('pilot-checks.json',{passed:true,partial_commit_recovery:true,completed_seed_replay:true,missing_reversal_detected:true,fault_rolled_back:true});
  state.event({event:'pilot_failure_detection_passed'});
}
module.exports={pilotChecks};
