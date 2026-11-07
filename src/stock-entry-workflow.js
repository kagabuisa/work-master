'use strict';

const { getPostgresPool, withPostgresTransaction } = require('./core');
const { currentPostingDate } = require('./posting-time');
const { isValidIsoDate } = require('./lib/dates');
const DELIVERY_STATUSES = ['Picked & packed', 'In Transit', 'Delivered', 'All Received', 'Received + DDR'];
const DELIVERY_DETAIL_FIELDS = ['picked_employee_id', 'picked_employee_name', 'picked_date',
  'in_transit_date', 'transporter_name', 'transporter_phone', 'delivered_date', 'received_date',
  'received_by_employee_id', 'received_by_employee_name'];

async function initStockEntryWorkflow(client) {
  // Keep operational delivery metadata separate from inventory documents, whose
  // financial fields are immutable after a warehouse period is closed.
  await client.query(`CREATE TABLE IF NOT EXISTS app_stock_entry_delivery (
      stock_entry_id BIGINT PRIMARY KEY REFERENCES app_stock_entries(id) ON DELETE CASCADE,
      delivery_status TEXT NOT NULL CHECK (delivery_status IN ('', 'Picked & packed', 'In Transit', 'Delivered', 'All Received')),
      updated_by_user_id BIGINT NOT NULL REFERENCES app_users(id),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS app_stock_entry_shares (
      stock_entry_id BIGINT NOT NULL REFERENCES app_stock_entries(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      granted_by_user_id BIGINT NOT NULL REFERENCES app_users(id),
      granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (stock_entry_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS app_stock_entry_shares_user_idx ON app_stock_entry_shares(user_id, stock_entry_id)`);
  const database = (await client.query('SELECT current_database() AS name')).rows[0].name;
  const runtimeRole = 'wm_inventory_runtime_' + require('node:crypto').createHash('sha256').update(database).digest('hex').slice(0, 12);
  if ((await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [runtimeRole])).rowCount) {
    await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON app_stock_entry_delivery,app_stock_entry_shares TO ${runtimeRole}`);
  }
}

function canManageStockEntry(user, entry) {
  return user?.role === 'admin' || Boolean(user?.id && entry.created_by_user_id
    && String(user.id) === String(entry.created_by_user_id));
}

async function initStockEntrySharePermissions(client) {
  await client.query(`ALTER TABLE app_stock_entry_shares ADD COLUMN IF NOT EXISTS permission TEXT NOT NULL DEFAULT 'read'
    CHECK (permission IN ('read', 'write'))`);
}

function workflowError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

async function stockEntryShareAccess(user, id, pool = getPostgresPool()) {
  if (!user?.id || !Number.isSafeInteger(Number(id)) || Number(id) < 1) return null;
  const { rows } = await pool.query(`SELECT share.permission FROM app_stock_entry_shares share
    JOIN app_stock_entries entry ON entry.id=share.stock_entry_id
    WHERE share.stock_entry_id=$1 AND share.user_id=$2 AND entry.entry_type <> 'reconciliation'`, [id, user.id]);
  return rows[0]?.permission || null;
}

async function sharedStockEntry(user, id, pool) {
  return Boolean(await stockEntryShareAccess(user, id, pool));
}

async function requireSharedStockEntryWrite(client, user, id) {
  const stockShare = await client.query(`SELECT 1 FROM app_stock_entry_shares
    WHERE stock_entry_id=$1 AND user_id=$2 AND permission='write' FOR SHARE`,
  [id, user?.id || null]);
  if (stockShare.rowCount) return;
  const voucherShare = await client.query(`SELECT 1 FROM app_voucher_shares
    WHERE voucher_type='stock-reconciliations' AND voucher_id=$1
      AND user_id=$2 AND permission='write' FOR SHARE`,
  [id, user?.id || null]);
  if (!voucherShare.rowCount) throw workflowError('Read & write sharing permission is required.', 403);
}

async function validateSharedStockEntryEdit(client, user, entry, payload) {
  await requireSharedStockEntryWrite(client, user, entry.id);
  const changesDocumentType = payload.entry_type !== entry.entry_type
    || payload.entry_type === 'cancel';
  if (payload.action !== 'save_draft' || changesDocumentType) {
    throw workflowError('Shared write access allows saving drafts and updating delivery status, not posting or cancellation.', 403);
  }
  const { warehouseAllowed, assignedMasterRecordAllowed } = require('./access');
  const { rows } = await client.query('SELECT warehouse,target_warehouse FROM app_stock_entry_items WHERE stock_entry_id=$1', [entry.id]);
  const originalWarehouses = new Set(rows.flatMap(row => [row.warehouse, row.target_warehouse]).filter(Boolean));
  for (const item of payload.items || []) {
    for (const warehouse of [item.warehouse, item.target_warehouse].filter(Boolean)) {
      if (!originalWarehouses.has(warehouse) && !warehouseAllowed(user, warehouse)) {
        throw workflowError('New warehouses must be within your permitted warehouse list.', 403);
      }
    }
  }
  if (payload.cost_center && payload.cost_center !== entry.cost_center
      && !assignedMasterRecordAllowed(user, 'cost-centers', payload.cost_center)) {
    throw workflowError('The new cost center is outside your permitted list.', 403);
  }
}

async function stockEntrySharing(user, entry) {
  if (!canManageStockEntry(user, entry)) return null;
  const [shares, users] = await Promise.all([
    getPostgresPool().query(`SELECT share.user_id, share.permission, account.username, account.active, share.granted_at
      FROM app_stock_entry_shares share JOIN app_users account ON account.id=share.user_id
      WHERE share.stock_entry_id=$1 ORDER BY account.username`, [entry.id]),
    getPostgresPool().query(`SELECT id, username FROM app_users WHERE active AND NOT api_service_account
      AND role <> 'admin' AND id::text <> COALESCE($1::text, '') ORDER BY username`, [entry.created_by_user_id]),
  ]);
  return { shares: shares.rows, users: users.rows };
}

function cleanDeliveryText(value, maximum = 140) {
  return String(value || '').trim().slice(0, maximum);
}

async function activeDeliveryEmployee(client, employeeId, user) {
  const id = cleanDeliveryText(employeeId, 100);
  if (!id) throw workflowError('Choose the employee responsible for this delivery step.');
  const { rows } = await client.query(`SELECT employee_id, employee_name FROM app_master_employees
    WHERE employee_id=$1 AND NOT disabled AND COALESCE(status, 'Active')='Active'
      AND docstatus='submitted'`, [id]);
  const { assignedMasterRecordAllowed } = require('./access');
  if (!rows[0] || !assignedMasterRecordAllowed(user, 'employees', id)) throw workflowError('Choose an active employee.');
  return rows[0];
}

function validDeliveryDate(value, message) {
  if (!isValidIsoDate(value)) throw workflowError(message);
  if (value > currentPostingDate()) throw workflowError('Delivery dates cannot be in the future.');
  return value;
}

async function normalizeDeliveryDetails(client, user, status, submitted = {}, existing = {}) {
  const details = {
    ...Object.fromEntries(DELIVERY_DETAIL_FIELDS.map(field => [field, cleanDeliveryText(existing?.[field])])),
    received_confirmed: Boolean(existing?.received_confirmed),
  };
  for (const field of DELIVERY_DETAIL_FIELDS) {
    if (submitted?.[field] !== undefined) details[field] = cleanDeliveryText(submitted[field]);
  }
  if (submitted?.received_confirmed !== undefined) {
    details.received_confirmed = ['1', 'on', 'true'].includes(String(submitted.received_confirmed).toLowerCase());
  }
  if (status === 'Picked & packed') {
    const employee = await activeDeliveryEmployee(client, details.picked_employee_id, user);
    details.picked_employee_id = employee.employee_id;
    details.picked_employee_name = employee.employee_name;
    details.picked_date = validDeliveryDate(details.picked_date, 'Enter the date picked and packed.');
  } else if (status === 'In Transit') {
    details.in_transit_date = currentPostingDate();
  } else if (status === 'Delivered') {
    details.transporter_name = cleanDeliveryText(details.transporter_name, 140);
    details.transporter_phone = cleanDeliveryText(details.transporter_phone, 40);
    if (!details.transporter_name) throw workflowError('Enter the transporter name.');
    if (!details.transporter_phone) throw workflowError('Enter the transporter phone number.');
    details.delivered_date = validDeliveryDate(details.delivered_date, 'Enter the delivery date.');
  } else if (['All Received', 'Received + DDR'].includes(status)) {
    details.received_date = validDeliveryDate(details.received_date, 'Enter the date the stock was received.');
    const employee = await activeDeliveryEmployee(client, details.received_by_employee_id, user);
    details.received_by_employee_id = employee.employee_id;
    details.received_by_employee_name = employee.employee_name;
    details.received_confirmed = true;
  }
  return details;
}

async function saveStockEntryDelivery(client, user, entry, value, submittedDetails = {}) {
  if (entry.entry_type === 'reconciliation') throw workflowError('Stock reconciliations do not have a delivery status.');
  if (!canManageStockEntry(user, entry)) await requireSharedStockEntryWrite(client, user, entry.id);
  if (entry.docstatus === 'cancelled') throw workflowError('Cancelled stock entries cannot change delivery status.');
  if (!DELIVERY_STATUSES.includes(value) && value !== '') throw workflowError('Choose a valid delivery status.');
  const current = (await client.query(`SELECT delivery_details FROM app_stock_entry_delivery
    WHERE stock_entry_id=$1 FOR UPDATE`, [entry.id])).rows[0]?.delivery_details || {};
  const details = await normalizeDeliveryDetails(client, user, value, submittedDetails, current);
  await client.query(`INSERT INTO app_stock_entry_delivery(
      stock_entry_id,delivery_status,delivery_details,updated_by_user_id)
    VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT (stock_entry_id) DO UPDATE
    SET delivery_status=EXCLUDED.delivery_status, delivery_details=EXCLUDED.delivery_details,
      updated_by_user_id=EXCLUDED.updated_by_user_id, updated_at=now()`,
  [entry.id, value, JSON.stringify(details), user.id]);
}

async function changeStockEntryWorkflow(user, id, action, value, permission = 'read', deliveryDetails = {}) {
  id = Number(id);
  if (!Number.isSafeInteger(id) || id < 1) throw workflowError('Stock entry not found.', 404);
  return withPostgresTransaction(async client => {
    const entry = (await client.query('SELECT * FROM app_stock_entries WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!entry || entry.entry_type === 'reconciliation') throw workflowError('Stock entry not found.', 404);
    if (action === 'delivery') {
      await saveStockEntryDelivery(client, user, entry, value, deliveryDetails);
      return;
    }
    if (!canManageStockEntry(user, entry)) throw workflowError('Only the stock entry owner or an admin can manage sharing.', 403);
    if (!['share', 'revoke'].includes(action)) throw workflowError('Unknown sharing action.');
    value = Number(value);
    if (!Number.isSafeInteger(value) || value < 1) throw workflowError('Choose a user.');
    if (action === 'revoke') {
      await client.query('DELETE FROM app_stock_entry_shares WHERE stock_entry_id=$1 AND user_id=$2', [id, value]);
      return;
    }
    if (!['read', 'write'].includes(permission)) throw workflowError('Choose Read-only or Read & write.');
    const recipient = (await client.query(`SELECT id FROM app_users WHERE id=$1 AND active
      AND NOT api_service_account AND role <> 'admin' FOR SHARE`, [value])).rows[0];
    if (!recipient || String(value) === String(entry.created_by_user_id)) throw workflowError('Choose another active user.');
    await client.query(`INSERT INTO app_stock_entry_shares(stock_entry_id,user_id,granted_by_user_id,permission)
      VALUES ($1,$2,$3,$4) ON CONFLICT (stock_entry_id,user_id) DO UPDATE
      SET permission=EXCLUDED.permission, granted_by_user_id=EXCLUDED.granted_by_user_id, granted_at=now()
      WHERE app_stock_entry_shares.permission <> EXCLUDED.permission`, [id, value, user.id, permission]);
  });
}

module.exports = { DELIVERY_STATUSES, initStockEntryWorkflow, canManageStockEntry,
  sharedStockEntry, stockEntryShareAccess, stockEntrySharing, changeStockEntryWorkflow, saveStockEntryDelivery,
  initStockEntrySharePermissions, validateSharedStockEntryEdit };
