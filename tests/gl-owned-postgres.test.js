'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const store=require('../src/store');
const {seedGoldenData}=require('./helpers/golden-seed');
const {clearReadCaches}=require('../src/read-cache');

test('owned summaries stay equivalent to detailed permissions through source and ledger changes',{
  skip:process.env.GL_EXPORT_TEST_POSTGRES!=='1',timeout:120000,
},async t=>{
 try{
  await seedGoldenData();const p=store.getPostgresPool();
  assert.match((await p.query('SELECT current_database() name')).rows[0].name,/_hr_test$/);
  const accounts=(await p.query('SELECT id,account_code FROM app_accounts ORDER BY id LIMIT 2')).rows;
  const id=950001,other=950002;
  await p.query(`INSERT INTO app_invoices(id,invoice_no,invoice_date,customer_id,customer_name,invoicer_id,created_by_user_id)
    VALUES ($1,'OWNED-INVOICE','2026-01-01','OWNED-C','Owned customer','OWNED-E','OWNED-A'),
      ($2,'OWNED-OTHER','2026-01-01','OWNED-C','Owned customer',NULL,'OWNED-B')`,[id,other]);
  await p.query(`INSERT INTO app_purchases(id,purchase_no,posting_date,supplier_id,supplier_name,created_by_user_id)
    VALUES($1,'OWNED-PURCHASE','2026-01-01','OWNED-S','Owned supplier','OWNED-A'),
      ($2,'OWNED-PURCHASE-OTHER','2026-01-01','OWNED-S','Owned supplier','OWNED-B')`,[id,other]);
  await p.query(`INSERT INTO app_journal_entries(id,journal_no,journal_type,posting_date,created_by_user_id)
    VALUES($1,'OWNED-JOURNAL','journal_entry','2026-01-01','OWNED-B'),
      ($2,'OWNED-JOURNAL-OTHER','journal_entry','2026-01-01','OWNED-A')`,[id,other]);
  await p.query(`INSERT INTO app_invoice_payments(id,invoice_id,payment_no,payment_date,amount,method)
    VALUES($1,$1,1,'2026-01-01',1,'cash')`,[id]);
  await p.query(`INSERT INTO app_purchase_payments(id,purchase_id,payment_no,payment_date,amount,method,journal_entry_id)
    VALUES($1,$1,1,'2026-01-01',1,'cash',$1)`,[id]);
  await p.query(`INSERT INTO app_stock_entries(id,entry_no,entry_type,posting_date,created_by_user_id)
    VALUES($1,'OWNED-STOCK','transfer','2026-01-01','OWNED-A')`,[id]);
  for(const type of ['sales_invoice','customer_payment','purchase','purchase_payment','payment_journal','journal_entry','stock_custom']){
   await p.query(`INSERT INTO app_gl_entries(posting_date,account_id,voucher_type,voucher_id,voucher_no,line_no,debit,credit)
     VALUES('2025-01-01',$1,$3,$4,'OWNED-GL',1,10.25,0),
       ('2026-01-04',$1,$3,$4,'OWNED-GL',2,2.75,0),
       ('2026-01-04',$2,$3,$4,'OWNED-GL',3,0,13)`,[accounts[0].id,accounts[1].id,type,id]);
  }
  const reconcile=async()=>{
   const {rows}=await p.query(`WITH expected AS (
     SELECT account_id,posting_date,voucher_type,mod(COALESCE(source_id,0),16)::int bucket,
       owner_ids,employee_ids,count(*)::bigint entry_count,sum(debit) debit,sum(credit) credit
     FROM wm_gl_owned_entries GROUP BY 1,2,3,4,5,6
    ), actual AS (SELECT * FROM wm_gl_owned_daily WHERE entry_count<>0 OR debit<>0 OR credit<>0)
    SELECT count(*)::int n FROM ((SELECT * FROM expected EXCEPT SELECT * FROM actual)
     UNION ALL (SELECT * FROM actual EXCEPT SELECT * FROM expected)) differences`);
   assert.equal(rows[0].n,0,'owned daily totals reconcile with their entries');
  };
  const equivalent=async()=>{
   clearReadCaches();await reconcile();
   for(const access of [{ownerId:'OWNED-A'},{ownerId:'OWNED-B'},
    {ownerId:'nobody',ownerEmployeeId:'OWNED-E'},{ownerId:'OWNED-A',ownerEmployeeId:'OWNED-E'},
    {ownerId:'nobody'},{ownerId:''}]){
    for(const filters of [{from:'2026-01-04',to:'2026-01-04'},
      {from:'2026-01-04',to:'2026-01-04',account:accounts[0].account_code},
      {to:'2026-01-04'},{from:'2026-01-04',to:'2026-01-04',voucher_type:'payment_journal'}]){
     const reference=await store.generalLedgerReport(filters,{...access,exportAll:true});
     for(const page of [1,2,20]){
      const actual=await store.generalLedgerReport({...filters,page,page_size:3},access);
      assert.deepEqual(actual.rows,reference.rows.slice((page-1)*3,page*3));
      assert.deepEqual(actual.opening_rows,reference.opening_rows);
      assert.deepEqual(actual.summary,reference.summary);
      assert.equal(actual.pagination.total,reference.rows.length);
     }
    }
   }
  };
  await t.test('initial ownership, employee overlap and shared payment journals count each entry once',equivalent);
  await t.test('source transfers, employee removal and payment relinking change access immediately',async()=>{
   await p.query("UPDATE app_invoices SET created_by_user_id='OWNED-B',invoicer_id=NULL WHERE id=$1",[id]);
   await p.query("UPDATE app_purchases SET created_by_user_id='OWNED-B' WHERE id=$1",[id]);
   await p.query("UPDATE app_journal_entries SET created_by_user_id='OWNED-A' WHERE id=$1",[id]);
   await p.query("UPDATE app_stock_entries SET created_by_user_id='OWNED-B' WHERE id=$1",[id]);
   await equivalent();
   await p.query('UPDATE app_invoice_payments SET invoice_id=$2 WHERE id=$1',[id,other]);
   await p.query("UPDATE app_purchase_payments SET purchase_id=$2,journal_entry_id=$2,method='journal' WHERE id=$1",[id,other]);
   await equivalent();
   await p.query("UPDATE app_purchase_payments SET method='cash' WHERE id=$1",[id]);
   await equivalent();
  });
  await t.test('backdating, reversals, orphan deletion and rollback preserve exact balances',async()=>{
   await p.query(`INSERT INTO app_gl_entries(posting_date,account_id,voucher_type,voucher_id,reversal_of_voucher_id,voucher_no,line_no,debit,credit,is_reversal)
     SELECT '2026-01-04',account_id,'sales_invoice_cancellation',999999,$1,'OWNED-REVERSE',line_no,credit,debit,true
     FROM app_gl_entries WHERE voucher_type='sales_invoice' AND voucher_id=$1`,[id]);
   await p.query("UPDATE app_gl_entries SET posting_date='2024-01-01',debit=7.25 WHERE voucher_no='OWNED-GL' AND line_no=2");
   await equivalent();
   const c=await p.connect();try{
    await c.query('BEGIN');
    await c.query("UPDATE app_invoices SET created_by_user_id='OWNED-A' WHERE id=$1",[id]);
    await c.query("DELETE FROM app_gl_entries WHERE voucher_no='OWNED-GL'");
    await c.query('ROLLBACK');
   }finally{c.release();}
   await equivalent();
   await p.query('DELETE FROM app_stock_entries WHERE id=$1',[id]);
   await equivalent();
   await p.query("DELETE FROM app_gl_entries WHERE voucher_no IN ('OWNED-GL','OWNED-REVERSE')");
   await equivalent();
  });
  await t.test('a ledger insert waiting behind an ownership edit uses the committed owner',async()=>{
   const a=await p.connect(),b=await p.connect();let pending;
   try{
    await a.query('BEGIN');await b.query('BEGIN');
    await a.query("UPDATE app_journal_entries SET created_by_user_id='OWNED-B' WHERE id=$1",[other]);
    pending=b.query(`INSERT INTO app_gl_entries(posting_date,account_id,voucher_type,voucher_id,voucher_no,line_no,debit,credit)
      VALUES('2026-01-04',$1,'journal_entry',$2,'OWNED-CONCURRENT',1,3,0)`,[accounts[0].id,other]);
    await new Promise(resolve=>setTimeout(resolve,100));
    await a.query('COMMIT');await pending;await b.query('COMMIT');
   }catch(error){await a.query('ROLLBACK');await pending?.catch(()=>{});await b.query('ROLLBACK');throw error;}
   finally{a.release();b.release();}
   await equivalent();
  });
  await t.test('payment relinking waits for a concurrent edit of the new parent owner',async()=>{
   await p.query('UPDATE app_invoice_payments SET invoice_id=$1 WHERE id=$1',[id]);
   await p.query(`INSERT INTO app_gl_entries(posting_date,account_id,voucher_type,voucher_id,voucher_no,line_no,debit,credit)
     VALUES('2026-01-04',$1,'customer_payment',$2,'OWNED-PARENT-RACE',1,5,0)`,[accounts[0].id,id]);
   const a=await p.connect(),b=await p.connect();let pending;
   try{
    await a.query('BEGIN');await b.query('BEGIN');
    await a.query("UPDATE app_invoices SET created_by_user_id='OWNED-A' WHERE id=$1",[other]);
    pending=b.query('UPDATE app_invoice_payments SET invoice_id=$2 WHERE id=$1',[id,other]);
    await new Promise(resolve=>setTimeout(resolve,100));
    await a.query('COMMIT');await pending;await b.query('COMMIT');
   }catch(error){await a.query('ROLLBACK');await pending?.catch(()=>{});await b.query('ROLLBACK');throw error;}
   finally{a.release();b.release();}
   await equivalent();
  });
  await t.test('source truncation removes orphan access and ledger truncation clears derived records',async()=>{
   await p.query('TRUNCATE app_journal_entry_lines,app_journal_entries CASCADE');
   await equivalent();
   await p.query('TRUNCATE app_gl_entries');
   assert.equal((await p.query('SELECT count(*)::int n FROM wm_gl_owned_entries')).rows[0].n,0);
   assert.equal((await p.query('SELECT count(*)::int n FROM wm_gl_owned_daily')).rows[0].n,0);
  });
 }finally{await store.closeStore();}
});
