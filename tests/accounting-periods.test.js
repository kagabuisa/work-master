'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const periods=require('../src/accounting-periods');
const {permissionCheck}=require('../src/authorize');
test('period workflow routes enforce Finance preparation and Admin approval/reopening',()=>{
 for(const role of ['finance','admin','standard','privileged']) {
  const req={currentUser:{role,permissions:[]},path:'/accounting-periods',method:'GET'};
  assert.equal(permissionCheck(req),['finance','admin'].includes(role));
  for(const action of ['create','save','submit','approve','return','reopen']) assert.equal(permissionCheck({...req,method:'POST',body:{action}}),['create','save','submit'].includes(action)?role==='finance':role==='admin');
 }
});
test('period screens render Finance preparation and Admin review with escaped notes',async()=>{
 const ejs=require('ejs');
 const base={assetVersion:'test',availableReports:[],can:()=>false,dateTimeSettings:{date_format:'yyyy-mm-dd',time_format:'24h'},formatTimestamp:()=>'',error:'',page:1,hasNext:false};
 const row={id:1,period_start:'2026-01-01',period_end:'2026-01-31',revision:1,review_notes:'<script>bad</script>',review_checks:{},preparer:'Finance',history:[]};
 for(const role of ['finance','admin'])for(const status of ['draft','pending','closed','returned','reopened']) {
  const html=await ejs.renderFile(require('node:path').join(__dirname,'../views/accounting-periods.ejs'),{...base,currentUser:{role,username:role},rows:[{...row,status}]});
  assert.ok(html.includes('Accounting Periods'));assert.ok(!html.includes('<script>bad</script>'));
  assert.equal(html.includes('value="approve"'),role==='admin'&&status==='pending');
  assert.equal(html.includes('value="reopen"'),role==='admin'&&status==='closed');
  assert.equal(html.includes('value="submit"'),role==='finance'&&['draft','returned','reopened'].includes(status));
 }
});
test('period review, stale actions, changes after review, ledger guards and concurrent close', {skip:process.env.SCHEMA_TEST_POSTGRES!=='1'},async()=>{
 const store=require('../src/store');let held;
 try {
  await require('./helpers/golden-seed').seedGoldenData();const pool=store.getPostgresPool();
  const make=async role=>(await pool.query("INSERT INTO app_users(username,password_hash,role) VALUES($1,'unused',$1) RETURNING id,role",[role])).rows[0];
  const finance=await make('finance'),admin=await make('admin'),other=await make('standard');
  const checks=Object.fromEntries(periods.CHECKS.map(k=>[k,'on']));
  const input={period_start:'2026-01-01',period_end:'2026-01-31',review_notes:'Statements and pending vouchers reviewed',...checks};
  await assert.rejects(periods.periodAction(admin,'create',input),/Finance/);
  await assert.rejects(periods.periodAction(other,'create',input),/Finance or Admin/);
  await assert.rejects(periods.periodAction(finance,'create',{...input,period_start:'2026-02-31'}),/valid period/);
  let row=await periods.periodAction(finance,'create',input);
  await assert.rejects(periods.periodAction(finance,'submit',{...input,id:row.id,revision:99}),/changed/);
  row=await periods.periodAction(finance,'submit',{...input,id:row.id,revision:row.revision});
  const gl=(await pool.query("SELECT * FROM app_gl_entries WHERE posting_date BETWEEN '2026-01-01' AND '2026-01-31' LIMIT 1")).rows[0];
  await pool.query('UPDATE app_gl_entries SET remarks=$2 WHERE id=$1',[gl.id,'Changed after Finance review']);
  await assert.rejects(periods.periodAction(admin,'approve',{id:row.id,revision:row.revision,reason:'Reviewed'}),/postings changed/);
  row=await periods.periodAction(admin,'return',{id:row.id,revision:row.revision,reason:'Please review late change'});
  row=await periods.periodAction(finance,'submit',{...input,id:row.id,revision:row.revision});
  held=await pool.connect();await held.query('BEGIN');
  await held.query('UPDATE app_gl_entries SET remarks=remarks WHERE id=$1',[gl.id]);
  const closing=periods.periodAction(admin,'approve',{id:row.id,revision:row.revision,reason:'Review complete'});
  // Poll database lock state, rather than relying on elapsed time for concurrency assertions.
  let waiting=false;
  for(let i=0;i<100&&!waiting;i++) {waiting=(await pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=1776342163 AND NOT granted) AS waiting")).rows[0].waiting;}
  assert.equal(waiting,true,'approval waits for the posting transaction');
  await held.query('COMMIT');held.release();held=null;row=await closing;assert.equal(row.status,'closed');
  await assert.rejects(pool.query('UPDATE app_gl_entries SET remarks=$2 WHERE id=$1',[gl.id,'illegal']),/accounting_period_closed/);
  await assert.rejects(pool.query('DELETE FROM app_gl_entries WHERE id=$1',[gl.id]),/accounting_period_closed/);
  await assert.rejects(pool.query('TRUNCATE app_gl_entries'),/accounting_period_closed/);
  const accounts=(await pool.query("SELECT id FROM app_accounts WHERE account_code IN ('1120','3000') ORDER BY account_code")).rows;
  const journal={journal_type:'journal_entry',posting_date:'2026-01-15',remarks:'Blocked period test',lines:[{account_id:accounts[0].id,debit:10,credit:0},{account_id:accounts[1].id,debit:0,credit:10}]};
  const before=(await pool.query('SELECT count(*) AS n FROM app_journal_entries')).rows[0].n;
  await assert.rejects(store.createJournalEntry(journal),e=>e.status===409&&e.code==='accounting_period_closed');
  assert.equal((await pool.query('SELECT count(*) AS n FROM app_journal_entries')).rows[0].n,before,'failed posting rolls back voucher and lines');
  const draft=await store.createJournalEntry(journal,{submit:false});
  assert.ok(draft,'draft preparation remains available');

  const insert=`INSERT INTO app_gl_entries(posting_date,account_id,voucher_type,voucher_id,line_no,debit,credit,is_reversal,reversal_of_voucher_type,reversal_of_voucher_id) VALUES($1,$2,'period_test',99999,1,1,0,$3,$4,$5)`;
  await assert.rejects(pool.query(insert,['2026-01-31',gl.account_id,false,null,null]),/accounting_period_closed/);
  await assert.rejects(pool.query(insert,['2026-02-01',gl.account_id,true,gl.voucher_type,gl.voucher_id]),/accounting_period_closed/);
  await pool.query(insert,['2026-02-01',gl.account_id,false,null,null]);
  await assert.rejects(periods.periodAction(finance,'reopen',{id:row.id,revision:row.revision,reason:'Fix'}),/Admin/);
  row=await periods.periodAction(admin,'reopen',{id:row.id,revision:row.revision,reason:'Approved adjustment required'});
  await pool.query('UPDATE app_gl_entries SET remarks=$2 WHERE id=$1',[gl.id,'Allowed after reopening']);
  assert.equal((await periods.listPeriods()).find(p=>p.id===row.id).history.at(-1).action,'reopen');
  await pool.query("DELETE FROM app_gl_entries WHERE voucher_type='period_test'");
  // A posting whose SQL statement starts before closure commits must see the new closure after waiting.
  held=await pool.connect();await held.query('BEGIN');await held.query('SELECT pg_advisory_xact_lock(1776342163)');
  await held.query("UPDATE app_accounting_periods SET status='closed' WHERE id=$1",[row.id]);
  const late=pool.query(insert,['2026-01-01',gl.account_id,false,null,null]).then(()=>null,e=>e);
  waiting=false;
  for(let i=0;i<100&&!waiting;i++)waiting=(await pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=1776342163 AND NOT granted) AS waiting")).rows[0].waiting;
  assert.equal(waiting,true);await held.query('COMMIT');held.release();held=null;
  assert.match((await late).message,/accounting_period_closed/);
  await assert.rejects(pool.query("UPDATE app_accounting_period_events SET reason='tampered'"),/immutable/);
  const history=await periods.listPeriods();
  await pool.query('DELETE FROM wm_schema_version WHERE version=54');await store.initStore();
  assert.deepEqual(await periods.listPeriods(),history,'migration replay preserves periods and audit history');


 }finally{if(held){await held.query('ROLLBACK');held.release();}await store.closeStore();}
});
