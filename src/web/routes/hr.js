'use strict';
const router=require('express').Router();
const hr=require('../../hr');
const {can}=require('../../authorize');
const {todayString}=require('../format');
const money=value=>`Ugx ${Number(value||0).toLocaleString('en-UG',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const {fail}=require('../../hr-policy');

router.use((_req,res,next)=>{res.set('Cache-Control','private, no-store');next();});
const handle=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(e){if(e.code==='23505'){e.status=409;e.message='A record already exists for this employee and date or payroll month. Cancel the previous record before creating a replacement.';}else if(e.code==='23503'){e.status=400;e.message='Choose an existing employee, leave type, cost center, and account.';}next(e);}};
const render=async(req,res,page,title,data={})=>{
  const opts=await hr.options(req.currentUser);
  res.render('hr',{page,title,money,today:todayString(),opts,...data});
};
const components=body=>Array.isArray(body.components)?body.components:Object.values(body.components||{});
const recoveries=body=>Array.isArray(body.recoveries)?body.recoveries:Object.values(body.recoveries||{});
const redirect=(res,path)=>res.redirect(303,`/hr/${path}`);

router.get('/',handle(async(req,res)=>{
  const area=['employees','attendance','leave','payroll','money','settings'].find(a=>can(req.currentUser,`hr.${a}.view`));
  if(!area) fail('HR access is required.',403);redirect(res,area);
}));
router.get('/employees',handle(async(req,res)=>render(req,res,'employees','Employees')));
router.get('/employees/:id',handle(async(req,res)=>{
  const data=await hr.employeeProfile(req.params.id,req.currentUser,can(req.currentUser,'hr.payroll.view'));
  return render(req,res,'employee',data.employee.employee_name,data);
}));
router.post('/employees/:id/profile',handle(async(req,res)=>{await hr.saveProfile(req.params.id,req.body,req.currentUser);redirect(res,`employees/${encodeURIComponent(req.params.id)}`);}));
router.post('/employees/:id/pay-plan',handle(async(req,res)=>{await hr.savePayPlan(req.params.id,{...req.body,components:components(req.body)},req.currentUser);redirect(res,`employees/${encodeURIComponent(req.params.id)}`);}));
router.get('/settings',handle(async(req,res)=>render(req,res,'settings','HR Settings',{settings:await hr.settings(req.currentUser)})));
router.post('/settings',handle(async(req,res)=>{
  try { await hr.saveSettings(req.body,req.currentUser);redirect(res,'settings'); }
  catch(error) {
    if(![400,404].includes(error.status) && !['23505','23503'].includes(error.code)) throw error;
    res.status(error.code?409:error.status);
    await render(req,res,'settings','HR Settings',{settings:await hr.settings(req.currentUser),settingsError:
      error.code==='23505'?'A leave type with this name already exists. Choose another name.':
      error.code==='23503'?'This leave type is in use and cannot be removed.':error.message});
  }
}));
router.get('/attendance',handle(async(req,res)=>render(req,res,'attendance','Attendance',{records:await hr.attendanceList(req.currentUser,req.query),filterDate:req.query.date||''})));
router.post('/attendance',handle(async(req,res)=>{await hr.attendanceBatch(req.body,req.currentUser);redirect(res,`attendance?date=${encodeURIComponent(req.body.attendance_date)}`);}));
router.post('/attendance/:id/submit',handle(async(req,res)=>{await hr.attendanceAction(req.params.id,'submit',req.currentUser);redirect(res,'attendance');}));
router.post('/attendance/:id/cancel',handle(async(req,res)=>{await hr.attendanceAction(req.params.id,'cancel',req.currentUser);redirect(res,'attendance');}));
router.get('/leave',handle(async(req,res)=>render(req,res,'leave','Leave',await hr.leaveList(req.currentUser))));
router.post('/leave',handle(async(req,res)=>{await hr.createLeave(req.body,req.currentUser);redirect(res,'leave');}));
router.post('/leave/allocations',handle(async(req,res)=>{await hr.allocateLeave(req.body,req.currentUser);redirect(res,'leave');}));
router.post('/leave/:id/submit',handle(async(req,res)=>{await hr.leaveAction(req.params.id,'submit',req.currentUser);redirect(res,'leave');}));
router.post('/leave/:id/cancel',handle(async(req,res)=>{await hr.leaveAction(req.params.id,'cancel',req.currentUser);redirect(res,'leave');}));
router.get('/money',handle(async(req,res)=>{
  const records=await hr.moneyList(req.currentUser);
  const payments=await hr.moneyRegisterPayments(records,req.currentUser);
  return render(req,res,'money','Employee Money',{records,payments});
}));
router.post('/money',handle(async(req,res)=>{await hr.createMoney(req.body,req.currentUser);redirect(res,'money');}));
router.post('/money/:id/submit',handle(async(req,res)=>{await hr.moneyAction(req.params.id,'submit',req.currentUser);redirect(res,'money');}));
router.post('/money/:id/cancel',handle(async(req,res)=>{await hr.moneyAction(req.params.id,'cancel',req.currentUser,req.body);redirect(res,'money');}));
router.post('/money/:id/pay',handle(async(req,res)=>{await hr.payMoney(req.params.id,req.body,req.currentUser);redirect(res,'money');}));
router.post('/money/:id/return',handle(async(req,res)=>{await hr.payMoney(req.params.id,req.body,req.currentUser,'return');redirect(res,'money');}));
router.post('/money/:id/cancel-payment',handle(async(req,res)=>{await hr.cancelPayment('money',req.params.id,req.body.payment_id,req.body,req.currentUser);redirect(res,'money');}));
router.get('/payslips',handle(async(req,res)=>render(req,res,'payslips','Payslips',{slips:await hr.payslipList(req.currentUser)})));
router.get('/payslips/:id',handle(async(req,res)=>render(req,res,'payslip','Payslip',await hr.payslipDetails(req.params.id,req.currentUser))));
router.get('/payroll',handle(async(req,res)=>render(req,res,'payroll','Payroll',{runs:await hr.payrollList(req.currentUser)})));
router.post('/payroll',handle(async(req,res)=>{
  try {
    const id=await hr.createPayroll(req.body,req.currentUser);redirect(res,`payroll/${id}`);
  } catch(error) {
    if(error.status!==400 && error.code!=='23505') throw error;
    res.status(error.code==='23505'?409:400);
    await render(req,res,'payroll','Payroll',{
      runs:await hr.payrollList(req.currentUser),formData:req.body,
      payrollError:error.code==='23505'?'A payroll already exists for a selected employee and month. Open the existing run or cancel it before creating a replacement.':error.message,
      correctionHref:error.employeeId && can(req.currentUser,'hr.employees.view')
        ? `/hr/employees/${encodeURIComponent(error.employeeId)}#${error.employeeSection}` : null,
      correctionLabel:error.employeeSection==='pay-plans'?'Open employee pay plans':'Open employee employment details',
    });
  }
}));
router.get('/payroll/:id',handle(async(req,res)=>{
  const data=await hr.payrollDetails(req.params.id,req.currentUser);
  const balances=can(req.currentUser,'hr.money.view')?await hr.moneyList(req.currentUser):[];
  return render(req,res,'run',`Payroll ${data.run.period}`,{...data,balances});
}));
router.post('/payroll/:id/slips/:slipId',handle(async(req,res)=>{
  if(recoveries(req.body).some(r=>r.money_id) && !can(req.currentUser,'hr.money.view')) fail('Employee Money Read is required to allocate recoveries.',403);
  await hr.updateSlip(req.params.id,req.params.slipId,{...req.body,components:components(req.body),recoveries:recoveries(req.body),preserveRecoveries:!can(req.currentUser,'hr.money.view')},req.currentUser);redirect(res,`payroll/${req.params.id}`);
}));
router.post('/payroll/:id/submit',handle(async(req,res)=>{await hr.payrollAction(req.params.id,'submit',req.currentUser);redirect(res,`payroll/${req.params.id}`);}));
router.post('/payroll/:id/cancel',handle(async(req,res)=>{await hr.payrollAction(req.params.id,'cancel',req.currentUser,req.body);redirect(res,`payroll/${req.params.id}`);}));
router.post('/payroll/:id/pay',handle(async(req,res)=>{await hr.payPayroll(req.params.id,req.body,req.currentUser);redirect(res,`payroll/${req.params.id}`);}));
router.post('/payroll/:id/cancel-payment',handle(async(req,res)=>{await hr.cancelPayment('payroll',req.params.id,req.body.payment_id,req.body,req.currentUser);redirect(res,`payroll/${req.params.id}`);}));
router.get('/payroll/:id/export',handle(async(req,res)=>{
  const {run,slips}=await hr.payrollDetails(req.params.id,req.currentUser);
  const rows=[['Payroll','Period','Status','Employee ID','Employee','Cost center','Paid days','Gross UGX','Deductions UGX','Net UGX','Employer contributions UGX','Paid UGX','Outstanding UGX'],
    ...slips.map(s=>[`PAY-${run.id}`,run.period,run.docstatus,s.employee_id,s.employee_name,s.cost_center,Number(s.paid_days),Number(s.gross_pay),Number(s.deductions),Number(s.net_pay),Number(s.employer_cost),Number(s.paid_amount),run.docstatus==='submitted'?Number(s.net_pay)-Number(s.paid_amount):''])];
  const cell=value=>{let valueText=String(value??'');if(typeof value!=='number'&&/^[\s]*[=+@-]/.test(valueText))valueText=`'${valueText}`;return `"${valueText.replaceAll('"','""')}"`;};
  res.attachment(`payroll-${run.id}-${run.period}.csv`);res.type('text/csv');res.send('\uFEFF'+rows.map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n');
}));
router.get('/payroll/:id/payslips/:slipId',handle(async(req,res)=>{
  const data=await hr.payrollDetails(req.params.id,req.currentUser);
  const slip=data.slips.find(s=>String(s.id)===req.params.slipId);if(!slip)fail('Payslip not found.',404);
  return render(req,res,'payslip',`Payslip — ${slip.employee_name}`,{run:data.run,slip});
}));
module.exports=router;
