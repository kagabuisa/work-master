'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {calculatePay,monthPeriod,amount,permissionForHr,HR_AREAS,employeeAllowed}=require('../src/hr-policy');
const {leaveDays}=require('../src/hr');
const {permissionCheck}=require('../src/authorize');
const {BUILT_IN_ROLES,ROLE_RECORD_TYPES}=require('../src/auth');

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
    opts:{employees:[{employee_id:'E-1',employee_name:'Employee One',company:'Test Company',disabled:false}]},
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
