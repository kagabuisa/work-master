'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {calculatePay,monthPeriod,amount,permissionForHr,HR_AREAS,employeeAllowed,payrollComponentAccountAllowed}=require('../src/hr-policy');
const {leaveDays}=require('../src/hr');
const {permissionCheck}=require('../src/authorize');
const {BUILT_IN_ROLES,ROLE_RECORD_TYPES}=require('../src/auth');
const {buildEmployeeStatementReport,employeeStatementCsv}=require('../src/hr-employee-statement');
const {sendEmployeeStatementPdf}=require('../src/web/employee-statement-pdf');

test('employee statements combine payroll and employee-money activity into one net ledger',()=>{
  const employee={employee_id:'E-1',employee_name:'Employee One',company:'Test Company',cost_center:'Shop'};
  const report=buildEmployeeStatementReport({
    employee,
    from:'2026-02-01',
    to:'2026-02-28',
    moneyRows:[
      {entry_id:1,date:'2026-01-02',voucher_type:'hr_payment',voucher_id:1,voucher_no:'HRP-1',
        money_id:1,money_kind:'loan',money_reason:'Staff loan',direction:'payout',debit:1000,credit:0},
      {entry_id:2,date:'2026-01-03',voucher_type:'hr_payment',voucher_id:2,voucher_no:'HRP-2',
        money_id:1,money_kind:'loan',money_reason:'Staff loan',direction:'return',payment_reference:'RETURN-1',debit:0,credit:200},
      {entry_id:3,date:'2026-02-03',voucher_type:'hr_money',voucher_id:3,voucher_no:'HRM-3',
        money_id:3,money_kind:'recovery',money_reason:'Stock shortage',debit:100,credit:0},
    ],
    salaryRows:[
      {entry_id:4,date:'2026-01-31',voucher_type:'hr_payroll',voucher_id:3,voucher_no:'PAY-3',
        run_id:3,period:'2026-01',slip_id:9,component_kind:'earning',component_label:'Basic salary',credit:1000,debit:0},
      {entry_id:5,date:'2026-01-31',voucher_type:'hr_payroll',voucher_id:3,voucher_no:'PAY-3',
        run_id:3,period:'2026-01',slip_id:9,component_kind:'deduction',component_label:'PAYE',credit:0,debit:100},
      {entry_id:6,date:'2026-02-05',voucher_type:'hr_payment',voucher_id:4,voucher_no:'HRP-4',
        run_id:3,period:'2026-01',slip_id:9,payment_reference:'SAL-4',debit:300,credit:0},
    ],
  });
  assert.deepEqual([report.openingBalance,report.totalDebit,report.totalCredit,report.closingBalance],[-100,400,0,300]);
  assert.equal(report.statement.length,2);
  assert.deepEqual(report.statement.map((entry)=>entry.type),['Recovery / charge','Salary payment']);
  assert.equal(report.statement[0].href,'/hr/money#money-3');
  assert.equal(report.statement[1].href,'/hr/payslips/9');
  const csv=employeeStatementCsv(report);
  assert.match(csv,/"Date","Source","Type","Reference","Description","Debit","Credit","Balance"/);
  assert.match(csv,/Closing balance/);
  assert.equal(permissionForHr('/hr/employees/E-1/statement','GET'),'hr.employees.view');
  assert.equal(permissionForHr('/hr/employees/statement','GET'),'hr.employees.view');
  assert.equal(permissionCheck({path:'/hr/employees/E-1/statement',method:'GET',
    currentUser:{role:'finance',permissions:['hr.employees.view']}}),true);
});

test('employee statements filter and group by transaction source',()=>{
  const report=buildEmployeeStatementReport({
    employee:{employee_id:'E-1',employee_name:'Employee One'},
    source:'receipts',
    order:'date',
    moneyRows:[
      {entry_id:1,date:'2026-01-02',voucher_type:'hr_payment',voucher_id:1,voucher_no:'HRP-1',
        money_id:1,money_kind:'loan',money_reason:'Staff loan',direction:'payout',debit:1000,credit:0},
      {entry_id:2,date:'2026-01-03',voucher_type:'hr_payment',voucher_id:2,voucher_no:'HRP-2',
        money_id:1,money_kind:'loan',money_reason:'Staff loan',direction:'return',payment_reference:'RETURN-1',debit:0,credit:200},
    ],
    salaryRows:[{entry_id:3,date:'2026-01-31',voucher_type:'hr_payroll',voucher_id:3,voucher_no:'PAY-3',
      run_id:3,period:'2026-01',slip_id:9,component_kind:'earning',component_label:'Basic salary',credit:1000}],
  });
  assert.deepEqual(report.sourceOptions.map(option=>option.key),['salary','advances','receipts']);
  assert.deepEqual(report.statement.map(entry=>entry.type),['Receipt']);
  assert.deepEqual(report.sourceGroups.map(group=>group.label),['Receipts & repayments']);
  assert.equal(report.closingBalance,-200);
  assert.equal(report.filters.source,'receipts');
  assert.equal(report.filters.order,'date');
});

test('employee statement screen renders one debtor-style ledger without unsafe raw content',async()=>{
  const employee={employee_id:'E/<1>',employee_name:'Employee <One>',company:'Test Company',cost_center:'Shop'};
  const report=buildEmployeeStatementReport({
    employee,
    moneyRows:[{entry_id:1,date:'2026-01-02',voucher_type:'hr_money',voucher_id:1,voucher_no:'HRM-1',
      money_id:1,money_kind:'recovery',money_reason:'<script>alert(1)</script>',debit:100,credit:0}],
    salaryRows:[{entry_id:2,date:'2026-01-31',voucher_type:'hr_payroll',voucher_id:2,voucher_no:'PAY-2',
      run_id:2,period:'2026-01',slip_id:8,component_kind:'earning',component_label:'Basic salary',credit:200,debit:0}],
  });
  const html=await require('ejs').renderFile(require('node:path').join(__dirname,'../views/hr-employee-statement.ejs'),{
    report,
    opts:{employees:[{employee_id:'E-1',employee_name:'Employee One',company:'Test Company',status:'Active'}]},
    scriptJson:require('../src/web/script-json').scriptJson,
    money:value=>Number(value||0).toLocaleString('en-UG'),
    formatDate:String,
    costCenterName:String,
  });
  assert.match(html,/Employee Statement/);
  assert.match(html,/Gross Salary Earned/);
  assert.match(html,/Payroll Summary/);
  assert.match(html,/Loan Summary/);
  assert.match(html,/Account Balances/);
  assert.ok(!html.includes('Statement Summary'));
  assert.match(html,/Salary/);
  assert.match(html,/Recovery \/ charge/);
  assert.match(html,/name="source"/);
  assert.match(html,/name="order"/);
  assert.match(html,/value="date" selected/);
  assert.match(html,/data-employee-statement-search/);
  assert.match(html,/name="employee" value="E\/&lt;1&gt;"/);
  assert.match(html,/employee-statement-options/);
  assert.ok(!html.includes('Source subtotal'));
  assert.match(html,/ui-statement-ledger-actions/);
  assert.ok(!html.includes('Salary accrued'));
  assert.equal((html.match(/statement-table/g)||[]).length,1);
  assert.ok(!html.includes('Opening balance'));
  assert.match(html,/Download PDF/);
  assert.match(html,/data-employee-statement-print/);
  assert.match(html,/Employee &lt;One&gt;/);
  assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  const sourceHtml=await require('ejs').renderFile(require('node:path').join(__dirname,'../views/hr-employee-statement.ejs'),{
    report:{...report,filters:{...report.filters,order:'source'}},
    opts:{employees:[]},
    scriptJson:require('../src/web/script-json').scriptJson,
    money:value=>Number(value||0).toLocaleString('en-UG'),
    formatDate:String,
    costCenterName:String,
  });
  assert.match(sourceHtml,/Source subtotal · Salary/);
  assert.match(sourceHtml,/Source net/);
});

test('employee statement PDFs handle empty, multi-page and long descriptions',async()=>{
  const response=()=>({headers:{},set(name,value){this.headers[name]=value;},attachment(value){this.filename=value;},
    type(value){this.contentType=value;},send(value){this.body=value;}});
  const employee={employee_id:'E-1',employee_name:'Employee / One'};
  const report=buildEmployeeStatementReport({
    employee,
    moneyRows:[{entry_id:1,date:'2026-01-02',voucher_type:'hr_money',voucher_id:1,voucher_no:'HRM-1',
      money_id:1,money_kind:'recovery',money_reason:'Charge',debit:100,credit:0}],
    salaryRows:[{entry_id:2,date:'2026-01-31',voucher_type:'hr_payroll',voucher_id:2,voucher_no:'PAY-2',
      run_id:2,period:'2026-01',slip_id:8,credit:200,debit:0}],
  });
  const longDescription='Detailed employee transaction description '.repeat(120);
  for(const variant of ['empty','normal','many','long']){
    const current=structuredClone(report);
    if(variant==='empty'){
      current.statement=[];
    } else if(variant==='many'){
      current.statement=Array.from({length:260},(_,index)=>({...report.statement[0],description:`Employee transaction ${index+1}`,balance:index+1}));
    } else if(variant==='long'){
      current.statement=[{...report.statement[0],description:longDescription}];
    }
    const res=response();
    await sendEmployeeStatementPdf(res,current,{name:'Test Company',address:'Kampala'},String);
    assert.equal(res.body.subarray(0,5).toString(),'%PDF-');
    assert.equal(res.filename,'Employee-One-statement.pdf');
    assert.equal(res.contentType,'application/pdf');
    assert.ok((res.body.toString('latin1').match(/\/Type \/Page\b/g)||[]).length>=1);
  }
});

test('payslip summaries require Employee Money Read and enforce saved and current scopes',async()=>{
  const {payslipMoneySummary,withoutMoneySnapshot}=require('../src/hr-money-summary');
  const rows=[
    {money_id:'1',employee_id:'E1',kind:'loan',reason:'Visible loan',account_id:11,cost_center:'Shop',balance_before:100000,recovered:10000,balance_remaining:90000},
    {money_id:'2',employee_id:'E1',kind:'advance',reason:'Hidden offset',account_id:11,offset_account_id:12,cost_center:'Shop',balance_before:20000,recovered:0,balance_remaining:20000},
    {money_id:'3',employee_id:'E1',kind:'loan',reason:'Hidden saved scope',account_id:12,cost_center:'Shop',balance_before:30000,recovered:0,balance_remaining:30000},
    {money_id:'4',employee_id:'E1',kind:'reimbursement',reason:'Transport',account_id:11,cost_center:'Shop',balance_before:5000,recovered:0,balance_remaining:5000},
    {money_id:'5',employee_id:'E1',kind:'loan',reason:'Hidden current scope',account_id:11,cost_center:'Shop',balance_before:7000,recovered:0,balance_remaining:7000},
    {money_id:'6',employee_id:'E2',kind:'loan',reason:'Other employee',account_id:11,cost_center:'Shop',balance_before:8000,recovered:0,balance_remaining:8000},
    {money_id:'7',employee_id:'E1',kind:'loan',reason:'Other cost center',account_id:11,cost_center:'Other',balance_before:9000,recovered:0,balance_remaining:9000},
  ];
  const current=rows.map(row=>({...row,id:row.money_id,account_id:row.money_id==='3'?11:row.money_id==='5'?12:row.account_id}));
  let queried=false;
  const client={query:async()=>{queried=true;return {rows:current};}};
  const user={role:'finance',permissions:['hr.payroll.view'],record_access:{employee_id:'E1',cost_center:'Shop'},permission_denials:['account.view:12']};
  const snapshot={version:1,as_of_date:'2026-01-31',rows};
  const slip={employee_id:'E1',employee_money_snapshot:snapshot};
  assert.equal(await payslipMoneySummary(client,slip,{docstatus:'submitted'},user,snapshot),null);
  assert.equal(queried,false);
  const reader={...user,permissions:[...user.permissions,'hr.money.view']};
  const summary=await payslipMoneySummary(client,slip,{docstatus:'submitted'},reader,snapshot);
  assert.deepEqual(summary.debts.map(row=>row.money_id),['1']);
  assert.deepEqual(summary.totals,{balance_before:100000,recovered:10000,balance_remaining:90000});
  assert.equal(summary.reimbursement_total,5000);
  assert.equal(withoutMoneySnapshot(slip).employee_money_snapshot,undefined);
  assert.deepEqual(await payslipMoneySummary(client,slip,{docstatus:'submitted'},reader,null),{status:'unavailable'});
});

test('payslips render printable summaries, provisional/cancelled states and historical omissions safely',async()=>{
  const base={run:{company:'Test Company',period:'2026-01',id:1,docstatus:'submitted'},
    slip:{employee_name:'Employee One',paid_days:31,calendar_days:31,components:[],gross_pay:100000,deductions:10000,net_pay:90000,employer_cost:0,paid_amount:0},
    costCenterName:()=>'',money:value=>Number(value).toLocaleString('en-UG'),formatDate:String};
  const summary={status:'frozen',as_of_date:'2026-01-31',debts:[
    {money_id:1,kind:'loan',reason:'Loan <script>alert(1)</script>',balance_before:100000,recovered:10000,balance_remaining:90000}],
    reimbursements:[{money_id:2,reason:'Transport',balance_remaining:5000}],
    totals:{balance_before:100000,recovered:10000,balance_remaining:90000},reimbursement_total:5000};
  const render=data=>require('ejs').renderFile(require('node:path').join(__dirname,'../views/hr-payslip.ejs'),{...base,...data});
  const html=await render({employeeMoneySummary:summary});
  assert.match(html,/Employee Money summary/);assert.match(html,/Reimbursements owed to employee/);
  assert.match(html,/Balances frozen when payroll was posted/);assert.match(html,/90,000/);
  assert.match(html,/Loan &lt;script&gt;/);assert.ok(!html.includes('<script>alert'));
  const section=html.match(/<section aria-label="Employee money summary">[\s\S]*?<\/section>/)[0];
  assert.match(section,/ui-table-scroll/);assert.ok(!section.includes('hr-no-print'));
  assert.match(await render({employeeMoneySummary:{...summary,status:'provisional'}}),/PROVISIONAL/);
  assert.match(await render({employeeMoneySummary:{...summary,status:'cancelled'}}),/CANCELLED — original balances/);
  assert.match(await render({employeeMoneySummary:{status:'unavailable'}}),/Historical employee money balances were not saved/);
  assert.ok(!(await render({employeeMoneySummary:null})).includes('Employee Money summary'));
  assert.match(await render({employeeMoneySummary:{...summary,debts:[],reimbursements:[]}}),/No employee debts available/);
});

test('only salary expense code 5236 and liabilities accept ordinary payroll deductions',()=>{
  for(const [account,allowed] of [
    [{account_type:'expense',account_code:'5236',account_name:'Renamed salary'},true],
    [{account_type:'expense',account_code:'6000',account_name:'Deductions'},false],
    [{account_type:'expense',account_code:'5237',account_name:'Salary - SACL'},false],
    [{account_type:'liability',account_code:'2101'},true],
    [{account_type:'asset',account_code:'5236'},false],
    [{account_type:'income',account_code:'5236'},false],
    [{account_type:'equity',account_code:'5236'},false],
  ])assert.equal(payrollComponentAccountAllowed(account,'deduction'),allowed);
  assert.equal(payrollComponentAccountAllowed({account_type:'expense',account_code:'6000'},'earning'),true);
  assert.equal(payrollComponentAccountAllowed({account_type:'expense',account_code:'6000'},'employer'),true);
  assert.equal(payrollComponentAccountAllowed({account_type:'liability'},'earning'),false);
});

test('component form limits deduction choices and keeps other expenses available for earnings',async()=>{
  const accounts=[
    {id:1,account_type:'expense',account_code:'5236',account_name:'Salary - SACL'},
    {id:2,account_type:'expense',account_code:'6000',account_name:'Deductions'},
    {id:3,account_type:'liability',account_code:'2101',account_name:'Tax payable'},
  ].map(a=>({...a,payroll_component_kinds:['earning','deduction','employer'].filter(kind=>payrollComponentAccountAllowed(a,kind))}));
  for(const kind of ['deduction','earning','employer']){
    const html=await require('ejs').renderFile(require('node:path').join(__dirname,'../views/hr-components.ejs'),{
      items:[{label:'Test',kind,amount:100,account_id:1,payable_account_id:3}],opts:{accounts},
    });
    const posting=html.match(/<select aria-label="Posting account"[\s\S]*?<\/select>/)[0];
    for(const a of accounts){
      const option=posting.match(new RegExp(`<option value="${a.id}"[^>]*>`))[0];
      assert.equal(option.includes('hidden disabled'),!payrollComponentAccountAllowed(a,kind));
    }
    assert.ok(!html.includes('Earnings use expense accounts.'));
    assert.ok(!html.includes('<option value="employer"'));
    const payable=html.match(/<select aria-label="Employer payable account"[\s\S]*?<\/select>/)[0];
    assert.match(payable,/<option value=""><\/option>/);
    assert.ok(!payable.includes('For employer contributions'));
    assert.equal(/value="3" selected/.test(payable),kind==='employer');
    assert.ok(!payable.includes('value="1"'));
    if(kind==='employer')assert.match(html,/type="hidden" name="components\[0\]\[kind\]" value="employer"/);
  }
});

test('changing a component type updates account choices and clears an incompatible selection',()=>{
  const handlers={};
  const kind={value:'earning'};
  const account={value:'other',options:[
    {value:'',dataset:{}},
    {value:'salary',dataset:{componentKinds:'earning deduction employer'}},
    {value:'other',dataset:{componentKinds:'earning employer'}},
    {value:'tax',dataset:{componentKinds:'deduction'}},
  ],get selectedOptions(){return this.options.filter(o=>o.value===this.value);}};
  const row={querySelector:selector=>selector.includes('[kind]')?kind:account};
  kind.matches=()=>true;kind.closest=()=>row;
  const document={querySelectorAll:selector=>selector==='[data-hr-components] tbody tr'?[row]:[],
    addEventListener:(name,fn)=>{handlers[name]=fn;}};
  require('node:vm').runInNewContext(require('node:fs').readFileSync(require('node:path').join(__dirname,'../public/hr.js'),'utf8'),{document});
  assert.equal(account.value,'other');
  assert.equal(account.options[3].disabled,true);
  kind.value='deduction';handlers.change({target:kind});
  assert.equal(account.value,'');
  assert.equal(account.options[1].disabled,false);
  assert.equal(account.options[2].disabled,true);
  assert.equal(account.options[3].disabled,false);
  account.value='salary';kind.value='employer';handlers.change({target:kind});
  assert.equal(account.value,'salary');
  assert.equal(account.options[2].disabled,false);
  assert.equal(account.options[3].disabled,true);
});

test('adding components still creates earnings after only a saved employer row remains',()=>{
  let add,appended;
  const makeRow=()=>{
    const kind={name:'components[0][kind]',tagName:'SELECT',value:'earning'};
    const account={name:'components[0][account_id]',tagName:'SELECT',value:'',options:[{value:'',dataset:{}}],get selectedOptions(){return this.options;}};
    const payable={name:'components[0][payable_account_id]',tagName:'SELECT',value:''};
    const label={name:'components[0][label]',value:'Saved salary',focus:()=>{}};
    return {kind,account,payable,label,cloneNode:makeRow,
      querySelectorAll:()=>[kind,account,payable,label],
      querySelector:selector=>selector.includes('[kind]')?kind:selector.includes('[account_id]')?account:label};
  };
  const original=makeRow();
  let originalPresent=true;
  const body={children:[{},{}],dataset:{},querySelector:()=>{
    assert.equal(originalPresent,true,'new rows must not depend on the original earning row remaining');
    return {closest:()=>original};
  },appendChild:row=>{appended=row;}};
  const button={previousElementSibling:{querySelector:()=>body},addEventListener:(name,fn)=>{add=fn;}};
  const document={querySelectorAll:selector=>selector==='[data-hr-add]'?[button]:[],addEventListener:()=>{}};
  require('node:vm').runInNewContext(require('node:fs').readFileSync(require('node:path').join(__dirname,'../public/hr.js'),'utf8'),{document});
  originalPresent=false;body.children=[{}];
  add();
  assert.equal(appended.kind.value,'earning');
  assert.equal(appended.label.value,'');
  assert.equal(appended.payable.value,'');
  assert.equal(appended.kind.name,'components[1][kind]');
});

test('payroll rounds components to cents, separates employer costs, and handles unpaid days',()=>{
  const pay=calculatePay([{label:'Basic',kind:'earning',amount:1000,prorate:true},{label:'Commission',kind:'earning',amount:100,prorate:false},
    {label:'Tax',kind:'deduction',amount:50},{label:'Employer',kind:'employer',amount:80}],15,30);
  assert.deepEqual([pay.gross_pay,pay.deductions,pay.net_pay,pay.employer_cost],[600,50,550,80]);
  assert.equal(calculatePay([{label:'Basic',kind:'earning',amount:10,prorate:true}],1,3).net_pay,3.33);
  assert.equal(calculatePay([{label:'Basic',kind:'earning',amount:1000,prorate:true}],0,30).net_pay,0);
  assert.throws(()=>calculatePay([{label:'Basic',kind:'earning',amount:100},{label:'Tax',kind:'deduction',amount:101}],1,1),/exceed/);
  for(const invalid of ['-1','1.001','1e3','NaN','',Infinity])assert.throws(()=>amount(invalid));
  assert.throws(()=>calculatePay([{label:'Basic',kind:'earning',amount:100}],32,31),/Paid days/);
});
test('calendar periods and leave count handle leap years, holidays, half days, and invalid ranges',()=>{
  assert.deepEqual(monthPeriod('2024-02'),{start:'2024-02-01',end:'2024-02-29',days:29});
  assert.throws(()=>monthPeriod('2026-13'));
  assert.equal(leaveDays('2026-01-01','2026-01-03',false,['2026-01-02']),2);
  assert.equal(leaveDays('2026-01-01','2026-01-01',true,[]),0.5);
  assert.equal(leaveDays('2026-01-02','2026-01-04',false,[],[1,2,3,4,5]),1);
  assert.throws(()=>leaveDays('2026-12-31','2027-01-01',false,[]),/same calendar year/);
  assert.throws(()=>leaveDays('2026-01-01','2026-01-02',true,[]),/Half-day/);
});
test('HR is opt-in, payments remain separate from creating payroll, and unknown endpoints fail closed',()=>{
  for(const role of BUILT_IN_ROLES.filter(r=>r.slug!=='admin'))assert.equal(role.permissions.some(p=>p.startsWith('hr.')),false,role.slug);
  const salary={role:'finance',permissions:['hr.payroll.view','hr.payroll.create']};
  assert.equal(permissionCheck({path:'/hr/payroll',method:'POST',currentUser:salary,body:{}}),true);
  assert.equal(permissionCheck({path:'/hr/payroll/1/pay',method:'POST',currentUser:salary,body:{}}),false);
  assert.equal(permissionForHr('/hr/payroll/1/slips/2','POST'),'hr.payroll.edit');
  assert.equal(permissionForHr('/hr/payroll/1/bogus','POST'),null);
  assert.equal(permissionCheck({path:'/hr/payroll/1/bogus',method:'POST',currentUser:{role:'admin'}}),false);
  assert.equal(permissionCheck({path:'/hr/payroll',method:'GET',currentUser:{role:'standard',permissions:['masters.employees.view']}}),false);
  assert.equal(ROLE_RECORD_TYPES.find(t=>t.key==='hr.payroll').permissions.create,'hr.payroll.create');
  assert.equal(ROLE_RECORD_TYPES.find(t=>t.key==='hr.payroll-payments').permissions.create,'hr.payroll.pay');
  for(const area of HR_AREAS)for(const action of area.actions)assert(ROLE_RECORD_TYPES.some(t=>Object.values(t.permissions).includes(`hr.${area.key}.${action}`)));
});
test('employee and cost-center denials remain effective for HR',()=>{
  const user={role:'finance',permissions:[],record_access:{employee_id:'E1'},permission_grants:[],permission_denials:[]};
  assert(employeeAllowed(user,'E1',null));assert(!employeeAllowed(user,'E2',null));
  assert(!employeeAllowed({...user,permission_denials:['employee.view:E1']},'E1',null));
  assert(!employeeAllowed({...user,record_access:{employee_id:'E1',cost_center:'Shop 1'}},'E1','Shop 2'));
});


test('payroll setup errors link to employee pay plans and retain draft inputs', async()=>{
  const ejs=require('ejs');
  const html=await ejs.renderFile(require('node:path').join(__dirname,'../views/hr-payroll.ejs'),{
    can:()=>true,today:'2026-10-09',money:String,runs:[],
    opts:{employees:[{employee_id:'E-1',employee_name:'Employee One',company:'Test Company',status:'Active',disabled:false}]},
    formData:{company:'Test Company',period:'2026-09',posting_date:'2026-09-30',employee_ids:['E-1']},
    payrollError:'Employee One needs a pay plan effective on or before 2026-09-01.',
    correctionHref:'/hr/employees/E-1#pay-plans',correctionLabel:'Open employee pay plans',
  });
  assert.match(html,/role="alert"/);
  assert.match(html,/href="\/hr\/employees\/E-1#pay-plans"/);
  assert.match(html,/<option selected>Test Company<\/option>/);
  assert.match(html,/name="period" value="2026-09"/);
  assert.match(html,/name="posting_date" value="2026-09-30"/);
  assert.match(html,/<option value="E-1" selected>/);
  assert.match(html,/Set up employee pay plans/);
});


test('shared employee directory permits HR Read and status switching requires master Write',()=>{
  const request=(path,method,permissions)=>({path,method,currentUser:{role:'finance',permissions},body:{active:'1'}});
  assert.equal(permissionCheck(request('/settings/employees','GET',['hr.employees.view'])),true);
  assert.equal(permissionCheck(request('/settings/employees/E1/active','POST',['masters.employees.edit'])),true);
  assert.equal(permissionCheck(request('/settings/employees/E1/active','POST',['masters.employees.submit','masters.employees.cancel'])),false);
  assert.equal(permissionCheck(request('/settings/employees/E1/active','POST',['hr.employees.edit'])),false);
});


test('employee inputs offer only explicitly active, enabled employees even for payroll', async()=>{
  const ejs=require('ejs');
  const employees=[
    {employee_id:'ACTIVE',employee_name:'Active employee',status:'Active',disabled:false},
    {employee_id:'LEFT',employee_name:'Former employee',status:'Left',disabled:false},
    {employee_id:'BLANK',employee_name:'Unspecified employee',status:null,disabled:false},
    {employee_id:'DISABLED',employee_name:'Disabled employee',status:'Active',disabled:true},
  ];
  const html=await ejs.renderFile(require('node:path').join(__dirname,'../views/hr-employee-select.ejs'),{
    label:'Employees',name:'employee_ids',multiple:true,activeOnly:false,opts:{employees},selectedIds:['ACTIVE','LEFT'],
  });
  assert.match(html,/<option value="ACTIVE" selected>/);
  for(const id of ['LEFT','BLANK','DISABLED']) assert.ok(!html.includes(`value="${id}"`),id);
  const defaults=await ejs.renderFile(require('node:path').join(__dirname,'../views/user-record-access-fields.ejs'),{
    prefix:'test',selected:{employee_id:'Former employee · LEFT'},
    choices:{warehouse:[],cost_center:[],retail_price_list:[],wholesale_price_list:[],employee_id:[
      {id:'ACTIVE',label:'Active employee · ACTIVE',selectable:true},{id:'LEFT',label:'Former employee · LEFT',selectable:false},
    ]},
  });
  assert.match(defaults,/<option value="Active employee · ACTIVE">/);
  assert.ok(!defaults.includes('<option value="Former employee · LEFT">'));
  assert.match(defaults,/value="Former employee · LEFT"/,'saved assignments remain visible');
});
