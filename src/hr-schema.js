'use strict';

const HR_TABLES = ['app_hr_profiles', 'app_hr_pay_plans', 'app_hr_settings', 'app_hr_attendance',
  'app_hr_leave_types', 'app_hr_holidays', 'app_hr_leave_allocations', 'app_hr_leave_requests',
  'app_hr_money', 'app_hr_runs', 'app_hr_slips', 'app_hr_payments', 'app_hr_recoveries'];

async function initHrSchema(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS app_hr_profiles (
    employee_id TEXT PRIMARY KEY REFERENCES app_master_employees(employee_id),
    joining_date DATE, leaving_date DATE, manager_id TEXT REFERENCES app_master_employees(employee_id),
    cost_center TEXT REFERENCES app_master_cost_centers(cost_center), branch TEXT, employment_type TEXT,
    CHECK (leaving_date IS NULL OR joining_date IS NULL OR leaving_date >= joining_date),
    CHECK (manager_id IS NULL OR manager_id <> employee_id)
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS app_hr_pay_plans (
    id BIGSERIAL PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES app_master_employees(employee_id),
    effective_from DATE NOT NULL, components JSONB NOT NULL, notes TEXT,
    UNIQUE(employee_id, effective_from)
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS app_hr_settings (
    id INTEGER PRIMARY KEY CHECK (id=1), salary_payable_account_id BIGINT REFERENCES app_accounts(id),
    working_weekdays JSONB NOT NULL DEFAULT '[0,1,2,3,4,5,6]'::jsonb
  )`);
  await client.query(`INSERT INTO app_hr_settings (id) VALUES (1) ON CONFLICT DO NOTHING`);
  await client.query(`CREATE TABLE IF NOT EXISTS app_hr_attendance (
    id BIGSERIAL PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES app_master_employees(employee_id),
    attendance_date DATE NOT NULL, status TEXT NOT NULL CHECK (status IN ('present','absent','half_day')),
    notes TEXT, docstatus TEXT NOT NULL DEFAULT 'draft' CHECK (docstatus IN ('draft','submitted','cancelled'))
  )`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS app_hr_attendance_day_idx
    ON app_hr_attendance(employee_id, attendance_date) WHERE docstatus <> 'cancelled'`);
  await client.query(`CREATE TABLE IF NOT EXISTS app_hr_leave_types (
    id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, is_paid BOOLEAN NOT NULL DEFAULT true
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS app_hr_holidays (
    holiday_date DATE PRIMARY KEY, description TEXT NOT NULL
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS app_hr_leave_allocations (
    id BIGSERIAL PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES app_master_employees(employee_id),
    leave_type_id BIGINT NOT NULL REFERENCES app_hr_leave_types(id), year INTEGER NOT NULL CHECK(year BETWEEN 1900 AND 2200),
    days NUMERIC(8,2) NOT NULL CHECK(days > 0), notes TEXT,
    UNIQUE(employee_id,leave_type_id,year)
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS app_hr_leave_requests (
    id BIGSERIAL PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES app_master_employees(employee_id),
    leave_type_id BIGINT NOT NULL REFERENCES app_hr_leave_types(id), from_date DATE NOT NULL, to_date DATE NOT NULL,
    days NUMERIC(8,2) NOT NULL CHECK(days > 0), half_day BOOLEAN NOT NULL DEFAULT false,
    reason TEXT NOT NULL, docstatus TEXT NOT NULL DEFAULT 'draft' CHECK(docstatus IN ('draft','submitted','cancelled')),
    CHECK(to_date >= from_date), CHECK(EXTRACT(YEAR FROM from_date)=EXTRACT(YEAR FROM to_date))
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS app_hr_money (
    id BIGSERIAL PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES app_master_employees(employee_id),
    kind TEXT NOT NULL CHECK(kind IN ('advance','loan','recovery','reimbursement')),
    posting_date DATE NOT NULL, amount NUMERIC(14,2) NOT NULL CHECK(amount > 0),
    account_id BIGINT NOT NULL REFERENCES app_accounts(id), offset_account_id BIGINT REFERENCES app_accounts(id),
    cost_center TEXT REFERENCES app_master_cost_centers(cost_center), reason TEXT NOT NULL,
    docstatus TEXT NOT NULL DEFAULT 'draft' CHECK(docstatus IN ('draft','submitted','cancelled'))
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS app_hr_runs (
    id BIGSERIAL PRIMARY KEY, company TEXT NOT NULL, period TEXT NOT NULL CHECK(period ~ '^\\d{4}-\\d{2}$'),
    posting_date DATE NOT NULL, payable_account_id BIGINT NOT NULL REFERENCES app_accounts(id),
    docstatus TEXT NOT NULL DEFAULT 'draft' CHECK(docstatus IN ('draft','submitted','cancelled')),
    review_version INTEGER NOT NULL DEFAULT 0, submitted_by_id TEXT, submitted_at TIMESTAMPTZ, cancellation_reason TEXT
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS app_hr_slips (
    id BIGSERIAL PRIMARY KEY, run_id BIGINT NOT NULL REFERENCES app_hr_runs(id),
    employee_id TEXT NOT NULL REFERENCES app_master_employees(employee_id), employee_name TEXT NOT NULL,
    period TEXT NOT NULL, cost_center TEXT REFERENCES app_master_cost_centers(cost_center),
    plan_id BIGINT NOT NULL REFERENCES app_hr_pay_plans(id), components JSONB NOT NULL,
    calendar_days NUMERIC(6,2) NOT NULL, paid_days NUMERIC(6,2) NOT NULL,
    input_note TEXT, gross_pay NUMERIC(14,2) NOT NULL, deductions NUMERIC(14,2) NOT NULL,
    net_pay NUMERIC(14,2) NOT NULL CHECK(net_pay >= 0), employer_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
    docstatus TEXT NOT NULL DEFAULT 'draft' CHECK(docstatus IN ('draft','submitted','cancelled')),
    UNIQUE(run_id,employee_id)
  )`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS app_hr_employee_period_idx
    ON app_hr_slips(employee_id,period) WHERE docstatus <> 'cancelled'`);
  await client.query(`CREATE TABLE IF NOT EXISTS app_hr_payments (
    id BIGSERIAL PRIMARY KEY, slip_id BIGINT REFERENCES app_hr_slips(id), money_id BIGINT REFERENCES app_hr_money(id),
    posting_date DATE NOT NULL, amount NUMERIC(14,2) NOT NULL CHECK(amount > 0),
    direction TEXT NOT NULL CHECK(direction IN ('payout','return')),
    bank_account_id BIGINT NOT NULL REFERENCES app_accounts(id), reference TEXT NOT NULL,
    docstatus TEXT NOT NULL DEFAULT 'submitted' CHECK(docstatus IN ('submitted','cancelled')),
    CHECK ((slip_id IS NULL) <> (money_id IS NULL)), CHECK(slip_id IS NULL OR direction='payout')
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS app_hr_recoveries (
    id BIGSERIAL PRIMARY KEY, slip_id BIGINT NOT NULL REFERENCES app_hr_slips(id),
    money_id BIGINT NOT NULL REFERENCES app_hr_money(id), amount NUMERIC(14,2) NOT NULL CHECK(amount > 0),
    UNIQUE(slip_id,money_id)
  )`);
  for (const table of ['app_hr_payments','app_hr_recoveries']) {
    await client.query(`CREATE INDEX IF NOT EXISTS ${table}_money_idx ON ${table}(money_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ${table}_slip_idx ON ${table}(slip_id)`);
  }
}

module.exports = { initHrSchema, HR_TABLES };
