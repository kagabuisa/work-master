'use strict';

const { getPostgresPool, withPostgresTransaction } = require('./core');
const DELIVERY_STATUSES = ['Picked & packed', 'In Transit', 'Delivered', 'All Received'];

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
  const { rows } = await client.query(`SELECT 1 FROM app_stock_entry_shares
    WHERE stock_entry_id=$1 AND user_id=$2 AND permission='write' FOR SHARE`, [id, user?.id || null]);
  if (!rows.length) throw workflowError('Read & write sharing permission is required.', 403);
}

async function validateSharedStockEntryEdit(client, user, entry, payload) {
  await requireSharedStockEntryWrite(client, user, entry.id);
  if (payload.action !== 'save_draft' || ['reconciliation', 'cancel'].includes(payload.entry_type)) {
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

async function saveStockEntryDelivery(client, user, entry, value) {
  if (entry.entry_type === 'reconciliation') throw workflowError('Stock reconciliations do not have a delivery status.');
  if (!canManageStockEntry(user, entry)) await requireSharedStockEntryWrite(client, user, entry.id);
  if (entry.docstatus === 'cancelled') throw workflowError('Cancelled stock entries cannot change delivery status.');
  if (!DELIVERY_STATUSES.includes(value) && value !== '') throw workflowError('Choose a valid delivery status.');
  await client.query(`INSERT INTO app_stock_entry_delivery(stock_entry_id,delivery_status,updated_by_user_id)
    VALUES ($1,$2,$3) ON CONFLICT (stock_entry_id) DO UPDATE
    SET delivery_status=EXCLUDED.delivery_status, updated_by_user_id=EXCLUDED.updated_by_user_id, updated_at=now()`, [entry.id, value, user.id]);
}

async function changeStockEntryWorkflow(user, id, action, value, permission = 'read') {
  id = Number(id);
  if (!Number.isSafeInteger(id) || id < 1) throw workflowError('Stock entry not found.', 404);
  return withPostgresTransaction(async client => {
    const entry = (await client.query('SELECT * FROM app_stock_entries WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!entry || entry.entry_type === 'reconciliation') throw workflowError('Stock entry not found.', 404);
    if (action === 'delivery') {
      await saveStockEntryDelivery(client, user, entry, value);
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
