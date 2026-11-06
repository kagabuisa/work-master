'use strict';

const { getPostgresPool, withPostgresTransaction } = require('./core');
const { paginationOptions, paginationResult } = require('./lib/pagination');

const SHARE_TYPES = Object.freeze({
  sales: {
    key: 'sales', label: 'Sales Invoice', plural: 'Sales invoices',
    table: 'app_invoices', numberColumn: 'invoice_no', dateColumn: 'invoice_date',
    partyColumn: 'customer_id', amountColumn: 'total', path: '/invoices',
  },
  purchases: {
    key: 'purchases', label: 'Purchase Invoice', plural: 'Purchase invoices',
    table: 'app_purchases', numberColumn: 'purchase_no', dateColumn: 'posting_date',
    partyColumn: 'supplier_id', amountColumn: 'total', path: '/purchases',
  },
  'purchase-orders': {
    key: 'purchase-orders', label: 'Purchase Order', plural: 'Purchase orders',
    table: 'app_purchase_orders', numberColumn: 'order_no', dateColumn: 'posting_date',
    partyColumn: 'supplier_id', amountColumn: 'total', path: '/purchase-orders',
  },
  journals: {
    key: 'journals', label: 'Journal Entry', plural: 'Journal entries',
    table: 'app_journal_entries', numberColumn: 'journal_no', dateColumn: 'posting_date',
    partyColumn: 'party_id', amountColumn: 'total_debit', path: '/journals',
  },
  'stock-reconciliations': {
    key: 'stock-reconciliations', label: 'Stock Reconciliation', plural: 'Stock reconciliations',
    table: 'app_stock_entries', numberColumn: 'entry_no', dateColumn: 'posting_date',
    partyColumn: '', amountColumn: '', path: '/stock/reconciliations',
    typeWhere: "entry_type='reconciliation'",
  },
});

function sharingError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function shareType(value) {
  const type = SHARE_TYPES[String(value || '')];
  if (!type) throw sharingError('Voucher type not found.', 404);
  return type;
}

function endPoint(type, id) {
  return `${shareType(type).path}/${Number(id)}/share`;
}

async function initVoucherSharing(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS app_voucher_shares (
    voucher_type TEXT NOT NULL CHECK (voucher_type IN (
      'sales', 'purchases', 'purchase-orders', 'journals', 'stock-reconciliations'
    )),
    voucher_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    granted_by_user_id BIGINT NOT NULL REFERENCES app_users(id),
    permission TEXT NOT NULL DEFAULT 'read' CHECK (permission IN ('read', 'write')),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (voucher_type, voucher_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS app_voucher_shares_user_idx
    ON app_voucher_shares(user_id, voucher_type, voucher_id);
  CREATE INDEX IF NOT EXISTS app_voucher_shares_voucher_idx
    ON app_voucher_shares(voucher_type, voucher_id)`);
  const database = (await client.query('SELECT current_database() AS name')).rows[0].name;
  const runtimeRole = 'wm_inventory_runtime_'
    + require('node:crypto').createHash('sha256').update(database).digest('hex').slice(0, 12);
  if ((await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [runtimeRole])).rowCount) {
    await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON app_voucher_shares TO ${runtimeRole}`);
  }
}

async function loadShareRecord(queryable, typeValue, idValue, { forUpdate = false } = {}) {
  const type = shareType(typeValue);
  const id = Number(idValue);
  if (!Number.isSafeInteger(id) || id < 1) throw sharingError(`${type.label} not found.`, 404);
  const conditions = [`id=$1`];
  if (type.typeWhere) conditions.push(type.typeWhere);
  const { rows } = await queryable.query(`SELECT id, ${type.numberColumn} AS number,
    COALESCE(docstatus, 'submitted') AS docstatus, created_by_user_id AS owner_id,
    ${type.dateColumn}::text AS posting_date
    FROM ${type.table} WHERE ${conditions.join(' AND ')}
    ${forUpdate ? 'FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) throw sharingError(`${type.label} not found.`, 404);
  return { ...rows[0], id: Number(rows[0].id), type: type.key, label: type.label };
}

async function voucherShareAccess(user, type, id, pool = getPostgresPool()) {
  if (!user?.id || !Number.isSafeInteger(Number(id)) || Number(id) < 1 || !SHARE_TYPES[type]) return null;
  const { rows } = await pool.query(`SELECT permission FROM app_voucher_shares
    WHERE voucher_type=$1 AND voucher_id=$2 AND user_id=$3`, [type, Number(id), user.id]);
  return rows[0]?.permission || null;
}

async function assertVoucherShareWrite(client, user, type, id) {
  if (!user?.id) throw sharingError('Read & write sharing permission is required.', 403);
  const { rowCount } = await client.query(`SELECT 1 FROM app_voucher_shares
    WHERE voucher_type=$1 AND voucher_id=$2 AND user_id=$3 AND permission='write' FOR SHARE`,
  [type, Number(id), user.id]);
  if (!rowCount) throw sharingError('Read & write sharing permission is required.', 403);
}

function canManageVoucherShare(user, record) {
  const ownerId = record?.owner_id || record?.created_by_user_id;
  return user?.role === 'admin' || Boolean(user?.id && ownerId
    && String(user.id) === String(ownerId));
}

async function voucherSharing(user, typeValue, record) {
  const type = shareType(typeValue);
  if (!canManageVoucherShare(user, record)) return null;
  const ownerId = record.owner_id || record.created_by_user_id || null;
  const [shares, users] = await Promise.all([
    getPostgresPool().query(`SELECT share.user_id, share.permission, account.username,
      account.active, share.granted_at
      FROM app_voucher_shares share
      JOIN app_users account ON account.id=share.user_id
      WHERE share.voucher_type=$1 AND share.voucher_id=$2
      ORDER BY account.username`, [type.key, record.id]),
    getPostgresPool().query(`SELECT id, username FROM app_users
      WHERE active AND NOT api_service_account AND role <> 'admin'
        AND id::text <> COALESCE($1::text, '')
      ORDER BY username`, [ownerId]),
  ]);
  return {
    type: type.key,
    label: type.label,
    voucher_id: record.id,
    endpoint: endPoint(type.key, record.id),
    shares: shares.rows,
    users: users.rows,
  };
}

async function changeVoucherShare(user, typeValue, idValue, action, value, permission = 'read') {
  const type = shareType(typeValue);
  const id = Number(idValue);
  if (!Number.isSafeInteger(id) || id < 1) throw sharingError(`${type.label} not found.`, 404);
  return withPostgresTransaction(async (client) => {
    const record = await loadShareRecord(client, type.key, id, { forUpdate: true });
    if (!canManageVoucherShare(user, record)) {
      throw sharingError(`Only the ${type.label.toLowerCase()} owner or an admin can manage sharing.`, 403);
    }
    if (!['share', 'revoke'].includes(action)) throw sharingError('Unknown sharing action.');
    const userId = Number(value);
    if (!Number.isSafeInteger(userId) || userId < 1) throw sharingError('Choose a user.');
    if (action === 'revoke') {
      await client.query(`DELETE FROM app_voucher_shares
        WHERE voucher_type=$1 AND voucher_id=$2 AND user_id=$3`, [type.key, id, userId]);
      return;
    }
    if (!['read', 'write'].includes(permission)) throw sharingError('Choose Read-only or Read & write.');
    const recipient = (await client.query(`SELECT id FROM app_users
      WHERE id=$1 AND active AND NOT api_service_account AND role <> 'admin'
      FOR SHARE`, [userId])).rows[0];
    if (!recipient || String(userId) === String(record.owner_id)) throw sharingError('Choose another active user.');
    await client.query(`INSERT INTO app_voucher_shares
      (voucher_type,voucher_id,user_id,granted_by_user_id,permission)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (voucher_type,voucher_id,user_id) DO UPDATE
      SET permission=EXCLUDED.permission, granted_by_user_id=EXCLUDED.granted_by_user_id,
        granted_at=now()
      WHERE app_voucher_shares.permission <> EXCLUDED.permission`, [type.key, id, userId, user.id, permission]);
  });
}

async function deleteVoucherShares(voucherType, voucherId, queryable = getPostgresPool()) {
  if (!SHARE_TYPES[voucherType]) return;
  await queryable.query('DELETE FROM app_voucher_shares WHERE voucher_type=$1 AND voucher_id=$2',
    [voucherType, Number(voucherId)]);
}

async function listSharedVouchers(user, filters = {}) {
  if (!user?.id) return { rows: [], pagination: paginationResult(0, paginationOptions(filters, 25, 100)) };
  const pagination = paginationOptions(filters, 25, 100);
  const query = `
    WITH shared AS (
      SELECT 'sales' AS voucher_type, share.voucher_id, share.permission, share.granted_at,
        invoice.invoice_no AS number, invoice.invoice_date::text AS posting_date,
        invoice.customer_id AS party, invoice.total::float AS amount,
        COALESCE(invoice.docstatus, 'submitted') AS docstatus
      FROM app_voucher_shares share
      JOIN app_invoices invoice ON invoice.id=share.voucher_id
      WHERE share.user_id=$1 AND share.voucher_type='sales'
      UNION ALL
      SELECT 'purchases', share.voucher_id, share.permission, share.granted_at,
        purchase.purchase_no, purchase.posting_date::text, purchase.supplier_id,
        purchase.total::float, COALESCE(purchase.docstatus, 'submitted')
      FROM app_voucher_shares share
      JOIN app_purchases purchase ON purchase.id=share.voucher_id
      WHERE share.user_id=$1 AND share.voucher_type='purchases'
      UNION ALL
      SELECT 'purchase-orders', share.voucher_id, share.permission, share.granted_at,
        purchase_order.order_no, purchase_order.posting_date::text, purchase_order.supplier_id,
        purchase_order.total::float, COALESCE(purchase_order.docstatus, 'submitted')
      FROM app_voucher_shares share
      JOIN app_purchase_orders purchase_order ON purchase_order.id=share.voucher_id
      WHERE share.user_id=$1 AND share.voucher_type='purchase-orders'
      UNION ALL
      SELECT 'journals', share.voucher_id, share.permission, share.granted_at,
        journal.journal_no, journal.posting_date::text,
        COALESCE(journal.party_id, journal.party_name, ''), journal.total_debit::float,
        COALESCE(journal.docstatus, 'submitted')
      FROM app_voucher_shares share
      JOIN app_journal_entries journal ON journal.id=share.voucher_id
      WHERE share.user_id=$1 AND share.voucher_type='journals'
      UNION ALL
      SELECT 'stock-reconciliations', share.voucher_id, share.permission, share.granted_at,
        entry.entry_no, entry.posting_date::text,
        COALESCE((SELECT STRING_AGG(DISTINCT item.warehouse, ', ' ORDER BY item.warehouse)
          FROM app_stock_entry_items item WHERE item.stock_entry_id=entry.id), ''),
        COALESCE((SELECT SUM(FLOOR(item.quantity * item.valuation_rate + 0.5))
          FROM app_stock_entry_items item WHERE item.stock_entry_id=entry.id), 0)::float,
        COALESCE(entry.docstatus, 'submitted')
      FROM app_voucher_shares share
      JOIN app_stock_entries entry ON entry.id=share.voucher_id
      WHERE share.user_id=$1 AND share.voucher_type='stock-reconciliations'
        AND entry.entry_type='reconciliation'
      UNION ALL
      SELECT 'stock', share.stock_entry_id, share.permission, share.granted_at,
        entry.entry_no, entry.posting_date::text,
        COALESCE((SELECT STRING_AGG(DISTINCT item.warehouse, ', ' ORDER BY item.warehouse)
          FROM app_stock_entry_items item WHERE item.stock_entry_id=entry.id), ''),
        COALESCE((SELECT SUM(FLOOR(item.quantity * item.valuation_rate + 0.5))
          FROM app_stock_entry_items item WHERE item.stock_entry_id=entry.id), 0)::float,
        COALESCE(entry.docstatus, 'submitted')
      FROM app_stock_entry_shares share
      JOIN app_stock_entries entry ON entry.id=share.stock_entry_id
      WHERE share.user_id=$1 AND entry.entry_type<>'reconciliation'
    )
    SELECT shared.*, COUNT(*) OVER()::int AS total_count
    FROM shared
    ORDER BY posting_date DESC, number DESC, voucher_type
    LIMIT $2 OFFSET $3`;
  const result = await getPostgresPool().query(query, [user.id, pagination.limit, pagination.offset]);
  const total = Number(result.rows[0]?.total_count || 0);
  pagination.page = Math.min(pagination.page, Math.max(1, Math.ceil(total / pagination.limit)));
  return {
    rows: result.rows.map(({ total_count, ...row }) => {
      const type = row.voucher_type === 'stock'
        ? { label: 'Stock Entry', path: '/stock/entries', key: 'stock' }
        : SHARE_TYPES[row.voucher_type];
      return {
        ...row,
        voucher_id: Number(row.voucher_id),
        label: type.label,
        href: type.key === 'stock' ? `/stock/entries/${row.voucher_id}` : `${type.path}/${row.voucher_id}`,
      };
    }),
    pagination: paginationResult(total, pagination),
  };
}

module.exports = {
  SHARE_TYPES, initVoucherSharing, loadShareRecord, voucherShareAccess,
  assertVoucherShareWrite, canManageVoucherShare, voucherSharing, changeVoucherShare,
  deleteVoucherShares, listSharedVouchers,
};
