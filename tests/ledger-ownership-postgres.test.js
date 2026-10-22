'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const store=require('../src/store');
const {seedGoldenData}=require('./helpers/golden-seed');
const {roundMoney}=require('../src/lib/money');
const {addGeneralLedgerAccessFilter:legacy}=require('./helpers/ledger-access-reference');
const {addGeneralLedgerAccessFilter:current,withGeneralLedgerExport}=require('../src/domain/ledger');

test('voucher membership preserves ownership, reversals, category scopes, HR and full-history balances',{
  skip:process.env.GL_EXPORT_TEST_POSTGRES!=='1',
},async()=>{
 try{
  await seedGoldenData();const pool=store.getPostgresPool();
  assert.match((await pool.query('SELECT current_database() name')).rows[0].name,/_hr_test$/);
  const accounts=(await pool.query("SELECT id,account_code FROM app_accounts WHERE account_code IN ('1120','3000','4000') ORDER BY account_code")).rows;
  assert.equal(accounts.length,3);
  await pool.query("INSERT INTO app_users(id,username,password_hash) VALUES(900001,'owner-a','unused'),(900002,'owner-b','unused')");
  await pool.query("INSERT INTO app_master_customers(customer_id,customer_name,customer_group) VALUES('OWN-R','Retail','Retail'),('OWN-W','Wholesale','Wholesale')");
  await pool.query("INSERT INTO app_master_suppliers(supplier_id,supplier_name,supplier_type) VALUES('OWN-L','Local','Local'),('OWN-I','Import','Import')");
  await pool.query("INSERT INTO app_master_employees(employee_id,employee_name) VALUES('OWN-EA','Employee A'),('OWN-EB','Employee B')");
  await pool.query("INSERT INTO app_master_cost_centers(cost_center,cost_center_name) VALUES('OWN-Shop','Shop'),('OWN-Other','Other')");
  await pool.query("INSERT INTO app_master_warehouses(warehouse) VALUES('OWN-Warehouse')");
  await pool.query("INSERT INTO wm_inventory_control(warehouse) VALUES('OWN-Warehouse')");
  const sources=[];
  for(let n=1;n<=4;n++){
   const id=900000+n,owner=n===2?'900002':n===3?null:'900001',employee=n<=2?'OWN-EA':n===3?null:'';
   await pool.query(`INSERT INTO app_invoices(id,invoice_no,invoice_date,customer_id,customer_name,invoicer_id,created_by_user_id)
    VALUES($1,$2,'2026-01-01',$3,$3,$4,$5)`,[id,'OWN-'+n,n%2?'OWN-R':'OWN-W',employee,owner]);
   await pool.query(`INSERT INTO app_purchases(id,purchase_no,posting_date,supplier_id,supplier_name,created_by_user_id)
    VALUES($1,$2,'2026-01-01',$3,$3,$4)`,[id,'OWN-'+n,n%2?'OWN-L':'OWN-I',owner]);
   await pool.query(`INSERT INTO app_journal_entries(id,journal_no,journal_type,posting_date,created_by_user_id)
    VALUES($1,$2,'journal_entry','2026-01-01',$3)`,[id,'OWN-'+n,owner]);
   await pool.query(`INSERT INTO app_journal_entry_lines(journal_entry_id,line_no,account_id,debit,credit)
    VALUES($1,1,$2,1,0),($1,2,$3,0,1)`,[id,accounts[0].id,accounts[n===4?2:1].id]);
   await pool.query(`INSERT INTO app_stock_entries(id,entry_no,entry_type,posting_date,created_by_user_id)
    VALUES($1,$2,'opening','2026-01-01',$3)`,[id,'OWN-'+n,owner]);
   await pool.query(`INSERT INTO app_invoice_payments(id,invoice_id,payment_no,payment_date,amount,method)
    VALUES($1,$1,1,'2026-01-01',1,'cash')`,[id]);
   await pool.query(`INSERT INTO app_purchase_payments(id,purchase_id,payment_no,payment_date,amount,method,journal_entry_id)
    VALUES($1,$1,1,'2026-01-01',1,$2,$3)`,[id,n===3?'journal':'cash',n===1?900001:n===4?null:900002]);
   if(n<=2)await pool.query(`INSERT INTO wm_inventory_corrections(id,warehouse,source_reference,reason,treatment,quantity,rate,prepared_by)
    VALUES($1,'OWN-Warehouse',$2,'Ownership fixture','physical',1,1,$1)`,[id,'OWN-'+n]);
   for(const type of ['sales_invoice','customer_payment','purchase','purchase_payment','payment_journal','cash_receipt','journal_entry','stock_custom']){
    sources.push({type,id,n});sources.push({type:type+'_cancellation',id:900000+(n%4)+1,reversal:id,n});
    if(n===1)sources.push({type,id:999999,reversal:id,n},{type,id:null,reversal:id,n});
   }
   if(n<=2)sources.push({type:'inventory_correction',id,n});
  }
  sources.push({type:'inventory_correction',id:900001,reversal:900002,n:1},
   {type:'inventory_correction',id:900002,reversal:900001,n:2},
   // This unsupported spelling must not inherit correction ownership merely
   // because it resembles a supported cancellation voucher type.
   {type:'inventory_correction_cancellation',id:900001,n:1});
  // Shared payment journals, NULL journal links and sources shared by creator
  // and assigned employee must preserve set membership without duplicating rows.
  await pool.query(`INSERT INTO app_purchase_payments(id,purchase_id,payment_no,payment_date,amount,method,journal_entry_id)
   VALUES(910001,900001,2,'2026-01-01',1,'cash',900002)`);
  const money=(await pool.query(`INSERT INTO app_hr_money(employee_id,kind,posting_date,amount,account_id,reason)
   VALUES('OWN-EA','advance','2026-01-01',1,$1,'Ownership fixture') RETURNING id`,[accounts[0].id])).rows[0].id;
  const hp=(await pool.query(`INSERT INTO app_hr_payments(money_id,posting_date,amount,direction,bank_account_id,reference)
   VALUES($1,'2026-01-01',1,'payout',$2,'Ownership fixture') RETURNING id`,[money,accounts[0].id])).rows[0].id;
  for(const type of ['hr_payroll','hr_money','hr_payment']){
   sources.push({type,id:type==='hr_payment'?hp:900001,n:1});
   sources.push({type:type+'_cancellation',id:900002,reversal:type==='hr_payment'?hp:900001,n:2});
  }
  sources.push({type:'journal_entry',id:null,n:1},{type:'sales_invoice',id:999999,n:2},{type:'unknown',id:900001,n:1});
  for(const [index,s]of sources.entries()){
   await pool.query(`INSERT INTO app_gl_entries(posting_date,account_id,voucher_type,voucher_id,voucher_no,line_no,
    debit,credit,party_type,party_id,party_name,cost_center,is_reversal,reversal_of_voucher_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'customer',$9,$10,$11,$12,$13)`,[
    ['2026-01-01','2026-01-04','2026-01-08'][index%3],accounts[index%2].id,s.type,s.id,'OWN-GL-'+index,1000+index,
    index%3?((index+1)/100).toFixed(2):0,index%3?0:((index+1)/100).toFixed(2),s.n%2?'OWN-EA':'OWN-EB',
    s.n%2?'Alpha':'Beta',index%3===0?null:s.n%2?'OWN-Shop':'OWN-Other',Boolean(s.reversal),s.reversal||null]);
  }
  const base={ownerId:'900001'};
  const accesses=[{},base,{ownerId:'900002'},{ownerId:'nobody'},{ownerId:''},
   {...base,ownerEmployeeId:'OWN-EA'},{ownerId:'nobody',ownerEmployeeId:'OWN-EA'},
   {...base,allowedAccounts:[String(accounts[0].id)]},
   {...base,allowedAccounts:accounts.slice(0,2).map(a=>String(a.id))},
   {...base,deniedAccounts:[String(accounts[1].id)]},{...base,allowedAccounts:[]},
   {...base,customerGroups:['retail']},{...base,customerGroups:[]},
   {...base,supplierTypes:['local']},{...base,supplierTypes:[]},
   {...base,customerGroups:['retail'],supplierTypes:['local']},
   {...base,hrAccess:{payroll:false,money:false}},
   {...base,hrAccess:{payroll:true,money:true}},
   {...base,hrAccess:{payroll:true,money:false,employees:['OWN-EA']}},
   {...base,hrAccess:{payroll:false,money:true,deniedEmployees:['OWN-EB'],costCenters:['OWN-Shop']}},
   {...base,customerGroups:[],hrAccess:{payroll:true,money:true,deniedCostCenters:['OWN-Other']}},
  ];
  function restriction(fn,access){const where=[],params=[];fn(where,params,access);return{sql:where.length?'WHERE '+where.join(' AND '):'WHERE true',params};}
  for(const access of accesses){
   const old=restriction(legacy,access),next=restriction(current,access),label=JSON.stringify(access);
   assert.deepEqual(next.params,old.params,label);
   const reference=(await pool.query(`SELECT gl.id FROM app_gl_entries gl ${old.sql} ORDER BY gl.id`,old.params)).rows;
   const actual=(await pool.query(`SELECT gl.id FROM app_gl_entries gl ${next.sql} ORDER BY gl.id`,next.params)).rows;
   assert.deepEqual(actual,reference,label);
   for(const [from,to]of [['2026-01-04','2026-01-08'],['2026-01-04','2026-01-04'],['2025-01-01','2025-01-02'],['2026-02-01','2026-02-02'],['','2026-01-08'],['2026-01-04','']]){
    for(const group_by of [undefined,'account']){
     const params=[...old.params,to||'9999-12-31'];
     const history=(await pool.query(`SELECT gl.id,gl.posting_date::text,account.account_code,
      SUM(gl.debit-gl.credit) OVER(PARTITION BY gl.account_id ORDER BY gl.posting_date,gl.id)::float running_balance
      FROM app_gl_entries gl JOIN app_accounts account ON account.id=gl.account_id
      ${old.sql} AND gl.posting_date<=$${params.length}::date
      ORDER BY ${group_by?'account.account_code,':''}gl.posting_date,gl.id`,params)).rows;
     const expected=history.filter(r=>r.posting_date>=from);
     const balanceParams=[...old.params,to||'9999-12-31',from||'0001-01-01'];
     const opening=(await pool.query(`SELECT account.account_code,account.account_name,
      COALESCE(SUM(gl.debit-gl.credit) FILTER(WHERE gl.posting_date<$${balanceParams.length}::date),0)::float running_balance
      FROM app_gl_entries gl JOIN app_accounts account ON account.id=gl.account_id
      ${old.sql} AND gl.posting_date<=$${balanceParams.length-1}::date
      GROUP BY account.id,account.account_code,account.account_name ORDER BY account.account_code,account.id`,balanceParams)).rows;
     const totals=(await pool.query(`SELECT
      COALESCE(SUM(gl.debit) FILTER(WHERE gl.posting_date>=$${balanceParams.length}::date),0)::float debit,
      COALESCE(SUM(gl.credit) FILTER(WHERE gl.posting_date>=$${balanceParams.length}::date),0)::float credit,
      COALESCE(SUM(gl.debit-gl.credit),0)::float balance FROM app_gl_entries gl
      ${old.sql} AND gl.posting_date<=$${balanceParams.length-1}::date`,balanceParams)).rows[0];
     const project=({id,posting_date,account_code,running_balance})=>({id,posting_date,account_code,running_balance});
     const filters={from,to,group_by,page:2,page_size:7};
     const page=await store.generalLedgerReport(filters,access);
     const full=await store.generalLedgerReport(filters,{...access,exportAll:true});
     assert.deepEqual(page.rows.map(project),expected.slice(7,14),label);
     assert.deepEqual(page.rows,full.rows.slice(7,14),label+' complete page rows');
     assert.deepEqual(page.account_summaries,full.account_summaries,label+' account summaries');
     assert.equal(page.pagination.total,expected.length,label+' page count');
     for(const number of [1,3,99]){
      const next=await store.generalLedgerReport({...filters,page:number},access);
      assert.deepEqual(next.rows,full.rows.slice((number-1)*7,number*7),label+' page '+number);
      assert.deepEqual(next.opening_rows,opening,label+' opening page '+number);
      assert.equal(next.pagination.total,expected.length,label+' count page '+number);
      assert.deepEqual(next.summary,page.summary,label+' totals page '+number);
     }
     await withGeneralLedgerExport(filters,access,async report=>{
      const rows=[];for await(const row of report.rows)rows.push(row);
      assert.deepEqual(rows.map(project),expected,label);assert.deepEqual(rows,full.rows,label);
      assert.deepEqual(report.account_summaries,full.account_summaries,label);
      assert.equal(report.pagination.total,expected.length,label);
      assert.deepEqual(report.opening_rows,opening,label);
      assert.deepEqual(report.summary,Object.fromEntries(Object.entries(totals).map(([key,value])=>[key,roundMoney(value)])),label);
      assert.deepEqual(report.opening_rows,page.opening_rows,label);assert.deepEqual(report.summary,page.summary,label);
     },{batchSize:3});
    }
   }
  }
  // The unpaginated path retains the independent original ownership predicate.
  // Compare every returned column and supplementary result for combined filters.
  for(const access of [base,accesses[5],accesses[8],accesses[15],accesses[18]]){
   for(const selected of [
    {account:accounts[0].account_code},
    {search:'OWN-GL-1'},
    {party:'Alpha',party_scope:'lines'},
    {party:'Alpha',party_scope:'related'},
    {party:'Alpha',party_scope:'related',group_by:'account',account:accounts[0].account_code},
    {voucher_type:'sales_invoice'},
    {voucher_type:'sales_invoice_cancellation'},
    {voucher_type:'journal_entry',voucher_id:'900001'},
    {voucher_type:'journal_entry_cancellation',voucher_id:'900002'},
   ]){
    const filters={from:'2026-01-04',to:'2026-01-08',...selected,page_size:3};
    const expected=await store.generalLedgerReport(filters,{...access,exportAll:true});
    for(const number of [1,2,99]){
     const actual=await store.generalLedgerReport({...filters,page:number},access);
     const {rows,pagination,...details}=actual;
     const {rows:all,pagination:ignored,...reference}=expected;
     assert.deepEqual(rows,all.slice((number-1)*3,number*3),JSON.stringify({access,selected,number}));
     assert.equal(pagination.total,all.length);
     assert.deepEqual(details,reference);
    }
   }
  }
  // An ownership edit cannot change an export already in progress, but must be
  // reflected by the next snapshot. No persisted ownership cache is involved.
  const snapshotFilters={from:'2026-01-04',to:'2026-01-08'};
  const before=await store.generalLedgerReport(snapshotFilters,{...base,exportAll:true});
  // Change ownership after totals have established the page snapshot. Rows,
  // openings and totals must still describe the same pre-edit permissions.
  const connect=pool.connect;let editPending=true;
  pool.connect=function(...args){
   if(typeof args[0]==='function')return connect.apply(this,args);
   return connect.apply(this,args).then(client=>{
    const query=client.query,release=client.release;
    client.query=async function(...args){
     const result=await query.apply(this,args);
     if(editPending&&String(args[0]).includes('account_totals AS')){
      editPending=false;
      await pool.query("UPDATE app_invoices SET created_by_user_id='900002' WHERE id=900001");
     }
     return result;
    };
    client.release=function(...args){client.query=query;client.release=release;return release.apply(this,args);};
    return client;
   });
  };
  try{
   const page=await store.generalLedgerReport({...snapshotFilters,page_size:7},base);
   assert.equal(editPending,false);
   assert.deepEqual(page.rows,before.rows.slice(0,7));
   assert.deepEqual(page.opening_rows,before.opening_rows);
   assert.deepEqual(page.summary,before.summary);
  }finally{
   pool.connect=connect;
   await pool.query("UPDATE app_invoices SET created_by_user_id='900001' WHERE id=900001");
  }
  await withGeneralLedgerExport(snapshotFilters,base,async report=>{
   const rows=[];
   for await(const row of report.rows){
    rows.push(row);
    if(rows.length===1)await pool.query("UPDATE app_invoices SET created_by_user_id='900002',invoicer_id=NULL WHERE id=900001");
   }
   assert.deepEqual(rows,before.rows);assert.deepEqual(report.opening_rows,before.opening_rows);
   assert.deepEqual(report.summary,before.summary);
  },{batchSize:1});
  for(const access of [base,{...base,ownerEmployeeId:'OWN-EA'}]){
   const old=restriction(legacy,access),next=restriction(current,access);
   assert.deepEqual((await pool.query(`SELECT gl.id FROM app_gl_entries gl ${next.sql} ORDER BY gl.id`,next.params)).rows,
    (await pool.query(`SELECT gl.id FROM app_gl_entries gl ${old.sql} ORDER BY gl.id`,old.params)).rows);
   const fresh=await store.generalLedgerReport(snapshotFilters,{...access,exportAll:true});
   await withGeneralLedgerExport(snapshotFilters,access,async report=>{
    const rows=[];for await(const row of report.rows)rows.push(row);
    assert.deepEqual(rows,fresh.rows);assert.deepEqual(report.summary,fresh.summary);
   });
  }
 }finally{await store.closeStore();}
});
