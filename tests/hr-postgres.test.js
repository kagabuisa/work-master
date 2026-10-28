'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const hr=require('../src/hr');
const store=require('../src/store');
const {runWithAuditUser}=require('../src/audit');
const {hrLedgerAccessOptions}=require('../src/web/helpers');
const admin={role:'admin',id:1,username:'HR Admin'};
const restrictedUserFor=employeeId=>({role:'finance',record_access:{employee_id:employeeId},permissions:['hr.payroll.view']});
const author={role:'finance',id:2,username:'Author',permissions:[]};

test('fractional HR postings, payments, snapshots and reversals reconcile; payroll lists batch slips', {
  skip:process.env.HR_TEST_POSTGRES!=='1',
},async()=>{
  const pool=store.getPostgresPool();
  try {
    assert.match((await pool.query('SELECT current_database() AS name')).rows[0].name,/_hr_test$/);
    await pool.query('DROP SCHEMA public CASCADE');await pool.query('CREATE SCHEMA public');await store.initStore();
    await pool.query(`INSERT INTO app_master_employees(employee_id,employee_name,company,status)
      VALUES('FRACTION-1','Fraction employee one','Fraction Co','Active'),('FRACTION-2','Fraction employee two','Fraction Co','Active')`);
    const ids={};
    for(const [key,type,detail] of [['salary','expense','Expense Account'],['payable','liability','Payable'],
      ['loan','asset','Receivable'],['bank','asset','Bank']]) ids[key]=(await pool.query(`INSERT INTO app_accounts
      (account_code,account_name,account_type,account_detail_type,normal_balance) VALUES($1,$1,$2,$3,$4) RETURNING id`,
    [`FRACTION-${key}`,type,detail,type==='liability'?'credit':'debit'])).rows[0].id;
    const ledger=async(type,id,account)=>Number((await pool.query(`SELECT COALESCE(sum(credit-debit),0) AS balance
      FROM app_gl_entries WHERE voucher_type=$1 AND voucher_id=$2 AND account_id=$3`,[type,id,account])).rows[0].balance);
    await runWithAuditUser(admin,async()=>{
      await hr.saveSettings({action:'accounts',salary_payable_account_id:ids.payable},admin);
      const loan=await hr.createMoney({employee_id:'FRACTION-1',kind:'loan',posting_date:'2026-01-01',
        amount:'20.25',account_id:ids.loan,reason:'Fractional advance'},admin);
      await hr.moneyAction(loan,'submit',admin);
      const disbursement=await hr.payMoney(loan,{amount:'20.25',posting_date:'2026-01-01',bank_account_id:ids.bank,reference:'Advance'},admin);
      assert.equal(await ledger('hr_payment',disbursement,ids.loan),-20.25);
      const returned=await hr.payMoney(loan,{amount:'0.25',posting_date:'2026-01-02',bank_account_id:ids.bank,reference:'Cash return'},admin,'return');
      assert.equal(await ledger('hr_payment',returned,ids.loan),0.25,'sub-shilling payments retain ledger lines');
      const reimbursement=await hr.createMoney({employee_id:'FRACTION-1',kind:'reimbursement',posting_date:'2026-01-01',
        amount:'12.25',account_id:ids.payable,offset_account_id:ids.salary,reason:'Travel'},admin);
      await hr.moneyAction(reimbursement,'submit',admin);
      assert.equal(await ledger('hr_money',reimbursement,ids.payable),12.25);
      const reimbPayment=await hr.payMoney(reimbursement,{amount:'2.15',posting_date:'2026-01-02',bank_account_id:ids.bank,reference:'Travel payment'},admin);
      assert.equal(await ledger('hr_payment',reimbPayment,ids.payable),-2.15);
      const components=[{label:'Salary',kind:'earning',amount:'1000.50',account_id:ids.salary},
        {label:'Allowance',kind:'earning',amount:'1000.50',account_id:ids.salary},
        {label:'Tax',kind:'deduction',amount:'0.25',account_id:ids.payable},
        {label:'Employer',kind:'employer',amount:'1.25',account_id:ids.salary,payable_account_id:ids.payable}];
      const prepare=async(employee,components,paidDays)=>{
        await hr.savePayPlan(employee,{effective_from:'2026-01-01',components},admin);
        const run=await hr.createPayroll({company:'Fraction Co',period:'2026-01',posting_date:'2026-01-31',employee_ids:[employee]},admin);
        const slip=(await hr.payrollDetails(run,admin)).slips[0];
        await hr.updateSlip(run,slip.id,{paid_days:paidDays,input_note:'Reviewed fractional amounts',components,
          recoveries:employee==='FRACTION-1'?[{money_id:loan,amount:'0.50'}]:[]},admin);
        await hr.payrollAction(run,'submit',admin);
        return {run,slip};
      };
      const first=await prepare('FRACTION-1',components,31);
      const firstDetails=await hr.payslipDetails(first.slip.id,admin);
      assert.equal(Number(firstDetails.slip.net_pay),2000.25);
      assert.equal(await ledger('hr_payroll',first.run,ids.payable),2001.75,'net, tax and employer payable reconcile exactly');
      assert.equal(firstDetails.employeeMoneySummary.debts[0].balance_remaining,19.50);
      assert.equal(firstDetails.employeeMoneySummary.reimbursement_total,10.10);
      assert.equal((await hr.moneyList(admin)).find(m=>String(m.id)===String(loan)).balance,19.50);
      const partial=await hr.payPayroll(first.run,{slip_id:first.slip.id,posting_date:'2026-01-31',
        amount:'0.25',bank_account_id:ids.bank,reference:'Partial salary'},admin);
      assert.equal(await ledger('hr_payment',partial,ids.payable),-0.25);
      const remainder=await hr.payPayroll(first.run,{slip_id:first.slip.id,posting_date:'2026-01-31',
        amount:'2000',bank_account_id:ids.bank,reference:'Remaining salary'},admin);
      assert.equal(Number((await hr.payslipDetails(first.slip.id,admin)).slip.paid_amount),2000.25);
      const second=await prepare('FRACTION-2',[{label:'Prorated salary',kind:'earning',amount:10,prorate:true,account_id:ids.salary}],1);
      assert.equal(Number((await hr.payslipDetails(second.slip.id,admin)).slip.net_pay),0.32);
      assert.equal(await ledger('hr_payroll',second.run,ids.payable),0.32);

      await pool.query(`INSERT INTO app_hr_runs(company,period,posting_date,payable_account_id)
        SELECT 'Fraction Co','2026-02','2026-02-28',$1 FROM generate_series(1,198)`,[ids.payable]);
      const original=pool.query;let queries=0;
      pool.query=function(...args){queries++;return original.apply(this,args);};
      let register;
      try { register=await hr.payrollList(admin); } finally { pool.query=original; }
      assert.equal(queries,7,'200 headers use one slip batch, not one query per run');
      assert.equal(register.length,2,'empty headers remain omitted');
      const row=register.find(r=>String(r.id)===String(first.run));
      assert.deepEqual([row.employees,row.gross,row.net,row.paid],[1,2001,2000.25,2000.25]);
      assert.deepEqual((await hr.payrollList(restrictedUserFor('FRACTION-1'))).map(r=>String(r.id)),[String(first.run)]);
      assert.equal((await hr.payrollList({...admin,role:'finance',permission_denials:[`account.view:${ids.salary}`]})).length,0);
      for(const id of [partial,remainder]) await hr.cancelPayment('payroll',first.run,id,{posting_date:'2026-02-01'},admin);
      assert.equal(await ledger('hr_payment_cancellation',partial,ids.payable),0.25);
      await hr.payrollAction(first.run,'cancel',admin,{posting_date:'2026-02-01',reason:'Reverse fractional payroll'});
      assert.equal(await ledger('hr_payroll_cancellation',first.run,ids.payable),-2001.75);
      assert.equal((await hr.moneyList(admin)).find(m=>String(m.id)===String(loan)).balance,20);
      await hr.cancelPayment('money',reimbursement,reimbPayment,{posting_date:'2026-02-01'},admin);
      assert.equal(await ledger('hr_payment_cancellation',reimbPayment,ids.payable),2.15);
      await hr.moneyAction(reimbursement,'cancel',admin,{posting_date:'2026-02-01'});
      assert.equal(await ledger('hr_money_cancellation',reimbursement,ids.payable),-12.25);
    });
  } finally { await store.closeStore(); }
});

test('payslip Employee Money balances are dated, frozen, scoped and independent of salary totals',{
  skip:process.env.HR_TEST_POSTGRES!=='1',
},async()=>{
  const pool=store.getPostgresPool();
  try{
    assert.match((await pool.query('SELECT current_database() AS name')).rows[0].name,/_hr_test$/);
    await pool.query('DROP SCHEMA public CASCADE');await pool.query('CREATE SCHEMA public');await store.initStore();
    await pool.query("INSERT INTO app_master_employees(employee_id,employee_name,company,status) VALUES('SUM-E1','Summary employee','Summary Company','Active'),('SUM-E2','Other employee','Summary Company','Active')");
    await pool.query("INSERT INTO app_master_cost_centers(cost_center,cost_center_name) VALUES('SUM Shop','Summary shop'),('SUM Other','Other shop')");
    const ids={};
    for(const [name,type,detail] of [['salary','expense','Expense Account'],['offset','expense','Expense Account'],['payable','liability','Payable'],['loan','asset','Receivable'],['advance','asset','Receivable'],['charge','asset','Receivable'],['bank','asset','Bank']])
      ids[name]=(await pool.query('INSERT INTO app_accounts(account_code,account_name,account_type,account_detail_type,normal_balance) VALUES($1,$1,$2,$3,$4) RETURNING id',[`SUM-${name}`,type,detail,['asset','expense'].includes(type)?'debit':'credit'])).rows[0].id;
    await runWithAuditUser(admin,async()=>{
      await hr.saveProfile('SUM-E1',{joining_date:'2026-01-01',cost_center:'SUM Shop'},admin);
      await hr.saveSettings({action:'accounts',salary_payable_account_id:ids.payable},admin);
      const components=[{label:'Salary',kind:'earning',amount:200000,account_id:ids.salary}];
      await hr.savePayPlan('SUM-E1',{effective_from:'2026-01-01',components},admin);
      const create=async(kind,amount,posting_date,reason,extra={})=>{
        const id=await hr.createMoney({employee_id:'SUM-E1',kind,amount,posting_date,reason,
          account_id:ids[kind==='recovery'?'charge':kind==='reimbursement'?'payable':kind],
          offset_account_id:['recovery','reimbursement'].includes(kind)?ids.offset:undefined,...extra},admin);
        await hr.moneyAction(id,'submit',admin);return id;
      };
      const pay=(id,amount,posting_date,direction='payout')=>hr.payMoney(id,{amount,posting_date,bank_account_id:ids.bank,reference:'Summary test'},admin,direction);
      const loan=await create('loan',100000,'2026-01-01','Original loan');await pay(loan,100000,'2026-01-01');
      const returned=await pay(loan,2000,'2026-01-10','return');
      await hr.cancelPayment('money',loan,returned,{posting_date:'2026-02-02'},admin);
      await pay(loan,3000,'2026-02-05','return');
      const advance=await create('advance',30000,'2026-01-02','Advance');await pay(advance,20000,'2026-01-02');await pay(advance,10000,'2026-02-01');
      const charge=await create('recovery',30000,'2026-01-03','Approved charge');
      const reimbursement=await create('reimbursement',5000,'2026-01-04','Transport');
      const reimbursementPayment=await pay(reimbursement,1000,'2026-01-06');
      await hr.cancelPayment('money',reimbursement,reimbursementPayment,{posting_date:'2026-02-02'},admin);
      await create('loan',9000,'2026-01-05','Unfunded loan');
      const otherScope=await create('loan',7000,'2026-01-05','Other cost center',{cost_center:'SUM Other'});await pay(otherScope,7000,'2026-01-05');
      const future=await create('loan',40000,'2026-02-01','Future loan');await pay(future,40000,'2026-02-01');
      const otherEmployee=await create('loan',88888,'2026-01-01','Unrelated employee',{employee_id:'SUM-E2'});await pay(otherEmployee,88888,'2026-01-01');
      const newRun=async(period,posting_date)=>{
        const id=await hr.createPayroll({company:'Summary Company',period,posting_date,employee_ids:['SUM-E1']},admin);
        return {id,slip:(await hr.payrollDetails(id,admin)).slips[0]};
      };
      // A future-dated posted recovery must not reduce January's opening balance.
      const feb=await newRun('2026-02','2026-02-28');
      await hr.updateSlip(feb.id,feb.slip.id,{paid_days:28,input_note:'February loan recovery',components,recoveries:[{money_id:loan,amount:5000}]},admin);
      await hr.payrollAction(feb.id,'submit',admin);
      const jan=await newRun('2026-01','2026-01-31');
      await hr.updateSlip(jan.id,jan.slip.id,{paid_days:31,input_note:'January recoveries',components,recoveries:[
        {money_id:loan,amount:10000},{money_id:advance,amount:5000},{money_id:charge,amount:30000},
      ]},admin);
      const before=await hr.payslipDetails(jan.slip.id,admin);
      assert.equal(before.employeeMoneySummary.status,'provisional');
      assert.equal(Number(before.slip.net_pay),155000);
      const loanRow=before.employeeMoneySummary.debts.find(row=>String(row.money_id)===String(loan));
      assert.deepEqual([loanRow.balance_before,loanRow.recovered,loanRow.balance_remaining],[98000,10000,88000]);
      assert.equal(before.employeeMoneySummary.reimbursement_total,4000,'dated reimbursement reversal is excluded from January');
      assert.equal(before.employeeMoneySummary.debts.length,4,'includes outstanding permitted scopes, omits unfunded/future/other employees');
      assert.deepEqual(before.employeeMoneySummary.totals,{balance_before:155000,recovered:45000,balance_remaining:110000});
      assert.equal((await pool.query('SELECT employee_money_snapshot FROM app_hr_slips WHERE id=$1',[jan.slip.id])).rows[0].employee_money_snapshot,null);
      const payrollOnly={role:'finance',permissions:['hr.payroll.view'],record_access:{employee_id:'SUM-E1'}};
      assert.equal((await hr.payslipDetails(jan.slip.id,payrollOnly)).employeeMoneySummary,null);
      await pool.query(`CREATE FUNCTION fail_summary_posting() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.voucher_type='hr_payroll' THEN RAISE EXCEPTION 'forced summary posting rollback'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER fail_summary_posting BEFORE INSERT ON app_gl_entries FOR EACH ROW EXECUTE FUNCTION fail_summary_posting()`);
      await assert.rejects(()=>hr.payrollAction(jan.id,'submit',admin),/forced summary posting rollback/);
      assert.equal((await pool.query('SELECT employee_money_snapshot FROM app_hr_slips WHERE id=$1',[jan.slip.id])).rows[0].employee_money_snapshot,null,'a failed ledger posting cannot leave a frozen summary');
      await pool.query('DROP TRIGGER fail_summary_posting ON app_gl_entries; DROP FUNCTION fail_summary_posting()');
      const reviewer={role:'finance',id:99,permissions:['hr.payroll.view','hr.payroll.submit']};
      await runWithAuditUser(reviewer,()=>hr.payrollAction(jan.id,'submit',reviewer));
      const frozen=await hr.payslipDetails(jan.slip.id,admin);
      assert.equal(frozen.employeeMoneySummary.status,'frozen');
      assert.deepEqual(frozen.employeeMoneySummary.debts,before.employeeMoneySummary.debts);
      assert.equal(frozen.employeeMoneySummary.debts.find(row=>String(row.money_id)===String(charge)).balance_remaining,0,'final recovery stays on the issued payslip');
      assert.ok(!Object.hasOwn(frozen.slip,'employee_money_snapshot'));
      assert.ok(!(await hr.payslipList(payrollOnly)).some(s=>Object.hasOwn(s,'employee_money_snapshot')));
      assert.ok(!(await hr.payrollDetails(jan.id,payrollOnly)).slips.some(s=>Object.hasOwn(s,'employee_money_snapshot')));
      const scoped={...payrollOnly,permissions:['hr.payroll.view','hr.money.view'],record_access:{employee_id:'SUM-E1',cost_center:'SUM Shop'},permission_denials:[`account.view:${ids.offset}`]};
      const visible=(await hr.payslipDetails(jan.slip.id,scoped)).employeeMoneySummary;
      assert.deepEqual(visible.totals,{balance_before:118000,recovered:15000,balance_remaining:103000});
      assert.equal(visible.reimbursements.length,0);
      await pay(loan,10000,'2026-03-01','return');
      await pay(reimbursement,5000,'2026-03-01');
      assert.deepEqual((await hr.payslipDetails(jan.slip.id,admin)).employeeMoneySummary,frozen.employeeMoneySummary);
      await hr.payrollAction(jan.id,'cancel',admin,{posting_date:'2026-03-05',reason:'Cancelled summary stays historical'});
      const cancelled=(await hr.payslipDetails(jan.slip.id,admin)).employeeMoneySummary;
      assert.equal(cancelled.status,'cancelled');assert.deepEqual(cancelled.debts,frozen.employeeMoneySummary.debts);
      const march=await newRun('2026-03','2026-03-31');
      const marchLoan=async()=> (await hr.payslipDetails(march.slip.id,admin)).employeeMoneySummary.debts.find(row=>String(row.money_id)===String(loan));
      assert.equal((await marchLoan()).balance_before,82000,'January cancellation restores its recovery; February still applies');
      await hr.payrollAction(feb.id,'cancel',admin,{posting_date:'2026-03-06',reason:'Restore February recovery'});
      assert.equal((await marchLoan()).balance_before,87000,'a dated payroll reversal restores the loan balance');
      await store.initStore();assert.deepEqual((await hr.payslipDetails(jan.slip.id,admin)).employeeMoneySummary,cancelled);
      await pool.query('UPDATE app_hr_slips SET employee_money_snapshot=NULL WHERE id=$1',[jan.slip.id]);
      assert.deepEqual((await hr.payslipDetails(jan.slip.id,admin)).employeeMoneySummary,{status:'unavailable'},'legacy payslips never substitute current balances');
    });
  }finally{await store.closeStore();}
});

test('salary deductions enforce the expense restriction through payroll posting and reversal',{
  skip:process.env.HR_TEST_POSTGRES!=='1',
},async()=>{
  const pool=store.getPostgresPool();
  try{
    assert.match((await pool.query('SELECT current_database() AS name')).rows[0].name,/_hr_test$/);
    await pool.query('DROP SCHEMA public CASCADE');await pool.query('CREATE SCHEMA public');await store.initStore();
    await pool.query("INSERT INTO app_master_employees(employee_id,employee_name,company,status) VALUES('DEDUCT-E1','Deduction employee','Deduction Company','Active')");
    const ids={};
    for(const [code,name,type,detail] of [
      ['5236','Salary - SACL','expense','Expense Account'],['6000','Deductions','expense','Expense Account'],
      ['2101','Deduction tax payable','liability','Tax'],['2102','Deduction salary payable','liability','Payable'],
      ['1501','Deduction employee loans','asset','Receivable'],['1401','Deduction bank','asset','Bank'],
    ])ids[code]=(await pool.query(`INSERT INTO app_accounts(account_code,account_name,account_type,account_detail_type,normal_balance)
      VALUES($1,$2,$3,$4,$5) RETURNING id`,[code,name,type,detail,['asset','expense'].includes(type)?'debit':'credit'])).rows[0].id;
    const components=[
      {label:'Salary',kind:'earning',amount:100000,account_id:ids['5236']},
      {label:'Salary reduction',kind:'deduction',amount:10000,account_id:ids['5236']},
      {label:'Tax',kind:'deduction',amount:5000,account_id:ids['2101']},
    ];
    const plan={effective_from:'2026-01-01',components};
    const payroll={company:'Deduction Company',period:'2026-01',posting_date:'2026-01-31',employee_ids:['DEDUCT-E1']};
    const error=/Deductions require a liability account or Salary - SACL/;
    await runWithAuditUser(admin,async()=>{
      await hr.saveSettings({action:'accounts',salary_payable_account_id:ids['2102']},admin);
      for(const invalidId of [ids['6000'],ids['1501']])await assert.rejects(()=>hr.savePayPlan('DEDUCT-E1',{
        ...plan,components:components.map((c,i)=>i===1?{...c,account_id:invalidId}:c),
      },admin),error);
      await hr.savePayPlan('DEDUCT-E1',plan,admin);
      const opts=await hr.options(admin);
      assert.ok(opts.accounts.find(a=>a.id===ids['5236']).payroll_component_kinds.includes('deduction'));
      assert.ok(!opts.accounts.find(a=>a.id===ids['6000']).payroll_component_kinds.includes('deduction'));
      const badComponents=components.map((c,i)=>i===1?{...c,account_id:ids['6000']}:c);
      // Saved plans and drafts must be rechecked even if changed outside the form.
      await pool.query('UPDATE app_hr_pay_plans SET components=$1 WHERE employee_id=$2',[JSON.stringify(badComponents),'DEDUCT-E1']);
      await assert.rejects(()=>hr.createPayroll(payroll,admin),error);
      await hr.savePayPlan('DEDUCT-E1',plan,admin);
      await pool.query('UPDATE app_accounts SET is_active=false WHERE id=$1',[ids['5236']]);
      await assert.rejects(()=>hr.createPayroll(payroll,admin),/active posting account/);
      await pool.query('UPDATE app_accounts SET is_active=true,is_group=true WHERE id=$1',[ids['5236']]);
      await assert.rejects(()=>hr.savePayPlan('DEDUCT-E1',plan,admin),/active posting account/);
      await pool.query("UPDATE app_accounts SET is_group=false,account_name='Renamed salary expense' WHERE id=$1",[ids['5236']]);
      await assert.rejects(()=>hr.createPayroll(payroll,{role:'finance',permission_denials:[`account.view:${ids['5236']}`]}),e=>e.status===403);
      const loan=await hr.createMoney({employee_id:'DEDUCT-E1',kind:'loan',posting_date:'2026-01-01',amount:100000,account_id:ids['1501'],reason:'Monthly loan'},admin);
      await hr.moneyAction(loan,'submit',admin);
      await hr.payMoney(loan,{amount:100000,posting_date:'2026-01-01',bank_account_id:ids['1401'],reference:'Loan disbursement'},admin);
      const runId=await hr.createPayroll(payroll,admin);
      const slip=(await hr.payrollDetails(runId,admin)).slips[0];
      const inputs={paid_days:31,input_note:'Salary reduction, tax and monthly loan recovery reviewed',components,recoveries:[{money_id:loan,amount:10000}]};
      await assert.rejects(()=>hr.updateSlip(runId,slip.id,{...inputs,components:badComponents},admin),error);
      await hr.updateSlip(runId,slip.id,inputs,admin);
      const reviewed=(await hr.payrollDetails(runId,admin)).slips[0];
      assert.equal(Number(reviewed.net_pay),75000);
      assert.equal((await hr.moneyList(admin))[0].balance,100000,'draft recovery does not reduce the loan');
      await pool.query('UPDATE app_hr_slips SET components=$1 WHERE id=$2',[JSON.stringify(badComponents),slip.id]);
      await assert.rejects(()=>hr.payrollAction(runId,'submit',admin),error);
      assert.equal((await pool.query("SELECT count(*)::int n FROM app_gl_entries WHERE voucher_type='hr_payroll' AND voucher_id=$1",[runId])).rows[0].n,0);
      await pool.query('UPDATE app_hr_slips SET components=$1 WHERE id=$2',[JSON.stringify(reviewed.components),slip.id]);
      await pool.query('UPDATE app_accounts SET is_active=false WHERE id=$1',[ids['5236']]);
      await assert.rejects(()=>hr.payrollAction(runId,'submit',admin),/active posting account/);
      await pool.query('UPDATE app_accounts SET is_active=true WHERE id=$1',[ids['5236']]);
      await hr.payrollAction(runId,'submit',admin);
      const lines=(await pool.query("SELECT account_id,sum(debit)::float debit,sum(credit)::float credit FROM app_gl_entries WHERE voucher_type='hr_payroll' AND voucher_id=$1 GROUP BY account_id",[runId])).rows;
      const salary=lines.find(l=>l.account_id===ids['5236']);assert.deepEqual([salary.debit,salary.credit],[100000,10000]);
      assert.equal(lines.find(l=>l.account_id===ids['2102']).credit,75000);
      assert.equal(lines.find(l=>l.account_id===ids['1501']).credit,10000);
      assert.equal(lines.reduce((n,l)=>n+l.debit-l.credit,0),0);
      assert.equal((await hr.moneyList(admin))[0].balance,90000);
      await hr.payrollAction(runId,'cancel',admin,{posting_date:'2026-02-01',reason:'Verify salary deduction reversal'});
      assert.equal((await hr.moneyList(admin))[0].balance,100000);
      const net=(await pool.query("SELECT sum(debit-credit)::float net FROM app_gl_entries WHERE voucher_type IN('hr_payroll','hr_payroll_cancellation') AND account_id=$1",[ids['5236']])).rows[0].net;
      assert.equal(net,0);
    });
  }finally{await store.closeStore();}
});

test('HR integrates leave, advances, payroll accrual, partial payments and reversible allocations',{
  skip:process.env.HR_TEST_POSTGRES!=='1',
},async()=>{
  const pool=store.getPostgresPool();
  try{
    const db=(await pool.query('SELECT current_database() AS name')).rows[0].name;
    assert.match(db,/_hr_test$/,'HR tests require a dedicated *_hr_test database');
    await pool.query('DROP SCHEMA public CASCADE');await pool.query('CREATE SCHEMA public');await store.initStore();
    await pool.query(`INSERT INTO app_master_employees(employee_id,employee_name,company,status) VALUES ('HR-E1','HR One','HR Company','Active'),('HR-E2','HR Two','HR Company','Active')`);
    await pool.query(`INSERT INTO app_master_cost_centers(cost_center,cost_center_name) VALUES('HR Shop','HR Shop')`);
    const ids={};
    for(const [code,type,detail] of [['salary','expense','Expense Account'],['tax','liability','Tax'],['employer','expense','Expense Account'],['payable','liability','Payable'],['advance','asset','Receivable'],['bank','asset','Bank'],['recovery','income','Income Account']]){
      ids[code]=(await pool.query('INSERT INTO app_accounts(account_code,account_name,account_type,account_detail_type,normal_balance) VALUES($1,$1,$2,$3,$4) RETURNING id',[`HR-${code}`,type,detail,type==='expense'||type==='asset'?'debit':'credit'])).rows[0].id;
    }
    await runWithAuditUser(admin,async()=>{
      await hr.saveProfile('HR-E1',{joining_date:'2026-01-01',cost_center:'HR Shop'},admin);
      const profile={joining_date:'2026-01-01',cost_center:'HR Shop'};
      for(const status of ['Left','','Active']) {
        await hr.saveProfile('HR-E1',{...profile,status},admin);
        assert.equal((await hr.employeeProfile('HR-E1',admin)).employee.status,status||null);
        assert.equal((await hr.employeeProfile('HR-E1',admin)).employee.disabled,status==='Left');
      }
      await assert.rejects(()=>hr.saveProfile('HR-E1',{...profile,status:'Inactive'},admin),/Choose Active, Left/);
      await assert.rejects(()=>hr.saveProfile('HR-E1',{...profile,status:'Left'},{role:'finance',permissions:['hr.employees.edit']}),e=>e.status===403);
      assert.equal((await hr.employeeProfile('HR-E1',admin)).employee.status,'Active');
      const detailValues={date_of_birth:'1990-04-12',gender:'Female',department:'Operations',designation:'Supervisor',phone:'+256700000001',email:'employee@example.com',nin:'CM12345',address:'Kampala\nUganda',next_of_kin:'Kin Name',next_of_kin_phone:'+256700000002',next_of_kin_relation:'Sister',marital_status:'Married',education:'Education history\n'+ 'A'.repeat(2500),work_experience:'Work history\n'+ 'B'.repeat(2500),references:'Reference One, Entity One, Manager, +256700000003\nReference Two, Entity Two, Supervisor, +256700000006',father:'Father Name',father_phone:'+256700000004',mother:'Mother Name',mother_phone:'+256700000005',nationality:'Ugandan'};
      await hr.saveProfile('HR-E1',{...profile,...detailValues},admin);
      let employeeDetails=(await hr.employeeProfile('HR-E1',admin)).employee;
      for(const [name,value] of Object.entries(detailValues)) assert.equal(employeeDetails[name],value,`${name} persists`);
      assert.deepEqual((await pool.query('SELECT department,designation,phone,email FROM app_master_employees WHERE employee_id=$1',['HR-E1'])).rows[0],{department:detailValues.department,designation:detailValues.designation,phone:detailValues.phone,email:detailValues.email});
      await hr.saveProfile('HR-E1',profile,admin);
      assert.equal((await hr.employeeProfile('HR-E1',admin)).employee.education,detailValues.education,'omitted details are preserved');
      for(const invalid of [{gender:'Unknown'},{marital_status:'Unknown'},{date_of_birth:'1990-02-30'},{email:'invalid'},{education:'x'.repeat(10001)}]) await assert.rejects(()=>hr.saveProfile('HR-E1',{...profile,...invalid},admin),e=>e.status===400);
      const hrEditor={role:'finance',permissions:['hr.employees.edit']};
      await hr.saveProfile('HR-E1',{...profile,nin:'UPDATED-NIN'},hrEditor);
      await assert.rejects(()=>hr.saveProfile('HR-E1',{...profile,department:'Blocked',nin:'SHOULD-NOT-SAVE'},hrEditor),e=>e.status===403);
      employeeDetails=(await hr.employeeProfile('HR-E1',admin)).employee;
      assert.equal(employeeDetails.nin,'UPDATED-NIN');
      assert.equal(employeeDetails.department,'Operations');
      await hr.saveProfile('HR-E1',{...profile,next_of_kin_phone:''},admin);
      assert.equal((await hr.employeeProfile('HR-E1',admin)).employee.next_of_kin_phone,'');
      await hr.saveSettings({action:'accounts',salary_payable_account_id:ids.payable},admin);
      await hr.saveSettings({action:'leave_type',name:'Annual',is_paid:'1'},admin);
      const type=(await pool.query('SELECT id FROM app_hr_leave_types')).rows[0].id;
      await hr.saveSettings({action:'leave_type',name:'Temporary',is_paid:'1'},admin);
      const temporary=(await pool.query("SELECT id FROM app_hr_leave_types WHERE name='Temporary'")).rows[0].id;
      await hr.saveSettings({action:'leave_type_edit',leave_type_id:temporary,name:'Renamed',is_paid:'0'},admin);
      assert.deepEqual((await pool.query('SELECT name,is_paid FROM app_hr_leave_types WHERE id=$1',[temporary])).rows[0],{name:'Renamed',is_paid:false});
      await assert.rejects(()=>hr.saveSettings({action:'leave_type_edit',leave_type_id:temporary,name:'Annual',is_paid:'0'},admin),e=>e.code==='23505');
      await hr.saveSettings({action:'leave_type_delete',leave_type_id:temporary},admin);
      assert.equal((await pool.query('SELECT id FROM app_hr_leave_types WHERE id=$1',[temporary])).rows.length,0);
      await hr.allocateLeave({employee_id:'HR-E1',leave_type_id:type,year:2026,days:2},admin);
      await hr.saveSettings({action:'leave_type_edit',leave_type_id:type,name:'Annual renamed',is_paid:'1'},admin);
      await assert.rejects(()=>hr.saveSettings({action:'leave_type_delete',leave_type_id:type},admin),/cannot be removed/);
      await assert.rejects(()=>hr.saveSettings({action:'leave_type_edit',leave_type_id:type,name:'Annual renamed',is_paid:'0'},admin),/Paid status cannot change/);

      await hr.createLeave({employee_id:'HR-E1',leave_type_id:type,from_date:'2026-01-02',to_date:'2026-01-03',reason:'Annual leave'},admin);
      const leave=(await hr.leaveList(admin)).requests[0];await hr.leaveAction(leave.id,'submit',admin);
      assert.equal(Number((await hr.leaveList(admin)).balances[0].used_days),2);
      await hr.createLeave({employee_id:'HR-E1',leave_type_id:type,from_date:'2026-01-03',to_date:'2026-01-03',reason:'Overlap'},admin);
      await assert.rejects(()=>hr.leaveAction((Number(leave.id)+1),'submit',admin),/overlaps/);
      await hr.leaveAction(leave.id,'cancel',admin);assert.equal(Number((await hr.leaveList(admin)).balances[0].used_days),0);
      await hr.attendanceBatch({employee_ids:['HR-E1','HR-E2'],attendance_date:'2026-01-05',status:'present'},admin);
      const attendance=(await hr.attendanceList(admin)).find(a=>a.employee_id==='HR-E1');await hr.attendanceAction(attendance.id,'submit',admin);
      await assert.rejects(()=>hr.attendanceBatch({employee_ids:['HR-E1'],attendance_date:'2026-01-05',status:'absent'},admin),e=>e.code==='23505');
      await hr.savePayPlan('HR-E1',{effective_from:'2026-01-01',components:[
        {label:'Basic salary',kind:'earning',amount:100000,prorate:true,account_id:ids.salary},
        {label:'Commission',kind:'earning',amount:10000,account_id:ids.salary},
        {label:'Tax',kind:'deduction',amount:10000,account_id:ids.tax},
        {label:'Employer contribution',kind:'employer',amount:5000,account_id:ids.employer,payable_account_id:ids.tax},
      ]},admin);
      await assert.rejects(()=>hr.savePayPlan('HR-E1',{effective_from:'2026-01-01',components:[{label:'Replacement',kind:'earning',amount:100000,account_id:ids.salary}]},{role:'finance',permissions:[],permission_denials:[`account.view:${ids.tax}`]}),e=>e.status===403);
      const advance=await hr.createMoney({employee_id:'HR-E1',kind:'advance',posting_date:'2026-01-01',amount:50000,account_id:ids.advance,reason:'Approved salary advance'},admin);
      await hr.moneyAction(advance,'submit',admin);
      assert.equal((await hr.moneyList(admin))[0].balance,0);
      const payout1=await hr.payMoney(advance,{amount:20000,posting_date:'2026-01-02',bank_account_id:ids.bank,reference:'ADV1'},admin);
      const payout2=await hr.payMoney(advance,{amount:20000,posting_date:'2026-01-03',bank_account_id:ids.bank,reference:'ADV2'},admin);
      const returned=await hr.payMoney(advance,{amount:5000,posting_date:'2026-01-04',bank_account_id:ids.bank,reference:'RETURN'},admin,'return');
      assert.equal((await hr.moneyList(admin))[0].balance,35000);
      const runId=await hr.createPayroll({company:'HR Company',period:'2026-01',posting_date:'2026-01-31',employee_ids:['HR-E1']},admin);
      await assert.rejects(()=>hr.createPayroll({company:'HR Company',period:'2026-01',posting_date:'2026-01-31',employee_ids:['HR-E1']},admin),e=>e.code==='23505');
      let data=await hr.payrollDetails(runId,admin);const slip=data.slips[0];
      await hr.savePayPlan('HR-E1',{effective_from:'2026-01-01',components:[{label:'New salary',kind:'earning',amount:999000,account_id:ids.salary}]},admin);
      assert.equal(Number((await hr.payrollDetails(runId,admin)).slips[0].gross_pay),110000,'run retains the original plan snapshot');
      await hr.updateSlip(runId,slip.id,{paid_days:31,input_note:'Full month and approved advance recovery',components:slip.components,recoveries:[{money_id:advance,amount:20000}]},admin);
      await hr.payrollAction(runId,'submit',admin);
      data=await hr.payrollDetails(runId,admin);assert.deepEqual([Number(data.slips[0].gross_pay),Number(data.slips[0].net_pay),Number(data.slips[0].employer_cost)],[110000,80000,5000]);
      assert.equal((await hr.moneyList(admin))[0].balance,15000);
      const hidden=await store.generalLedgerReport({}, {exportAll:true,...hrLedgerAccessOptions({role:'finance',permissions:[]})});
      assert.equal(hidden.rows.filter(r=>r.voucher_type.startsWith('hr_')).length,0);
      const visible=await store.generalLedgerReport({}, {exportAll:true,...hrLedgerAccessOptions(admin)});
      assert(visible.rows.some(r=>r.voucher_type==='hr_payroll'));
      assert.equal((await hr.payslipList({...restrictedUserFor('HR-E1')})).length,1);
      await assert.rejects(()=>hr.payrollAction(runId,'submit',admin),/Only draft/);
      await assert.rejects(()=>hr.attendanceAction(attendance.id,'cancel',admin),/posted payroll/);
      await assert.rejects(()=>hr.cancelPayment('money',advance,payout1,{posting_date:'2026-01-31'},admin),/recovered/);
      await assert.rejects(()=>hr.moneyAction(advance,'cancel',admin,{posting_date:'2026-01-31'}),/linked/);
      const restricted={role:'finance',record_access:{employee_id:'HR-E2'},permissions:[]};
      await assert.rejects(()=>hr.payrollDetails(runId,restricted),e=>e.status===403);
      assert.equal((await hr.payrollList(restricted)).length,0);
      const payment=await hr.payPayroll(runId,{slip_id:slip.id,amount:40000,posting_date:'2026-02-01',bank_account_id:ids.bank,reference:'SAL1'},admin);
      assert.equal(Number((await hr.payrollDetails(runId,admin)).slips[0].paid_amount),40000);
      await assert.rejects(()=>hr.payPayroll(runId,{slip_id:slip.id,amount:40001,posting_date:'2026-02-01',bank_account_id:ids.bank,reference:'TOO MUCH'},admin),/exceeds/);
      await assert.rejects(()=>hr.payrollAction(runId,'cancel',admin,{posting_date:'2026-02-01',reason:'Reverse'}),/payments first/);
      const racing=await Promise.allSettled([1,2].map(i=>hr.payPayroll(runId,{slip_id:slip.id,amount:30000,posting_date:'2026-02-01',bank_account_id:ids.bank,reference:`RACE-${i}`},admin)));
      assert.equal(racing.filter(r=>r.status==='fulfilled').length,1,'concurrent payment cannot overspend outstanding salary');
      await hr.cancelPayment('payroll',runId,racing.find(r=>r.status==='fulfilled').value,{posting_date:'2026-02-01'},admin);
      await hr.cancelPayment('payroll',runId,payment,{posting_date:'2026-02-01'},admin);
      await hr.payrollAction(runId,'cancel',admin,{posting_date:'2026-02-01',reason:'Corrected payroll'});
      assert.equal((await hr.moneyList(admin))[0].balance,35000);
      await hr.cancelPayment('money',advance,returned,{posting_date:'2026-02-01'},admin);
      await hr.cancelPayment('money',advance,payout1,{posting_date:'2026-02-01'},admin);
      await hr.cancelPayment('money',advance,payout2,{posting_date:'2026-02-01'},admin);
      await hr.moneyAction(advance,'cancel',admin,{posting_date:'2026-02-01'});
      const totals=(await pool.query("SELECT sum(debit)::float AS debit,sum(credit)::float AS credit FROM app_gl_entries WHERE voucher_type LIKE 'hr_%'")).rows[0];assert.equal(totals.debit,totals.credit);
      assert.equal(Number((await pool.query("SELECT sum(debit-credit) AS net FROM app_gl_entries WHERE account_id=$1",[ids.advance])).rows[0].net),0);
      const payrollNet=(await pool.query("SELECT sum(debit-credit)::float AS net FROM app_gl_entries WHERE voucher_type IN('hr_payroll','hr_payroll_cancellation') AND account_id=$1",[ids.salary])).rows[0];assert.equal(payrollNet.net,0);
      assert.equal((await pool.query('SELECT created_by FROM app_hr_runs WHERE id=$1',[runId])).rows[0].created_by,admin.username);
    });
    await runWithAuditUser(author,async()=>{
      const id=await hr.createMoney({employee_id:'HR-E2',kind:'recovery',posting_date:'2026-03-01',amount:100,account_id:ids.advance,offset_account_id:ids.recovery,reason:'Test approval separation'},author);
      await assert.rejects(()=>hr.moneyAction(id,'submit',author),e=>e.status===403);
      await hr.moneyAction(id,'submit',admin);
    });
    // Exercise actual route rendering and permission decisions without production sessions.
    await hr.createEmployee({employee_id:'HR/NEW',employee_name:'New Employee',company:'HR Company',status:'Active',joining_date:'2026-01-01',gender:'Female',education:'New education'},admin);
    assert.equal((await hr.employeeProfile('HR/NEW',admin)).employee.education,'New education');
    await store.setMasterRecordActive('employees','HR/NEW',false);
    assert.equal((await hr.employeeProfile('HR/NEW',admin)).employee.status,'Left');
    await store.setMasterRecordActive('employees','HR/NEW',true);
    assert.equal((await hr.employeeProfile('HR/NEW',admin)).employee.status,'Active');
    await hr.saveProfile('HR/NEW',{employee_name:'Updated employee',company:'Updated company',status:'Left'},admin);
    assert.equal((await hr.employeeProfile('HR/NEW',admin)).employee.disabled,true);
    await assert.rejects(()=>hr.createEmployee({employee_id:'FAILED',employee_name:'Invalid employee',date_of_birth:'invalid'},admin),e=>e.status===400);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM app_master_employees WHERE employee_id='FAILED'")).rows[0].n,0);
    const creator={role:'finance',permissions:['masters.employees.create']};
    await hr.createEmployee({employee_name:'Core only',department:'Core department'},creator);
    await assert.rejects(()=>hr.createEmployee({employee_name:'Forbidden HR',nin:'NO'},creator),e=>e.status===403);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM app_master_employees WHERE employee_id='Forbidden HR'")).rows[0].n,0);
    const express=require('express');const app=express();
    app.set('view engine','ejs');app.set('views',require('node:path').join(__dirname,'../views'));
    app.locals.assetVersion='test';
    app.locals.dateTimeSettings={date_format:'YYYY-MM-DD',time_format:'24h'};
    app.use(express.urlencoded({extended:true}));
    app.use((req,res,next)=>{
      const user=req.get('x-test-user')==='payroll-reader'?restrictedUserFor('HR-E1'):req.get('x-test-user')==='scoped'?restrictedUserFor('HR-E2'):req.get('x-test-user')==='ordinary'?{role:'standard',permissions:['masters.employees.view']}:req.get('x-test-user')==='profile-reader'?{role:'finance',permissions:['hr.employees.view']}:req.get('x-test-user')==='profile-scoped'?{role:'finance',permissions:['hr.employees.view'],record_access:{employee_id:'HR-E2'}}:admin;
      user.username=user.username||'Test user';req.currentUser=user;res.locals.currentUser=user;res.locals.can=p=>require('../src/authorize').can(user,p);
      res.locals.availableReports=[];res.locals.formatDate=require('../src/date-time-format').formatDate;
      res.locals.formatTimestamp=v=>String(v||'');
      if(!require('../src/authorize').permissionCheck(req))return res.status(403).send('Denied');
      runWithAuditUser(user,next);
    });
    app.use(require('../src/web/routes/settings'));
    app.use('/hr',require('../src/web/routes/hr'));
    app.use((err,req,res,next)=>res.status(err.status||500).send(err.message));
    const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    try{
      const base=`http://127.0.0.1:${server.address().port}`;
      const settingsResponse=await fetch(base+'/hr/settings');
      const settingsHtml=await settingsResponse.text();
      assert.equal(settingsResponse.status,200);
      assert.match(settingsHtml,/value="leave_type_edit"/);
      assert.match(settingsHtml,/value="leave_type_delete"/);
      const usedType=(await pool.query('SELECT id FROM app_hr_leave_types LIMIT 1')).rows[0].id;
      const removal=await fetch(base+'/hr/settings',{method:'POST',body:new URLSearchParams({action:'leave_type_delete',leave_type_id:String(usedType)})});
      assert.equal(removal.status,400);
      assert.match(await removal.text(),/cannot be removed/);
      const runId=await runWithAuditUser(admin,()=>hr.createPayroll({company:'HR Company',period:'2026-02',posting_date:'2026-02-28',employee_ids:['HR-E1']},admin));
      const slip=(await hr.payrollDetails(runId,admin)).slips[0];
      for(const url of ['/hr/employees','/hr/employees/HR-E1','/hr/settings','/hr/attendance','/hr/leave','/hr/money','/hr/payroll',`/hr/payroll/${runId}`,`/hr/payroll/${runId}/payslips/${slip.id}`,'/hr/payslips',`/hr/payslips/${slip.id}`]) {
        const response=await fetch(base+url);const html=await response.text();assert.equal(response.status,200,`${url}: ${html.slice(0,400)}`);assert.match(html,url==='/hr/employees'?/Employees/:/Human Resources/);
      }
      const denied=await fetch(base+'/hr/payroll',{headers:{'x-test-user':'ordinary'}});assert.equal(denied.status,403);
      for(const url of [`/hr/payslips/${slip.id}`,`/hr/payroll/${runId}/payslips/${slip.id}`]){
        assert.match(await (await fetch(base+url)).text(),/Employee Money summary/);
        assert.ok(!(await (await fetch(base+url,{headers:{'x-test-user':'payroll-reader'}})).text()).includes('Employee Money summary'));
      }
      const employeeHtml=await (await fetch(base+'/hr/employees/HR-E1')).text();
      const listRedirect=await fetch(base+'/hr/employees?q=HR-E1&page=1',{redirect:'manual'});
      assert.equal(listRedirect.headers.get('location'),'/settings/employees?q=HR-E1&page=1');
      const list=await fetch(base+'/settings/employees',{headers:{'x-test-user':'profile-reader'}});
      const listHtml=await list.text();
      assert.equal(list.status,200,listHtml);
      assert.match(listHtml,/href="\/hr\/employees\/HR-E1"/);
      const scopedList=await (await fetch(base+'/settings/employees',{headers:{'x-test-user':'profile-scoped'}})).text();
      assert.ok(scopedList.includes('HR-E2'));
      assert.ok(!scopedList.includes('HR-E1'));
      const editRedirect=await fetch(base+'/settings/employees/HR-E1/edit',{redirect:'manual'});
      assert.equal(editRedirect.headers.get('location'),'/hr/employees/HR-E1');
      const newForm=await (await fetch(base+'/settings/employees/new')).text();
      assert.match(newForm,/name="education"/);
      assert.match(newForm,/Create employee/);
      assert.ok(!newForm.includes('Download employee details PDF'));
      const toggle=await fetch(base+'/settings/employees/HR%2FNEW/active',{method:'POST',body:new URLSearchParams({active:'1'}),redirect:'manual'});
      assert.equal(toggle.status,303);
      assert.equal((await hr.employeeProfile('HR/NEW',admin)).employee.status,'Active');
      assert.equal((await fetch(base+'/settings/employees/HR%2FNEW/active',{method:'POST',headers:{'x-test-user':'profile-reader'},body:new URLSearchParams({active:'0'}),redirect:'manual'})).status,403);
      assert.match(employeeHtml,/Download employee details PDF/);
      const pdf=await fetch(base+'/hr/employees/HR-E1/pdf');
      assert.equal(pdf.status,200);
      assert.equal(pdf.headers.get('content-type'),'application/pdf');
      assert.match(pdf.headers.get('content-disposition'),/attachment;.*employee-details\.pdf/);
      assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,5).toString(),'%PDF-');
      assert.equal((await fetch(base+'/hr/employees/HR-E1/pdf',{headers:{'x-test-user':'ordinary'}})).status,403);
      assert.equal((await fetch(base+'/hr/employees/HR-E1/pdf',{headers:{'x-test-user':'profile-scoped'}})).status,403);
      assert.equal((await fetch(base+'/hr/employees/HR-E1/pdf',{headers:{'x-test-user':'profile-reader'}})).status,200);
      assert.equal((await fetch(base+'/hr/employees/MISSING/pdf')).status,404);
      for(const field of require('../src/hr-employee-fields').employeeDetailFields) assert.ok(employeeHtml.includes(`name="${field.name}"`),`${field.label} appears in the form`);
      assert.match(employeeHtml,/<textarea name="education" rows="6" maxlength="10000"/);
      const invalidProfile=await fetch(base+'/hr/employees/HR-E1/profile',{method:'POST',body:new URLSearchParams({date_of_birth:'invalid',nationality:'Retained value'})});
      assert.equal(invalidProfile.status,400);
      const invalidHtml=await invalidProfile.text();
      assert.match(invalidHtml,/Date of Birth must be a valid date/);
      assert.match(invalidHtml,/value="Retained value"/);
      const scoped=await fetch(base+`/hr/payslips/${slip.id}`,{headers:{'x-test-user':'scoped'}});assert.equal(scoped.status,403);
      const form=new URLSearchParams({'paid_days':'28','input_note':'February pay reviewed','components[0][label]':'Basic salary','components[0][kind]':'earning','components[0][amount]':'999000','components[0][account_id]':String(ids.salary)});
      const review=await fetch(base+`/hr/payroll/${runId}/slips/${slip.id}`,{method:'POST',body:form,redirect:'manual'});assert.equal(review.status,303);
      const post=await fetch(base+`/hr/payroll/${runId}/submit`,{method:'POST',redirect:'manual'});assert.equal(post.status,303);
      const postedPage=await fetch(base+`/hr/payroll/${runId}`);assert.equal(postedPage.status,200);assert.match(await postedPage.text(),/Record salary payment/);
      const payment=await fetch(base+`/hr/payroll/${runId}/pay`,{method:'POST',body:new URLSearchParams({slip_id:String(slip.id),amount:'1',posting_date:'2026-03-01',bank_account_id:String(ids.bank),reference:'HTTP-SALARY'}),redirect:'manual'});assert.equal(payment.status,303);
      const csv=await fetch(base+`/hr/payroll/${runId}/export`);assert.equal(csv.status,200);assert.match(csv.headers.get('content-type'),/text\/csv/);assert.match(await csv.text(),/Outstanding UGX/);
      const scopedCsv=await fetch(base+`/hr/payroll/${runId}/export`,{headers:{'x-test-user':'scoped'}});assert.equal(scopedCsv.status,403);
    }finally{await new Promise(resolve=>server.close(resolve));}
  }finally{await store.closeStore();}
});


test('employee searches return only Active records while historical employee access remains available', {
  skip:process.env.HR_TEST_POSTGRES!=='1',
},async()=>{
  const pool=store.getPostgresPool();
  try {
    assert.match((await pool.query('SELECT current_database() AS name')).rows[0].name,/_hr_test$/);
    await pool.query('DROP SCHEMA public CASCADE');await pool.query('CREATE SCHEMA public');await store.initStore();
    await pool.query(`INSERT INTO app_master_employees(employee_id,employee_name,status,disabled) VALUES
      ('ACTIVE','Active employee','Active',false),('LEFT','Former employee','Left',false),
      ('BLANK','Unspecified employee',NULL,false),('DISABLED','Disabled employee','Active',true)`);
    assert.deepEqual((await store.masterEmployees({})).map(e=>e.employee_id),['ACTIVE']);
    assert.deepEqual(await store.masterEmployees({search:'Former'}),[]);
    assert.deepEqual(await store.masterEmployees({allowedIds:['LEFT','BLANK']}),[]);
    assert.deepEqual(await store.masterEmployees({deniedIds:['ACTIVE']}),[]);
    assert.equal((await store.masterEmployees({includeDisabled:true,employmentStatus:'Left'}))[0].employee_id,'LEFT');
    assert.ok((await hr.options(admin)).employees.some(e=>e.employee_id==='LEFT'),'historical authorization still sees former employees');
    assert.equal((await hr.employeeProfile('LEFT',admin)).employee.employee_name,'Former employee');
  } finally {await store.closeStore();}
});
