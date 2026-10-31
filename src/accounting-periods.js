'use strict';
const { withPostgresTransaction, getPostgresPool } = require('./core');
const { isValidIsoDate } = require('./lib/dates');
const { currentPostingDate } = require('./posting-time');
const LOCK_KEY = 1776342163;
const fail = (message,status=400) => { throw Object.assign(new Error(message),{status}); };
const CHECKS = ['cash','bank','receivables','payables','accounts','pending'];
function access(user) { if (!['finance','admin'].includes(user?.role)) fail('Finance or Admin role is required.',403); }
async function actor(client,user,role) {
 const row=(await client.query('SELECT id,role,active FROM app_users WHERE id=$1 FOR SHARE',[user.id])).rows[0];
 if (!row?.active || row.role!==role) fail(`The ${role==='admin'?'Admin':'Finance'} role is required for this action.`,403);
 return row;
}
// This scan is only used for Finance submission and Admin approval. Posting guards use date indexes.
async function snapshot(client,start,end) {
 return (await client.query(`SELECT jsonb_build_object('entries',count(*),'debit',COALESCE(sum(debit),0),'credit',COALESCE(sum(credit),0),
  'fingerprint',COALESCE(sum(hashtextextended(g::text,0)::numeric),0)::text) AS value FROM app_gl_entries g WHERE posting_date BETWEEN $1::date AND $2::date`,[start,end])).rows[0].value;
}
async function listPeriods(page=1) {
 page=Math.max(1,Math.min(100000,Number.parseInt(page,10)||1));
 return (await getPostgresPool().query(`SELECT p.*,u.username AS preparer,a.username AS approver,o.username AS opener,
 (SELECT COALESCE(jsonb_agg(jsonb_build_object('action',e.action,'reason',e.reason,'actor',eu.username,'at',e.created_at) ORDER BY e.id),'[]')
 FROM app_accounting_period_events e JOIN app_users eu ON eu.id=e.actor_id WHERE e.period_id=p.id) AS history
 FROM app_accounting_periods p JOIN app_users u ON u.id=p.prepared_by LEFT JOIN app_users a ON a.id=p.approved_by
 LEFT JOIN app_users o ON o.id=p.opened_by ORDER BY p.period_start DESC,p.id DESC LIMIT 51 OFFSET $1`,[(page-1)*50])).rows;
}
async function periodAction(user,action,input={}) {
 access(user);
 if(!['create','save','submit','approve','return','reopen'].includes(action)) fail('Unknown period action.');
 const finance=['create','save','submit'].includes(action);
 return withPostgresTransaction(async client=>{
  // Lock ordering is constant: actor, period coordination, period row.
  await actor(client,user,finance?'finance':'admin');
  if(['submit','approve','reopen'].includes(action)) await client.query('SELECT pg_advisory_xact_lock($1)',[LOCK_KEY]);
  let row;
  if(action!=='create') {
   if(!/^[1-9][0-9]*$/.test(String(input.id))) fail('Invalid period.');
   row=(await client.query('SELECT * FROM app_accounting_periods WHERE id=$1 FOR UPDATE',[input.id])).rows[0];
   if(!row) fail('Period not found.',404);
   if(Number(input.revision)!==row.revision) fail('This period changed. Reload before trying again.',409);
  }
  if(finance) {
   if(row && !['draft','returned','reopened'].includes(row.status)) fail('Only draft, returned or reopened periods can be prepared.',409);
   const start=String(input.period_start||''),end=String(input.period_end||''),notes=String(input.review_notes||'').trim();
   if(!isValidIsoDate(start)||!isValidIsoDate(end)||start>end||end>currentPostingDate()) fail('Choose valid period dates ending today or earlier.');
   if(notes.length>10000) fail('Review notes must be 10,000 characters or fewer.');
   const checks=Object.fromEntries(CHECKS.map(k=>[k,input[k]==='on']));
   if(action==='submit' && (!notes || CHECKS.some(k=>!checks[k]))) fail('Complete every review check and enter review notes before submitting.');
   if(action==='submit') {
    const overlap=await client.query("SELECT 1 FROM app_accounting_periods WHERE status='closed' AND period_start<=$2::date AND period_end>=$1::date",[start,end]);
    if(overlap.rowCount) fail('The period overlaps an existing closed period.');
   }
   const state=action==='submit'?'pending':'draft';
   const reviewed=action==='submit'?JSON.stringify(await snapshot(client,start,end)):null;
   if(!row) row=(await client.query(`INSERT INTO app_accounting_periods(period_start,period_end,review_notes,review_checks,prepared_by,status)
    VALUES($1,$2,$3,$4,$5,'draft') RETURNING *`,[start,end,notes,JSON.stringify(checks),user.id])).rows[0];
   else row=(await client.query(`UPDATE app_accounting_periods SET period_start=$2,period_end=$3,review_notes=$4,review_checks=$5,
    prepared_by=$6,prepared_at=now(),status=$7,ledger_snapshot=$8,approved_by=NULL,approved_at=NULL,revision=revision+1 WHERE id=$1 RETURNING *`,
    [row.id,start,end,notes,JSON.stringify(checks),user.id,state,reviewed])).rows[0];
  } else {
   const notes=String(input.reason||'').trim(); if(!notes || notes.length>10000) fail('Enter review notes or a reason (up to 10,000 characters).');
   if(action==='reopen') {
    if(row.status!=='closed') fail('Only a closed period can be reopened.',409);
    row=(await client.query("UPDATE app_accounting_periods SET status='reopened',opened_by=$2,opened_at=now(),open_reason=$3,revision=revision+1 WHERE id=$1 RETURNING *",[row.id,user.id,notes])).rows[0];
   } else {
    if(row.status!=='pending') fail('This period is not awaiting review.',409);
    if(Number(row.prepared_by)===Number(user.id)) fail('The preparer cannot approve or review their own period.',403);
    if(action==='approve') {
     const overlap=await client.query("SELECT 1 FROM app_accounting_periods WHERE status='closed' AND period_start<=$2::date AND period_end>=$1::date",[row.period_start,row.period_end]);
     if(overlap.rowCount) fail('The period overlaps an existing closed period.');
     const live=await snapshot(client,row.period_start,row.period_end);
     if(JSON.stringify(live)!==JSON.stringify(row.ledger_snapshot)) fail('Ledger postings changed after Finance submitted the review. Return it to Finance for a fresh review.',409);
     if(Number(live.debit)!==Number(live.credit)) fail('The period ledger is unbalanced. Return it to Finance.');
    }
    row=(await client.query(`UPDATE app_accounting_periods SET status=$2,admin_notes=$3,approved_by=$4,approved_at=CASE WHEN $2='closed' THEN now() ELSE NULL END,
     revision=revision+1 WHERE id=$1 RETURNING *`,[row.id,action==='approve'?'closed':'returned',notes,action==='approve'?user.id:null])).rows[0];
   }
  }
  await client.query('INSERT INTO app_accounting_period_events(period_id,action,actor_id,reason,state) VALUES($1,$2,$3,$4,$5)',
   [row.id,action,user.id,finance?row.review_notes:String(input.reason).trim(),JSON.stringify(row)]);
  return row;
 });
}
module.exports={listPeriods,periodAction,CHECKS,access};
