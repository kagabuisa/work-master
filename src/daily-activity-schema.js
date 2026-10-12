'use strict';

async function initDailyActivitySchema(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS app_daily_activity_reports (
    id BIGSERIAL PRIMARY KEY,
    name TEXT GENERATED ALWAYS AS ('DAR-' || lpad(id::text, greatest(6, length(id::text)), '0')) STORED UNIQUE,
    date DATE NOT NULL,
    shop TEXT NOT NULL REFERENCES app_master_cost_centers(cost_center) ON UPDATE CASCADE,
    warehouse TEXT NOT NULL REFERENCES app_master_warehouses(warehouse) ON UPDATE CASCADE,
    unit_type TEXT NOT NULL CHECK (unit_type IN ('Shop', 'Field Sales(FiSa)')),
    leads NUMERIC(16,3) NOT NULL DEFAULT 0 CHECK (leads >= 0),
    sales NUMERIC(14,2) NOT NULL CHECK (sales >= 0),
    expense NUMERIC(14,2) NOT NULL CHECK (expense >= 0),
    banked NUMERIC(14,2) GENERATED ALWAYS AS (sales - expense) STORED,
    expense_details TEXT NOT NULL CHECK (length(trim(expense_details)) > 0),
    stock_entry_number TEXT,
    packages_received BIGINT NOT NULL CHECK (packages_received >= 0),
    delivery_differences TEXT NOT NULL CHECK (delivery_differences IN ('No', 'Yes - Fill out a Delivery Difference Report - DDR')),
    item_differences TEXT,
    remarks TEXT,
    comments_or_remarks TEXT,
    docstatus INTEGER NOT NULL DEFAULT 0 CHECK (docstatus IN (0,1,2)),
    created_by TEXT, created_by_user_id TEXT, created_at TIMESTAMPTZ,
    updated_by TEXT, updated_by_user_id TEXT, updated_at TIMESTAMPTZ
  )`);
  await client.query('CREATE INDEX IF NOT EXISTS app_daily_activity_date_idx ON app_daily_activity_reports(date DESC, id DESC)');
}
module.exports = { initDailyActivitySchema };
