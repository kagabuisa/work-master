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
    const express=require('express');const app=express();
    app.set('view engine','ejs');app.set('views',require('node:path').join(__dirname,'../views'));
    app.locals.assetVersion='test';
    app.locals.dateTimeSettings={date_format:'YYYY-MM-DD',time_format:'24h'};
    app.use(express.urlencoded({extended:true}));
    app.use((req,res,next)=>{
      const user=req.get('x-test-user')==='scoped'?restrictedUserFor('HR-E2'):req.get('x-test-user')==='ordinary'?{role:'standard',permissions:['masters.employees.view']}:admin;
      req.currentUser=user;res.locals.currentUser=user;res.locals.can=p=>require('../src/authorize').can(user,p);
      res.locals.availableReports=[];res.locals.formatDate=require('../src/date-time-format').formatDate;
      res.locals.formatTimestamp=v=>String(v||'');
      if(!require('../src/authorize').permissionCheck(req))return res.status(403).send('Denied');
      runWithAuditUser(user,next);
    });
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
        const response=await fetch(base+url);const html=await response.text();assert.equal(response.status,200,`${url}: ${html.slice(0,400)}`);assert.match(html,/Human Resources/);
      }
      const denied=await fetch(base+'/hr/payroll',{headers:{'x-test-user':'ordinary'}});assert.equal(denied.status,403);
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
