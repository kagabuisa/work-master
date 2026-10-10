'use strict';

const { getPostgresPool, withPostgresTransaction } = require('./core');
const { auditActor } = require('./audit');
const { postGlEntry, reverseVoucherGlEntries } = require('./domain/posting');
const { validateCostCenter } = require('./cost-centers');
const { accountAllowed, assignedMasterRecordAllowed } = require('./access');
const { fail, date, amount, cents, monthPeriod, assertEmployee, employeeAllowed, assertAccount, calculatePay } = require('./hr-policy');

const key = (value) => { const n=Number(value); if (!Number.isSafeInteger(n) || n<1) fail('Record not found.',404); return n; };
const text = (value, required=false) => { const s=String(value || '').trim(); if(s.length>2000 || required && !s) fail('Enter a description (up to 2,000 characters).'); return s; };

async function employee(client, employeeId, user, active=false) {
  const {rows}=await client.query(`SELECT e.*, p.joining_date::text, p.leaving_date::text,
    p.manager_id, p.cost_center, p.branch, p.employment_type FROM app_master_employees e
    LEFT JOIN app_hr_profiles p USING(employee_id) WHERE e.employee_id=$1 FOR UPDATE OF e`,[String(employeeId)]);
  const e=rows[0]; if(!e) fail('Employee not found.',404);
  assertEmployee(user,e.employee_id,e.cost_center);
  if(active && (e.disabled || String(e.status).toLowerCase()==='left')) fail('Choose an active employee.');
  return e;
}
async function account(client,id,user,types, bank=false, allowInactive=false) {
  assertAccount(user,id);
  const {rows}=await client.query('SELECT * FROM app_accounts WHERE id=$1 FOR SHARE',[key(id)]);
  const a=rows[0];
  if(!a || a.is_group || !allowInactive && !a.is_active || types && !types.includes(a.account_type)
      || bank && !['Bank','Cash'].includes(a.account_detail_type)) fail(bank ? 'Choose an active cash or bank account.' : 'Choose an active posting account of the appropriate type.');
  return a;
}
async function costCenter(client,value,user) {
  const cc=await validateCostCenter(client,value);
  if(cc && !assignedMasterRecordAllowed(user,'cost-centers',cc)) fail('This cost center is outside your permitted records.',403);
  return cc;
}
function assertEmployment(e, from, to=from) {
  if(e.joining_date && from < e.joining_date || e.leaving_date && to > e.leaving_date) fail('The dates fall outside this employee’s employment dates.');
}
async function settings(user, client=getPostgresPool()) {
  const result=await client.query('SELECT * FROM app_hr_settings WHERE id=1');
  return result.rows[0];
}
async function options(user) {
  const pool=getPostgresPool();
  const [employees,accounts,centers,types,holidays]=await Promise.all([
    pool.query(`SELECT e.employee_id,e.employee_name,e.company,e.status,e.disabled,p.cost_center,p.joining_date::text,p.leaving_date::text,
      p.manager_id,p.branch,p.employment_type FROM app_master_employees e LEFT JOIN app_hr_profiles p USING(employee_id) ORDER BY e.employee_name`),
    pool.query('SELECT id,account_name,account_type,account_detail_type FROM app_accounts WHERE is_active AND NOT is_group ORDER BY account_name'),
    pool.query('SELECT cost_center FROM app_master_cost_centers WHERE NOT disabled AND NOT is_group ORDER BY cost_center'),
    pool.query('SELECT * FROM app_hr_leave_types ORDER BY name'), pool.query('SELECT holiday_date::text,description FROM app_hr_holidays ORDER BY holiday_date DESC'),
  ]);
  return {employees:employees.rows.filter(e=>employeeAllowed(user,e.employee_id,e.cost_center)),
    accounts:accounts.rows.filter(a=>accountAllowed(user,String(a.id))),
    centers:centers.rows.filter(c=>assignedMasterRecordAllowed(user,'cost-centers',c.cost_center)),
    leaveTypes:types.rows,holidays:holidays.rows};
}
async function saveSettings(payload,user) {
  return withPostgresTransaction(async client=>{
    if(['leave_type_edit','leave_type_delete'].includes(payload.action)) {
      const id=key(payload.leave_type_id);
      const current=(await client.query('SELECT * FROM app_hr_leave_types WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!current) fail('Leave type not found.',404);
      const used=(await client.query(`SELECT EXISTS(SELECT 1 FROM app_hr_leave_allocations WHERE leave_type_id=$1)
        OR EXISTS(SELECT 1 FROM app_hr_leave_requests WHERE leave_type_id=$1) AS used`,[id])).rows[0].used;
      if(payload.action==='leave_type_delete') {
        if(used) fail('This leave type has allocations or leave requests and cannot be removed. You can still rename it.');
        await client.query('DELETE FROM app_hr_leave_types WHERE id=$1',[id]);
      } else {
        const name=text(payload.name,true); if(name.length>100) fail('Leave type name is too long.');
        if(!['0','1'].includes(payload.is_paid)) fail('Choose whether this leave type is paid.');
        const paid=payload.is_paid==='1';
        if(used && paid!==current.is_paid) fail('Paid status cannot change after a leave type has allocations or requests. Create a new leave type instead.');
        await client.query('UPDATE app_hr_leave_types SET name=$1,is_paid=$2 WHERE id=$3',[name,paid,id]);
      }
    } else if(payload.action==='leave_type') {
      const name=text(payload.name,true); if(name.length>100) fail('Leave type name is too long.');
      if(!['0','1'].includes(payload.is_paid)) fail('Choose whether this leave type is paid.');
      await client.query('INSERT INTO app_hr_leave_types(name,is_paid) VALUES($1,$2)',[name,payload.is_paid==='1']);
    } else if(payload.action==='holiday') {
      await client.query('INSERT INTO app_hr_holidays(holiday_date,description) VALUES($1,$2) ON CONFLICT(holiday_date) DO UPDATE SET description=EXCLUDED.description',[date(payload.holiday_date),text(payload.description,true)]);
    } else if(payload.action==='calendar') {
      const raw=Array.isArray(payload.working_weekdays)?payload.working_weekdays:[payload.working_weekdays];
      const days=[...new Set(raw.filter(v=>v!==undefined).map(Number))].sort();
      if(!days.length||days.some(d=>!Number.isInteger(d)||d<0||d>6)) fail('Select at least one working weekday.');
      await client.query('UPDATE app_hr_settings SET working_weekdays=$1 WHERE id=1',[JSON.stringify(days)]);
    } else if(payload.action==='accounts') {
      const a=await account(client,payload.salary_payable_account_id,user,['liability']);
      await client.query('UPDATE app_hr_settings SET salary_payable_account_id=$1 WHERE id=1',[a.id]);
    } else fail('Choose a valid settings action.');
  });
}
async function employeeProfile(id,user,showPay=false) {
  return withPostgresTransaction(async client=>{
    const e=await employee(client,id,user);
    const plans=showPay ? (await client.query('SELECT *,effective_from::text FROM app_hr_pay_plans WHERE employee_id=$1 ORDER BY app_hr_pay_plans.effective_from DESC',[id])).rows.filter(plan=>plan.components.every(c=>accountAllowed(user,String(c.account_id))&&(!c.payable_account_id||accountAllowed(user,String(c.payable_account_id))))) : [];
    return {employee:e,plans};
  });
}
async function saveProfile(id,payload,user) {
  return withPostgresTransaction(async client=>{
    const e=await employee(client,id,user);
    const joining=payload.joining_date ? date(payload.joining_date) : null;
    const leaving=payload.leaving_date ? date(payload.leaving_date) : null;
    if(joining && leaving && leaving<joining) fail('Leaving date cannot precede joining date.');
    const manager=text(payload.manager_id)||null;
    if(manager===id) fail('An employee cannot be their own manager.');
    if(manager && manager!==e.manager_id) await employee(client,manager,user);
    const cc=await costCenter(client,payload.cost_center,user);
    await client.query(`INSERT INTO app_hr_profiles(employee_id,joining_date,leaving_date,manager_id,cost_center,branch,employment_type)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(employee_id) DO UPDATE SET joining_date=EXCLUDED.joining_date,
      leaving_date=EXCLUDED.leaving_date,manager_id=EXCLUDED.manager_id,cost_center=EXCLUDED.cost_center,
      branch=EXCLUDED.branch,employment_type=EXCLUDED.employment_type`,[e.employee_id,joining,leaving,manager,cc,text(payload.branch),text(payload.employment_type)]);
  });
}
async function normalizeComponents(client,input,user) {
  if(!Array.isArray(input)) fail('Enter pay components.');
  const out=[];
  for(const row of input) {
    if(!String(row.label||'').trim() && !row.amount) continue;
    if(!['earning','deduction','employer'].includes(row.kind)) fail('Choose a component type.');
    const a=await account(client,row.account_id,user,row.kind==='deduction'?['liability']:['expense']);
    const component={label:text(row.label,true),kind:row.kind,amount:amount(row.amount),prorate:row.prorate===true||row.prorate==='1',account_id:Number(a.id)};
    if(row.kind==='employer') component.payable_account_id=Number((await account(client,row.payable_account_id,user,['liability'])).id);
    out.push(component);
  }
  calculatePay(out,1,1);
  return out;
}
async function savePayPlan(id,payload,user) {
  return withPostgresTransaction(async client=>{
    await employee(client,id,user,true);
    const effective=date(payload.effective_from);
    const existing=(await client.query('SELECT components FROM app_hr_pay_plans WHERE employee_id=$1 AND effective_from=$2 FOR UPDATE',[id,effective])).rows[0];
    for(const c of existing?.components||[]) { assertAccount(user,c.account_id);if(c.payable_account_id)assertAccount(user,c.payable_account_id); }
    const components=await normalizeComponents(client,payload.components,user);
    await client.query(`INSERT INTO app_hr_pay_plans(employee_id,effective_from,components,notes) VALUES($1,$2,$3,$4)
      ON CONFLICT(employee_id,effective_from) DO UPDATE SET components=EXCLUDED.components,notes=EXCLUDED.notes`,
      [id,effective,JSON.stringify(components),text(payload.notes)]);
  });
}
async function attendanceList(user,query={}) {
  const day=query.date ? date(query.date) : null;
  const {rows}=await getPostgresPool().query(`SELECT a.*, a.attendance_date::text,e.employee_name,p.cost_center FROM app_hr_attendance a
    JOIN app_master_employees e USING(employee_id) LEFT JOIN app_hr_profiles p USING(employee_id)
    WHERE ($1::date IS NULL OR a.attendance_date=$1) ORDER BY a.attendance_date DESC,a.id DESC LIMIT 1000`,[day]);
  return rows.filter(r=>employeeAllowed(user,r.employee_id,r.cost_center));
}
async function attendanceBatch(payload,user) {
  return withPostgresTransaction(async client=>{
    const day=date(payload.attendance_date);
    const ids=[...new Set((Array.isArray(payload.employee_ids)?payload.employee_ids:[payload.employee_ids]).filter(Boolean))].sort();
    if(!ids.length || ids.length>500) fail('Select between one and 500 employees.');
    if(!['present','absent','half_day'].includes(payload.status)) fail('Choose an attendance status.');
    for(const id of ids) { const e=await employee(client,id,user,true); assertEmployment(e,day);
      await client.query('INSERT INTO app_hr_attendance(employee_id,attendance_date,status,notes) VALUES($1,$2,$3,$4)',[id,day,payload.status,text(payload.notes)]); }
  });
}
async function lockedAttendance(client,id,user) {
  const candidate=(await client.query('SELECT employee_id FROM app_hr_attendance WHERE id=$1',[key(id)])).rows[0];
  if(!candidate) fail('Attendance not found.',404);
  await employee(client,candidate.employee_id,user);
  return (await client.query('SELECT *,attendance_date::text FROM app_hr_attendance WHERE id=$1 FOR UPDATE',[id])).rows[0];
}
async function attendanceAction(id,action,user) {
  return withPostgresTransaction(async client=>{
    const r=await lockedAttendance(client,id,user);
    if(action==='submit' && r.docstatus!=='draft' || action==='cancel' && r.docstatus==='cancelled') fail('Attendance is already processed.');
    const locked=await client.query(`SELECT 1 FROM app_hr_slips WHERE employee_id=$1 AND period=to_char($2::date,'YYYY-MM') AND docstatus='submitted' LIMIT 1`,[r.employee_id,r.attendance_date]);
    if(locked.rowCount) fail('This month has posted payroll. Correct payroll before changing attendance.');
    await client.query('UPDATE app_hr_attendance SET docstatus=$2 WHERE id=$1',[id,action==='submit'?'submitted':'cancelled']);
  });
}
function leaveDays(from,to,halfDay,holidayDates,workingWeekdays=[0,1,2,3,4,5,6]) {
  date(from); date(to);
  if(to<from || from.slice(0,4)!==to.slice(0,4)) fail('Leave dates must be ordered and in the same calendar year. Split requests across years.');
  if(halfDay && from!==to) fail('Half-day leave must cover one day.');
  let days=0; const holidays=new Set(holidayDates);
  for(let d=new Date(`${from}T00:00:00Z`);d.toISOString().slice(0,10)<=to;d.setUTCDate(d.getUTCDate()+1)) {
    if(workingWeekdays.includes(d.getUTCDay())&&!holidays.has(d.toISOString().slice(0,10))) days+=halfDay?0.5:1;
  }
  if(!days) fail('The request contains no working days.');
  return days;
}
async function leaveList(user) {
  const pool=getPostgresPool();
  const [requests,balances]=await Promise.all([
    pool.query(`SELECT r.*,r.from_date::text,r.to_date::text,e.employee_name,t.name AS leave_type,t.is_paid,p.cost_center
      FROM app_hr_leave_requests r JOIN app_master_employees e USING(employee_id) JOIN app_hr_leave_types t ON t.id=r.leave_type_id
      LEFT JOIN app_hr_profiles p USING(employee_id) ORDER BY r.id DESC LIMIT 1000`),
    pool.query(`SELECT a.*,e.employee_name,t.name AS leave_type,p.cost_center,
      COALESCE((SELECT sum(r.days) FROM app_hr_leave_requests r WHERE r.employee_id=a.employee_id AND r.leave_type_id=a.leave_type_id
      AND EXTRACT(YEAR FROM r.from_date)=a.year AND r.docstatus='submitted'),0) AS used_days
      FROM app_hr_leave_allocations a JOIN app_master_employees e USING(employee_id)
      JOIN app_hr_leave_types t ON t.id=a.leave_type_id LEFT JOIN app_hr_profiles p USING(employee_id) ORDER BY a.year DESC,e.employee_name`),
  ]);
  return {requests:requests.rows.filter(r=>employeeAllowed(user,r.employee_id,r.cost_center)),balances:balances.rows.filter(r=>employeeAllowed(user,r.employee_id,r.cost_center))};
}
async function allocateLeave(payload,user) {
  return withPostgresTransaction(async client=>{
    await employee(client,payload.employee_id,user,true);
    const year=Number(payload.year); if(!Number.isInteger(year)||year<1900||year>2200) fail('Choose a valid year.');
    const days=amount(payload.days,'Leave days',false);
    const used=(await client.query(`SELECT COALESCE(sum(days),0) AS days FROM app_hr_leave_requests
      WHERE employee_id=$1 AND leave_type_id=$2 AND EXTRACT(YEAR FROM from_date)=$3 AND docstatus='submitted'`,[payload.employee_id,key(payload.leave_type_id),year])).rows[0];
    if(days<Number(used.days)) fail('Allocation cannot be smaller than approved leave already taken.');
    await client.query(`INSERT INTO app_hr_leave_allocations(employee_id,leave_type_id,year,days,notes) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(employee_id,leave_type_id,year) DO UPDATE SET days=EXCLUDED.days,notes=EXCLUDED.notes`,[payload.employee_id,payload.leave_type_id,year,days,text(payload.notes)]);
  });
}
async function createLeave(payload,user) {
  return withPostgresTransaction(async client=>{
    const e=await employee(client,payload.employee_id,user,true);
    const from=date(payload.from_date),to=date(payload.to_date); assertEmployment(e,from,to);
    const holidays=(await client.query('SELECT holiday_date::text FROM app_hr_holidays WHERE holiday_date BETWEEN $1 AND $2',[from,to])).rows.map(r=>r.holiday_date);
    const half=payload.half_day==='1'; const calendar=await settings(user,client); const days=leaveDays(from,to,half,holidays,calendar.working_weekdays);
    await client.query(`INSERT INTO app_hr_leave_requests(employee_id,leave_type_id,from_date,to_date,days,half_day,reason) VALUES($1,$2,$3,$4,$5,$6,$7)`,[e.employee_id,key(payload.leave_type_id),from,to,days,half,text(payload.reason,true)]);
  });
}
async function leaveAction(id,action,user) {
  return withPostgresTransaction(async client=>{
    const candidate=(await client.query('SELECT employee_id FROM app_hr_leave_requests WHERE id=$1',[key(id)])).rows[0];
    if(!candidate) fail('Leave request not found.',404);
    const e=await employee(client,candidate.employee_id,user);
    const r=(await client.query('SELECT *,from_date::text,to_date::text FROM app_hr_leave_requests WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(action==='submit' && r.docstatus!=='draft' || action==='cancel' && r.docstatus==='cancelled') fail('Leave request is already processed.');
    if(action==='submit' && user?.role!=='admin' && String(r.created_by_user_id)===String(user.id)) fail('A different user must approve this leave request.',403);
    const affected=await client.query(`SELECT 1 FROM app_hr_slips WHERE employee_id=$1 AND docstatus='submitted'
      AND period BETWEEN to_char($2::date,'YYYY-MM') AND to_char($3::date,'YYYY-MM') LIMIT 1`,[r.employee_id,r.from_date,r.to_date]);
    if(affected.rowCount) fail('Posted payroll covers these leave dates. Correct payroll before changing leave.');
    if(action==='submit') {
      assertEmployment(e,r.from_date,r.to_date);
      const overlap=await client.query(`SELECT 1 FROM app_hr_leave_requests WHERE employee_id=$1 AND id<>$2 AND docstatus='submitted'
        AND from_date<=$4 AND to_date>=$3 LIMIT 1`,[r.employee_id,id,r.from_date,r.to_date]);
      if(overlap.rowCount) fail('Approved leave overlaps this request.');
      const holidayRows=(await client.query('SELECT holiday_date::text FROM app_hr_holidays WHERE holiday_date BETWEEN $1 AND $2',[r.from_date,r.to_date])).rows;
      r.days=leaveDays(r.from_date,r.to_date,r.half_day,holidayRows.map(h=>h.holiday_date),(await settings(user,client)).working_weekdays);
      const type=(await client.query('SELECT * FROM app_hr_leave_types WHERE id=$1',[r.leave_type_id])).rows[0];
      if(type.is_paid) {
        const balance=(await client.query(`SELECT a.days-COALESCE((SELECT sum(l.days) FROM app_hr_leave_requests l
          WHERE l.employee_id=a.employee_id AND l.leave_type_id=a.leave_type_id AND EXTRACT(YEAR FROM l.from_date)=a.year AND l.docstatus='submitted'),0) AS remaining
          FROM app_hr_leave_allocations a WHERE employee_id=$1 AND leave_type_id=$2 AND year=EXTRACT(YEAR FROM $3::date)`,[r.employee_id,r.leave_type_id,r.from_date])).rows[0];
        if(!balance || Number(balance.remaining)<Number(r.days)) fail('Insufficient allocated leave.');
      }
    }
    await client.query('UPDATE app_hr_leave_requests SET docstatus=$2,days=$3 WHERE id=$1',[id,action==='submit'?'submitted':'cancelled',r.days]);
  });
}

const moneyBalanceSql=`SELECT m.*,m.posting_date::text,e.employee_name,
  COALESCE((SELECT sum(p.amount) FROM app_hr_payments p WHERE p.money_id=m.id AND p.direction='payout' AND p.docstatus='submitted'),0) AS paid_out,
  COALESCE((SELECT sum(p.amount) FROM app_hr_payments p WHERE p.money_id=m.id AND p.direction='return' AND p.docstatus='submitted'),0) AS returned,
  COALESCE((SELECT sum(r.amount) FROM app_hr_recoveries r JOIN app_hr_slips s ON s.id=r.slip_id WHERE r.money_id=m.id AND s.docstatus='submitted'),0) AS recovered
  FROM app_hr_money m JOIN app_master_employees e USING(employee_id)`;
function moneyRow(r) {
  const funded=['advance','loan'].includes(r.kind)?Number(r.paid_out):Number(r.amount);
  return {...r,balance:r.docstatus==='submitted'?Math.max(0,(cents(funded)-cents(r.returned)-cents(r.recovered)-(r.kind==='reimbursement'?cents(r.paid_out):0))/100):0};
}
function moneyAccountsAllowed(user,m) {
  return accountAllowed(user,String(m.account_id)) && (!m.offset_account_id || accountAllowed(user,String(m.offset_account_id)));
}
async function moneyList(user) {
  const rows=(await getPostgresPool().query(`${moneyBalanceSql} ORDER BY m.id DESC`)).rows;
  const opts=await options(user); const allowed=new Set(opts.employees.map(e=>e.employee_id));
  return rows.filter(m=>allowed.has(m.employee_id)&&moneyAccountsAllowed(user,m)&&(!m.cost_center||assignedMasterRecordAllowed(user,'cost-centers',m.cost_center))).map(moneyRow);
}
async function lockedMoney(client,id,user,asOf=null) {
  const base=(await client.query('SELECT employee_id FROM app_hr_money WHERE id=$1',[key(id)])).rows[0];
  if(!base) fail('Employee transaction not found.',404);
  await employee(client,base.employee_id,user);
  await client.query('SELECT id FROM app_hr_money WHERE id=$1 FOR UPDATE',[id]);
  const m=moneyRow((await client.query(`${moneyBalanceSql} WHERE m.id=$1`,[id])).rows[0]);
  if(!moneyAccountsAllowed(user,m)) fail('This transaction uses restricted accounts.',403);
  if(m.cost_center && !assignedMasterRecordAllowed(user,'cost-centers',m.cost_center)) fail('This transaction uses a restricted cost center.',403);
  if(asOf && ['advance','loan'].includes(m.kind)) {
    const funded=(await client.query("SELECT COALESCE(sum(CASE WHEN direction='payout' THEN amount ELSE -amount END),0) AS amount FROM app_hr_payments WHERE money_id=$1 AND docstatus='submitted' AND posting_date<=$2",[m.id,asOf])).rows[0];
    m.balance=Math.max(0,(cents(funded.amount)-cents(m.recovered))/100);
  }
  return m;
}
async function createMoney(payload,user) {
  return withPostgresTransaction(async client=>{
    const e=await employee(client,payload.employee_id,user,true);
    if(!['advance','loan','recovery','reimbursement'].includes(payload.kind)) fail('Choose a transaction type.');
    const a=await account(client,payload.account_id,user,payload.kind==='reimbursement'?['liability']:['asset']);
    if(payload.kind!=='reimbursement' && a.account_detail_type!=='Receivable') fail('Choose a receivable account for employee advances, loans, and recoveries.');
    const offset=['recovery','reimbursement'].includes(payload.kind)?await account(client,payload.offset_account_id,user,payload.kind==='reimbursement'?['expense']:['income','expense']):null;
    const cc=await costCenter(client,payload.cost_center || e.cost_center,user);
    const result=await client.query(`INSERT INTO app_hr_money(employee_id,kind,posting_date,amount,account_id,offset_account_id,cost_center,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[e.employee_id,payload.kind,date(payload.posting_date),amount(payload.amount,'Amount',false),a.id,offset?.id||null,cc,text(payload.reason,true)]);
    return result.rows[0].id;
  });
}
async function moneyAction(id,action,user,payload={}) {
  return withPostgresTransaction(async client=>{
    const m=await lockedMoney(client,id,user);
    if(action==='submit' && m.docstatus!=='draft' || action==='cancel' && m.docstatus==='cancelled') fail('Employee transaction is already processed.');
    if(action==='submit') {
      if(user?.role!=='admin' && String(m.created_by_user_id)===String(user.id)) fail('A different user must approve this transaction.',403);
      const balanceAccount=await account(client,m.account_id,user,m.kind==='reimbursement'?['liability']:['asset']);
      if(m.kind!=='reimbursement' && balanceAccount.account_detail_type!=='Receivable') fail('Employee balances require a receivable account.');
      if(m.offset_account_id) await account(client,m.offset_account_id,user,m.kind==='reimbursement'?['expense']:['income','expense']);
      if(['recovery','reimbursement'].includes(m.kind)) {
        const reimb=m.kind==='reimbursement';
        await postGlEntry(client,{posting_date:m.posting_date,voucher_type:'hr_money',voucher_id:m.id,voucher_no:`HRM-${m.id}`,party_type:'employee',party_id:m.employee_id,party_name:m.employee_name,cost_center:m.cost_center,remarks:m.reason,
          lines:[{account_id:m.account_id,debit:reimb?0:Number(m.amount),credit:reimb?Number(m.amount):0},
            {account_id:m.offset_account_id,debit:reimb?Number(m.amount):0,credit:reimb?0:Number(m.amount)}]});
      }
    } else if(m.docstatus==='submitted') {
      const linked=await client.query(`SELECT 1 FROM app_hr_recoveries r JOIN app_hr_slips s ON s.id=r.slip_id WHERE r.money_id=$1 AND s.docstatus <> 'cancelled'
        UNION ALL SELECT 1 FROM app_hr_payments WHERE money_id=$1 AND docstatus='submitted' LIMIT 1`,[m.id]);
      if(linked.rowCount) fail('Cancel linked payments and payroll recoveries first.');
      const when=date(payload.posting_date); if(when<m.posting_date) fail('Cancellation cannot precede the transaction.');
      await reverseVoucherGlEntries(client,'hr_money',m.id,when);
    }
    await client.query('UPDATE app_hr_money SET docstatus=$2 WHERE id=$1',[m.id,action==='submit'?'submitted':'cancelled']);
  });
}
async function payMoney(id,payload,user,direction='payout') {
  return withPostgresTransaction(async client=>{
    const m=await lockedMoney(client,id,user);
    if(m.docstatus!=='submitted') fail('Approve the employee transaction before payment.');
    if(direction==='return' && m.kind==='reimbursement') fail('Reimbursements cannot receive a cash return.');
    if(direction==='payout' && m.kind==='recovery') fail('A recovery is repaid, not disbursed.');
    const value=amount(payload.amount,'Payment',false), when=date(payload.posting_date);
    if(when<m.posting_date) fail('Payment cannot precede the employee transaction.');
    let maximum=direction==='return'?m.balance:m.kind==='reimbursement'?m.balance:(cents(m.amount)-cents(m.paid_out))/100;
    if(direction==='return' && ['advance','loan'].includes(m.kind)) maximum=Math.min(maximum,(await lockedMoney(client,m.id,user,when)).balance);
    if(cents(value)>cents(maximum)) fail('Payment exceeds the available amount on this date.');
    const bank=await account(client,payload.bank_account_id,user,['asset'],true);
    await account(client,m.account_id,user,m.kind==='reimbursement'?['liability']:['asset']);
    if(String(bank.id)===String(m.account_id)) fail('The payment account must differ from the employee balance account.');
    const payment=(await client.query(`INSERT INTO app_hr_payments(money_id,posting_date,amount,direction,bank_account_id,reference) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,[m.id,when,value,direction,bank.id,text(payload.reference,true)])).rows[0];
    const payout=direction==='payout';
    await postGlEntry(client,{posting_date:when,voucher_type:'hr_payment',voucher_id:payment.id,voucher_no:`HRP-${payment.id}`,party_type:'employee',party_id:m.employee_id,party_name:m.employee_name,cost_center:m.cost_center,
      lines:[{account_id:m.account_id,debit:payout?value:0,credit:payout?0:value},{account_id:bank.id,debit:payout?0:value,credit:payout?value:0}]});
    return payment.id;
  });
}

async function runSlips(client,id) {
  return (await client.query(`SELECT s.*,COALESCE((SELECT sum(p.amount) FROM app_hr_payments p WHERE p.slip_id=s.id AND p.docstatus='submitted'),0) AS paid_amount
    FROM app_hr_slips s WHERE run_id=$1 ORDER BY employee_id`,[id])).rows;
}
function assertSlipAccounts(user,s) {
  assertEmployee(user,s.employee_id,s.cost_center);
  for(const c of s.components) { assertAccount(user,c.account_id); if(c.payable_account_id) assertAccount(user,c.payable_account_id); }
}
async function lockedRun(client,id,user) {
  const run=(await client.query('SELECT *,posting_date::text FROM app_hr_runs WHERE id=$1 FOR UPDATE',[key(id)])).rows[0];
  if(!run) fail('Payroll run not found.',404);
  assertAccount(user,run.payable_account_id);
  const slips=await runSlips(client,id);
  for(const s of slips) { await employee(client,s.employee_id,user); assertSlipAccounts(user,s); }
  return {run,slips};
}
async function payrollList(user) {
  const runs=(await getPostgresPool().query('SELECT *,posting_date::text FROM app_hr_runs ORDER BY id DESC LIMIT 200')).rows;
  const opts=await options(user); const employees=new Set(opts.employees.map(e=>e.employee_id));
  const out=[];
  for(const r of runs) {
    if(!accountAllowed(user,String(r.payable_account_id))) continue;
    const slips=await runSlips(getPostgresPool(),r.id);
    if(!slips.length || slips.some(s=>!employees.has(s.employee_id)||!employeeAllowed(user,s.employee_id,s.cost_center)||s.components.some(c=>!accountAllowed(user,String(c.account_id))||c.payable_account_id&&!accountAllowed(user,String(c.payable_account_id))))) continue;
    out.push({...r,employees:slips.length,gross:slips.reduce((n,s)=>n+Number(s.gross_pay),0),net:slips.reduce((n,s)=>n+Number(s.net_pay),0),paid:slips.reduce((n,s)=>n+Number(s.paid_amount),0)});
  }
  return out;
}
async function createPayroll(payload,user) {
  return withPostgresTransaction(async client=>{
    const period=monthPeriod(payload.period);const company=text(payload.company,true);
    const payable=(await settings(user,client)).salary_payable_account_id;
    if(!payable) fail('Set the salary payable account in HR Settings first.');
    await account(client,payable,user,['liability']);
    const ids=[...new Set((Array.isArray(payload.employee_ids)?payload.employee_ids:[payload.employee_ids]).filter(Boolean))].sort();
    if(!ids.length||ids.length>500) fail('Select between one and 500 employees.');
    const profiles=[];
    for(const id of ids) {
      const e=await employee(client,id,user);
      if((e.disabled || String(e.status).toLowerCase()==='left') && !e.leaving_date) {
        const error=new Error(`${e.employee_name} needs a leaving date to establish payroll eligibility. Set it under HR → Employees → Employment.`);
        error.status=400;error.employeeId=e.employee_id;error.employeeSection='employment';throw error;
      }
      if(e.company!==company) fail('All selected employees must belong to the payroll company.');
      if(e.joining_date && e.joining_date>period.end || e.leaving_date && e.leaving_date<period.start) fail(`${e.employee_name} was not employed during this period.`);
      const plan=(await client.query('SELECT * FROM app_hr_pay_plans WHERE employee_id=$1 AND effective_from<=$2 ORDER BY effective_from DESC LIMIT 1',[id,period.start])).rows[0];
      if(!plan) {
        const error=new Error(`${e.employee_name} needs a pay plan effective on or before ${period.start}. Set it under HR → Employees → Pay plans.`);
        error.status=400;error.employeeId=e.employee_id;error.employeeSection='pay-plans';throw error;
      }
      const from=e.joining_date&&e.joining_date>period.start?e.joining_date:period.start;
      const to=e.leaving_date&&e.leaving_date<period.end?e.leaving_date:period.end;
      const days=Math.round((new Date(to)-new Date(from))/86400000)+1;
      profiles.push({e,plan,days});
    }
    const posting=date(payload.posting_date); if(posting<period.end) fail('Payroll posting date cannot precede the end of the period.');
    const run=(await client.query('INSERT INTO app_hr_runs(company,period,posting_date,payable_account_id) VALUES($1,$2,$3,$4) RETURNING id',[company,payload.period,posting,payable])).rows[0];
    for(const {e,plan,days} of profiles) {
      for(const c of plan.components) {
        await account(client,c.account_id,user,c.kind==='deduction'?['liability']:['expense']);
        if(c.kind==='employer') await account(client,c.payable_account_id,user,['liability']);
      }
      const pay=calculatePay(plan.components,days,period.days);
      await client.query(`INSERT INTO app_hr_slips(run_id,employee_id,employee_name,period,cost_center,plan_id,components,calendar_days,paid_days,gross_pay,deductions,net_pay,employer_cost)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[run.id,e.employee_id,e.employee_name,payload.period,e.cost_center,plan.id,JSON.stringify(pay.components),period.days,days,pay.gross_pay,pay.deductions,pay.net_pay,pay.employer_cost]);
    }
    return run.id;
  });
}
async function payrollDetails(id,user) {
  return withPostgresTransaction(async client=>{
    const result=await lockedRun(client,id,user);
    result.payments=(await client.query(`SELECT p.*,p.posting_date::text,a.account_name,s.employee_name FROM app_hr_payments p
      JOIN app_hr_slips s ON s.id=p.slip_id JOIN app_accounts a ON a.id=p.bank_account_id WHERE s.run_id=$1 ORDER BY p.id DESC`,[id])).rows.filter(p=>accountAllowed(user,String(p.bank_account_id)));
    const recoveries=(await client.query(`SELECT r.*,m.kind,m.reason FROM app_hr_recoveries r JOIN app_hr_money m ON m.id=r.money_id JOIN app_hr_slips s ON s.id=r.slip_id WHERE s.run_id=$1`,[id])).rows;
    result.recoveries=recoveries;
    return result;
  });
}
async function payslipList(user) {
  const rows=(await getPostgresPool().query(`SELECT s.*,r.company,r.docstatus AS run_status,
    r.payable_account_id,COALESCE((SELECT sum(p.amount) FROM app_hr_payments p WHERE p.slip_id=s.id AND p.docstatus='submitted'),0) AS paid_amount
    FROM app_hr_slips s JOIN app_hr_runs r ON r.id=s.run_id ORDER BY s.period DESC,s.id DESC LIMIT 1000`)).rows;
  const opts=await options(user);const employees=new Set(opts.employees.map(e=>e.employee_id));
  return rows.filter(s=>employees.has(s.employee_id)&&employeeAllowed(user,s.employee_id,s.cost_center)&&accountAllowed(user,String(s.payable_account_id))&&s.components.every(c=>accountAllowed(user,String(c.account_id))&&(!c.payable_account_id||accountAllowed(user,String(c.payable_account_id)))));
}
async function payslipDetails(id,user) {
  return withPostgresTransaction(async client=>{
    const s=(await client.query(`SELECT s.*,COALESCE((SELECT sum(p.amount) FROM app_hr_payments p WHERE p.slip_id=s.id AND p.docstatus='submitted'),0) AS paid_amount
      FROM app_hr_slips s WHERE id=$1`,[key(id)])).rows[0];
    if(!s)fail('Payslip not found.',404);
    await employee(client,s.employee_id,user);assertSlipAccounts(user,s);
    const run=(await client.query('SELECT *,posting_date::text FROM app_hr_runs WHERE id=$1',[s.run_id])).rows[0];
    assertAccount(user,run.payable_account_id);
    return {run,slip:s};
  });
}

async function updateSlip(runId,slipId,payload,user) {
  return withPostgresTransaction(async client=>{
    const {run,slips}=await lockedRun(client,runId,user);
    if(run.docstatus!=='draft') fail('Only draft payroll can be edited.');
    const s=slips.find(s=>String(s.id)===String(slipId)); if(!s) fail('Payslip not found.',404);
    const note=text(payload.input_note);
    if(!note) fail('Explain the paid-day, component, and recovery inputs before saving.');
    const baseComponents=await normalizeComponents(client,payload.components,user);
    const recoveries=payload.preserveRecoveries ? (await client.query('SELECT money_id,amount FROM app_hr_recoveries WHERE slip_id=$1',[s.id])).rows : Array.isArray(payload.recoveries)?payload.recoveries:[];
    if(recoveries.length>100) fail('Too many recovery allocations.');
    await client.query('DELETE FROM app_hr_recoveries WHERE slip_id=$1',[s.id]);
    const seen=new Set();
    for(const r of recoveries.filter(r=>r.money_id && Number(r.amount)>0).sort((a,b)=>Number(a.money_id)-Number(b.money_id))) {
      const m=await lockedMoney(client,r.money_id,user,run.posting_date);
      if(seen.has(String(m.id))) fail('Choose each employee balance once.'); seen.add(String(m.id));
      if(m.employee_id!==s.employee_id||m.docstatus!=='submitted'||m.kind==='reimbursement'||m.posting_date>run.posting_date) fail('Choose an approved balance for this employee dated on or before payroll.');
      const value=amount(r.amount,'Recovery',false);
      if(cents(value)>cents(m.balance)) fail('Recovery exceeds the employee balance.');
      baseComponents.push({label:`${m.kind}: ${m.reason}`,kind:'deduction',amount:value,prorate:false,account_id:Number(m.account_id),money_id:Number(m.id)});
      await client.query('INSERT INTO app_hr_recoveries(slip_id,money_id,amount) VALUES($1,$2,$3)',[s.id,m.id,value]);
    }
    const pay=calculatePay(baseComponents,payload.paid_days,s.calendar_days);
    const e=await employee(client,s.employee_id,user);
    const period=monthPeriod(run.period);
    const employedFrom=e.joining_date&&e.joining_date>period.start?e.joining_date:period.start;
    const employedTo=e.leaving_date&&e.leaving_date<period.end?e.leaving_date:period.end;
    const maximum=Math.max(0,Math.round((new Date(employedTo)-new Date(employedFrom))/86400000)+1);
    if(Number(payload.paid_days)>maximum) fail('Paid days exceed employment days in the period.');
    await client.query('UPDATE app_hr_runs SET review_version=review_version+1 WHERE id=$1',[runId]);
    await client.query(`UPDATE app_hr_slips SET components=$2,paid_days=$3,input_note=$4,gross_pay=$5,deductions=$6,net_pay=$7,employer_cost=$8 WHERE id=$1`,[s.id,JSON.stringify(pay.components),payload.paid_days,note,pay.gross_pay,pay.deductions,pay.net_pay,pay.employer_cost]);
  });
}
async function payrollAction(id,action,user,payload={}) {
  return withPostgresTransaction(async client=>{
    const {run,slips}=await lockedRun(client,id,user);
    if(action==='submit') {
      if(run.docstatus!=='draft') fail('Only draft payroll can be posted.');
      if(user?.role!=='admin' && (String(run.created_by_user_id)===String(user.id)||String(run.updated_by_user_id)===String(user.id))) fail('A different user must approve this payroll.',403);
      await account(client,run.payable_account_id,user,['liability']);
      const allRecoveries=(await client.query(`SELECT r.*,m.employee_id FROM app_hr_recoveries r JOIN app_hr_money m ON m.id=r.money_id JOIN app_hr_slips s ON s.id=r.slip_id WHERE s.run_id=$1 ORDER BY r.money_id`,[id])).rows;
      for(const r of allRecoveries) {
        const m=await lockedMoney(client,r.money_id,user,run.posting_date);
        if(m.docstatus!=='submitted'||cents(r.amount)>cents(m.balance)) fail('An employee balance changed. Review recovery allocations before posting.');
      }
      const lines=[];
      for(const s of slips) {
        const e=await employee(client,s.employee_id,user);
        const period=monthPeriod(run.period);
        if((e.disabled || String(e.status).toLowerCase()==='left') && !e.leaving_date || e.joining_date && e.joining_date>period.end || e.leaving_date && e.leaving_date<period.start) fail('Review employee employment dates before posting.');
        const from=e.joining_date&&e.joining_date>period.start?e.joining_date:period.start;
        const to=e.leaving_date&&e.leaving_date<period.end?e.leaving_date:period.end;
        if(Number(s.paid_days)>Math.round((new Date(to)-new Date(from))/86400000)+1) fail('Paid days exceed the employee’s current employment dates.');
        if(e.company!==run.company) fail('Employee company changed. Recreate this payroll.');
        if(!s.input_note) fail(`Review and save payroll inputs for ${s.employee_name} before posting.`);
        if(s.cost_center) await costCenter(client,s.cost_center,user);
        const pay=calculatePay(s.components,s.paid_days,s.calendar_days);
        const party={party_type:'employee',party_id:s.employee_id,party_name:s.employee_name,cost_center:s.cost_center};
        for(const c of pay.components) {
          await account(client,c.account_id,user,c.money_id?['asset']:c.kind==='deduction'?['liability']:['expense']);
          const value=c.calculated_amount;
          lines.push({...party,account_id:c.account_id,debit:c.kind==='deduction'?0:value,credit:c.kind==='deduction'?value:0});
          if(c.kind==='employer') { await account(client,c.payable_account_id,user,['liability']);lines.push({...party,account_id:c.payable_account_id,debit:0,credit:value}); }
        }
        lines.push({...party,account_id:run.payable_account_id,debit:0,credit:pay.net_pay});
      }
      await postGlEntry(client,{posting_date:run.posting_date,voucher_type:'hr_payroll',voucher_id:run.id,voucher_no:`PAY-${run.id}`,remarks:`Payroll ${run.period}`,lines});
      await client.query("UPDATE app_hr_runs SET docstatus='submitted',submitted_by_id=$2,submitted_at=now() WHERE id=$1",[id,auditActor().id]);
      await client.query("UPDATE app_hr_slips SET docstatus='submitted' WHERE run_id=$1",[id]);
    } else {
      if(run.docstatus==='cancelled') fail('Payroll is already cancelled.');
      const payments=await client.query("SELECT 1 FROM app_hr_payments p JOIN app_hr_slips s ON s.id=p.slip_id WHERE s.run_id=$1 AND p.docstatus='submitted' LIMIT 1",[id]);
      if(payments.rowCount) fail('Cancel payroll payments first.');
      if(run.docstatus==='submitted') {
        const when=date(payload.posting_date); if(when<run.posting_date) fail('Cancellation cannot precede payroll posting.');
        await reverseVoucherGlEntries(client,'hr_payroll',id,when);
      }
      await client.query("UPDATE app_hr_runs SET docstatus='cancelled',cancellation_reason=$2 WHERE id=$1",[id,text(payload.reason,true)]);
      await client.query("UPDATE app_hr_slips SET docstatus='cancelled' WHERE run_id=$1",[id]);
    }
  });
}
async function payPayroll(id,payload,user) {
  return withPostgresTransaction(async client=>{
    const {run,slips}=await lockedRun(client,id,user);
    if(run.docstatus!=='submitted') fail('Post payroll before recording payments.');
    const s=slips.find(s=>String(s.id)===String(payload.slip_id)); if(!s) fail('Choose a payslip in this payroll.');
    const value=amount(payload.amount,'Payment',false);const when=date(payload.posting_date);
    if(when<run.posting_date) fail('Payment cannot precede payroll posting.');
    if(cents(value)>cents(s.net_pay)-cents(s.paid_amount)) fail('Payment exceeds salary outstanding.');
    const bank=await account(client,payload.bank_account_id,user,['asset'],true);
    await account(client,run.payable_account_id,user,['liability']);
    const p=(await client.query(`INSERT INTO app_hr_payments(slip_id,posting_date,amount,direction,bank_account_id,reference) VALUES($1,$2,$3,'payout',$4,$5) RETURNING id`,[s.id,when,value,bank.id,text(payload.reference,true)])).rows[0];
    await postGlEntry(client,{posting_date:when,voucher_type:'hr_payment',voucher_id:p.id,voucher_no:`HRP-${p.id}`,party_type:'employee',party_id:s.employee_id,party_name:s.employee_name,cost_center:s.cost_center,
      lines:[{account_id:run.payable_account_id,debit:value,credit:0},{account_id:bank.id,debit:0,credit:value}]});
    return p.id;
  });
}
async function moneyRegisterPayments(records,user) {
  const result={};for(const r of records)result[r.id]=[];
  if(!records.length)return result;
  const rows=(await getPostgresPool().query(`SELECT p.*,p.posting_date::text,a.account_name FROM app_hr_payments p
    JOIN app_accounts a ON a.id=p.bank_account_id WHERE money_id=ANY($1::bigint[]) ORDER BY p.id`,[records.map(r=>r.id)])).rows;
  for(const p of rows)if(accountAllowed(user,String(p.bank_account_id)))result[p.money_id].push(p);
  return result;
}
async function moneyPayments(id,user) {
  return withPostgresTransaction(async client=>{
    await lockedMoney(client,id,user);
    return (await client.query('SELECT p.*,p.posting_date::text,a.account_name FROM app_hr_payments p JOIN app_accounts a ON a.id=p.bank_account_id WHERE money_id=$1 ORDER BY p.id',[id])).rows.filter(p=>accountAllowed(user,String(p.bank_account_id)));
  });
}
async function cancelPayment(ownerKind,ownerId,paymentId,payload,user) {
  return withPostgresTransaction(async client=>{
    const run=ownerKind==='payroll'?await lockedRun(client,ownerId,user):null;
    const m=ownerKind==='money'?await lockedMoney(client,ownerId,user):null;
    const p=(await client.query('SELECT *,posting_date::text FROM app_hr_payments WHERE id=$1 FOR UPDATE',[key(paymentId)])).rows[0];
    if(!p || ownerKind==='money' && String(p.money_id)!==String(m.id)||ownerKind==='payroll' && !run.slips.some(s=>String(s.id)===String(p.slip_id))) fail('Payment not found.',404);
    assertAccount(user,p.bank_account_id);
    if(p.docstatus!=='submitted') fail('Payment is already cancelled.');
    const when=date(payload.posting_date); if(when<p.posting_date) fail('Cancellation cannot precede payment.');
    if(m && p.direction==='payout' && ['advance','loan'].includes(m.kind) && cents(p.amount)>cents(m.balance)) fail('This disbursement has been recovered. Reverse returns or payroll recoveries first.');
    if(m && p.direction==='payout' && ['advance','loan'].includes(m.kind)) {
      const allocations=(await client.query(`SELECT s.run_id,run.posting_date::text,sum(r.amount) AS recovered FROM app_hr_recoveries r
        JOIN app_hr_slips s ON s.id=r.slip_id JOIN app_hr_runs run ON run.id=s.run_id
        WHERE r.money_id=$1 AND s.docstatus='submitted' GROUP BY s.run_id,run.posting_date ORDER BY run.posting_date`,[m.id])).rows;
      let recovered=0;
      for(const allocation of allocations) {
        recovered+=cents(allocation.recovered);
        const funded=(await client.query(`SELECT COALESCE(sum(CASE WHEN direction='payout' THEN amount ELSE -amount END),0) AS amount
          FROM app_hr_payments WHERE money_id=$1 AND id<>$2 AND docstatus='submitted' AND posting_date<=$3`,[m.id,p.id,allocation.posting_date])).rows[0];
        if(cents(funded.amount)<recovered) fail('This disbursement funded earlier payroll recoveries. Cancel those recoveries first.');
      }
    }
    await reverseVoucherGlEntries(client,'hr_payment',p.id,when);
    await client.query("UPDATE app_hr_payments SET docstatus='cancelled' WHERE id=$1",[p.id]);
  });
}

module.exports={settings,options,saveSettings,employeeProfile,saveProfile,savePayPlan,attendanceList,attendanceBatch,attendanceAction,
  leaveDays,leaveList,allocateLeave,createLeave,leaveAction,moneyList,createMoney,moneyAction,payMoney,moneyPayments,moneyRegisterPayments,
  payrollList,createPayroll,payrollDetails,payslipList,payslipDetails,updateSlip,payrollAction,payPayroll,cancelPayment};
