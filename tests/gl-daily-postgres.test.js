'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const store=require('../src/store');const {seedGoldenData}=require('./helpers/golden-seed');
const {roundMoney}=require('../src/lib/money');
test('daily balances follow inserts, backdated updates, deletes, rollback, access filters and truncate',{
 skip:process.env.GL_EXPORT_TEST_POSTGRES!=='1',timeout:60000,
},async()=>{
 try{
  await seedGoldenData();const p=store.getPostgresPool();
  const accounts=(await p.query('SELECT id FROM app_accounts ORDER BY id LIMIT 2')).rows;
  const reconcile=async()=>{
   const r=await p.query(`WITH expected AS (
    SELECT account_id,posting_date,voucher_type,mod(COALESCE(voucher_id,0),16)::int bucket,
      CASE WHEN voucher_type LIKE 'hr_%' THEN party_id END party_id,
      CASE WHEN voucher_type LIKE 'hr_%' THEN cost_center END cost_center,
      CASE WHEN voucher_type IN ('hr_payment','hr_payment_cancellation') THEN COALESCE(reversal_of_voucher_id,voucher_id) END voucher_id,
      count(*)::bigint entry_count,sum(debit) debit,sum(credit) credit
    FROM app_gl_entries GROUP BY 1,2,3,4,5,6,7
   ), actual AS (SELECT * FROM wm_gl_daily WHERE entry_count<>0 OR debit<>0 OR credit<>0)
   SELECT count(*)::int n FROM ((SELECT * FROM expected EXCEPT SELECT * FROM actual)
     UNION ALL (SELECT * FROM actual EXCEPT SELECT * FROM expected)) diff`);
   assert.equal(r.rows[0].n,0);
  };
  await reconcile();
  await p.query(`INSERT INTO app_gl_entries(posting_date,account_id,voucher_type,voucher_id,line_no,debit,credit,party_id,cost_center)
    VALUES ('2024-01-01',$1,'journal_entry',9000,1,10.25,0,'hidden','hidden'),
      ('2024-01-01',$2,'journal_entry',9000,2,0,10.25,NULL,NULL),
      ('2025-01-01',$1,'hr_payroll',9001,1,20,0,'E1',NULL),
      ('2025-01-01',$1,'hr_payroll',9002,1,30,0,NULL,''),
      ('2025-01-01',$1,'hr_payment',9003,1,40,0,'E1',NULL)`,accounts.map(a=>a.id));
  await reconcile();
  await p.query("UPDATE app_gl_entries SET posting_date='2023-01-01',account_id=$1,credit=11.75 WHERE voucher_type='journal_entry' AND voucher_id=9000 AND line_no=2",[accounts[0].id]);await reconcile();
  const client=await p.connect();try{await client.query('BEGIN');await client.query("DELETE FROM app_gl_entries WHERE voucher_id=9000");await client.query('ROLLBACK');}finally{client.release();}await reconcile();
  for(const access of [{},{allowedAccounts:[String(accounts[0].id)]},{allowedAccounts:[]},
    {deniedAccounts:[String(accounts[0].id)]},{ownerId:'nobody'},
    {hrAccess:{payroll:false,money:false}},{hrAccess:{payroll:true,money:true}},
    {hrAccess:{payroll:true,money:false,employees:['E1']}},
    {hrAccess:{payroll:true,money:true,deniedEmployees:['E1'],costCenters:['']}}]){
   for(const filters of [{},{from:'2024-01-01',to:'2025-02-01'},{voucher_type:'hr_payroll'},{party:'E1'},{search:'900'}]){
    const all=await store.generalLedgerReport(filters,{...access,exportAll:true});
    assert.equal(all.pagination.total,all.rows.length);
    assert.equal(all.summary.debit,roundMoney(all.rows.reduce((n,r)=>n+r.debit,0)));
    assert.equal(all.summary.credit,roundMoney(all.rows.reduce((n,r)=>n+r.credit,0)));
   }
  }
  await p.query('DELETE FROM app_gl_entries WHERE voucher_id=9000');await reconcile();
  // Opposite account line orders must both commit.
  await Promise.all([0,1].map(n=>store.createJournalEntry({journal_type:'journal_entry',posting_date:'2026-01-01',remarks:'Daily concurrent '+n,
    lines:[{account_id:accounts[n].id,debit:10,credit:0},{account_id:accounts[1-n].id,debit:0,credit:10}]})));
  await reconcile();
  require('../src/read-cache').clearReadCaches();
  const types=await store.generalLedgerFilterOptions();
  assert.deepEqual(types.voucher_types.map(r=>r.value),(await p.query('SELECT DISTINCT voucher_type FROM app_gl_entries ORDER BY voucher_type')).rows.map(r=>r.voucher_type));
  await p.query('TRUNCATE app_gl_entries');assert.equal((await p.query('SELECT count(*)::int n FROM wm_gl_daily')).rows[0].n,0);
  require('../src/read-cache').clearReadCaches();
  assert.deepEqual((await store.generalLedgerFilterOptions()).voucher_types,[]);
 }finally{await store.closeStore();}
});
