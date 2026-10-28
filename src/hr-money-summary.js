'use strict';

const { can } = require('./authorize');
const { accountAllowed, assignedMasterRecordAllowed } = require('./access');
const { cents, employeeAllowed } = require('./hr-policy');

function withoutMoneySnapshot(slip) {
  const { employee_money_snapshot, ...visible } = slip;
  return visible;
}

// Use original ledger entries and dated reversals, including transactions that
// have since been cancelled. Current register balances cannot describe an older date.
async function buildMoneySnapshot(client, slip, run) {
  const { rows } = await client.query(`SELECT m.id AS money_id,m.employee_id,m.kind,m.reason,
      m.account_id,m.offset_account_id,m.cost_center,
      GREATEST(0,(CASE WHEN m.kind='reimbursement' THEN -1 ELSE 1 END) *
        (COALESCE(obligation.balance,0)+COALESCE(payment.balance,0))-COALESCE(prior.recovered,0)) AS balance_before,
      COALESCE(current_recovery.amount,0) AS recovered
    FROM app_hr_money m
    LEFT JOIN LATERAL (
      SELECT sum(g.debit-g.credit) AS balance FROM app_gl_entries g
      WHERE g.voucher_type IN ('hr_money','hr_money_cancellation') AND g.voucher_id=m.id
        AND g.account_id=m.account_id AND g.posting_date<=$2
    ) obligation ON true
    LEFT JOIN LATERAL (
      SELECT sum(g.debit-g.credit) AS balance FROM app_hr_payments p
      JOIN app_gl_entries g ON g.voucher_id=p.id AND g.voucher_type IN ('hr_payment','hr_payment_cancellation')
      WHERE p.money_id=m.id AND g.account_id=m.account_id AND g.posting_date<=$2
    ) payment ON true
    LEFT JOIN LATERAL (
      SELECT sum(r.amount) AS recovered FROM app_hr_recoveries r
      JOIN app_hr_slips s ON s.id=r.slip_id
      WHERE r.money_id=m.id AND s.id<>$3
        AND EXISTS(SELECT 1 FROM app_gl_entries g WHERE g.voucher_type='hr_payroll'
          AND g.voucher_id=s.run_id AND g.posting_date<=$2)
        AND NOT EXISTS(SELECT 1 FROM app_gl_entries g WHERE g.voucher_type='hr_payroll_cancellation'
          AND g.voucher_id=s.run_id AND g.posting_date<=$2)
    ) prior ON true
    LEFT JOIN app_hr_recoveries current_recovery ON current_recovery.money_id=m.id AND current_recovery.slip_id=$3
    WHERE m.employee_id=$1 AND m.posting_date<=$2 ORDER BY m.id`, [slip.employee_id, run.posting_date, slip.id]);
  return { version: 1, as_of_date: run.posting_date, rows: rows.map(row => ({ ...row,
    balance_before: cents(row.balance_before)/100, recovered: cents(row.recovered)/100,
    balance_remaining: (cents(row.balance_before)-cents(row.recovered))/100,
  })).filter(row => row.balance_before !== 0 || row.recovered !== 0) };
}

function moneyScopeAllowed(user, row) {
  return employeeAllowed(user,row.employee_id,row.cost_center)
    && accountAllowed(user,String(row.account_id))
    && (!row.offset_account_id || accountAllowed(user,String(row.offset_account_id)))
    && (!row.cost_center || assignedMasterRecordAllowed(user,'cost-centers',row.cost_center));
}

async function payslipMoneySummary(client, slip, run, user, snapshot) {
  if (!can(user,'hr.money.view')) return null;
  const provisional = run.docstatus === 'draft';
  if (provisional) snapshot = await buildMoneySnapshot(client,slip,run);
  if (!snapshot) return { status: 'unavailable' };
  const { rows: current } = await client.query(`SELECT id,employee_id,account_id,offset_account_id,cost_center
    FROM app_hr_money WHERE id=ANY($1::bigint[])`, [snapshot.rows.map(row=>row.money_id)]);
  const byId=new Map(current.map(row=>[String(row.id),row]));
  // Enforce both the captured scopes and the current transaction scopes.
  const permitted=snapshot.rows.filter(row=>{
    const now=byId.get(String(row.money_id));
    return now && now.employee_id===slip.employee_id && row.employee_id===slip.employee_id
      && moneyScopeAllowed(user,row) && moneyScopeAllowed(user,now);
  });
  const debts=permitted.filter(row=>row.kind!=='reimbursement');
  const reimbursements=permitted.filter(row=>row.kind==='reimbursement');
  const total=field=>debts.reduce((sum,row)=>sum+cents(row[field]),0)/100;
  return { status: provisional?'provisional':run.docstatus==='cancelled'?'cancelled':'frozen',
    as_of_date:snapshot.as_of_date,debts,reimbursements,
    totals:{balance_before:total('balance_before'),recovered:total('recovered'),balance_remaining:total('balance_remaining')},
    reimbursement_total:reimbursements.reduce((sum,row)=>sum+cents(row.balance_remaining),0)/100,
    invalid_recovery:debts.some(row=>row.balance_remaining<0),
  };
}

module.exports = { buildMoneySnapshot, payslipMoneySummary, withoutMoneySnapshot };
